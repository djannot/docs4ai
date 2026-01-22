// Test setup file
import * as fs from 'fs';
import * as path from 'path';

const workerId = process.env.JEST_WORKER_ID || '0';

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
