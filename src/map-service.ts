import type Database from 'better-sqlite3';

const MAP_SAMPLE_LIMIT = 600;
const MAP_NEIGHBOR_LIMIT = 10;

interface MapQueryResult {
    chunk_id: string;
    rrf_score: number;
}

interface VisualizationPoint {
    id: string;
    x: number;
    y: number;
    score: number | null;
    type: 'result' | 'neighbor' | 'map' | 'focus';
    url: string;
    displayPath: string;
    section: string;
    heading_hierarchy: string;
    chunk_index: number;
    total_chunks: number;
    keywords: string[];
}

interface VisualizationPayload {
    points: VisualizationPoint[];
    center: { x: number; y: number };
    focusId?: string;
}

export class MapService {
    ensureMapTables(db: Database.Database): void {
        const coordsRow = db.prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='chunk_coords'"
        ).get() as { sql?: string } | undefined;
        const coordsSql = coordsRow?.sql ?? '';
        if (coordsSql.includes('FOREIGN KEY') || coordsSql.includes('REFERENCES vec_items')) {
            db.exec('DROP TABLE IF EXISTS chunk_coords');
        }

        db.exec(`
            CREATE TABLE IF NOT EXISTS chunk_coords (
                chunk_id TEXT PRIMARY KEY,
                x REAL,
                y REAL
            )
        `);
    }

    buildVisualizationForQuery(db: Database.Database, results: MapQueryResult[], sampleLimit: number = MAP_SAMPLE_LIMIT): VisualizationPayload {
        const topResults = results.slice(0, 5);
        const resultIds = topResults.map(result => result.chunk_id);
        const resultScores = new Map<string, number>();
        topResults.forEach(result => resultScores.set(result.chunk_id, result.rrf_score));

        const neighborScores = new Map<string, number>();
        const neighborIds: string[] = [];

        const embeddingStmt = db.prepare('SELECT embedding FROM vec_items WHERE chunk_id = ?');
        const neighborStmt = db.prepare(`
            SELECT chunk_id, distance
            FROM vec_items
            WHERE embedding MATCH ? AND k = ?
            ORDER BY distance
        `);

        for (const result of topResults) {
            const row = embeddingStmt.get(result.chunk_id) as { embedding?: Float32Array | Buffer } | undefined;
            const embedding = this.normalizeEmbedding(row?.embedding);
            if (!embedding) continue;
            const neighbors = neighborStmt.all(embedding, MAP_NEIGHBOR_LIMIT + 1) as Array<{ chunk_id: string; distance: number }>;
            for (const neighbor of neighbors) {
                if (neighbor.chunk_id === result.chunk_id) continue;
                if (!neighborScores.has(neighbor.chunk_id)) {
                    neighborIds.push(neighbor.chunk_id);
                }
                neighborScores.set(neighbor.chunk_id, 1 / (1 + (neighbor.distance ?? 0)));
            }
        }

        const uniqueNeighborIds = Array.from(new Set(neighborIds));
        const rows = this.fetchChunkRows(db, [...resultIds, ...uniqueNeighborIds]);
        const points: VisualizationPoint[] = [
            ...this.buildVisualizationFromIds(rows, resultIds, 'result', resultScores),
            ...this.buildVisualizationFromIds(rows, uniqueNeighborIds, 'neighbor', neighborScores)
        ];

        const excludeIds = new Set(points.map(point => point.id));
        const sampleRows = db.prepare(`
            SELECT
                vec_items.chunk_id,
                vec_items.url,
                vec_items.section,
                vec_items.heading_hierarchy,
                vec_items.chunk_index,
                vec_items.total_chunks,
                vec_items.content,
                chunk_coords.x,
                chunk_coords.y,
                files.display_path
            FROM chunk_coords
            JOIN vec_items ON vec_items.chunk_id = chunk_coords.chunk_id
            LEFT JOIN files ON files.source_url = vec_items.url
            ORDER BY RANDOM()
            LIMIT ?
        `).all(sampleLimit) as Array<any>;

        for (const row of sampleRows) {
            if (excludeIds.has(row.chunk_id)) continue;
            points.push(this.makeVisualizationPoint(row, 'map', null));
        }

        const centerPoint = points.find(point => point.type === 'result') || points[0];
        const center = centerPoint ? { x: centerPoint.x, y: centerPoint.y } : { x: 0, y: 0 };

        return { points, center };
    }

    buildMapOverview(db: Database.Database, sampleLimit: number = MAP_SAMPLE_LIMIT): VisualizationPayload {
        const sampleRows = db.prepare(`
            SELECT
                vec_items.chunk_id,
                vec_items.url,
                vec_items.section,
                vec_items.heading_hierarchy,
                vec_items.chunk_index,
                vec_items.total_chunks,
                vec_items.content,
                chunk_coords.x,
                chunk_coords.y,
                files.display_path
            FROM chunk_coords
            JOIN vec_items ON vec_items.chunk_id = chunk_coords.chunk_id
            LEFT JOIN files ON files.source_url = vec_items.url
            ORDER BY RANDOM()
            LIMIT ?
        `).all(sampleLimit) as Array<any>;

        const points = sampleRows.map(row => this.makeVisualizationPoint(row, 'map', null));
        const centerPoint = points[0];
        const center = centerPoint ? { x: centerPoint.x, y: centerPoint.y } : { x: 0, y: 0 };
        return { points, center };
    }

    buildNeighborVisualization(db: Database.Database, chunkId: string, limit: number = MAP_NEIGHBOR_LIMIT): VisualizationPayload | null {
        const baseRows = this.fetchChunkRows(db, [chunkId]);
        const baseRow = baseRows.get(chunkId);
        if (!baseRow) return null;

        const embeddingRow = db.prepare('SELECT embedding FROM vec_items WHERE chunk_id = ?').get(chunkId) as {
            embedding?: Float32Array | Buffer;
        } | undefined;
        const embedding = this.normalizeEmbedding(embeddingRow?.embedding);
        if (!embedding) return null;

        const neighborRows = db.prepare(`
            SELECT chunk_id, distance
            FROM vec_items
            WHERE embedding MATCH ? AND k = ?
            ORDER BY distance
        `).all(embedding, limit + 1) as Array<{ chunk_id: string; distance: number }>;

        const neighborScores = new Map<string, number>();
        const neighborIds: string[] = [];
        for (const neighbor of neighborRows) {
            if (neighbor.chunk_id === chunkId) continue;
            neighborIds.push(neighbor.chunk_id);
            neighborScores.set(neighbor.chunk_id, 1 / (1 + (neighbor.distance ?? 0)));
        }

        const rows = this.fetchChunkRows(db, [chunkId, ...neighborIds]);
        const points: VisualizationPoint[] = [
            ...this.buildVisualizationFromIds(rows, [chunkId], 'focus', new Map([[chunkId, 1]])),
            ...this.buildVisualizationFromIds(rows, neighborIds, 'neighbor', neighborScores)
        ];

        const center = { x: baseRow.x ?? 0, y: baseRow.y ?? 0 };
        return { points, center, focusId: chunkId };
    }

    private normalizeEmbedding(embedding: Float32Array | Buffer | number[] | null | undefined): Float32Array | null {
        if (!embedding) return null;
        if (embedding instanceof Float32Array) return embedding;
        if (Array.isArray(embedding)) return new Float32Array(embedding);
        if (Buffer.isBuffer(embedding)) {
            return new Float32Array(embedding.buffer, embedding.byteOffset, Math.floor(embedding.byteLength / 4));
        }
        return null;
    }

    private parseHeadingHierarchy(raw: string): string {
        if (!raw) return '';
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return parsed.filter(Boolean).join(' > ');
            }
        } catch {
            return raw;
        }
        return raw;
    }

    private extractKeywords(content: string, max: number = 3): string[] {
        if (!content) return [];
        const stopwords = new Set([
            'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you', 'are',
            'was', 'were', 'have', 'has', 'had', 'not', 'but', 'can', 'will', 'all', 'any',
            'its', 'our', 'they', 'their', 'them', 'using', 'use', 'used', 'over', 'more',
            'also', 'such', 'than', 'then', 'when', 'what', 'where', 'which', 'who', 'how'
        ]);
        const tokens = (content.toLowerCase().match(/[a-z0-9]{3,}/g) || [])
            .filter(token => !stopwords.has(token));
        const counts = new Map<string, number>();
        for (const token of tokens) {
            counts.set(token, (counts.get(token) || 0) + 1);
        }
        return Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, max)
            .map(([token]) => token);
    }

    private fetchChunkRows(db: Database.Database, ids: string[]): Map<string, {
        chunk_id: string;
        x: number | null;
        y: number | null;
        url: string;
        section: string;
        heading_hierarchy: string;
        chunk_index: number;
        total_chunks: number;
        content: string;
    }> {
        const map = new Map<string, any>();
        if (ids.length === 0) return map;
        const placeholders = ids.map(() => '?').join(',');
        const rows = db.prepare(`
            SELECT
                vec_items.chunk_id,
                vec_items.url,
                vec_items.section,
                vec_items.heading_hierarchy,
                vec_items.chunk_index,
                vec_items.total_chunks,
                vec_items.content,
                chunk_coords.x,
                chunk_coords.y,
                files.display_path
            FROM vec_items
            LEFT JOIN chunk_coords ON chunk_coords.chunk_id = vec_items.chunk_id
            LEFT JOIN files ON files.source_url = vec_items.url
            WHERE vec_items.chunk_id IN (${placeholders})
        `).all(...ids) as Array<any>;

        rows.forEach(row => {
            map.set(row.chunk_id, row);
        });

        return map;
    }

    private buildVisualizationFromIds(
        rows: Map<string, any>,
        ids: string[],
        type: VisualizationPoint['type'],
        scoreMap?: Map<string, number | null>
    ): VisualizationPoint[] {
        const points: VisualizationPoint[] = [];
        for (const id of ids) {
            const row = rows.get(id);
            if (!row) continue;
            points.push(this.makeVisualizationPoint(row, type, scoreMap?.get(id) ?? null));
        }
        return points;
    }

    private makeVisualizationPoint(
        row: {
            chunk_id: string;
            x: number | null;
            y: number | null;
            url: string;
            display_path?: string;
            section: string;
            heading_hierarchy: string;
            chunk_index: number;
            total_chunks: number;
            content: string;
        },
        type: VisualizationPoint['type'],
        score: number | null
    ): VisualizationPoint {
        return {
            id: row.chunk_id,
            x: row.x ?? 0,
            y: row.y ?? 0,
            score,
            type,
            url: row.url,
            displayPath: row.display_path || row.url,
            section: row.section,
            heading_hierarchy: this.parseHeadingHierarchy(row.heading_hierarchy),
            chunk_index: Number(row.chunk_index),
            total_chunks: Number(row.total_chunks),
            keywords: this.extractKeywords(row.content)
        };
    }
}
