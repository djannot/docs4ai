import * as fs from 'fs';
import * as path from 'path';
import { ContentProcessor } from '../src/processor';
import { DatabaseManager } from '../src/database';
import { McpServer } from '../src/mcp-server';
import { createTempDir, createTestDbPath, findAvailablePort, mcpQuery } from './helpers';

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

describe('Profile smoke flow', () => {
  it('syncs, queries, restarts, and switches databases', async () => {
    const root = createTempDir('profile');
    const filePath = path.join(root, 'guide.txt');
    fs.writeFileSync(filePath, `# Guide\n\n${new Array(200).fill('guide').join(' ')}`);

    const processor = new ContentProcessor();
    const dbPath = createTestDbPath('profile');
    const database = new DatabaseManager(dbPath, 3);

    const chunks = processor.chunkContent(fs.readFileSync(filePath, 'utf-8'), filePath);
    database.insertChunk(chunks[0], [1, 0, 0]);

    const port = await findAvailablePort(4500);
    const server = new McpServer(port);
    server.setDatabase(dbPath);
    server.setEmbeddingProvider('local');
    await server.start();

    currentEmbedding = [1, 0, 0];
    const initialResults = await mcpQuery(port, 'guide', 3);
    expect(initialResults.results.length).toBeGreaterThan(0);

    await server.stop();
    database.close();

    const reopened = new DatabaseManager(dbPath, 3);
    const restartPort = await findAvailablePort(port + 1);
    const restartServer = new McpServer(restartPort);
    restartServer.setDatabase(dbPath);
    restartServer.setEmbeddingProvider('local');
    await restartServer.start();

    const restartedResults = await mcpQuery(restartPort, 'guide', 3);
    expect(restartedResults.results.length).toBeGreaterThan(0);

    await restartServer.stop();
    reopened.close();

    const newDbPath = createTestDbPath('profile-openai');
    const switchedDb = new DatabaseManager(newDbPath, 5);
    expect(switchedDb.getTotalChunksCount()).toBe(0);
    switchedDb.close();
  });
});
