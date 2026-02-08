import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';
import { DriveSyncer } from '../src/drive-syncer';
import { createTempDir } from './helpers';

function createStream(content: string) {
  const stream = new PassThrough();
  setImmediate(() => {
    stream.write(content);
    stream.end();
  });
  return stream;
}

function createDriveMock(structure: Record<string, any[]>) {
  const listCalls: any[] = [];
  const getCalls: any[] = [];
  const exportCalls: any[] = [];

  const files = {
    list: jest.fn(async (params: any) => {
      listCalls.push(params);
      const match = String(params.q || '').match(/'([^']+)' in parents/);
      const parentId = match ? match[1] : 'root';
      const filesForParent = structure[parentId] || [];
      return { data: { files: filesForParent } };
    }),
    get: jest.fn(async (params: any) => {
      getCalls.push(params);
      return { data: createStream(`file:${params.fileId}`) };
    }),
    export: jest.fn(async (params: any) => {
      exportCalls.push(params);
      return { data: createStream(`export:${params.fileId}`) };
    })
  };

  return {
    drive: { files } as any,
    listCalls,
    getCalls,
    exportCalls
  };
}

describe('DriveSyncer', () => {
  it('downloads eligible files and uses export for Google Docs', async () => {
    const rootFolder = 'root-folder';
    const childFolder = 'child-folder';
    const now = new Date().toISOString();

    const { drive, exportCalls, getCalls } = createDriveMock({
      [rootFolder]: [
        { id: 'doc1', name: 'Doc', mimeType: 'application/vnd.google-apps.document', modifiedTime: now, webViewLink: 'https://drive/doc1' },
        { id: 'pdf1', name: 'Report.pdf', mimeType: 'application/pdf', modifiedTime: now, webViewLink: 'https://drive/pdf1' },
        { id: childFolder, name: 'Sub', mimeType: 'application/vnd.google-apps.folder' }
      ],
      [childFolder]: [
        { id: 'txt1', name: 'Notes.txt', mimeType: 'text/plain', modifiedTime: now, webViewLink: 'https://drive/txt1' }
      ]
    });

    const cacheDir = createTempDir('drive-cache');
    const syncer = new DriveSyncer(drive, rootFolder, cacheDir, {
      recursive: true,
      extensions: ['.docx', '.pdf', '.txt'],
      onFileAdd: async () => {},
      onFileChange: async () => {},
      onFileDelete: async () => {}
    });

    syncer.beginSync();
    const files = await syncer.listRemoteFiles();
    expect(files).toHaveLength(3);

    const docFile = files.find(f => f.id === 'doc1');
    const pdfFile = files.find(f => f.id === 'pdf1');
    const txtFile = files.find(f => f.id === 'txt1');
    expect(docFile).toBeTruthy();
    expect(pdfFile).toBeTruthy();
    expect(txtFile).toBeTruthy();

    const docEntry = await syncer.downloadToCache(docFile!);
    const pdfEntry = await syncer.downloadToCache(pdfFile!);
    const txtEntry = await syncer.downloadToCache(txtFile!);

    expect(docEntry?.displayPath).toBe('My Drive/Doc.docx');
    expect(pdfEntry?.displayPath).toBe('My Drive/Report.pdf');
    expect(txtEntry?.displayPath).toBe('My Drive/Sub/Notes.txt');

    expect(exportCalls).toHaveLength(1);
    expect(exportCalls[0].fileId).toBe('doc1');
    expect(getCalls).toHaveLength(2);

    expect(fs.existsSync(docEntry!.localPath)).toBe(true);
    expect(fs.existsSync(pdfEntry!.localPath)).toBe(true);
    expect(fs.existsSync(txtEntry!.localPath)).toBe(true);
  });

  it('includes driveId and corpora when set for shared drives', async () => {
    const { drive, listCalls } = createDriveMock({ root: [] });
    const cacheDir = createTempDir('drive-cache');
    const syncer = new DriveSyncer(drive, 'root', cacheDir, {
      recursive: false,
      extensions: ['.pdf'],
      onFileAdd: async () => {},
      onFileChange: async () => {},
      onFileDelete: async () => {}
    });

    syncer.setDriveId('shared-drive-id');
    syncer.beginSync();
    await syncer.listRemoteFiles();

    expect(listCalls.length).toBeGreaterThan(0);
    expect(listCalls[0].driveId).toBe('shared-drive-id');
    expect(listCalls[0].corpora).toBe('drive');
  });

  it('skips download when cached file is newer than Drive modified time', async () => {
    const rootFolder = 'root-folder';
    const modifiedTime = new Date(Date.now() - 60_000).toISOString();
    const { drive, getCalls, exportCalls } = createDriveMock({
      [rootFolder]: [
        { id: 'pdf1', name: 'Report.pdf', mimeType: 'application/pdf', modifiedTime }
      ]
    });

    const cacheDir = createTempDir('drive-cache');
    const cachedPath = path.join(cacheDir, 'pdf1.pdf');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachedPath, 'cached');
    fs.utimesSync(cachedPath, Date.now() / 1000, Date.now() / 1000);

    const syncer = new DriveSyncer(drive, rootFolder, cacheDir, {
      recursive: false,
      extensions: ['.pdf'],
      onFileAdd: async () => {},
      onFileChange: async () => {},
      onFileDelete: async () => {}
    });

    syncer.beginSync();
    const files = await syncer.listRemoteFiles();
    const entry = await syncer.downloadToCache(files[0]);

    expect(entry?.localPath).toBe(cachedPath);
    expect(getCalls).toHaveLength(0);
    expect(exportCalls).toHaveLength(0);
  });
});
