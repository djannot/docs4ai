import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { DocumentChunk } from './processor';

export class DatabaseManager {
    private db: Database.Database;
    private insertStmt: Database.Statement;
    private updateStmt: Database.Statement;
    
    // Cache counts for immediate UI feedback
    private _trackedFilesCount: number = 0;
    private _totalChunksCount: number = 0;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        sqliteVec.load(this.db);
        this.createTables();
        
        // Prepare statements for insert/update (matching doc2vec's approach)
        this.insertStmt = this.db.prepare(`
            INSERT INTO vec_items (embedding, version, heading_hierarchy, section, chunk_id, content, url, hash, chunk_index, total_chunks)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        this.updateStmt = this.db.prepare(`
            UPDATE vec_items SET embedding = ?, version = ?, heading_hierarchy = ?, section = ?, content = ?, url = ?, hash = ?, chunk_index = ?, total_chunks = ?
            WHERE chunk_id = ?
        `);
        
        // Initialize counts from database
        this._trackedFilesCount = this._queryTrackedFilesCount();
        this._totalChunksCount = this._queryTotalChunksCount();
        
        console.log(`Database initialized at: ${dbPath}`);
    }
    
    private _queryTrackedFilesCount(): number {
        const stmt = this.db.prepare('SELECT COUNT(*) as count FROM files');
        const row = stmt.get() as { count: number };
        return Number(row.count);
    }
    
    private _queryTotalChunksCount(): number {
        const stmt = this.db.prepare('SELECT COUNT(*) as count FROM vec_items');
        const row = stmt.get() as { count: number };
        return Number(row.count);
    }

    private createTables() {
        // Create vec0 virtual table (sqlite-vec)
        this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(
                embedding FLOAT[3072],
                version TEXT,
                heading_hierarchy TEXT,
                section TEXT,
                chunk_id TEXT UNIQUE,
                content TEXT,
                url TEXT,
                hash TEXT,
                chunk_index INTEGER,
                total_chunks INTEGER
            )
        `);

        // Create files tracking table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS files (
                path TEXT PRIMARY KEY,
                hash TEXT,
                modified_at TEXT,
                chunk_count INTEGER
            )
        `);

        console.log('Database tables created');
    }

    insertChunk(chunk: DocumentChunk, embedding: number[] | null) {
        const embeddingData = embedding ? new Float32Array(embedding) : new Float32Array(3072).fill(0);
        // Use JSON.stringify for heading_hierarchy to match doc2vec format
        const headingHierarchyJson = JSON.stringify(chunk.headingHierarchy);

        try {
            this.insertStmt.run(
                embeddingData,
                chunk.version,
                headingHierarchyJson,
                chunk.section,
                chunk.chunkId,
                chunk.content,
                chunk.url,
                chunk.hash,
                BigInt(chunk.chunkIndex),
                BigInt(chunk.totalChunks)
            );
            this._totalChunksCount++;
        } catch (error: any) {
            // If insert fails due to UNIQUE constraint, update instead
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.message?.includes('UNIQUE constraint failed')) {
                this.updateStmt.run(
                    embeddingData,
                    chunk.version,
                    headingHierarchyJson,
                    chunk.section,
                    chunk.content,
                    chunk.url,
                    chunk.hash,
                    BigInt(chunk.chunkIndex),
                    BigInt(chunk.totalChunks),
                    chunk.chunkId
                );
                // Update doesn't change count
            } else {
                throw error;
            }
        }
    }

    removeChunksForFile(filePath: string) {
        const url = `file://${filePath}`;
        // Get count before delete
        const countStmt = this.db.prepare('SELECT COUNT(*) as count FROM vec_items WHERE url = ?');
        const countRow = countStmt.get(url) as { count: number };
        const deletedCount = Number(countRow.count);
        
        const stmt = this.db.prepare('DELETE FROM vec_items WHERE url = ?');
        stmt.run(url);
        
        this._totalChunksCount -= deletedCount;
    }

    getExistingChunkHash(chunkId: string): string | null {
        const stmt = this.db.prepare('SELECT hash FROM vec_items WHERE chunk_id = ?');
        const row = stmt.get(chunkId) as { hash: string } | undefined;
        return row?.hash ?? null;
    }

    getTotalChunksCount(): number {
        return this._totalChunksCount;
    }

    upsertFileInfo(filePath: string, hash: string, modifiedAt: Date, chunkCount: number) {
        // Check if file already exists
        const checkStmt = this.db.prepare('SELECT 1 FROM files WHERE path = ?');
        const exists = checkStmt.get(filePath);
        
        const stmt = this.db.prepare(`
            INSERT OR REPLACE INTO files (path, hash, modified_at, chunk_count)
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(filePath, hash, modifiedAt.toISOString(), chunkCount);
        
        // Only increment if this is a new file
        if (!exists) {
            this._trackedFilesCount++;
        }
    }

    getFileInfo(filePath: string): { path: string; hash: string; modifiedAt: Date; chunkCount: number } | null {
        const stmt = this.db.prepare('SELECT * FROM files WHERE path = ?');
        const row = stmt.get(filePath) as any;
        if (!row) return null;
        return {
            path: row.path,
            hash: row.hash,
            modifiedAt: new Date(row.modified_at),
            chunkCount: row.chunk_count
        };
    }

    removeFileInfo(filePath: string) {
        // Check if file exists before deleting
        const checkStmt = this.db.prepare('SELECT 1 FROM files WHERE path = ?');
        const exists = checkStmt.get(filePath);
        
        const stmt = this.db.prepare('DELETE FROM files WHERE path = ?');
        stmt.run(filePath);
        
        if (exists) {
            this._trackedFilesCount--;
        }
    }

    getAllTrackedFiles(): string[] {
        const stmt = this.db.prepare('SELECT path FROM files');
        const rows = stmt.all() as { path: string }[];
        return rows.map(r => r.path);
    }

    getAllTrackedFilesWithInfo(): { path: string; chunkCount: number; modifiedAt: string }[] {
        const stmt = this.db.prepare('SELECT path, chunk_count, modified_at FROM files ORDER BY modified_at DESC');
        const rows = stmt.all() as { path: string; chunk_count: number; modified_at: string }[];
        return rows.map(r => ({
            path: r.path,
            chunkCount: r.chunk_count,
            modifiedAt: r.modified_at
        }));
    }

    getChunksForFile(filePath: string): { chunkId: string; content: string; section: string; chunkIndex: number }[] {
        const url = `file://${filePath}`;
        const stmt = this.db.prepare(`
            SELECT chunk_id, content, section, chunk_index 
            FROM vec_items 
            WHERE url = ? 
            ORDER BY chunk_index
        `);
        const rows = stmt.all(url) as { chunk_id: string; content: string; section: string; chunk_index: number }[];
        return rows.map(r => ({
            chunkId: r.chunk_id,
            content: r.content,
            section: r.section,
            chunkIndex: Number(r.chunk_index)
        }));
    }

    getTrackedFilesCount(): number {
        return this._trackedFilesCount;
    }

    clearAllData() {
        this.db.exec('DELETE FROM vec_items');
        this.db.exec('DELETE FROM files');
        this._trackedFilesCount = 0;
        this._totalChunksCount = 0;
        console.log('Cleared all data');
    }

    close() {
        this.db.close();
    }
}
