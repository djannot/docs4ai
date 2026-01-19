import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import Store from 'electron-store';
import { FolderSyncer } from './syncer';
import { DatabaseManager } from './database';
import { ContentProcessor } from './processor';
import { EmbeddingService, InvalidApiKeyError } from './embeddings';
import { McpServer } from './mcp-server';

interface ProfileSettings {
    id: string;
    name: string;
    watchedFolder: string;
    databasePath: string;
    openAIApiKey: string;
    fileExtensions: string;
    recursive: boolean;
    mcpServerEnabled: boolean;
    mcpServerPort: number;
}

interface AppSettings {
    profiles: ProfileSettings[];
    activeProfileId: string | null;
}

interface ProfileState {
    syncer: FolderSyncer | null;
    database: DatabaseManager | null;
    processor: ContentProcessor | null;
    embeddingService: EmbeddingService | null;
    mcpServer: McpServer | null;
    status: 'idle' | 'syncing' | 'processing';
    processedCount: number;
    totalChunks: number;
}

// Store for persistent settings
const store = new Store<AppSettings>({
    defaults: {
        profiles: [],
        activeProfileId: null
    }
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let profileStates: Map<string, ProfileState> = new Map();
let isQuitting = false;
let syncCancelled: Map<string, boolean> = new Map();

// Track which ports are in use by which profiles
const portUsage: Map<number, string> = new Map(); // port -> profileId

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
        // On macOS and Linux, hide to tray instead of closing
        if ((process.platform === 'darwin' || process.platform === 'linux') && !isQuitting) {
            event.preventDefault();
            mainWindow?.hide();
        }
    });
}

