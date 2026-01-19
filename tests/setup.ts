// Test setup file
import * as fs from 'fs';
import * as path from 'path';

// Clean up any leftover test directories
const testDirs = [
  path.join(__dirname, 'temp'),
  path.join(__dirname, 'test-dbs'),
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
