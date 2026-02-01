import express, { Request, Response } from 'express';
import { Server } from 'http';
import Database from 'better-sqlite3';
import { loadSqliteVec } from "./sqliteVec";
import { randomUUID } from 'crypto';
import { EmbeddingService, EmbeddingProvider } from './embeddings';
import { MapService } from './map-service';
import { createMapRouter } from './map-routes';
import { createSearchRouter } from './search-routes';

// Configuration constants
const EMBEDDING_TIMEOUT_MS = 30000; // 30 second timeout for embedding generation
const SESSION_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Clean up every 5 minutes
const MAX_SESSIONS = 1000; // Maximum number of concurrent sessions

interface SessionData {
    createdAt: number;
    lastAccessedAt: number;
}

interface QueryResult {
    chunk_id: string;
    distance: number | null;
    rrf_score: number;
    match_type?: 'semantic' | 'keyword' | 'hybrid';
    content: string;
    url: string;
    section: string;
    heading_hierarchy: string;
    chunk_index: number;
    total_chunks: number;
}

interface ChunkResult {
    chunk_id: string;
    content: string;
    section: string;
    heading_hierarchy: string;
    chunk_index: number;
    total_chunks: number;
}

interface JsonRpcRequest {
    jsonrpc: string;
    id?: string | number;
    method: string;
    params?: any;
}

function buildFtsQuery(text: string): { query: string; termCount: number } {
    const cleaned = text.replace(/[^\p{L}\p{N}\s]/gu, ' ');
    const words = cleaned.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
        return { query: '', termCount: 0 };
    }
    return {
        query: words.map(word => `${word}*`).join(' AND '),
        termCount: words.length
    };
}

export class McpServer {
    private app: express.Application;
    private server: Server | null = null;
    private dbPath: string | null = null;
    private db: Database.Database | null = null; // Cached database connection
    private openaiApiKey: string | null = null;
    private embeddingProvider: EmbeddingProvider = 'local';
    private embeddingService: EmbeddingService | null = null;
    private embeddingContextLength: number = 2048;
    private port: number;
    private sessions: Map<string, SessionData> = new Map();
    private sessionCleanupInterval: NodeJS.Timeout | null = null;
    private onCostUpdate: ((tokens: number, cost: number) => void) | null = null;
    private isStopping = false; // Prevent multiple concurrent stop calls
    private stopPromise: Promise<void> | null = null;
    private mapService: MapService;