// Create tray icons for different states
function createTrayIcon(state: 'idle' | 'syncing' | 'processing'): Electron.NativeImage {
    // Linux typically uses 22px, macOS uses 22px, Windows uses 16px
    const size = process.platform === 'win32' ? 16 : 22;
    const canvas = Buffer.alloc(size * size * 4);
    
    // Fill with transparent background
    for (let i = 0; i < canvas.length; i += 4) {
        canvas[i] = 0;     // R
        canvas[i + 1] = 0; // G
        canvas[i + 2] = 0; // B
        canvas[i + 3] = 0; // A (transparent)
    }
    
    // Status colors - brighter for Linux visibility
    let statusColor = { r: 150, g: 150, b: 150 }; // Light gray for idle
    if (state === 'syncing') {
        statusColor = { r: 52, g: 199, b: 89 }; // Green
    } else if (state === 'processing') {
        statusColor = { r: 255, g: 149, b: 0 }; // Orange
    }
    
    // Draw a simple, visible document icon
    // For better visibility on Linux, make it simpler and brighter
    const docX = size * 0.2;
    const docY = size * 0.15;
    const docW = size * 0.6;
    const docH = size * 0.7;
    
    // Draw document background (white/light)
    for (let y = Math.floor(docY); y < Math.floor(docY + docH); y++) {
        for (let x = Math.floor(docX); x < Math.floor(docX + docW); x++) {
            if (x >= 0 && x < size && y >= 0 && y < size) {
                const idx = (y * size + x) * 4;
                // White document
                canvas[idx] = 255;
                canvas[idx + 1] = 255;
                canvas[idx + 2] = 255;
                canvas[idx + 3] = 255;
            }
        }
    }
    
    // Draw document border (darker)
    const borderColor = { r: 100, g: 100, b: 100 };
    for (let y = Math.floor(docY); y < Math.floor(docY + docH); y++) {
        for (let x = Math.floor(docX); x < Math.floor(docX + docW); x++) {
            if (x >= 0 && x < size && y >= 0 && y < size) {
                const onBorder = (x === Math.floor(docX) || x === Math.floor(docX + docW) - 1 ||
                                 y === Math.floor(docY) || y === Math.floor(docY + docH) - 1);
                if (onBorder) {
                    const idx = (y * size + x) * 4;
                    canvas[idx] = borderColor.r;
                    canvas[idx + 1] = borderColor.g;
                    canvas[idx + 2] = borderColor.b;
                    canvas[idx + 3] = 255;
                }
            }
        }
    }
    
    // Draw status indicator dot (bottom right, larger for visibility)
    const dotX = Math.floor(docX + docW * 0.7);
    const dotY = Math.floor(docY + docH * 0.8);
    const dotRadius = process.platform === 'linux' ? 4 : 3; // Larger on Linux
    
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

function getOverallStatus(): { state: 'idle' | 'syncing' | 'processing', totalFiles: number, totalChunks: number, syncingCount: number } {
    let state: 'idle' | 'syncing' | 'processing' = 'idle';
    let totalFiles = 0;
    let totalChunks = 0;
    let syncingCount = 0;
    
    for (const profileState of profileStates.values()) {
        totalFiles += profileState.processedCount;
        totalChunks += profileState.totalChunks;
        if (profileState.syncer?.isSyncing) {
            syncingCount++;
            if (profileState.status === 'processing') {
                state = 'processing';
            } else if (state !== 'processing') {
                state = 'syncing';
            }
        }
    }
    
    return { state, totalFiles, totalChunks, syncingCount };
}

function updateTray() {
    if (!tray) return;
    
    const overall = getOverallStatus();
    const state = overall.state;
    const appSettings = store.store;
    const activeProfile = appSettings.profiles?.find(p => p.id === appSettings.activeProfileId);
    
    tray.setImage(createTrayIcon(state));
    
    // Build tooltip with profile info
    let tooltip = 'Docs4ai';
    if (activeProfile) {
        tooltip += ` - ${activeProfile.name}`;
    }
    if (overall.state === 'processing') {
        tooltip += ' - Processing...';
    } else if (overall.syncingCount > 0) {
        tooltip += ` - ${overall.syncingCount} profile(s) syncing`;
    } else {
        tooltip += ' - Not syncing';
    }
    tray.setToolTip(tooltip);
    
    // Build context menu with profile information
    const menuItems: Electron.MenuItemConstructorOptions[] = [];
    
    // Active profile info
    if (activeProfile) {
        menuItems.push({
            label: `Active: ${activeProfile.name}`,
            enabled: false
        });
    }
    
    // Overall status
    menuItems.push({
        label: overall.syncingCount > 0 ? `● ${overall.syncingCount} profile(s) syncing` : '○ Not syncing',
        enabled: false
    });
    
    menuItems.push({
        label: `Files: ${overall.totalFiles} | Chunks: ${overall.totalChunks}`,
        enabled: false
    });
    
    // Profile list with status
    if (appSettings.profiles && appSettings.profiles.length > 0) {
        menuItems.push({ type: 'separator' });
        menuItems.push({
            label: 'Profiles:',
            enabled: false
        });
        
        for (const profile of appSettings.profiles) {
            const profileState = profileStates.get(profile.id);
            const isSyncing = profileState?.syncer?.isSyncing ?? false;
            const isActive = profile.id === appSettings.activeProfileId;
            const prefix = isActive ? '→ ' : (isSyncing ? '● ' : '○ ');
            
            menuItems.push({
                label: `${prefix}${profile.name}${isSyncing ? ` (${profileState?.processedCount || 0} files)` : ''}`,
                enabled: true,
                click: () => {
                    if (mainWindow) {
                        mainWindow.show();
                        // Send message to renderer to switch profile
                        mainWindow.webContents.send('switch-profile', profile.id);
                    }
                }
            });
        }
    }
    
    menuItems.push({ type: 'separator' });
    menuItems.push({ label: 'Show Docs4ai', click: () => mainWindow?.show() });
    menuItems.push({ type: 'separator' });
    menuItems.push({ label: 'Quit', click: () => app.quit() });
    
    const contextMenu = Menu.buildFromTemplate(menuItems);
    tray.setContextMenu(contextMenu);
}

function createTray() {
    try {
        // Try to use the icon file first, fallback to generated icon
        let iconImage: Electron.NativeImage;
        const iconPath = path.join(__dirname, '..', 'assets', 'icon.svg');
        try {
            iconImage = nativeImage.createFromPath(iconPath);
            // If SVG doesn't work, try to resize the generated icon
            if (iconImage.isEmpty()) {
                throw new Error('SVG icon empty, using generated icon');
            }
            // Resize to appropriate size for tray
            const size = process.platform === 'win32' ? 16 : 22;
            iconImage = iconImage.resize({ width: size, height: size });
        } catch (error) {
            console.log('Could not load icon file, using generated icon:', error);
            iconImage = createTrayIcon('idle');
        }
        
        tray = new Tray(iconImage);
        
        // Set tooltip
        tray.setToolTip('Docs4ai');
        
        // Update with current status
        updateTray();
        
        // Handle click events
        // On Linux, left-click typically shows the context menu, right-click also shows menu
        // We'll handle both click and right-click
        tray.on('click', () => {
            // On Linux, click might show menu, but we can also show window
            if (mainWindow) {
                if (mainWindow.isVisible()) {
                    mainWindow.hide();
                } else {
                    mainWindow.show();
                }
            }
        });
        
        // Also handle right-click (though context menu is usually shown automatically)
        tray.on('right-click', () => {
            // Context menu is set in updateTray(), this is just for showing window if needed
            mainWindow?.show();
        });
        
        console.log('Tray icon created successfully on', process.platform);
        
        // On Linux/GNOME, tray icons may be hidden by default
        if (process.platform === 'linux') {
            const desktopEnv = process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '';
            if (desktopEnv.toLowerCase().includes('gnome')) {
                console.log('NOTE: On GNOME, tray icons may be hidden by default.');
                console.log('To enable tray icons, install a GNOME extension like:');
                console.log('  - "AppIndicator and KStatusNotifierItem Support"');
                console.log('  - "Tray Icons: Reloaded"');
                console.log('Then enable it in GNOME Extensions app.');
            }
        }
    } catch (error) {
        console.error('Error creating tray:', error);
        // Try with generated icon as fallback
        try {
            tray = new Tray(createTrayIcon('idle'));
            updateTray();
            tray.on('click', () => {
                mainWindow?.show();
            });
            console.log('Tray created with fallback icon');
        } catch (fallbackError) {
            console.error('Failed to create tray even with fallback:', fallbackError);
        }
    }
}

// IPC Handlers
function setupIpcHandlers() {
    // Get all profiles
    ipcMain.handle('get-profiles', () => {
        const appSettings = store.store;
        return {
            profiles: appSettings.profiles || [],
            activeProfileId: appSettings.activeProfileId || null
        };
    });

    // Get settings for a specific profile
    ipcMain.handle('get-profile-settings', (_event: IpcMainInvokeEvent, profileId: string) => {
        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);
        return profile || null;
    });

    // Create a new profile
    ipcMain.handle('create-profile', (_event: IpcMainInvokeEvent, name: string) => {
        try {
            console.log('[IPC] create-profile called with name:', name);
            const appSettings = store.store;
            console.log('[IPC] Current profiles count:', appSettings.profiles?.length || 0);
            
            // Find next available port starting from 3333
            let nextPort = 3333;
            const usedPorts = new Set((appSettings.profiles || []).map(p => p.mcpServerPort || 3333));
            while (usedPorts.has(nextPort)) {
                nextPort++;
            }
            
            const newProfile: ProfileSettings = {
                id: `profile-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                name: name || 'New Profile',
                watchedFolder: '',
                databasePath: '',
                openAIApiKey: '',
                fileExtensions: '.md,.txt,.html,.pdf,.doc,.docx',
                recursive: true,
                mcpServerEnabled: false,
                mcpServerPort: nextPort
            };
            
            console.log('[IPC] Created profile object:', newProfile);
            
            const currentProfiles = appSettings.profiles || [];
            const updatedProfiles = [...currentProfiles, newProfile];
            
            console.log('[IPC] Updating store with', updatedProfiles.length, 'profiles');
            store.set('profiles', updatedProfiles);
            
            if (!appSettings.activeProfileId) {
                console.log('[IPC] Setting active profile to:', newProfile.id);
                store.set('activeProfileId', newProfile.id);
            }
            
            // Verify it was saved
            const verifySettings = store.store;
            console.log('[IPC] Verification - profiles in store:', verifySettings.profiles?.length || 0);
            console.log('[IPC] Created profile:', newProfile.id, newProfile.name);
            
            return newProfile;
        } catch (error: any) {
            console.error('[IPC] Error creating profile:', error);
            throw error;
        }
    });

    // Delete a profile
    ipcMain.handle('delete-profile', (_event: IpcMainInvokeEvent, profileId: string) => {
        const appSettings = store.store;
        
        // Stop syncing if this profile is active
        const state = profileStates.get(profileId);
        if (state) {
            syncCancelled.set(profileId, true);
            state.syncer?.stop();
            state.database?.close();
            profileStates.delete(profileId);
            syncCancelled.delete(profileId);
        }
        
        appSettings.profiles = appSettings.profiles?.filter(p => p.id !== profileId) || [];
        
        // If we deleted the active profile, switch to first available or null
        if (appSettings.activeProfileId === profileId) {
            appSettings.activeProfileId = appSettings.profiles.length > 0 ? appSettings.profiles[0].id : null;
        }
        
        store.store = appSettings;
        sendStats();
        updateTray();
        return { success: true };
    });

    // Update profile settings
    ipcMain.handle('update-profile', async (_event: IpcMainInvokeEvent, profileId: string, updates: Partial<ProfileSettings>) => {
        const appSettings = store.store;
        const profileIndex = appSettings.profiles?.findIndex(p => p.id === profileId);
        
        if (profileIndex === undefined || profileIndex === -1) {
            return { success: false, error: 'Profile not found' };
        }
        
        appSettings.profiles![profileIndex] = {
            ...appSettings.profiles![profileIndex],
            ...updates
        };
        
        store.store = appSettings;
        
        // Update embedding service if API key changed
        const state = profileStates.get(profileId);
        if (updates.openAIApiKey && state) {
            state.embeddingService = new EmbeddingService(updates.openAIApiKey);
            // Also update MCP server for this profile if running
            if (state.mcpServer) {
                state.mcpServer.setApiKey(updates.openAIApiKey);
            }
        }
        
        // If MCP server port changed and server is running, need to restart
        if (updates.mcpServerPort !== undefined && state?.mcpServer?.isRunning()) {
            const oldPort = appSettings.profiles![profileIndex].mcpServerPort;
            const newPort = updates.mcpServerPort as number;
            if (oldPort !== newPort) {
                // Port changed - stop old server
                await state.mcpServer.stop();
                portUsage.delete(oldPort);
                state.mcpServer = null;
                appSettings.profiles![profileIndex].mcpServerEnabled = false;
            }
        }
        
        return { success: true };
    });

    // Set active profile
    ipcMain.handle('set-active-profile', (_event: IpcMainInvokeEvent, profileId: string) => {
        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);
        
        if (!profile) {
            return { success: false, error: 'Profile not found' };
        }
        
        appSettings.activeProfileId = profileId;
        store.store = appSettings;
        
        return { success: true };
    });

    // Start MCP server for a profile
    ipcMain.handle('start-mcp-server', async (_event: IpcMainInvokeEvent, profileId: string) => {
        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);
        
        if (!profile) {
            return { success: false, error: 'Profile not found' };
        }
        
        const port = profile.mcpServerPort || 3333;
        const dbPath = profile.databasePath;
        const apiKey = profile.openAIApiKey;

        if (!dbPath) {
            return { success: false, error: 'Database path not configured for this profile' };
        }

        if (!apiKey) {
            return { success: false, error: 'OpenAI API key required for MCP server' };
        }

        // Check if port is already in use by another profile
        const portOwner = portUsage.get(port);
        if (portOwner && portOwner !== profileId) {
            const otherProfile = appSettings.profiles?.find(p => p.id === portOwner);
            const otherProfileName = otherProfile?.name || 'another profile';
            return { success: false, error: `Port ${port} is already in use by profile "${otherProfileName}". Please use a different port.` };
        }

        try {
            // Get or create profile state
            let state = profileStates.get(profileId);
            if (!state) {
                state = {
                    syncer: null,
                    database: null,
                    processor: null,
                    embeddingService: null,
                    mcpServer: null,
                    status: 'idle',
                    processedCount: 0,
                    totalChunks: 0
                };
                profileStates.set(profileId, state);
            }

            // Stop existing server if running
            if (state.mcpServer?.isRunning()) {
                await state.mcpServer.stop();
                portUsage.delete(port);
            }

            // Create and start new server
            state.mcpServer = new McpServer(port);
            state.mcpServer.setDatabase(dbPath);
            state.mcpServer.setApiKey(apiKey);
            await state.mcpServer.start();
            
            // Track port usage
            portUsage.set(port, profileId);
            
            // Update profile settings
            profile.mcpServerEnabled = true;
            store.store = appSettings;
            
            return { success: true, port };
        } catch (error: any) {
            // Check if it's a port in use error
            if (error.code === 'EADDRINUSE' || error.message?.includes('EADDRINUSE') || error.message?.includes('address already in use')) {
                return { success: false, error: `Port ${port} is already in use. Please choose a different port.` };
            }
            return { success: false, error: error.message };
        }
    });

    // Stop MCP server for a profile
    ipcMain.handle('stop-mcp-server', async (_event: IpcMainInvokeEvent, profileId: string) => {
        try {
            const state = profileStates.get(profileId);
            if (state?.mcpServer) {
                const port = state.mcpServer.getPort();
                await state.mcpServer.stop();
                portUsage.delete(port);
                state.mcpServer = null;
            }
            
            const appSettings = store.store;
            const profile = appSettings.profiles?.find(p => p.id === profileId);
            if (profile) {
                profile.mcpServerEnabled = false;
                store.store = appSettings;
            }
            
            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // Get MCP server status for a profile
    ipcMain.handle('get-mcp-status', (_event: IpcMainInvokeEvent, profileId: string) => {
        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);
        const state = profileStates.get(profileId);
        
        if (!profile) {
            return { running: false, port: 3333 };
        }
        
        return {
            running: state?.mcpServer?.isRunning() ?? false,
            port: profile.mcpServerPort || 3333
        };
    });

    // Update MCP server port for a profile
    ipcMain.handle('update-mcp-port', (_event: IpcMainInvokeEvent, profileId: string, port: number) => {
        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);
        
        if (!profile) {
            return { success: false, error: 'Profile not found' };
        }
        
        // Don't check port conflicts here - allow setting the port
        // Port conflicts will be validated when starting the server
        // This allows users to change the port even if another profile is using it
        // (they'll get an error when trying to start, which is the right time to validate)
        
        const oldPort = profile.mcpServerPort;
        profile.mcpServerPort = port;
        
        // If server is running, update port tracking
        if (oldPort && portUsage.has(oldPort) && portUsage.get(oldPort) === profileId) {
            portUsage.delete(oldPort);
            // Only update port tracking if new port is not in use by another profile
            const portOwner = portUsage.get(port);
            if (!portOwner || portOwner === profileId) {
                portUsage.set(port, profileId);
            }
        }
        
        store.store = appSettings;
        return { success: true };
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

    // Get stats for a specific profile
    ipcMain.handle('get-stats', (_event: IpcMainInvokeEvent, profileId: string) => {
        const state = profileStates.get(profileId);
        if (!state) {
            return {
                isSyncing: false,
                trackedFiles: 0,
                totalChunks: 0
            };
        }
        
        return {
            isSyncing: state.syncer?.isSyncing ?? false,
            trackedFiles: state.database?.getTrackedFilesCount() ?? 0,
            totalChunks: state.database?.getTotalChunksCount() ?? 0
        };
    });

    // Get all tracked files with info for a profile
    ipcMain.handle('get-files', (_event: IpcMainInvokeEvent, profileId: string) => {
        const state = profileStates.get(profileId);
        if (!state || !state.database) return [];
        return state.database.getAllTrackedFilesWithInfo();
    });

    // Get chunks for a specific file in a profile
    ipcMain.handle('get-chunks', (_event: IpcMainInvokeEvent, profileId: string, filePath: string) => {
        const state = profileStates.get(profileId);
        if (!state || !state.database) return [];
        return state.database.getChunksForFile(filePath);
    });

    // Start watching a profile
    ipcMain.handle('start-watching', async (_event: IpcMainInvokeEvent, profileId: string) => {
        return await startWatchingInternal(profileId);
    });

    // Stop watching a profile
    ipcMain.handle('stop-watching', (_event: IpcMainInvokeEvent, profileId: string) => {
        syncCancelled.set(profileId, true);
        const state = profileStates.get(profileId);
        if (state) {
            state.syncer?.stop();
            state.syncer = null;
        }
        sendStats(profileId);
        updateTray();
        return { success: true };
    });

    // Force full sync for a profile
    ipcMain.handle('force-sync', async (_event: IpcMainInvokeEvent, profileId: string) => {
        const state = profileStates.get(profileId);
        if (!state || !state.database) {
            return { success: false, error: 'Database not initialized' };
        }

        state.database.clearAllData();
        await performInitialSync(profileId, true); // Force reprocess all
        sendStats(profileId);
        return { success: true };
    });
}

// Internal function to start watching a profile
async function startWatchingInternal(profileId: string): Promise<{ success: boolean; error?: string }> {
    const appSettings = store.store;
    const profile = appSettings.profiles?.find(p => p.id === profileId);
    
    if (!profile) {
        return { success: false, error: 'Profile not found' };
    }

    const { watchedFolder, databasePath, openAIApiKey, fileExtensions, recursive } = profile;

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
        // Get or create profile state
        let state = profileStates.get(profileId);
        if (!state) {
            state = {
                syncer: null,
                database: null,
                processor: null,
                embeddingService: null,
                mcpServer: null,
                status: 'idle',
                processedCount: 0,
                totalChunks: 0
            };
            profileStates.set(profileId, state);
        }

        // Initialize database
        if (state.database) {
            state.database.close();
        }
        state.database = new DatabaseManager(databasePath);

        // Initialize processor
        state.processor = new ContentProcessor();

        // Initialize embedding service (required for semantic search)
        state.embeddingService = new EmbeddingService(openAIApiKey);
        
        // Validate API key before starting sync
        console.log(`[${profile.name}] Validating OpenAI API key...`);
        try {
            const isValid = await state.embeddingService.validateApiKey();
            if (!isValid) {
                state.embeddingService = null;
                return { success: false, error: 'Invalid OpenAI API key' };
            }
            console.log(`[${profile.name}] API key validated successfully`);
        } catch (error: any) {
            state.embeddingService = null;
            return { success: false, error: `Failed to validate API key: ${error.message}` };
        }

        // Parse extensions
        const extensions = fileExtensions.split(',').map(e => e.trim()).filter(e => e);

        // Stop existing syncer if any
        if (state.syncer) {
            state.syncer.stop();
        }

        // Create syncer
        state.syncer = new FolderSyncer(watchedFolder, {
            recursive,
            extensions,
            onFileAdd: async (filePath) => {
                await processFile(profileId, filePath);
                sendStats(profileId);
            },
            onFileChange: async (filePath) => {
                await processFile(profileId, filePath);
                sendStats(profileId);
            },
            onFileDelete: async (filePath) => {
                state.database?.removeChunksForFile(filePath);
                state.database?.removeFileInfo(filePath);
                sendStats(profileId);
            }
        });

        state.syncer.start();

        // Reset sync cancelled flag
        syncCancelled.set(profileId, false);

        // Initial sync
        await performInitialSync(profileId);
        sendStats(profileId);
        updateTray();

        return { success: true };
    } catch (error: any) {
        console.error(`[${profile.name}] Error starting syncer:`, error);
        return { success: false, error: error.message };
    }
}

async function processFile(profileId: string, filePath: string, forceReprocess: boolean = false) {
    const state = profileStates.get(profileId);
    if (!state || !state.database || !state.processor) return;
    
    // Check if sync was cancelled
    if (syncCancelled.get(profileId)) return;

    try {
        // Check if file needs processing (incremental sync)
        if (!forceReprocess) {
            const fileInfo = state.database.getFileInfo(filePath);
            if (fileInfo) {
                // Get file's current modification time
                const fs = require('fs');
                try {
                    const stats = fs.statSync(filePath);
                    const currentModTime = stats.mtime;
                    
                    // Skip if file hasn't been modified since last sync
                    if (currentModTime <= fileInfo.modifiedAt) {
                        console.log(`[${profileId}] Skipping (unchanged): ${filePath}`);
                        return;
                    }
                } catch {
                    // File might not exist, continue processing
                }
            }
        }

        state.status = 'processing';
        updateTray();

        const content = await state.processor.readFile(filePath);
        if (!content) {
            state.status = state.syncer?.isSyncing ? 'syncing' : 'idle';
            updateTray();
            return;
        }

        // Check content hash - skip if content is identical
        const hash = state.processor.generateHash(content);
        if (!forceReprocess) {
            const fileInfo = state.database.getFileInfo(filePath);
            if (fileInfo && fileInfo.hash === hash) {
                console.log(`[${profileId}] Skipping (same hash): ${filePath}`);
                // Update modification time even if content unchanged
                state.database.upsertFileInfo(filePath, hash, new Date(), fileInfo.chunkCount);
                state.status = state.syncer?.isSyncing ? 'syncing' : 'idle';
                updateTray();
                return;
            }
        }

        const chunks = state.processor.chunkContent(content, filePath);

        // Remove old chunks
        state.database.removeChunksForFile(filePath);

        // Generate embeddings and insert chunks
        for (const chunk of chunks) {
            let embedding: number[] | null = null;

            if (state.embeddingService) {
                try {
                    embedding = await state.embeddingService.generateEmbedding(chunk.content);
                } catch (error) {
                    if (error instanceof InvalidApiKeyError) {
                        console.error(`[${profileId}] Invalid API key detected - stopping sync`);
                        handleInvalidApiKey(profileId);
                        return; // Stop processing this file
                    }
                    console.error(`[${profileId}] Error generating embedding:`, error);
                }
            }

            state.database.insertChunk(chunk, embedding);
        }

        // Update file info with current timestamp
        state.database.upsertFileInfo(filePath, hash, new Date(), chunks.length);

        console.log(`[${profileId}] Processed: ${filePath} (${chunks.length} chunks)`);
    } catch (error) {
        console.error(`[${profileId}] Error processing ${filePath}:`, error);
    } finally {
        state.status = state.syncer?.isSyncing ? 'syncing' : 'idle';
        updateTray();
    }
}

async function performInitialSync(profileId: string, forceReprocess: boolean = false) {
    const state = profileStates.get(profileId);
    if (!state || !state.syncer || !state.database) return;

    const appSettings = store.store;
    const profile = appSettings.profiles?.find(p => p.id === profileId);
    const profileName = profile?.name || profileId;

    const files = state.syncer.getSyncedFiles();
    console.log(`[${profileName}] Initial sync: ${files.length} files (force=${forceReprocess})`);

    let processed = 0;
    let skipped = 0;

    for (let i = 0; i < files.length; i++) {
        // Check if sync was cancelled
        if (syncCancelled.get(profileId)) {
            console.log(`[${profileName}] Sync cancelled`);
            break;
        }
        
        const filePath = files[i];
        
        // Check if file needs processing before logging
        const fileInfo = state.database.getFileInfo(filePath);
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
        
        console.log(`[${profileName}] Processing ${i + 1}/${files.length}: ${filePath}`);
        await processFile(profileId, filePath, forceReprocess);
        processed++;
        // Update stats after each file during initial sync
        sendStats(profileId);
    }
    
    if (!syncCancelled.get(profileId)) {
        console.log(`[${profileName}] Sync complete: ${processed} processed, ${skipped} skipped (unchanged)`);
    }
}

function sendStats(profileId?: string) {
    if (profileId) {
        // Send stats for a specific profile
        const state = profileStates.get(profileId);
        const stats = {
            profileId,
            isSyncing: state?.syncer?.isSyncing ?? false,
            trackedFiles: state?.database?.getTrackedFilesCount() ?? 0,
            totalChunks: state?.database?.getTotalChunksCount() ?? 0
        };
        
        if (state) {
            state.processedCount = stats.trackedFiles;
            state.totalChunks = stats.totalChunks;
        }
        
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.webContents.send('stats-update', stats);
            } catch (err) {
                console.error('Error sending stats:', err);
            }
        }
    } else {
        // Send stats for all profiles
        const appSettings = store.store;
        const allStats = (appSettings.profiles || []).map(profile => {
            const state = profileStates.get(profile.id);
            return {
                profileId: profile.id,
                isSyncing: state?.syncer?.isSyncing ?? false,
                trackedFiles: state?.database?.getTrackedFilesCount() ?? 0,
                totalChunks: state?.database?.getTotalChunksCount() ?? 0
            };
        });
        
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                mainWindow.webContents.send('stats-update-all', allStats);
            } catch (err) {
                console.error('Error sending stats:', err);
            }
        }
    }
    
    updateTray();
}

function handleInvalidApiKey(profileId: string) {
    // Cancel sync and stop watching
    syncCancelled.set(profileId, true);
    const state = profileStates.get(profileId);
    if (state) {
        if (state.syncer) {
            state.syncer.stop();
            state.syncer = null;
        }
        
        // Clear the embedding service
        state.embeddingService = null;
    }
    
    // Notify the UI
    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            mainWindow.webContents.send('api-key-error', {
                profileId,
                message: 'Invalid OpenAI API key. Please check your API key and try again.'
            });
            mainWindow.show(); // Bring window to front
        } catch (err) {
            console.error('Error sending API key error:', err);
        }
    }
    
    sendStats(profileId);
    updateTray();
}

app.whenReady().then(() => {
    // Prevent app from quitting when all windows are closed (for tray support on Linux/macOS)
    app.on('window-all-closed', () => {
        // On macOS and Linux, keep the app running when windows are closed (runs in tray)
        // On Windows, quit the app
        if (process.platform === 'win32') {
            app.quit();
        }
        // On Linux and macOS, don't quit - app runs in tray
    });
    
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


app.on('before-quit', async () => {
    isQuitting = true;
    console.log('Quitting app...');
    
    // Stop all syncers, close all databases, and stop all MCP servers
    for (const [profileId, state] of profileStates.entries()) {
        syncCancelled.set(profileId, true);
        state.syncer?.stop();
        state.database?.close();
        if (state.mcpServer?.isRunning()) {
            const port = state.mcpServer.getPort();
            await state.mcpServer.stop();
            portUsage.delete(port);
        }
    }
    profileStates.clear();
    syncCancelled.clear();
    portUsage.clear();
    
    tray?.destroy();
    console.log('Cleanup complete');
});
