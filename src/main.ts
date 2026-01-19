import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import Store from 'electron-store';
import { FolderSyncer } from './syncer';
import { DatabaseManager } from './database';
import { ContentProcessor } from './processor';
import { EmbeddingService, InvalidApiKeyError } from './embeddings';
import { McpServer } from './mcp-server';

interface Settings {
    watchedFolder: string;
    databasePath: string;
    openAIApiKey: string;
    version: string;
    fileExtensions: string;
    recursive: boolean;
    mcpServerEnabled: boolean;
    mcpServerPort: number;
}

// Store for persistent settings
const store = new Store<Settings>({
    defaults: {
        watchedFolder: '',
        databasePath: '',
        openAIApiKey: '',
        version: '1.0.0',
        fileExtensions: '.md,.txt,.html,.pdf,.doc,.docx',
        recursive: true,
        mcpServerEnabled: false,
        mcpServerPort: 3333
    }
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let syncer: FolderSyncer | null = null;
let database: DatabaseManager | null = null;
let processor: ContentProcessor | null = null;
let embeddingService: EmbeddingService | null = null;
let mcpServer: McpServer | null = null;
let currentStatus = 'idle'; // 'idle', 'watching', 'processing'
let processedCount = 0;
let totalChunks = 0;
let isQuitting = false;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 600,
        height: 750,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        title: 'Docs4ai',
        show: false
    });

    // Load HTML from src directory (not dist)
    mainWindow.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });

    mainWindow.on('close', (event) => {
        if (process.platform === 'darwin' && !isQuitting) {
            event.preventDefault();
            mainWindow?.hide();
        }
    });
}

// Create tray icons for different states
function createTrayIcon(state: 'idle' | 'syncing' | 'processing'): Electron.NativeImage {
    const size = 22; // macOS menu bar size
    const canvas = Buffer.alloc(size * size * 4);
    
    // Status colors
    let statusColor = { r: 128, g: 128, b: 128 }; // Gray for idle
    if (state === 'syncing') {
        statusColor = { r: 52, g: 199, b: 89 }; // Green
    } else if (state === 'processing') {
        statusColor = { r: 255, g: 149, b: 0 }; // Orange
    }
    
    // Draw a document shape
    for (let y = 2; y < 20; y++) {
        for (let x = 4; x < 18; x++) {
            const idx = (y * size + x) * 4;
            
            // Folded corner area (top right)
            if (x >= 13 && y < 7 && (x - 13) + (7 - y) < 5) {
                // Folded part - lighter
                if ((x - 13) + (7 - y) === 4) {
                    canvas[idx] = 80;
                    canvas[idx + 1] = 80;
                    canvas[idx + 2] = 80;
                    canvas[idx + 3] = 255;
                }
            }
            // Document outline
            else if (y === 2 || y === 19 || x === 4 || x === 17 || (x === 13 && y < 7) || (y === 7 && x > 13)) {
                canvas[idx] = 60;
                canvas[idx + 1] = 60;
                canvas[idx + 2] = 60;
                canvas[idx + 3] = 255;
            }
            // Document fill
            else if (y > 2 && y < 19 && x > 4 && x < 17) {
                canvas[idx] = 40;
                canvas[idx + 1] = 40;
                canvas[idx + 2] = 40;
                canvas[idx + 3] = 180;
            }
        }
    }
    
    // Draw status indicator dot (bottom right)
    const dotX = 15;
    const dotY = 17;
    const dotRadius = 3;
    
    for (let dy = -dotRadius; dy <= dotRadius; dy++) {
        for (let dx = -dotRadius; dx <= dotRadius; dx++) {
            if (dx * dx + dy * dy <= dotRadius * dotRadius) {
                const px = dotX + dx;
                const py = dotY + dy;
                if (px >= 0 && px < size && py >= 0 && py < size) {
                    const idx = (py * size + px) * 4;
                    canvas[idx] = statusColor.r;
                    canvas[idx + 1] = statusColor.g;
                    canvas[idx + 2] = statusColor.b;
                    canvas[idx + 3] = 255;
                }
            }
        }
    }
    
    const icon = nativeImage.createFromBuffer(canvas, { width: size, height: size });
    if (process.platform === 'darwin') {
        icon.setTemplateImage(true);
    }
    return icon;
}