    constructor(port: number = 3333, embeddingContextLength?: number) {
        this.port = port;
        this.embeddingContextLength = embeddingContextLength ?? 8192;
        this.mapService = new MapService();
        this.app = express();
        this.app.use(express.json());
        this.app.use((_req, res, next) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            if (_req.method === 'OPTIONS') {
                res.sendStatus(204);
                return;
            }
            next();
        });
        this.app.use(createMapRouter({
            getDatabase: () => this.getDatabase(),
            mapService: this.mapService,
            hasDatabase: () => Boolean(this.dbPath)
        }));
        this.app.use(createSearchRouter({
            getDatabase: () => this.getDatabase(),
            mapService: this.mapService,
            hasDatabase: () => Boolean(this.dbPath),
            hasOpenAiKey: () => Boolean(this.openaiApiKey),
            isOpenAiProvider: () => this.embeddingProvider === 'openai',
            queryDatabase: (queryText: string, limit: number) => this.queryDatabase(queryText, limit)
        }));
        this.setupRoutes();
        this.startSessionCleanup();
    }

    /**
     * Get or create a cached database connection
     */
    private getDatabase(): Database.Database {
        if (!this.dbPath) {
            throw new Error('Database not configured');
        }

        if (!this.db) {
            console.log('MCP Server: Creating new database connection');
            this.db = new Database(this.dbPath);
            loadSqliteVec(this.db);
            this.mapService.ensureMapTables(this.db);
        }

        return this.db;
    }

    /**
     * Close the cached database connection
     */
    private closeDatabase(): void {
        if (this.db) {
            try {
                this.db.close();
            } catch (error) {
                console.error('Error closing database:', error);
            }
            this.db = null;
        }
    }

    /**
     * Start periodic session cleanup
     */
    private startSessionCleanup(): void {
        this.sessionCleanupInterval = setInterval(() => {
            this.cleanupExpiredSessions();
        }, SESSION_CLEANUP_INTERVAL_MS);
        this.sessionCleanupInterval.unref();
    }

    /**
     * Stop session cleanup interval
     */
    private stopSessionCleanup(): void {
        if (this.sessionCleanupInterval) {
            clearInterval(this.sessionCleanupInterval);
            this.sessionCleanupInterval = null;
        }
    }

    /**
     * Remove expired sessions from the map
     */
    private cleanupExpiredSessions(): void {
        const now = Date.now();
        let expiredCount = 0;

        for (const [sessionId, data] of this.sessions) {
            if (now - data.lastAccessedAt > SESSION_EXPIRY_MS) {
                this.sessions.delete(sessionId);
                expiredCount++;
            }
        }

        if (expiredCount > 0) {
            console.log(`MCP Server: Cleaned up ${expiredCount} expired sessions. Active sessions: ${this.sessions.size}`);
        }
    }

    /**
     * Create or update a session
     */
    private touchSession(sessionId: string): void {
        const existing = this.sessions.get(sessionId);
        const now = Date.now();

        if (existing) {
            existing.lastAccessedAt = now;
        } else {
            // Check if we're at max capacity
            if (this.sessions.size >= MAX_SESSIONS) {
                // Remove oldest session
                let oldestId: string | null = null;
                let oldestTime = Infinity;
                for (const [id, data] of this.sessions) {
                    if (data.lastAccessedAt < oldestTime) {
                        oldestTime = data.lastAccessedAt;
                        oldestId = id;
                    }
                }
                if (oldestId) {
                    this.sessions.delete(oldestId);
                }
            }

            this.sessions.set(sessionId, {
                createdAt: now,
                lastAccessedAt: now
            });
        }
    }

    /**
     * Wrap a promise with a timeout
     */
    private withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error(`${operation} timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            promise
                .then((result) => {
                    clearTimeout(timer);
                    resolve(result);
                })
                .catch((error) => {
                    clearTimeout(timer);
                    reject(error);
                });
        });
    }


    private async getEmbeddingService(): Promise<EmbeddingService> {
        if (this.embeddingService) {
            return this.embeddingService;
        }

        if (this.embeddingProvider === 'openai' && this.openaiApiKey) {
            this.embeddingService = new EmbeddingService('openai', this.openaiApiKey, this.embeddingContextLength);
        } else {
            // Use the specified local model
            this.embeddingService = new EmbeddingService(this.embeddingProvider, undefined, this.embeddingContextLength);
            await this.embeddingService.validateApiKey(); // Ensures model is loaded
        }

        return this.embeddingService;
    }

    private setupRoutes() {
        // Health check
        this.app.get('/health', (_req: Request, res: Response) => {
            res.json({ 
                status: 'ok', 
                database: this.dbPath ? 'connected' : 'not connected',
                embeddingProvider: this.embeddingProvider
            });
        });

        // MCP-style tool listing
        this.app.get('/tools', (_req: Request, res: Response) => {
            res.json({
                tools: [{
                    name: 'query_documents',
                    description: 'Search through synced documents using hybrid search (semantic vectors + keyword FTS5).',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: 'The natural language query to search for.'
                            },
                            limit: {
                                type: 'number',
                                description: 'Maximum number of results to return (1-20). Defaults to 5.',
                                default: 5
                            }
                        },
                        required: ['query']
                    }
                }]
            });
        });

        // Query endpoint is registered in createSearchRouter

        // Map overview + neighbor routes are registered in createMapRouter

        // MCP Streamable HTTP endpoint - proper JSON-RPC handling
        this.app.post('/mcp', async (req: Request, res: Response) => {
            try {
                const request = req.body as JsonRpcRequest;
                const { jsonrpc, id, method, params } = request;

                // Get or create session
                let sessionId = req.headers['mcp-session-id'] as string;
                if (!sessionId && method === 'initialize') {
                    sessionId = randomUUID();
                }

                // Touch session to track activity
                if (sessionId) {
                    this.touchSession(sessionId);
                    res.setHeader('mcp-session-id', sessionId);
                }

                console.log(`MCP Request: ${method}`, params ? JSON.stringify(params).substring(0, 100) : '');

                // Handle MCP methods
                switch (method) {
                    case 'initialize':
                        res.json({
                            jsonrpc: '2.0',
                            id,
                            result: {
                                protocolVersion: '2024-11-05',
                                capabilities: {
                                    tools: {}
                                },
                                serverInfo: {
                                    name: 'docs4ai',
                                    version: '1.0.0'
                                }
                            }
                        });
                        return;

                    case 'notifications/initialized':
                        // Client acknowledged initialization - no response needed for notifications
                        res.status(204).send();
                        return;

                    case 'tools/list':
                        res.json({
                            jsonrpc: '2.0',
                            id,
                            result: {
                                tools: [
                                    {
                                        name: 'query_documents',
                                        description: 'Search through synced documents using hybrid search (semantic vectors + keyword FTS5). Returns relevant document chunks with their chunk_index and total_chunks so you can retrieve additional chunks from the same document using get_chunks.',
                                        inputSchema: {
                                            type: 'object',
                                            properties: {
                                                query: { 
                                                    type: 'string', 
                                                    description: 'The natural language search query' 
                                                },
                                                limit: { 
                                                    type: 'number', 
                                                    description: 'Maximum number of results to return (1-20)',
                                                    default: 5
                                                }
                                            },
                                            required: ['query']
                                        }
                                    },
                                    {
                                        name: 'get_chunks',
                                        description: 'Retrieve a range of chunks from a document by file path. Use this to get more context from a document after finding it with query_documents. Chunks are 0-indexed. If startIndex and endIndex are not provided, all chunks are returned.',
                                        inputSchema: {
                                            type: 'object',
                                            properties: {
                                                file_path: {
                                                    type: 'string',
                                                    description: 'The file path (url) of the document to retrieve chunks from'
                                                },
                                                startIndex: {
                                                    type: 'number',
                                                    description: 'The starting chunk index (0-based, inclusive). If not provided, starts from the first chunk (index 0).'
                                                },
                                                endIndex: {
                                                    type: 'number',
                                                    description: 'The ending chunk index (0-based, inclusive). If not provided, retrieves all chunks from startIndex to the end.'
                                                }
                                            },
                                            required: ['file_path']
                                        }
                                    }
                                ]
                            }
                        });
                        return;

                    case 'tools/call':
                        const { name, arguments: args } = params || {};
                        
                        if (name === 'query_documents') {
                            if (!this.dbPath) {
                                res.json({
                                    jsonrpc: '2.0',
                                    id,
                                    result: {
                                        content: [{ type: 'text', text: 'Error: Database not configured in Docs4ai app. Please configure it in the app settings.' }],
                                        isError: true
                                    }
                                });
                                return;
                            }

                            // Check if we need API key (only for OpenAI)
                            if (this.embeddingProvider === 'openai' && !this.openaiApiKey) {
                                res.json({
                                    jsonrpc: '2.0',
                                    id,
                                    result: {
                                        content: [{ type: 'text', text: 'Error: OpenAI API key not configured. Please add your API key in the app or switch to local embeddings.' }],
                                        isError: true
                                    }
                                });
                                return;
                            }

                            const query = args?.query || args?.queryText || '';
                            if (!query) {
                                res.json({
                                    jsonrpc: '2.0',
                                    id,
                                    result: {
                                        content: [{ type: 'text', text: 'Error: query parameter is required' }],
                                        isError: true
                                    }
                                });
                                return;
                            }

                            try {
                                const results = await this.queryDatabase(query, Math.min(args?.limit || 5, 20));
                                
                                if (results.length === 0) {
                                    res.json({
                                        jsonrpc: '2.0',
                                        id,
                                        result: {
                                            content: [{ type: 'text', text: `No results found for "${query}"` }]
                                        }
                                    });
                                    return;
                                }

                                const formatted = results.map((r, i) => {
                                    const distance = r.distance === null ? 'n/a' : r.distance.toFixed(4);
                                    const matchType = r.match_type || 'semantic';
                                    return `**Result ${i + 1}** (rrf: ${r.rrf_score.toFixed(4)}, distance: ${distance}, match: ${matchType})\n` +
                                    `File: ${r.url}\n` +
                                    `Section: ${r.section}\n` +
                                    `Chunk: ${r.chunk_index + 1} of ${r.total_chunks}\n` +
                                    `${r.content}\n` +
                                    `---`;
                                }).join('\n\n');

                                res.json({
                                    jsonrpc: '2.0',
                                    id,
                                    result: {
                                        content: [{ type: 'text', text: `Found ${results.length} results for "${query}":\n\n${formatted}` }]
                                    }
                                });
                                return;
                            } catch (queryError: any) {
                                res.json({
                                    jsonrpc: '2.0',
                                    id,
                                    result: {
                                        content: [{ type: 'text', text: `Error querying database: ${queryError.message}` }],
                                        isError: true
                                    }
                                });
                                return;
                            }
                        }

                        if (name === 'get_chunks') {
                            if (!this.dbPath) {
                                res.json({
                                    jsonrpc: '2.0',
                                    id,
                                    result: {
                                        content: [{ type: 'text', text: 'Error: Database not configured in Docs4ai app.' }],
                                        isError: true
                                    }
                                });
                                return;
                            }

                            const filePath = args?.file_path || '';
                            if (!filePath) {
                                res.json({
                                    jsonrpc: '2.0',
                                    id,
                                    result: {
                                        content: [{ type: 'text', text: 'Error: file_path parameter is required' }],
                                        isError: true
                                    }
                                });
                                return;
                            }

                            try {
                                const chunks = this.getChunksForFile(filePath, args?.startIndex, args?.endIndex);
                                
                                if (chunks.length === 0) {
                                    res.json({
                                        jsonrpc: '2.0',
                                        id,
                                        result: {
                                            content: [{ type: 'text', text: `No chunks found for file: ${filePath}` }]
                                        }
                                    });
                                    return;
                                }

                                const formatted = chunks.map((c) => 
                                    `**Chunk ${c.chunk_index + 1} of ${c.total_chunks}**\n` +
                                    `Section: ${c.section}\n` +
                                    `${c.content}\n` +
                                    `---`
                                ).join('\n\n');

                                res.json({
                                    jsonrpc: '2.0',
                                    id,
                                    result: {
                                        content: [{ type: 'text', text: `Retrieved ${chunks.length} chunk(s) from "${filePath}":\n\n${formatted}` }]
                                    }
                                });
                                return;
                            } catch (chunkError: any) {
                                res.json({
                                    jsonrpc: '2.0',
                                    id,
                                    result: {
                                        content: [{ type: 'text', text: `Error retrieving chunks: ${chunkError.message}` }],
                                        isError: true
                                    }
                                });
                                return;
                            }
                        }

                        res.json({
                            jsonrpc: '2.0',
                            id,
                            error: {
                                code: -32601,
                                message: `Unknown tool: ${name}`
                            }
                        });
                        return;

                    default:
                        res.json({
                            jsonrpc: '2.0',
                            id,
                            error: {
                                code: -32601,
                                message: `Method not found: ${method}`
                            }
                        });
                        return;
                }
            } catch (error: any) {
                console.error('MCP error:', error);
                res.json({
                    jsonrpc: '2.0',
                    id: req.body?.id,
                    error: {
                        code: -32603,
                        message: error.message
                    }
                });
            }
        });

        // Handle GET for SSE (not implemented, return 404)
        this.app.get('/mcp', (_req: Request, res: Response) => {
            res.status(404).json({ error: 'SSE not supported, use POST for Streamable HTTP' });
        });
    }

    private async queryDatabase(queryText: string, limit: number): Promise<QueryResult[]> {
        if (!this.dbPath) {
            throw new Error('Database not configured');
        }

        // Get the embedding service
        const embeddingService = await this.getEmbeddingService();

        // Generate embedding for query with timeout
        const result = await this.withTimeout(
            embeddingService.generateEmbedding(queryText),
            EMBEDDING_TIMEOUT_MS,
            'Embedding generation'
        );
        const queryEmbedding = result.embedding;

        // Track tokens and cost for query (only for OpenAI)
        if (this.embeddingProvider === 'openai' && this.onCostUpdate) {
            const tokens = result.tokens;
            const cost = (tokens / 1_000_000) * 0.13; // $0.13 per million tokens
            this.onCostUpdate(tokens, cost);
        }

        // Query database using cached connection
        const db = this.getDatabase();

        const candidateLimit = Math.min(limit * 5, 50);
        const rrfK = 60;
        const { query: ftsQuery, termCount } = buildFtsQuery(queryText);
        const vectorWeight = termCount >= 5 ? 1.2 : 1.0;
        const ftsWeight = termCount > 0 && termCount <= 2 ? 1.2 : 1.0;

        const vectorStmt = db.prepare(`
            SELECT
                chunk_id,
                distance,
                content,
                url,
                section,
                heading_hierarchy,
                chunk_index,
                total_chunks
            FROM vec_items
            WHERE embedding MATCH ? AND k = ?
            ORDER BY distance
        `);

        const ftsStmt = db.prepare(`
            SELECT
                vec_items.chunk_id,
                vec_items.content,
                vec_items.url,
                vec_items.section,
                vec_items.heading_hierarchy,
                vec_items.chunk_index,
                vec_items.total_chunks
            FROM fts_chunks
            JOIN vec_items ON vec_items.chunk_id = fts_chunks.chunk_id
            WHERE fts_chunks MATCH ?
            ORDER BY bm25(fts_chunks)
            LIMIT ?
        `);

        const vectorResults = vectorStmt.all(
            new Float32Array(queryEmbedding),
            candidateLimit
        ) as QueryResult[];
        const ftsResults = ftsQuery
            ? (ftsStmt.all(ftsQuery, candidateLimit) as QueryResult[])
            : [];

        const combined = new Map<string, QueryResult>();
        const vectorDistanceById = new Map<string, number>();

        vectorResults.forEach((result, index) => {
            if (result.distance !== null && result.distance !== undefined) {
                vectorDistanceById.set(result.chunk_id, result.distance);
            }
            const rrfScore = (1 / (rrfK + index + 1)) * vectorWeight;
            combined.set(result.chunk_id, {
                ...result,
                match_type: 'semantic',
                rrf_score: rrfScore
            });
        });

        ftsResults.forEach((result, index) => {
            const rrfScore = (1 / (rrfK + index + 1)) * ftsWeight;
            const existing = combined.get(result.chunk_id);
            if (existing) {
                existing.rrf_score += rrfScore;
                existing.match_type = 'hybrid';
                if (existing.distance === null || existing.distance === undefined) {
                    const vectorDistance = vectorDistanceById.get(result.chunk_id);
                    if (vectorDistance !== undefined) {
                        existing.distance = vectorDistance;
                    }
                }
                return;
            }

            combined.set(result.chunk_id, {
                ...result,
                distance: null,
                match_type: 'keyword',
                rrf_score: rrfScore
            });
        });

        const results = Array.from(combined.values())
            .sort((a, b) => b.rrf_score - a.rrf_score)
            .slice(0, limit);

        return results;
    }

    private getChunksForFile(filePath: string, startIndex?: number, endIndex?: number): ChunkResult[] {
        if (!this.dbPath) {
            throw new Error('Database not configured');
        }

        // Use cached database connection
        const db = this.getDatabase();

        let rows: ChunkResult[];

        if (startIndex !== undefined || endIndex !== undefined) {
            // Get chunks in the specified range
            const start = startIndex ?? 0;

            if (endIndex !== undefined) {
                // Both start and end specified
                const stmt = db.prepare(`
                    SELECT
                        chunk_id,
                        content,
                        section,
                        heading_hierarchy,
                        chunk_index,
                        total_chunks
                    FROM vec_items
                    WHERE url = ? AND chunk_index >= ? AND chunk_index <= ?
                    ORDER BY chunk_index
                `);
                rows = stmt.all(filePath, start, endIndex) as ChunkResult[];
            } else {
                // Only start specified, get from start to end
                const stmt = db.prepare(`
                    SELECT
                        chunk_id,
                        content,
                        section,
                        heading_hierarchy,
                        chunk_index,
                        total_chunks
                    FROM vec_items
                    WHERE url = ? AND chunk_index >= ?
                    ORDER BY chunk_index
                `);
                rows = stmt.all(filePath, start) as ChunkResult[];
            }
        } else {
            // Get all chunks for the file
            const stmt = db.prepare(`
                SELECT
                    chunk_id,
                    content,
                    section,
                    heading_hierarchy,
                    chunk_index,
                    total_chunks
                FROM vec_items
                WHERE url = ?
                ORDER BY chunk_index
            `);
            rows = stmt.all(filePath) as ChunkResult[];
        }

        return rows;
    }

    setDatabase(dbPath: string | null) {
        // Close existing connection if database path changes
        if (this.dbPath !== dbPath) {
            this.closeDatabase();
        }
        this.dbPath = dbPath;
        console.log(`MCP Server: Database set to ${dbPath}`);
    }

    setApiKey(apiKey: string | null) {
        this.openaiApiKey = apiKey;
        // Reset embedding service so it gets recreated with new key
        if (this.embeddingProvider === 'openai') {
            this.embeddingService = null;
        }
    }

    setEmbeddingProvider(provider: EmbeddingProvider) {
        this.embeddingProvider = provider;
        // Reset embedding service so it gets recreated with new provider
        this.embeddingService = null;
        console.log(`MCP Server: Embedding provider set to ${provider}`);
    }

    setOnCostUpdate(callback: (tokens: number, cost: number) => void) {
        this.onCostUpdate = callback;
    }

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const server = this.app.listen(this.port, () => {
                    console.log(`MCP Server running on http://localhost:${this.port} (embeddings: ${this.embeddingProvider})`);
                    resolve();
                });
                
                server.on('error', (error: any) => {
                    if (error.code === 'EADDRINUSE') {
                        console.error(`MCP Server: Port ${this.port} already in use`);
                    }
                    reject(error);
                });
                
                this.server = server;
            } catch (error) {
                reject(error);
            }
        });
    }

    async stop(): Promise<void> {
        // If already stopping, return the existing promise (idempotent)
        if (this.isStopping && this.stopPromise) {
            return this.stopPromise;
        }

        // If already stopped, return immediately
        if (!this.server && !this.embeddingService && !this.sessionCleanupInterval) {
            return Promise.resolve();
        }

        this.isStopping = true;

        this.stopPromise = (async () => {
            // Stop session cleanup interval
            this.stopSessionCleanup();

            // Terminate embedding service worker if it exists
            if (this.embeddingService) {
                try {
                    await this.embeddingService.terminate();
                } catch (error) {
                    console.error('Error terminating embedding service:', error);
                }
                this.embeddingService = null;
            }

            // Close database connection
            this.closeDatabase();

            // Clear sessions
            this.sessions.clear();

            // Close HTTP server
            await new Promise<void>((resolve) => {
                if (this.server) {
                    this.server.close(() => {
                        console.log('MCP Server stopped');
                        this.server = null;
                        resolve();
                    });
                } else {
                    resolve();
                }
            });

            this.isStopping = false;
            this.stopPromise = null;
        })();

        return this.stopPromise;
    }

    isRunning(): boolean {
        return this.server !== null;
    }

    getPort(): number {
        return this.port;
    }
}
