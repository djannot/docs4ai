import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface TestProfile {
  id: string;
  name: string;
  folderPath: string;
  dbPath: string;
  apiKey: string;
  port: number;
}

export interface TestFile {
  name: string;
  content: string;
}

const workerId = process.env.JEST_WORKER_ID || '0';
const tempRoot = path.join(__dirname, `temp-${workerId}`);
const dbRoot = path.join(__dirname, `test-dbs-${workerId}`);

/**
 * Creates a temporary directory for testing
 */
export function createTempDir(prefix: string = 'test'): string {
  const testDir = path.join(tempRoot, `${prefix}-${randomUUID()}`);
  fs.mkdirSync(testDir, { recursive: true });
  return testDir;
}

/**
 * Creates sample text files in a directory
 */
export function createSampleFiles(dir: string, files: TestFile[]): void {
  files.forEach(file => {
    const filePath = path.join(dir, file.name);
    fs.writeFileSync(filePath, file.content, 'utf-8');
  });
}

/**
 * Creates a subdirectory with files
 */
export function createSubDirWithFiles(parentDir: string, subDirName: string, files: TestFile[]): string {
  const subDir = path.join(parentDir, subDirName);
  fs.mkdirSync(subDir, { recursive: true });
  createSampleFiles(subDir, files);
  return subDir;
}

/**
 * Creates a test database path
 */
export function createTestDbPath(profileName: string): string {
  const dbDir = dbRoot;
  fs.mkdirSync(dbDir, { recursive: true });
  return path.join(dbDir, `${profileName}-${randomUUID()}.db`);
}

/**
 * Waits for a condition to be true (supports async conditions)
 */
export function waitFor(condition: () => boolean | Promise<boolean>, timeout: number = 5000, interval: number = 100): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const startTime = Date.now();
    const check = async () => {
      const result = await condition();
      if (result) {
        resolve();
      } else if (Date.now() - startTime > timeout) {
        reject(new Error(`Timeout waiting for condition after ${timeout}ms`));
      } else {
        setTimeout(check, interval);
      }
    };
    check();
  });
}

/**
 * Makes an HTTP request to the MCP server
 */
export async function mcpQuery(port: number, query: string, limit: number = 5): Promise<any> {
  // Use Node's built-in fetch (Node 18+)
  const response = await fetch(`http://localhost:${port}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit }),
  });
  return response.json();
}

/**
 * Makes an MCP JSON-RPC request
 */
export async function mcpJsonRpc(port: number, method: string, params: any = {}): Promise<any> {
  // Use Node's built-in fetch (Node 18+)
  const response = await fetch(`http://localhost:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });
  return response.json();
}

/**
 * Checks if a port is available
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('net');
    const server = net.createServer();
    server.listen(port, () => {
      server.once('close', () => resolve(true));
      server.close();
    });
    server.on('error', () => resolve(false));
  });
}

/**
 * Finds an available port starting from a base port
 */
export async function findAvailablePort(startPort: number = 3333): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`Could not find available port starting from ${startPort}`);
}