function updateTray() {
    if (!tray) return;
    
    const isSyncing = syncer?.isSyncing ?? false;
    const state = currentStatus === 'processing' ? 'processing' : (isSyncing ? 'syncing' : 'idle');
    
    tray.setImage(createTrayIcon(state));
    
    let tooltip = 'Docs4ai';
    if (currentStatus === 'processing') {
        tooltip = `Docs4ai - Processing...`;
    } else if (isSyncing) {
        tooltip = `Docs4ai - Syncing (${processedCount} files, ${totalChunks} chunks)`;
    } else {
        tooltip = 'Docs4ai - Not syncing';
    }
    tray.setToolTip(tooltip);
    
    // Update context menu
    const contextMenu = Menu.buildFromTemplate([
        { 
            label: isSyncing ? '● Syncing' : '○ Not syncing',
            enabled: false
        },
        { 
            label: `Files: ${processedCount} | Chunks: ${totalChunks}`,
            enabled: false
        },
        { type: 'separator' },
        { label: 'Show Docs4ai', click: () => mainWindow?.show() },
        { type: 'separator' },
        { 
            label: isSyncing ? 'Stop Sync' : 'Start Sync',
            click: async () => {
                if (isSyncing) {
                    syncCancelled = true;
                    syncer?.stop();
                    syncer = null;
                    sendStats();
                    updateTray();
                } else {
                    // Start watching using the same logic as IPC handler
                    await startWatchingInternal();
                }
            }
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
    ]);
    
    tray.setContextMenu(contextMenu);
}

function createTray() {
    tray = new Tray(createTrayIcon('idle'));
    updateTray();
    
    tray.on('click', () => {
        mainWindow?.show();
    });
}

// IPC Handlers
function setupIpcHandlers() {
    // Get settings
    ipcMain.handle('get-settings', () => {
        return {
            watchedFolder: store.get('watchedFolder'),
            databasePath: store.get('databasePath'),
            openAIApiKey: store.get('openAIApiKey'),
            version: store.get('version'),
            fileExtensions: store.get('fileExtensions'),
            recursive: store.get('recursive'),
            mcpServerEnabled: store.get('mcpServerEnabled'),
            mcpServerPort: store.get('mcpServerPort')
        };
    });

    // Save settings
    ipcMain.handle('save-settings', (_event: IpcMainInvokeEvent, settings: Partial<Settings>) => {
        Object.entries(settings).forEach(([key, value]) => {
            store.set(key as keyof Settings, value as any);
        });
        
        // Update embedding service if API key changed
        if (settings.openAIApiKey) {
            embeddingService = new EmbeddingService(settings.openAIApiKey);
            // Also update MCP server
            if (mcpServer) {
                mcpServer.setApiKey(settings.openAIApiKey);
            }
        }
        
        return true;
    });

    // Start MCP server
    ipcMain.handle('start-mcp-server', async () => {
        const port = store.get('mcpServerPort') as number;
        const dbPath = store.get('databasePath') as string;
        const apiKey = store.get('openAIApiKey') as string;

        if (!dbPath) {
            return { success: false, error: 'Database path not configured' };
        }

        if (!apiKey) {
            return { success: false, error: 'OpenAI API key required for MCP server' };
        }

        try {
            if (mcpServer?.isRunning()) {
                await mcpServer.stop();
            }

            mcpServer = new McpServer(port);
            mcpServer.setDatabase(dbPath);
            mcpServer.setApiKey(apiKey);
            await mcpServer.start();
            
            store.set('mcpServerEnabled', true);
            return { success: true, port };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // Stop MCP server
    ipcMain.handle('stop-mcp-server', async () => {
        try {
            if (mcpServer) {
                await mcpServer.stop();
                mcpServer = null;
            }
            store.set('mcpServerEnabled', false);
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // Get MCP server status
    ipcMain.handle('get-mcp-status', () => {
        return {
            running: mcpServer?.isRunning() ?? false,
            port: mcpServer?.getPort() ?? store.get('mcpServerPort')
        };
    });

    // Select folder
    ipcMain.handle('select-folder', async () => {
        const result = await dialog.showOpenDialog(mainWindow!, {
            properties: ['openDirectory']
        });
        
        if (!result.canceled && result.filePaths.length > 0) {
            return result.filePaths[0];
        }
        return null;
    });

    // Select database file
    ipcMain.handle('select-database', async () => {
        const result = await dialog.showSaveDialog(mainWindow!, {
            defaultPath: 'docs4ai.db',
            filters: [{ name: 'SQLite Database', extensions: ['db'] }]
        });
        
        if (!result.canceled && result.filePath) {
            return result.filePath;
        }
        return null;
    });

    // Get stats
    ipcMain.handle('get-stats', () => {
        return {
            isSyncing: syncer?.isSyncing ?? false,
            trackedFiles: database?.getTrackedFilesCount() ?? 0,
            totalChunks: database?.getTotalChunksCount() ?? 0
        };
    });

    // Get all tracked files with info
    ipcMain.handle('get-files', () => {
        if (!database) return [];
        return database.getAllTrackedFilesWithInfo();
    });

    // Get chunks for a specific file
    ipcMain.handle('get-chunks', (_event, filePath: string) => {
        if (!database) return [];
        return database.getChunksForFile(filePath);
    });

    // Start watching
    ipcMain.handle('start-watching', async () => {
        return await startWatchingInternal();
    });

    // Stop watching
    ipcMain.handle('stop-watching', () => {
        syncCancelled = true; // Cancel any running sync
        syncer?.stop();
        syncer = null;
        sendStats();
        return { success: true };
    });

    // Force full sync
    ipcMain.handle('force-sync', async () => {
        const version = store.get('version') as string;

        if (!database) {
            return { success: false, error: 'Database not initialized' };
        }

        database.clearAllData();
        await performInitialSync(version, true); // Force reprocess all
        sendStats();
        return { success: true };
    });
}

// Internal function to start watching - used by both IPC handler and tray menu
async function startWatchingInternal(): Promise<{ success: boolean; error?: string }> {
    const watchedFolder = store.get('watchedFolder') as string;
    const databasePath = store.get('databasePath') as string;
    const openAIApiKey = store.get('openAIApiKey') as string;
    const version = store.get('version') as string;
    const fileExtensions = store.get('fileExtensions') as string;
    const recursive = store.get('recursive') as boolean;

    if (!watchedFolder) {
        return { success: false, error: 'No folder selected' };
    }

    if (!databasePath) {
        return { success: false, error: 'No database path selected' };
    }

    if (!openAIApiKey) {
        return { success: false, error: 'OpenAI API key is required for generating embeddings' };
    }

    try {
        // Initialize database
        database = new DatabaseManager(databasePath);

        // Initialize processor
        processor = new ContentProcessor();

        // Initialize embedding service (required for semantic search)
        embeddingService = new EmbeddingService(openAIApiKey);
        
        // Validate API key before starting sync
        console.log('Validating OpenAI API key...');
        try {
            const isValid = await embeddingService.validateApiKey();
            if (!isValid) {
                embeddingService = null;
                return { success: false, error: 'Invalid OpenAI API key' };
            }
            console.log('API key validated successfully');
        } catch (error: any) {
            embeddingService = null;
            return { success: false, error: `Failed to validate API key: ${error.message}` };
        }

        // Parse extensions
        const extensions = fileExtensions.split(',').map(e => e.trim()).filter(e => e);

        // Create syncer
        syncer = new FolderSyncer(watchedFolder, {
            recursive,
            extensions,
            onFileAdd: async (filePath) => {
                await processFile(filePath, version);
                sendStats();
            },
            onFileChange: async (filePath) => {
                await processFile(filePath, version);
                sendStats();
            },
            onFileDelete: async (filePath) => {
                database?.removeChunksForFile(filePath);
                database?.removeFileInfo(filePath);
                sendStats();
            }
        });

        syncer.start();

        // Reset sync cancelled flag
        syncCancelled = false;

        // Initial sync
        await performInitialSync(version);
        sendStats();
        updateTray();

        return { success: true };
    } catch (error: any) {
        console.error('Error starting syncer:', error);
        return { success: false, error: error.message };
    }
}

// Flag to track if sync is in progress and should continue
let syncCancelled = false;

async function processFile(filePath: string, version: string, forceReprocess: boolean = false) {
    if (!database || !processor) return;
    
    // Check if sync was cancelled
    if (syncCancelled) return;

    try {
        // Check if file needs processing (incremental sync)
        if (!forceReprocess) {
            const fileInfo = database.getFileInfo(filePath);
            if (fileInfo) {
                // Get file's current modification time
                const fs = require('fs');
                try {
                    const stats = fs.statSync(filePath);
                    const currentModTime = stats.mtime;
                    
                    // Skip if file hasn't been modified since last sync
                    if (currentModTime <= fileInfo.modifiedAt) {
                        console.log(`Skipping (unchanged): ${filePath}`);
                        return;
                    }
                } catch {
                    // File might not exist, continue processing
                }
            }
        }

        currentStatus = 'processing';
        updateTray();

        const content = await processor.readFile(filePath);
        if (!content) {
            currentStatus = syncer?.isSyncing ? 'syncing' : 'idle';
            updateTray();
            return;
        }

        // Check content hash - skip if content is identical
        const hash = processor.generateHash(content);
        if (!forceReprocess) {
            const fileInfo = database.getFileInfo(filePath);
            if (fileInfo && fileInfo.hash === hash) {
                console.log(`Skipping (same hash): ${filePath}`);
                // Update modification time even if content unchanged
                database.upsertFileInfo(filePath, hash, new Date(), fileInfo.chunkCount);
                currentStatus = syncer?.isSyncing ? 'syncing' : 'idle';
                updateTray();
                return;
            }
        }

        const chunks = processor.chunkContent(content, filePath, version);

        // Remove old chunks
        database.removeChunksForFile(filePath);

        // Generate embeddings and insert chunks
        for (const chunk of chunks) {
            let embedding: number[] | null = null;

            if (embeddingService) {
                try {
                    embedding = await embeddingService.generateEmbedding(chunk.content);
                } catch (error) {
                    if (error instanceof InvalidApiKeyError) {
                        console.error('Invalid API key detected - stopping sync');
                        handleInvalidApiKey();
                        return; // Stop processing this file
                    }
                    console.error('Error generating embedding:', error);
                }
            }

            database.insertChunk(chunk, embedding);
        }

        // Update file info with current timestamp
        database.upsertFileInfo(filePath, hash, new Date(), chunks.length);

        console.log(`Processed: ${filePath} (${chunks.length} chunks)`);
    } catch (error) {
        console.error(`Error processing ${filePath}:`, error);
    } finally {
        currentStatus = syncer?.isSyncing ? 'syncing' : 'idle';
        updateTray();
    }
}

async function performInitialSync(version: string, forceReprocess: boolean = false) {
    if (!syncer || !database) return;

    const files = syncer.getSyncedFiles();
    console.log(`Initial sync: ${files.length} files (force=${forceReprocess})`);

    let processed = 0;
    let skipped = 0;

    for (let i = 0; i < files.length; i++) {
        // Check if sync was cancelled
        if (syncCancelled) {
            console.log('Sync cancelled');
            break;
        }
        
        const filePath = files[i];
        
        // Check if file needs processing before logging
        const fileInfo = database.getFileInfo(filePath);
        const needsProcessing = forceReprocess || !fileInfo;
        
        if (!needsProcessing && fileInfo) {
            const fs = require('fs');
            try {
                const stats = fs.statSync(filePath);
                if (stats.mtime <= fileInfo.modifiedAt) {
                    skipped++;
                    continue; // Skip unchanged files silently
                }
            } catch {
                // Process if we can't stat
            }
        }
        
        console.log(`Processing ${i + 1}/${files.length}: ${filePath}`);
        await processFile(filePath, version, forceReprocess);
        processed++;
        // Update stats after each file during initial sync
        sendStats();
    }
    
    if (!syncCancelled) {
        console.log(`Sync complete: ${processed} processed, ${skipped} skipped (unchanged)`);
    }
}

function sendStats() {
    processedCount = database?.getTrackedFilesCount() ?? 0;
    totalChunks = database?.getTotalChunksCount() ?? 0;
    
    const stats = {
        isSyncing: syncer?.isSyncing ?? false,
        trackedFiles: processedCount,
        totalChunks: totalChunks
    };
    
    console.log('Sending stats:', stats);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            mainWindow.webContents.send('stats-update', stats);
        } catch (err) {
            console.error('Error sending stats:', err);
        }
    }
    
    updateTray();
}

function handleInvalidApiKey() {
    // Cancel sync and stop watching
    syncCancelled = true;
    if (syncer) {
        syncer.stop();
        syncer = null;
    }
    
    // Clear the embedding service
    embeddingService = null;
    
    // Notify the UI
    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            mainWindow.webContents.send('api-key-error', 'Invalid OpenAI API key. Please check your API key and try again.');
            mainWindow.show(); // Bring window to front
        } catch (err) {
            console.error('Error sending API key error:', err);
        }
    }
    
    sendStats();
    updateTray();
}

app.whenReady().then(() => {
    createWindow();
    createTray();
    setupIpcHandlers();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        } else {
            mainWindow?.show();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', async () => {
    isQuitting = true;
    syncCancelled = true;
    console.log('Quitting app...');
    syncer?.stop();
    if (mcpServer?.isRunning()) {
        await mcpServer.stop();
    }
    database?.close();
    tray?.destroy();
    console.log('Cleanup complete');
});
