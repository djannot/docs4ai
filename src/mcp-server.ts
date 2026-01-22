import express, { Request, Response } from 'express';
import { Server } from 'http';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { randomUUID } from 'crypto';
import { EmbeddingService, EmbeddingProvider } from './embeddings';

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
    distance: number;
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

    constructor(port: number = 3333, embeddingContextLength?: number) {
        this.port = port;
        this.embeddingContextLength = embeddingContextLength ?? 8192;
        this.app = express();
        this.app.use(express.json());
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
            sqliteVec.load(this.db);
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
                    description: 'Search through synced documents using semantic vector search.',
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

        // Query endpoint
        this.app.post('/query', async (req: Request, res: Response) => {
            try {
                const { query, queryText, limit = 5 } = req.body;
                const searchQuery = query || queryText; // Support both parameter names

                if (!searchQuery) {
                    res.status(400).json({ error: 'query is required' });
                    return;
                }

                if (!this.dbPath) {
                    res.status(503).json({ error: 'Database not configured. Please select a database in the app.' });
                    return;
                }

                // Check if we need API key (only for OpenAI)
                if (this.embeddingProvider === 'openai' && !this.openaiApiKey) {
                    res.status(503).json({ error: 'OpenAI API key not configured. Please add your API key in the app or switch to local embeddings.' });
                    return;
                }

                const results = await this.queryDatabase(searchQuery, Math.min(limit, 20));
                res.json({ 
                    query: searchQuery,
                    count: results.length,
                    results 
                });
            } catch (error: any) {
                console.error('Query error:', error);
                res.status(500).json({ error: error.message });
            }
        });

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
                                        description: 'Search through synced documents using semantic vector search. Returns relevant document chunks with their chunk_index and total_chunks so you can retrieve additional chunks from the same document using get_chunks.',
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

                                const formatted = results.map((r, i) => 
                                    `**Result ${i + 1}** (distance: ${r.distance.toFixed(4)})\n` +
                                    `File: ${r.url}\n` +
                                    `Section: ${r.section}\n` +
                                    `Chunk: ${r.chunk_index + 1} of ${r.total_chunks}\n` +
                                    `${r.content}\n` +
                                    `---`
                                ).join('\n\n');

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

        const stmt = db.prepare(`
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
            WHERE embedding MATCH ?
            ORDER BY distance
            LIMIT ?
        `);

        const rows = stmt.all(new Float32Array(queryEmbedding), limit) as QueryResult[];
        return rows;
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
