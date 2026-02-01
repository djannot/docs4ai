import type { Request, Response } from 'express';
import type Database from 'better-sqlite3';
import express from 'express';
import { MapService } from './map-service';

interface QueryResult {
    chunk_id: string;
    rrf_score: number;
}

interface SearchRouteDeps {
    getDatabase: () => Database.Database;
    mapService: MapService;
    hasDatabase: () => boolean;
    hasOpenAiKey: () => boolean;
    isOpenAiProvider: () => boolean;
    queryDatabase: (queryText: string, limit: number) => Promise<QueryResult[]>;
}

export function createSearchRouter({
    getDatabase,
    mapService,
    hasDatabase,
    hasOpenAiKey,
    isOpenAiProvider,
    queryDatabase
}: SearchRouteDeps) {
    const router = express.Router();

    router.post('/query', async (req: Request, res: Response) => {
        try {
            const { query, queryText, limit = 5, includeVisualization = false } = req.body;
            const searchQuery = query || queryText;

            if (!searchQuery) {
                res.status(400).json({ error: 'query is required' });
                return;
            }

            if (!hasDatabase()) {
                res.status(503).json({ error: 'Database not configured. Please select a database in the app.' });
                return;
            }

            if (isOpenAiProvider() && !hasOpenAiKey()) {
                res.status(503).json({ error: 'OpenAI API key not configured. Please add your API key in the app or switch to local embeddings.' });
                return;
            }

            const results = await queryDatabase(searchQuery, Math.min(limit, 20));
            const responsePayload: any = {
                query: searchQuery,
                count: results.length,
                results
            };

            if (includeVisualization && results.length > 0) {
                const db = getDatabase();
                responsePayload.visualization = mapService.buildVisualizationForQuery(db, results);
            }

            res.json(responsePayload);
        } catch (error: any) {
            console.error('Query error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}
