import * as fs from 'fs';
import * as path from 'path';
import type { drive_v3 } from 'googleapis';
import type { Syncer, SyncerOptions } from './syncer';

interface DriveExportRule {
    mimeType: string;
    extension: string;
}

interface DriveFileInfo {
    id: string;
    name: string;
    mimeType: string;
    modifiedTime?: string;
    webViewLink?: string;
    drivePath?: string;
}

interface DriveIndexEntry {
    localPath: string;
    modifiedTimeMs: number;
    sourceUrl?: string;
    displayPath?: string;
}

const GOOGLE_DOC_EXPORTS: Record<string, DriveExportRule[]> = {
    'application/vnd.google-apps.document': [
        { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', extension: '.docx' },
        { mimeType: 'application/pdf', extension: '.pdf' },
        { mimeType: 'text/plain', extension: '.txt' }
    ],
    'application/vnd.google-apps.spreadsheet': [
        { mimeType: 'text/csv', extension: '.csv' }
    ],
    'application/vnd.google-apps.presentation': [
        { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', extension: '.pptx' },
        { mimeType: 'application/pdf', extension: '.pdf' }
    ]
};

export class DriveSyncer implements Syncer {
    private drive: drive_v3.Drive;
    private folderId: string;
    private rootName = 'My Drive';
    private driveId: string | null = null;
    private options: SyncerOptions;
    private cacheDir: string;
    private pollIntervalMs = 30000;
    private pollTimer: NodeJS.Timeout | null = null;
    private fileIndex: Map<string, DriveIndexEntry> = new Map();
    private inFlightDownloads: Map<string, Promise<DriveIndexEntry>> = new Map();
    private _isSyncing = false;
    private isRefreshing = false;

    constructor(drive: drive_v3.Drive, folderId: string, cacheDir: string, options: SyncerOptions) {
        this.drive = drive;
        this.folderId = folderId;
        this.cacheDir = cacheDir;
        this.options = options;
        fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    setRootName(rootName: string) {
        this.rootName = rootName || 'My Drive';
    }

    setDriveId(driveId: string | null) {
        this.driveId = driveId || null;
    }

    get isSyncing(): boolean {
        return this._isSyncing;
    }

    beginSync() {
        if (this._isSyncing) return;
        this._isSyncing = true;
        fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    start() {
        this.startPolling();
    }

    startPolling() {
        if (this.pollTimer) return;
        if (!this._isSyncing) {
            this.beginSync();
        }
        this.refreshAndEmit().catch((error) => {
            console.error('Drive sync refresh failed:', error);
        });
        this.pollTimer = setInterval(() => {
            this.refreshAndEmit().catch((error) => {
                console.error('Drive sync refresh failed:', error);
            });
        }, this.pollIntervalMs);
    }

    async stop(): Promise<void> {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        this._isSyncing = false;
    }

    async listRemoteFiles(): Promise<DriveFileInfo[]> {
        const files = await this.fetchFiles();
        return files.filter((file) => this.resolveFile(file) !== null);
    }

    async downloadToCache(file: DriveFileInfo): Promise<DriveIndexEntry | null> {
        if (!this._isSyncing) return null;

        const resolved = this.resolveFile(file);
        if (!resolved) {
            return null;
        }

        const result = await this.ensureCachedForFile(file, resolved);
        if (result) {
            this.fileIndex.set(file.id, result);
        }
        return result;
    }

    async getSyncedFiles(): Promise<string[]> {
        console.log(`[DriveSyncer] Starting initial scan for folder ${this.folderId}`);
        const files = await this.fetchFiles();
        const nextIndex = new Map<string, DriveIndexEntry>();
        const localPaths: string[] = [];
        let eligibleCount = 0;

        for (const file of files) {
            if (!this._isSyncing) {
                break;
            }
            const resolved = this.resolveFile(file);
            if (!resolved) continue;
            eligibleCount++;

            const cached = await this.ensureCachedForFile(file, resolved);
            if (!cached) {
                continue;
            }
            nextIndex.set(file.id, cached);
            localPaths.push(cached.localPath);
        }

        this.fileIndex = nextIndex;
        console.log(`[DriveSyncer] Initial scan: ${files.length} files, ${eligibleCount} eligible`);
        return localPaths;
    }

    private async refreshAndEmit(): Promise<void> {
        if (this.isRefreshing || !this._isSyncing) return;
        this.isRefreshing = true;

        try {
            const files = await this.fetchFiles();
            const nextIndex = new Map<string, DriveIndexEntry>();
            let eligibleCount = 0;

            for (const file of files) {
                const resolved = this.resolveFile(file);
                if (!resolved) continue;
                eligibleCount++;

                const cached = await this.ensureCachedForFile(file, resolved);
                if (!cached) {
                    continue;
                }
                nextIndex.set(file.id, cached);

                const previous = this.fileIndex.get(file.id);
                if (!previous) {
                    await this.options.onFileAdd(cached.localPath, cached.sourceUrl, cached.displayPath);
                } else if (previous.modifiedTimeMs < cached.modifiedTimeMs) {
                    await this.options.onFileChange(cached.localPath, cached.sourceUrl, cached.displayPath);
                }
            }

            for (const [fileId, entry] of this.fileIndex.entries()) {
                if (!nextIndex.has(fileId)) {
                    await this.options.onFileDelete(entry.localPath);
                    if (fs.existsSync(entry.localPath)) {
                        fs.unlinkSync(entry.localPath);
                    }
                }
            }

            this.fileIndex = nextIndex;
            console.log(`[DriveSyncer] Refresh: ${files.length} files, ${eligibleCount} eligible`);
        } finally {
            this.isRefreshing = false;
        }
    }

    private resolveFile(file: DriveFileInfo): { localPath: string; exportRule?: DriveExportRule; displayPath?: string } | null {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
            return null;
        }

        let exportRule: DriveExportRule | undefined;
        if (file.mimeType.startsWith('application/vnd.google-apps.')) {
            const exportOptions = GOOGLE_DOC_EXPORTS[file.mimeType] || [];
            exportRule = exportOptions.find(option => this.hasValidExtension(option.extension));
            if (!exportRule) {
                return null;
            }
        }

        const extension = exportRule?.extension || path.extname(file.name).toLowerCase();
        if (!this.hasValidExtension(extension)) {
            return null;
        }

        const localPath = path.join(this.cacheDir, `${file.id}${extension || ''}`);
        const displayPath = this.buildDisplayPath(file, extension);
        return { localPath, exportRule, displayPath };
    }

    private hasValidExtension(extension: string): boolean {
        if (this.options.extensions.length === 0) return true;
        if (!extension) return false;
        return this.options.extensions.includes(extension);
    }

    private async ensureCachedForFile(file: DriveFileInfo, resolved: { localPath: string; exportRule?: DriveExportRule; displayPath?: string }): Promise<DriveIndexEntry | null> {
        const existing = this.inFlightDownloads.get(file.id);
        if (existing) {
            return await existing;
        }

        const downloadPromise = this.ensureCached(file, resolved);
        this.inFlightDownloads.set(file.id, downloadPromise);
        try {
            return await downloadPromise;
        } finally {
            this.inFlightDownloads.delete(file.id);
        }
    }

    private async ensureCached(file: DriveFileInfo, resolved: { localPath: string; exportRule?: DriveExportRule; displayPath?: string }): Promise<DriveIndexEntry> {
        const modifiedTimeMs = file.modifiedTime ? new Date(file.modifiedTime).getTime() : 0;
        const cached = this.fileIndex.get(file.id);
        let needsDownload = !cached || cached.modifiedTimeMs < modifiedTimeMs || !fs.existsSync(cached.localPath);
        const localPath = resolved.localPath;
        const displayPath = resolved.displayPath;

        if (!needsDownload && cached) {
            const storedPath = cached.localPath || localPath;
            if (!fs.existsSync(storedPath)) {
                needsDownload = true;
            }
        }

        if (needsDownload && fs.existsSync(localPath) && modifiedTimeMs > 0) {
            try {
                const stats = fs.statSync(localPath);
                if (stats.mtimeMs >= modifiedTimeMs) {
                    needsDownload = false;
                }
            } catch (error) {
                console.warn('Failed to stat cached Drive file:', error);
            }
        }
        const sourceUrl = this.getSourceUrl(file);

        if (needsDownload) {
            await this.downloadFile(file, localPath, resolved.exportRule?.mimeType);
            const updatedTime = modifiedTimeMs || Date.now();
            try {
                fs.utimesSync(localPath, updatedTime / 1000, updatedTime / 1000);
            } catch (error) {
                console.warn('Failed to update cached file timestamps:', error);
            }
        }

        return { localPath, modifiedTimeMs, sourceUrl, displayPath };
    }

    private async downloadFile(file: DriveFileInfo, localPath: string, exportMimeType?: string): Promise<void> {
        if (!this._isSyncing) return;
        const tempPath = `${localPath}.${Date.now()}.tmp`;
        console.log(`[DriveSyncer] Downloading ${file.name} (${file.id})`);
        const response = exportMimeType
            ? await this.withTimeout(this.drive.files.export({ fileId: file.id, mimeType: exportMimeType }, { responseType: 'stream' }), 'export')
            : await this.withTimeout(this.drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' }), 'download');

        await new Promise<void>((resolve, reject) => {
            const dest = fs.createWriteStream(tempPath);
            const stream = response.data;

            const cleanup = (error?: Error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            };

            if (!this._isSyncing) {
                stream.destroy();
                dest.close();
                cleanup();
                return;
            }

            stream.on('error', reject);
            dest.on('error', reject);
            dest.on('finish', resolve);
            stream.pipe(dest);
        });

        if (!this._isSyncing) {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
            return;
        }

        if (fs.existsSync(tempPath)) {
            fs.renameSync(tempPath, localPath);
        }
    }

    private async fetchFiles(): Promise<DriveFileInfo[]> {
        console.log(`[DriveSyncer] Listing folder ${this.folderId} (recursive=${this.options.recursive})`);
        const files: DriveFileInfo[] = [];
        await this.listFolder(this.folderId, files, this.options.recursive, this.rootName, this.driveId);
        return files;
    }

    private async listFolder(folderId: string, files: DriveFileInfo[], recursive: boolean, currentPath: string, driveId: string | null): Promise<void> {
        let pageToken: string | undefined;

        do {
            const response = await this.withTimeout(this.drive.files.list({
                q: `'${folderId}' in parents and trashed = false`,
                fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink)',
                pageToken,
                supportsAllDrives: true,
                includeItemsFromAllDrives: true,
                driveId: driveId || undefined,
                corpora: driveId ? 'drive' : undefined
            }), 'list');

            const fetched = response.data.files || [];
            for (const file of fetched) {
                if (!file.id || !file.name || !file.mimeType) continue;
                const normalized: DriveFileInfo = {
                    id: file.id,
                    name: file.name,
                    mimeType: file.mimeType,
                    modifiedTime: file.modifiedTime || undefined,
                    webViewLink: file.webViewLink || undefined,
                    drivePath: `${currentPath}/${file.name}`
                };

                if (file.mimeType === 'application/vnd.google-apps.folder') {
                    if (recursive) {
                        await this.listFolder(file.id, files, recursive, `${currentPath}/${file.name}`, driveId);
                    }
                    continue;
                }

                files.push(normalized);
            }

            pageToken = response.data.nextPageToken || undefined;
        } while (pageToken);
    }

    private async withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number = 60000): Promise<T> {
        let timeoutId: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(`Google Drive ${label} request timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        });

        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }

    private getSourceUrl(file: DriveFileInfo): string {
        if (file.webViewLink) {
            return file.webViewLink;
        }
        return `https://drive.google.com/open?id=${file.id}`;
    }

    private buildDisplayPath(file: DriveFileInfo, extension: string): string {
        const basePath = file.drivePath || file.name;
        if (!extension) {
            return basePath;
        }
        const lowerBase = basePath.toLowerCase();
        if (lowerBase.endsWith(extension)) {
            return basePath;
        }
        return `${basePath}${extension}`;
    }
}
