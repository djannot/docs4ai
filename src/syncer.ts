import chokidar from 'chokidar';
import * as path from 'path';
import * as fs from 'fs';

export interface SyncerOptions {
    recursive: boolean;
    extensions: string[];
    onFileAdd: (filePath: string) => Promise<void>;
    onFileChange: (filePath: string) => Promise<void>;
    onFileDelete: (filePath: string) => Promise<void>;
}

export class FolderSyncer {
    private fsWatcher: chokidar.FSWatcher | null = null;
    private folderPath: string;
    private options: SyncerOptions;
    private _isSyncing = false;

    constructor(folderPath: string, options: SyncerOptions) {
        this.folderPath = folderPath;
        this.options = options;
    }

    get isSyncing(): boolean {
        return this._isSyncing;
    }

    start() {
        if (this._isSyncing) return;

        const globPattern = this.options.recursive 
            ? path.join(this.folderPath, '**', '*')
            : path.join(this.folderPath, '*');

        this.fsWatcher = chokidar.watch(globPattern, {
            ignored: /(^|[\/\\])\../, // ignore dotfiles
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100
            }
        });

        this.fsWatcher
            .on('add', async (filePath: string) => {
                if (this.shouldProcess(filePath)) {
                    console.log(`File added: ${filePath}`);
                    await this.options.onFileAdd(filePath);
                }
            })
            .on('change', async (filePath: string) => {
                if (this.shouldProcess(filePath)) {
                    console.log(`File changed: ${filePath}`);
                    await this.options.onFileChange(filePath);
                }
            })
            .on('unlink', async (filePath: string) => {
                // For delete events, only check extension (file no longer exists)
                if (this.hasValidExtension(filePath)) {
                    console.log(`File deleted: ${filePath}`);
                    await this.options.onFileDelete(filePath);
                }
            })
            .on('error', (error: Error) => {
                console.error('Syncer error:', error);
            });

        this._isSyncing = true;
        console.log(`Started syncing: ${this.folderPath}`);
    }

    stop() {
        if (this.fsWatcher) {
            this.fsWatcher.close();
            this.fsWatcher = null;
        }
        this._isSyncing = false;
        console.log('Stopped syncing');
    }

    private shouldProcess(filePath: string): boolean {
        // Check if it's a file (not directory)
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) return false;
        } catch {
            return false;
        }

        return this.hasValidExtension(filePath);
    }
    
    private hasValidExtension(filePath: string): boolean {
        // Check extension
        if (this.options.extensions.length === 0) return true;
        
        const ext = path.extname(filePath).toLowerCase();
        return this.options.extensions.includes(ext);
    }

    getSyncedFiles(): string[] {
        const files: string[] = [];
        
        const walkDir = (dir: string) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                
                for (const entry of entries) {
                    if (entry.name.startsWith('.')) continue;
                    
                    const fullPath = path.join(dir, entry.name);
                    
                    if (entry.isDirectory() && this.options.recursive) {
                        walkDir(fullPath);
                    } else if (entry.isFile() && this.shouldProcess(fullPath)) {
                        files.push(fullPath);
                    }
                }
            } catch (error) {
                console.error(`Error reading directory ${dir}:`, error);
            }
        };

        walkDir(this.folderPath);
        return files;
    }
}
