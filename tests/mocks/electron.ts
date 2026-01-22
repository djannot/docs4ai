import * as fs from 'fs';
import * as path from 'path';

const workerId = process.env.JEST_WORKER_ID || '0';
const userDataDir = path.join(process.cwd(), 'tests', `electron-user-data-${workerId}`);
fs.mkdirSync(userDataDir, { recursive: true });

export const app = {
  getPath: (_name: string) => userDataDir,
  isPackaged: false,
  resourcesPath: userDataDir
};

export default { app };
