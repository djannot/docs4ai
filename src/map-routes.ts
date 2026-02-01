import type { Request, Response } from 'express';
import type Database from 'better-sqlite3';
import express from 'express';
import { MapService } from './map-service';

const MAP_SAMPLE_CAP = 2000;
const MAP_NEIGHBOR_CAP = 50;

interface MapRouteDeps {
    getDatabase: () => Database.Database;
    mapService: MapService;
    hasDatabase: () => boolean;
}

export function createMapRouter({ getDatabase, mapService, hasDatabase }: MapRouteDeps) {
    const router = express.Router();

    router.post('/map', (req: Request, res: Response) => {
        try {
            if (!hasDatabase()) {
                res.status(503).json({ error: 'Database not configured. Please select a database in the app.' });
                return;
            }
            const db = getDatabase();
            const limit = Math.min(Number(req.body?.limit ?? MAP_SAMPLE_CAP), MAP_SAMPLE_CAP);
            const visualization = mapService.buildMapOverview(db, limit);
            res.json({ visualization });
        } catch (error: any) {
            console.error('Map overview error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    router.post('/neighbors', (req: Request, res: Response) => {
        try {
            if (!hasDatabase()) {
                res.status(503).json({ error: 'Database not configured. Please select a database in the app.' });
                return;
            }
            const chunkId = req.body?.chunk_id as string;
            if (!chunkId) {
                res.status(400).json({ error: 'chunk_id is required' });
                return;
            }
            const limit = Math.min(Number(req.body?.limit ?? MAP_NEIGHBOR_CAP), MAP_NEIGHBOR_CAP);
            const db = getDatabase();
            const visualization = mapService.buildNeighborVisualization(db, chunkId, limit);
            if (!visualization) {
                res.status(404).json({ error: 'Chunk not found' });
                return;
            }
            res.json({ visualization });
        } catch (error: any) {
            console.error('Neighbor query error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}
