// Test setup file
import * as fs from 'fs';
import * as path from 'path';

const workerId = process.env.JEST_WORKER_ID || '0';
process.env.DOCS4AI_SKIP_MODEL_DOWNLOAD = '1';

const MOCK_EMBEDDING_DIMENSION = 1024;

class MockLlamaChatSession {
  setChatHistory() {}
  async prompt() {
    return 'mock response';
  }
  async dispose() {}
}

const mockNodeLlama = {
  getLlama: async () => ({
    loadModel: async () => ({
      createEmbeddingContext: async () => ({
        getEmbeddingFor: async () => ({ vector: new Float32Array(MOCK_EMBEDDING_DIMENSION) }),
        dispose: async () => {}
      }),
      createContext: async () => ({
        getSequence: () => ({}),
        dispose: async () => {}
      }),
      tokenize: (text: string) => text.split(/\s+/).filter(Boolean),
      dispose: async () => {}
    })
  }),
  LlamaChatSession: MockLlamaChatSession,
  defineChatSessionFunction: (definition: any) => definition
};

(globalThis as any).__docs4aiNodeLlamaMock = mockNodeLlama;

// Clean up any leftover test directories
const testDirs = [
  path.join(__dirname, `temp-${workerId}`),
  path.join(__dirname, `test-dbs-${workerId}`),
  path.join(__dirname, `electron-user-data-${workerId}`),
];

testDirs.forEach(dir => {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
});

// Cleanup after all tests
afterAll(() => {
  testDirs.forEach(dir => {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
