import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from '../src/database';
import { ContentProcessor } from '../src/processor';
import { McpServer } from '../src/mcp-server';
import { createTempDir, createTestDbPath, findAvailablePort, mcpJsonRpc, mcpQuery } from './helpers';

let currentEmbedding: number[] = [1, 0, 0];

jest.mock('../src/embeddings', () => {
  const actual = jest.requireActual('../src/embeddings');
  return {
    ...actual,
    EmbeddingService: class MockEmbeddingService {
      private provider: string;
      constructor(provider: string = 'local') {
        this.provider = provider;
      }
      async validateApiKey() {
        return true;
      }
      async generateEmbedding() {
        return { embedding: currentEmbedding, tokens: 5 };
      }
      getProvider() {
        return this.provider;
      }
      async terminate() {}
    }
  };
});

describe('McpServer', () => {
  let dbPath: string;
  let server: McpServer;
  let port: number;
  let processor: ContentProcessor;
  let database: DatabaseManager;
  let fileA: string;
  let fileB: string;

  beforeAll(async () => {
    const root = createTempDir('mcp-server');
    fileA = path.join(root, 'alpha.txt');
    fileB = path.join(root, 'beta.txt');
    fs.writeFileSync(fileA, `# Alpha\n\n${new Array(200).fill('alpha').join(' ')}`);
    fs.writeFileSync(fileB, `# Beta\n\n${new Array(200).fill('beta').join(' ')}`);

    dbPath = createTestDbPath('mcp');
    processor = new ContentProcessor();
    database = new DatabaseManager(dbPath, 3);

    const chunkA = processor.chunkContent(fs.readFileSync(fileA, 'utf-8'), fileA)[0];
    const chunkB = processor.chunkContent(fs.readFileSync(fileB, 'utf-8'), fileB)[0];
    database.insertChunk(chunkA, [1, 0, 0]);
    database.insertChunk(chunkB, [0, 1, 0]);

    port = await findAvailablePort(4400);
    server = new McpServer(port);
    server.setDatabase(dbPath);
    server.setEmbeddingProvider('local');
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    database.close();
  });

  it('returns results with metadata and respects limits', async () => {
    currentEmbedding = [1, 0, 0];
    const results = await mcpQuery(port, 'alpha', 1);

    expect(results.count).toBe(1);
    expect(results.results[0]).toHaveProperty('chunk_id');
    expect(results.results[0]).toHaveProperty('section');
    expect(results.results[0]).toHaveProperty('url');
  });

  it('rejects empty query payloads', async () => {
    const response = await fetch(`http://localhost:${port}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(400);
  });

  it('returns JSON-RPC errors for unknown methods', async () => {
    const response = await mcpJsonRpc(port, 'unknown/method', {});
    expect(response.error?.code).toBe(-32601);
  });

  it('returns tool errors when database is missing', async () => {
    server.setDatabase(null);
    const response = await mcpJsonRpc(port, 'tools/call', {
      name: 'query_documents',
      arguments: { query: 'alpha' }
    });

    expect(response.result?.isError).toBe(true);
    server.setDatabase(dbPath);
  });
});
