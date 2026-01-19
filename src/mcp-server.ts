import express, { Request, Response } from 'express';
import { Server } from 'http';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';

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
    private openaiApiKey: string | null = null;
    private port: number;
    private sessions: Map<string, boolean> = new Map();

    constructor(port: number = 3333) {
        this.port = port;
        this.app = express();
        this.app.use(express.json());
        this.setupRoutes();
    }

    private setupRoutes() {
        // Health check
        this.app.get('/health', (_req: Request, res: Response) => {
            res.json({ status: 'ok', database: this.dbPath ? 'connected' : 'not connected' });
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

                if (!this.openaiApiKey) {
                    res.status(503).json({ error: 'OpenAI API key not configured. Please add your API key in the app.' });
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
                    this.sessions.set(sessionId, true);
                }

                // Set session header
                if (sessionId) {
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
                                        description: 'Retrieve specific chunks from a document by file path. Use this to get more context from a document after finding it with query_documents. You can retrieve individual chunks or a range of chunks.',
                                        inputSchema: {
                                            type: 'object',
                                            properties: {
                                                file_path: {
                                                    type: 'string',
                                                    description: 'The file path (url) of the document to retrieve chunks from'
                                                },
                                                chunk_indices: {
                                                    type: 'array',
                                                    items: { type: 'number' },
                                                    description: 'Array of chunk indices to retrieve (0-based). If not provided, returns all chunks.'
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
                            if (!this.dbPath || !this.openaiApiKey) {
                                res.json({
                                    jsonrpc: '2.0',
                                    id,
                                    result: {
                                        content: [{ type: 'text', text: 'Error: Database or API key not configured in Docs4ai app. Please configure them in the app settings.' }],
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
                                const chunks = this.getChunksForFile(filePath, args?.chunk_indices);
                                
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
        if (!this.dbPath || !this.openaiApiKey) {
            throw new Error('Database or API key not configured');
        }

        // Generate embedding for query
        const openai = new OpenAI({ apiKey: this.openaiApiKey });
        const embeddingResponse = await openai.embeddings.create({
            model: 'text-embedding-3-large',
            input: queryText
        });
        const queryEmbedding = embeddingResponse.data[0].embedding;

        // Query database
        const db = new Database(this.dbPath);
        sqliteVec.load(db);

        try {
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
        } finally {
            db.close();
        }
    }

    private getChunksForFile(filePath: string, chunkIndices?: number[]): ChunkResult[] {
        if (!this.dbPath) {
            throw new Error('Database not configured');
        }

        const db = new Database(this.dbPath);
        sqliteVec.load(db);

        try {
            let rows: ChunkResult[];
            
            if (chunkIndices && chunkIndices.length > 0) {
                // Get specific chunks by index
                const placeholders = chunkIndices.map(() => '?').join(',');
                const stmt = db.prepare(`
                    SELECT
                        chunk_id,
                        content,
                        section,
                        heading_hierarchy,
                        chunk_index,
                        total_chunks
                    FROM vec_items
                    WHERE url = ? AND chunk_index IN (${placeholders})
                    ORDER BY chunk_index
                `);
                rows = stmt.all(filePath, ...chunkIndices) as ChunkResult[];
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
        } finally {
            db.close();
        }
    }

    setDatabase(dbPath: string | null) {
        this.dbPath = dbPath;
        console.log(`MCP Server: Database set to ${dbPath}`);
    }

    setApiKey(apiKey: string | null) {
        this.openaiApiKey = apiKey;
    }

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const server = this.app.listen(this.port, () => {
                    console.log(`MCP Server running on http://localhost:${this.port}`);
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

    stop(): Promise<void> {
        return new Promise((resolve) => {
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
    }

    isRunning(): boolean {
        return this.server !== null;
    }

    getPort(): number {
        return this.port;
    }
}
