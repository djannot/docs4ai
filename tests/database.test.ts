import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { DatabaseManager } from '../src/database';
import { ContentProcessor } from '../src/processor';
import { OPENAI_EMBEDDING_DIMENSION } from '../src/embeddings';
import { createTestDbPath } from './helpers';

describe('DatabaseManager', () => {
  it('persists data across reopen', () => {
    const dbPath = createTestDbPath('persist');
    const processor = new ContentProcessor();
    const content = `# Title\n\n${new Array(200).fill('token').join(' ')}`;
    const chunks = processor.chunkContent(content, dbPath);

    const db = new DatabaseManager(dbPath, 3);
    const embedding = [0.1, 0.2, 0.3];
    db.insertChunk(chunks[0], embedding);
    db.close();

    const reopened = new DatabaseManager(dbPath, 3);
    expect(reopened.getTotalChunksCount()).toBe(1);
    const storedChunks = reopened.getChunksForFile(dbPath);
    expect(storedChunks.length).toBe(1);
    reopened.close();
  });

  it('uses existing embedding dimension from metadata', () => {
    const dbPath = createTestDbPath('dimension');
    const db = new DatabaseManager(dbPath, 3);
    db.close();

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const reopened = new DatabaseManager(dbPath, 7);
    warnSpy.mockRestore();
    expect(reopened.getEmbeddingDimension()).toBe(3);
    reopened.close();
  });

  it('falls back to OpenAI dimension when metadata is missing', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const dbPath = createTestDbPath('legacy');
    const legacy = new Database(dbPath);
    sqliteVec.load(legacy);
    legacy.exec(`
      CREATE VIRTUAL TABLE vec_items USING vec0(
        embedding FLOAT[${OPENAI_EMBEDDING_DIMENSION}],
        heading_hierarchy TEXT,
        section TEXT,
        chunk_id TEXT UNIQUE,
        content TEXT,
        url TEXT,
        hash TEXT,
        chunk_index INTEGER,
        total_chunks INTEGER
      );
    `);
    legacy.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        hash TEXT,
        modified_at TEXT,
        chunk_count INTEGER
      );
    `);
    legacy.prepare(`
      INSERT INTO vec_items (embedding, heading_hierarchy, section, chunk_id, content, url, hash, chunk_index, total_chunks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Float32Array(OPENAI_EMBEDDING_DIMENSION).fill(0),
      '[]',
      'Intro',
      'legacy-chunk',
      'Legacy content',
      'file:///legacy.txt',
      'legacy-hash',
      BigInt(0),
      BigInt(1)
    );
    legacy.close();

    const reopened = new DatabaseManager(dbPath, 5);
    expect(reopened.getEmbeddingDimension()).toBe(OPENAI_EMBEDDING_DIMENSION);
    reopened.close();
    warnSpy.mockRestore();
  });

  it('updates file info without duplicating tracked counts', () => {
    const dbPath = createTestDbPath('file-info');
    const db = new DatabaseManager(dbPath, 3);
    const filePath = '/tmp/example.txt';
    const firstHash = 'hash-1';

    db.upsertFileInfo(filePath, firstHash, new Date('2024-01-01T00:00:00Z'), 2);
    expect(db.getTrackedFilesCount()).toBe(1);

    db.upsertFileInfo(filePath, firstHash, new Date('2024-01-02T00:00:00Z'), 2);
    expect(db.getTrackedFilesCount()).toBe(1);

    const info = db.getFileInfo(filePath);
    expect(info?.hash).toBe(firstHash);
    db.close();
  });
});
