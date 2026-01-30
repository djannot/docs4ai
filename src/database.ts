import Database from 'better-sqlite3';
import { loadSqliteVec } from './sqliteVec';
import { DocumentChunk } from './processor';
import { LOCAL_EMBEDDING_DIMENSION, OPENAI_EMBEDDING_DIMENSION } from './embeddings';

export class DatabaseManager {
    private db: Database.Database;
    private insertStmt: Database.Statement;
    private updateStmt: Database.Statement;
    private ftsInsertStmt: Database.Statement;
    private ftsDeleteStmt: Database.Statement;
    private embeddingDimension: number;
    
    // Cache counts for immediate UI feedback
    private _trackedFilesCount: number = 0;
    private _totalChunksCount: number = 0;

    constructor(dbPath: string, embeddingDimension: number = LOCAL_EMBEDDING_DIMENSION) {
        this.db = new Database(dbPath);
        this.embeddingDimension = embeddingDimension;
        loadSqliteVec(this.db);
        this.createTables();
        
        // Prepare statements for insert/update (matching doc2vec's approach)
        this.insertStmt = this.db.prepare(`
            INSERT INTO vec_items (embedding, heading_hierarchy, section, chunk_id, content, url, hash, chunk_index, total_chunks)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        this.updateStmt = this.db.prepare(`
            UPDATE vec_items SET embedding = ?, heading_hierarchy = ?, section = ?, content = ?, url = ?, hash = ?, chunk_index = ?, total_chunks = ?
            WHERE chunk_id = ?
        `);
        this.ftsInsertStmt = this.db.prepare(`
            INSERT INTO fts_chunks (content, section, heading_hierarchy, url, chunk_id)
            VALUES (?, ?, ?, ?, ?)
        `);
        this.ftsDeleteStmt = this.db.prepare('DELETE FROM fts_chunks WHERE chunk_id = ?');
        
        // Initialize counts from database
        this._trackedFilesCount = this._queryTrackedFilesCount();
        this._totalChunksCount = this._queryTotalChunksCount();
        
        console.log(`Database initialized at: ${dbPath} (embedding dimension: ${embeddingDimension})`);
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
        // Check if vec_items table already exists
        const tableExists = this.db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_items'"
        ).get();

        if (tableExists) {
            // Table exists - check if we need to recreate it with different dimensions
            // Get the current dimension from metadata or infer it
            const currentDimension = this.getCurrentEmbeddingDimension();
            
            if (currentDimension !== this.embeddingDimension) {
                console.warn(`Embedding dimension mismatch: database has ${currentDimension}, requested ${this.embeddingDimension}`);
                console.warn('Database will continue with existing dimension. To change, clear data or use a new database.');
                // Use the existing dimension to avoid data corruption
                this.embeddingDimension = currentDimension;
            }
        } else {
            // Create new vec0 virtual table with specified dimension
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(
                    embedding FLOAT[${this.embeddingDimension}],
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
        }

        const ftsRow = this.db.prepare(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='fts_chunks'"
        ).get() as { sql?: string } | undefined;
        const ftsSql = ftsRow?.sql ?? '';
        const needsFtsRebuild = ftsSql.includes("content='vec_items'");
        if (needsFtsRebuild) {
            this.db.exec('DROP TABLE IF EXISTS fts_chunks');
        }

        const ftsExists = this.db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='fts_chunks'"
        ).get();
        if (!ftsExists) {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
                    content,
                    section,
                    heading_hierarchy,
                    url,
                    chunk_id UNINDEXED
                )
            `);
            this.db.exec(`
                INSERT INTO fts_chunks (content, section, heading_hierarchy, url, chunk_id)
                SELECT content, section, heading_hierarchy, url, chunk_id FROM vec_items
            `);
        }

        // Create files tracking table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS files (
                path TEXT PRIMARY KEY,
                hash TEXT,
                modified_at TEXT,
                chunk_count INTEGER
            )
        `);

        // Create metadata table to store embedding dimension info
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        `);

        // Store embedding dimension in metadata
        this.db.prepare(`
            INSERT OR REPLACE INTO metadata (key, value) VALUES ('embedding_dimension', ?)
        `).run(String(this.embeddingDimension));

        console.log('Database tables created');
    }

    private getCurrentEmbeddingDimension(): number {
        try {
            // Try to get from metadata table
            const metadataExists = this.db.prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'"
            ).get();
            
            if (metadataExists) {
                const row = this.db.prepare(
                    "SELECT value FROM metadata WHERE key = 'embedding_dimension'"
                ).get() as { value: string } | undefined;
                
                if (row) {
                    return parseInt(row.value, 10);
                }
            }
            
            // Fallback: check for existing data and infer dimension
            // For now, default to OpenAI dimension for backward compatibility with existing databases
            const hasData = this.db.prepare('SELECT 1 FROM vec_items LIMIT 1').get();
            if (hasData) {
                // Existing database without metadata - assume OpenAI dimension
                return OPENAI_EMBEDDING_DIMENSION;
            }
            
            // No data, use the requested dimension
            return this.embeddingDimension;
        } catch {
            return this.embeddingDimension;
        }
    }

    private syncFtsEntry(chunk: DocumentChunk, headingHierarchyJson: string) {
        this.ftsDeleteStmt.run(chunk.chunkId);
        this.ftsInsertStmt.run(
            chunk.content,
            chunk.section,
            headingHierarchyJson,
            chunk.url,
            chunk.chunkId
        );
    }

    getEmbeddingDimension(): number {
        return this.embeddingDimension;
    }

    insertChunk(chunk: DocumentChunk, embedding: number[] | null) {
        const embeddingData = embedding 
            ? new Float32Array(embedding) 
            : new Float32Array(this.embeddingDimension).fill(0);
        
        // Use JSON.stringify for heading_hierarchy to match doc2vec format
        const headingHierarchyJson = JSON.stringify(chunk.headingHierarchy);

        try {
            this.insertStmt.run(
                embeddingData,
                headingHierarchyJson,
                chunk.section,
                chunk.chunkId,
                chunk.content,
                chunk.url,
                chunk.hash,
                BigInt(chunk.chunkIndex),
                BigInt(chunk.totalChunks)
            );
            this.syncFtsEntry(chunk, headingHierarchyJson);
            this._totalChunksCount++;
        } catch (error: any) {
            // If insert fails due to UNIQUE constraint, update instead
            if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.message?.includes('UNIQUE constraint failed')) {
                this.updateStmt.run(
                    embeddingData,
                    headingHierarchyJson,
                    chunk.section,
                    chunk.content,
                    chunk.url,
                    chunk.hash,
                    BigInt(chunk.chunkIndex),
                    BigInt(chunk.totalChunks),
                    chunk.chunkId
                );
                this.syncFtsEntry(chunk, headingHierarchyJson);
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
        this.db.prepare('DELETE FROM fts_chunks WHERE url = ?').run(url);
        
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
        this.db.exec('DELETE FROM fts_chunks');
        this.db.exec('DELETE FROM files');
        this._trackedFilesCount = 0;
        this._totalChunksCount = 0;
        console.log('Cleared all data');
    }

    close() {
        this.db.close();
    }
}
