import * as fs from 'fs';
import * as path from 'path';
import { FolderSyncer } from '../src/syncer';
import { createTempDir, waitFor } from './helpers';

describe('FolderSyncer', () => {
  it('collects files with recursion and extensions', () => {
    const root = createTempDir('syncer-root');
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested, { recursive: true });

    const rootFile = path.join(root, 'root.md');
    const nestedFile = path.join(nested, 'nested.txt');
    const ignoredFile = path.join(nested, 'image.png');

    fs.writeFileSync(rootFile, 'root');
    fs.writeFileSync(nestedFile, 'nested');
    fs.writeFileSync(ignoredFile, 'binary');

    const nonRecursive = new FolderSyncer(root, {
      recursive: false,
      extensions: ['.md', '.txt'],
      onFileAdd: async () => {},
      onFileChange: async () => {},
      onFileDelete: async () => {},
    });

    const recursive = new FolderSyncer(root, {
      recursive: true,
      extensions: ['.md', '.txt'],
      onFileAdd: async () => {},
      onFileChange: async () => {},
      onFileDelete: async () => {},
    });

    const nonRecursiveFiles = nonRecursive.getSyncedFiles();
    const recursiveFiles = recursive.getSyncedFiles();

    expect(nonRecursiveFiles).toEqual([rootFile]);
    expect(recursiveFiles.sort()).toEqual([nestedFile, rootFile].sort());
  });

  it('emits add, change, and delete events', async () => {
    const root = createTempDir('syncer-events');
    const events: { add: string[]; change: string[]; remove: string[] } = {
      add: [],
      change: [],
      remove: [],
    };

    const syncer = new FolderSyncer(root, {
      recursive: false,
      extensions: ['.md'],
      onFileAdd: async (filePath: string) => {
        events.add.push(filePath);
      },
      onFileChange: async (filePath: string) => {
        events.change.push(filePath);
      },
      onFileDelete: async (filePath: string) => {
        events.remove.push(filePath);
      },
    });

    syncer.start();

    await new Promise(resolve => setTimeout(resolve, 300));

    const filePath = path.join(root, 'notes.md');
    fs.writeFileSync(filePath, 'hello');
    await waitFor(() => events.add.includes(filePath));

    fs.writeFileSync(filePath, 'hello world');
    await waitFor(() => events.change.includes(filePath));

    const renamedPath = path.join(root, 'renamed.md');
    fs.renameSync(filePath, renamedPath);
    await waitFor(() => events.remove.includes(filePath));
    await waitFor(() => events.add.includes(renamedPath));

    const ignoredPath = path.join(root, 'ignored.png');
    fs.writeFileSync(ignoredPath, 'binary');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(events.add).not.toContain(ignoredPath);

    fs.unlinkSync(renamedPath);
    await waitFor(() => events.remove.includes(renamedPath));

    await syncer.stop();
  });
});
