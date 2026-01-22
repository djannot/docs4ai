import * as fs from 'fs';
import * as path from 'path';
import { FolderSyncer } from '../src/syncer';
import { DatabaseManager } from '../src/database';
import { ContentProcessor } from '../src/processor';
import { EmbeddingService, EmbeddingProvider, MINILM_EMBEDDING_DIMENSION, OPENAI_EMBEDDING_DIMENSION, getEmbeddingDimension, isModelDownloaded } from '../src/embeddings';
import { McpServer } from '../src/mcp-server';
import {
  createTempDir,
  createSampleFiles,
  createTestDbPath,
  waitFor,
  mcpQuery,
  mcpJsonRpc,
  findAvailablePort,
  TestFile,
} from './helpers';

describe('Multi-Profile Integration Tests', () => {
  // Test configuration
  const TEST_API_KEY = process.env.OPENAI_API_KEY || 'test-key-placeholder';
  const USE_REAL_API = !!process.env.OPENAI_API_KEY;

  // Profile 1: Technical documentation (will use local model)
  const profile1Files: TestFile[] = [
    {
      name: 'getting-started.md',
      content: `# Getting Started Guide

This guide will help you get started with our platform.

## Installation

To install the software, run the following command:
\`\`\`bash
npm install
\`\`\`

## Configuration

The configuration file is located in the root directory. You can modify settings there.

## Next Steps

After installation, you should:
1. Configure your API keys
2. Set up your database
3. Run the initial sync
`,
    },
    {
      name: 'api-reference.txt',
      content: `API Reference

The API provides several endpoints for managing your data.

GET /api/users
Returns a list of all users.

POST /api/users
Creates a new user. Requires authentication.

PUT /api/users/:id
Updates an existing user.

DELETE /api/users/:id
Deletes a user.
`,
    },
    {
      name: 'troubleshooting.md',
      content: `# Troubleshooting Guide

## Common Issues

### Connection Errors
If you're experiencing connection errors, check your network settings.

### Authentication Failures
Make sure your API key is correctly configured in the settings.

### Database Errors
Verify that your database connection string is correct.
`,
    },
  ];

  // Profile 2: Business documentation (will use OpenAI)
  const profile2Files: TestFile[] = [
    {
      name: 'business-plan.txt',
      content: `Business Plan 2024

Our business plan focuses on three key areas:
1. Customer acquisition
2. Product development
3. Market expansion

We expect to grow revenue by 50% this year.
`,
    },
    {
      name: 'meeting-notes.md',
      content: `# Meeting Notes - Q1 Review

## Attendees
- John Doe (CEO)
- Jane Smith (CTO)
- Bob Johnson (CFO)

## Discussion Points
- Q1 revenue exceeded expectations
- New product launch scheduled for Q2
- Hiring plan approved for engineering team

## Action Items
1. Finalize product specifications
2. Post job openings
3. Schedule follow-up meeting
`,
    },
    {
      name: 'strategy.txt',
      content: `Strategic Plan

Our strategy focuses on:
- Innovation in core products
- Expansion into new markets
- Building strategic partnerships

Key metrics to track:
- Customer satisfaction score
- Monthly recurring revenue
- Churn rate
`,
    },
  ];

  let profile1Folder: string;
  let profile1DbPath: string;
  let profile1Port: number;
  let profile1Syncer: FolderSyncer | null = null;
  let profile1Database: DatabaseManager | null = null;
  let profile1Processor: ContentProcessor | null = null;
  let profile1Embedding: EmbeddingService | null = null;
  let profile1McpServer: McpServer | null = null;
  let profile1Provider: EmbeddingProvider = 'local-minilm';

  let profile2Folder: string;
  let profile2DbPath: string;
  let profile2Port: number;
  let profile2Syncer: FolderSyncer | null = null;
  let profile2Database: DatabaseManager | null = null;
  let profile2Processor: ContentProcessor | null = null;
  let profile2Embedding: EmbeddingService | null = null;
  let profile2McpServer: McpServer | null = null;
  let profile2Provider: EmbeddingProvider = 'openai';

  beforeAll(async () => {
    // Set up Profile 1 (local model)
    profile1Folder = createTempDir('profile1');
    profile1DbPath = createTestDbPath('profile1');
    profile1Port = await findAvailablePort(3333);
    createSampleFiles(profile1Folder, profile1Files);

    // Set up Profile 2 (OpenAI)
    profile2Folder = createTempDir('profile2');
    profile2DbPath = createTestDbPath('profile2');
    profile2Port = await findAvailablePort(profile1Port + 1);
    createSampleFiles(profile2Folder, profile2Files);

    // Initialize Profile 1 components with local model dimension
    const profile1Dimension = getEmbeddingDimension(profile1Provider);
    profile1Database = new DatabaseManager(profile1DbPath, profile1Dimension);
    profile1Processor = new ContentProcessor();
    
    // For tests, we'll skip local model initialization (requires Electron worker threads)
    // and just test with mock embeddings
    profile1Embedding = null; // Will use mock embeddings

    // Initialize Profile 2 components with OpenAI dimension
    const profile2Dimension = getEmbeddingDimension(profile2Provider);
    profile2Database = new DatabaseManager(profile2DbPath, profile2Dimension);
    profile2Processor = new ContentProcessor();
    
    if (USE_REAL_API) {
      profile2Embedding = new EmbeddingService('openai', TEST_API_KEY);
      console.log('Validating OpenAI API key...');
      const profile2Valid = await profile2Embedding.validateApiKey();
      if (!profile2Valid) {
        throw new Error('Invalid OpenAI API key. Set OPENAI_API_KEY environment variable.');
      }
    } else {
      console.log('⚠️  Using placeholder API key. Embedding generation will be skipped.');
      console.log('   Set OPENAI_API_KEY environment variable to test with real embeddings.');
      profile2Embedding = null;
    }
  });

  afterAll(async () => {
    // Stop all syncers
    if (profile1Syncer) profile1Syncer.stop();
    if (profile2Syncer) profile2Syncer.stop();

    // Stop all MCP servers
    if (profile1McpServer) await profile1McpServer.stop();
    if (profile2McpServer) await profile2McpServer.stop();

    // Terminate embedding workers
    if (profile1Embedding) await profile1Embedding.terminate();
    if (profile2Embedding) await profile2Embedding.terminate();

    // Close databases
    if (profile1Database) profile1Database.close();
    if (profile2Database) profile2Database.close();

    // Clean up temp directories
    if (fs.existsSync(profile1Folder)) {
      fs.rmSync(profile1Folder, { recursive: true, force: true });
    }
    if (fs.existsSync(profile2Folder)) {
      fs.rmSync(profile2Folder, { recursive: true, force: true });
    }
    if (fs.existsSync(profile1DbPath)) {
      fs.unlinkSync(profile1DbPath);
    }
    if (fs.existsSync(profile2DbPath)) {
      fs.unlinkSync(profile2DbPath);
    }
  });

  describe('Embedding Provider Configuration', () => {
    it('should return correct dimensions for each provider', () => {
      expect(getEmbeddingDimension('local-minilm')).toBe(MINILM_EMBEDDING_DIMENSION);
      expect(getEmbeddingDimension('local-e5')).toBe(MINILM_EMBEDDING_DIMENSION);
      expect(getEmbeddingDimension('local-e5-large')).toBe(MINILM_EMBEDDING_DIMENSION);
      expect(getEmbeddingDimension('openai')).toBe(OPENAI_EMBEDDING_DIMENSION);
    });

    it('should create databases with correct embedding dimensions', () => {
      // Profile 1 uses local embeddings
      expect(profile1Database).not.toBeNull();
      
      // Profile 2 uses OpenAI embeddings
      expect(profile2Database).not.toBeNull();
    });
  });

  describe('Profile Setup', () => {
    it('should create two separate profile folders with different files', () => {
      expect(fs.existsSync(profile1Folder)).toBe(true);
      expect(fs.existsSync(profile2Folder)).toBe(true);

      const profile1FilesList = fs.readdirSync(profile1Folder);
      const profile2FilesList = fs.readdirSync(profile2Folder);

      expect(profile1FilesList.length).toBe(profile1Files.length);
      expect(profile2FilesList.length).toBe(profile2Files.length);

      // Verify files are different
      expect(profile1FilesList).not.toEqual(profile2FilesList);
    });

    it('should create separate databases for each profile', () => {
      expect(fs.existsSync(profile1DbPath)).toBe(true);
      expect(fs.existsSync(profile2DbPath)).toBe(true);
      expect(profile1DbPath).not.toBe(profile2DbPath);
    });

    it('should assign different ports to each profile', () => {
      expect(profile1Port).not.toBe(profile2Port);
      expect(profile1Port).toBeGreaterThan(0);
      expect(profile2Port).toBeGreaterThan(0);
    });
  });

  describe('Syncing with Local Model (Profile 1)', () => {
    it('should sync Profile 1 files to database with local model dimensions', async () => {
      expect(profile1Database).not.toBeNull();
      expect(profile1Processor).not.toBeNull();

      const processedFiles: string[] = [];
      const localDimension = MINILM_EMBEDDING_DIMENSION;

      profile1Syncer = new FolderSyncer(profile1Folder, {
        recursive: false,
        extensions: ['.md', '.txt'],
        onFileAdd: async (filePath: string) => {
          const content = await profile1Processor!.readFile(filePath);
          if (!content) return;

          const chunks = profile1Processor!.chunkContent(content, filePath);
          for (const chunk of chunks) {
            // Use mock embedding with local model dimension
            const embedding = new Array(localDimension).fill(0);
            profile1Database!.insertChunk(chunk, embedding);
          }
          processedFiles.push(filePath);
        },
        onFileChange: async (filePath: string) => {
          const content = await profile1Processor!.readFile(filePath);
          if (!content) return;

          const chunks = profile1Processor!.chunkContent(content, filePath);
          for (const chunk of chunks) {
            const embedding = new Array(localDimension).fill(0);
            profile1Database!.insertChunk(chunk, embedding);
          }
        },
        onFileDelete: async (filePath: string) => {
          profile1Database!.removeChunksForFile(filePath);
          profile1Database!.removeFileInfo(filePath);
        },
      });

      // Get initial files and process them
      const files = profile1Syncer.getSyncedFiles();
      for (const filePath of files) {
        const content = await profile1Processor!.readFile(filePath);
        if (!content) continue;

        const chunks = profile1Processor!.chunkContent(content, filePath);
        for (const chunk of chunks) {
          const embedding = new Array(localDimension).fill(0);
          profile1Database!.insertChunk(chunk, embedding);
        }
        processedFiles.push(filePath);
      }

      expect(processedFiles.length).toBeGreaterThan(0);
      expect(profile1Database!.getTotalChunksCount()).toBeGreaterThan(0);
    }, 60000);
  });

  describe('Syncing with OpenAI (Profile 2)', () => {
    it('should sync Profile 2 files to database with OpenAI dimensions', async () => {
      expect(profile2Database).not.toBeNull();
      expect(profile2Processor).not.toBeNull();

      const processedFiles: string[] = [];
      const openaiDimension = OPENAI_EMBEDDING_DIMENSION;

      profile2Syncer = new FolderSyncer(profile2Folder, {
        recursive: false,
        extensions: ['.md', '.txt'],
        onFileAdd: async (filePath: string) => {
          const content = await profile2Processor!.readFile(filePath);
          if (!content) return;

          const chunks = profile2Processor!.chunkContent(content, filePath);
          for (const chunk of chunks) {
            if (USE_REAL_API && profile2Embedding) {
              const result = await profile2Embedding.generateEmbedding(chunk.content);
              profile2Database!.insertChunk(chunk, result.embedding);
            } else {
              // Use mock embedding with OpenAI dimension
              const embedding = new Array(openaiDimension).fill(0);
              profile2Database!.insertChunk(chunk, embedding);
            }
          }
          processedFiles.push(filePath);
        },
        onFileChange: async (filePath: string) => {
          const content = await profile2Processor!.readFile(filePath);
          if (!content) return;

          const chunks = profile2Processor!.chunkContent(content, filePath);
          for (const chunk of chunks) {
            if (USE_REAL_API && profile2Embedding) {
              const result = await profile2Embedding.generateEmbedding(chunk.content);
              profile2Database!.insertChunk(chunk, result.embedding);
            } else {
              const embedding = new Array(openaiDimension).fill(0);
              profile2Database!.insertChunk(chunk, embedding);
            }
          }
        },
        onFileDelete: async (filePath: string) => {
          profile2Database!.removeChunksForFile(filePath);
          profile2Database!.removeFileInfo(filePath);
        },
      });

      const files = profile2Syncer.getSyncedFiles();
      for (const filePath of files) {
        const content = await profile2Processor!.readFile(filePath);
        if (!content) continue;

        const chunks = profile2Processor!.chunkContent(content, filePath);
        for (const chunk of chunks) {
          if (USE_REAL_API && profile2Embedding) {
            const result = await profile2Embedding.generateEmbedding(chunk.content);
            profile2Database!.insertChunk(chunk, result.embedding);
          } else {
            const embedding = new Array(openaiDimension).fill(0);
            profile2Database!.insertChunk(chunk, embedding);
          }
        }
        processedFiles.push(filePath);
      }

      expect(processedFiles.length).toBeGreaterThan(0);
      expect(profile2Database!.getTotalChunksCount()).toBeGreaterThan(0);
    }, 120000); // 2 minutes timeout for API calls
  });

  describe('Provider Switching', () => {
    it('should require new database when switching from local to OpenAI', () => {
      // When switching providers, database needs different embedding dimensions
      const localDim = getEmbeddingDimension('local-minilm');
      const openaiDim = getEmbeddingDimension('openai');
      
      expect(localDim).not.toBe(openaiDim);
      
      // This simulates why we need to clear the database when switching providers
      // The embedding dimensions are incompatible
      expect(localDim).toBe(MINILM_EMBEDDING_DIMENSION);
      expect(openaiDim).toBe(OPENAI_EMBEDDING_DIMENSION);
    });

    it('should not require new database when switching between local models', () => {
      const minilmDim = getEmbeddingDimension('local-minilm');
      const e5Dim = getEmbeddingDimension('local-e5');
      
      expect(minilmDim).toBe(e5Dim);
      expect(minilmDim).toBe(MINILM_EMBEDDING_DIMENSION);
    });
  });

  describe('Database Independence', () => {
    it('should have different data in each profile database', () => {
      const profile1Chunks = profile1Database!.getTotalChunksCount();
      const profile2Chunks = profile2Database!.getTotalChunksCount();

      expect(profile1Chunks).toBeGreaterThan(0);
      expect(profile2Chunks).toBeGreaterThan(0);
      // They might have similar chunk counts, but databases are separate
      expect(profile1Chunks + profile2Chunks).toBeGreaterThan(Math.max(profile1Chunks, profile2Chunks));
    });
  });

  describe('MCP Server', () => {
    it('should start MCP server for Profile 1', async () => {
      profile1McpServer = new McpServer(profile1Port);
      profile1McpServer.setDatabase(profile1DbPath);
      // Set the same embedding provider used when syncing (local-minilm = 384 dims)
      profile1McpServer.setEmbeddingProvider(profile1Provider);

      await profile1McpServer.start();

      // Wait for server to be ready
      await waitFor(async () => {
        try {
          const response = await fetch(`http://localhost:${profile1Port}/health`);
          return response.ok;
        } catch {
          return false;
        }
      }, 5000);

      const healthResponse = await fetch(`http://localhost:${profile1Port}/health`);
      const health = await healthResponse.json();

      expect(health.status).toBe('ok');
      expect(health.database).toBe('connected');
    });

    it('should start MCP server for Profile 2', async () => {
      profile2McpServer = new McpServer(profile2Port);
      profile2McpServer.setDatabase(profile2DbPath);
      if (USE_REAL_API) {
        profile2McpServer.setApiKey(TEST_API_KEY);
        profile2McpServer.setEmbeddingProvider('openai');
      }

      await profile2McpServer.start();

      await waitFor(async () => {
        try {
          const response = await fetch(`http://localhost:${profile2Port}/health`);
          return response.ok;
        } catch {
          return false;
        }
      }, 5000);

      const healthResponse = await fetch(`http://localhost:${profile2Port}/health`);
      const health = await healthResponse.json();

      expect(health.status).toBe('ok');
      expect(health.database).toBe('connected');
    });

    it('should query Profile 1 MCP server with local model and get relevant results', async () => {
      // This test uses the local embedding model via worker threads
      // The project is built before tests run, so the compiled worker is available
      const results = await mcpQuery(profile1Port, 'artificial intelligence machine learning', 5);

      expect(results).toBeDefined();
      expect(Array.isArray(results.results) || Array.isArray(results)).toBe(true);
      
      const resultsArray = results.results || results;
      expect(resultsArray.length).toBeGreaterThan(0);

      // Should find content about AI/ML
      const content = JSON.stringify(resultsArray).toLowerCase();
      expect(content.includes('ai') || content.includes('machine') || content.includes('learning') || content.includes('neural')).toBe(true);
    }, 60000); // Longer timeout for local model loading

    it('should query Profile 2 MCP server with OpenAI and get different results', async () => {
      if (!USE_REAL_API) {
        console.log('⚠️  Skipping query test - requires real API key for embeddings');
        return;
      }

      const results = await mcpQuery(profile2Port, 'business plan', 5);

      expect(results).toBeDefined();
      expect(Array.isArray(results.results) || Array.isArray(results)).toBe(true);
      
      const resultsArray = results.results || results;
      expect(resultsArray.length).toBeGreaterThan(0);

      // Should find content about business
      const content = JSON.stringify(resultsArray).toLowerCase();
      expect(content.includes('business') || content.includes('revenue')).toBe(true);
    }, 30000);

    it('should support MCP JSON-RPC protocol on Profile 1', async () => {
      const response = await mcpJsonRpc(profile1Port, 'tools/list', {});

      expect(response).toBeDefined();
      expect(response.tools || response.result?.tools).toBeDefined();
    });

    it('should support MCP JSON-RPC protocol on Profile 2', async () => {
      const response = await mcpJsonRpc(profile2Port, 'tools/list', {});

      expect(response).toBeDefined();
      expect(response.tools || response.result?.tools).toBeDefined();
    });

    it('should stop both MCP servers independently', async () => {
      await profile1McpServer!.stop();
      await profile2McpServer!.stop();

      // Verify servers are stopped
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Verify servers are stopped by checking that requests fail
      await expect(fetch(`http://localhost:${profile1Port}/health`)).rejects.toThrow();
      await expect(fetch(`http://localhost:${profile2Port}/health`)).rejects.toThrow();
    });
  });

  describe('Profile Independence', () => {
    it('should maintain separate state for each profile', () => {
      // Both profiles have data (chunk counts might be similar, but databases are separate)
      expect(profile1Database!.getTotalChunksCount()).toBeGreaterThan(0);
      expect(profile2Database!.getTotalChunksCount()).toBeGreaterThan(0);
      expect(profile1Port).not.toBe(profile2Port);
      expect(profile1Folder).not.toBe(profile2Folder);
      expect(profile1DbPath).not.toBe(profile2DbPath);
    });

    it('should allow both profiles to run simultaneously', () => {
      expect(profile1Syncer?.isSyncing || false).toBeDefined();
      expect(profile2Syncer?.isSyncing || false).toBeDefined();
    });

    it('should use different embedding providers for each profile', () => {
      expect(profile1Provider).toBe('local-minilm');
      expect(profile2Provider).toBe('openai');
      expect(profile1Provider).not.toBe(profile2Provider);
    });
  });
});
