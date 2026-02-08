import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import Store from 'electron-store';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import { Worker } from 'worker_threads';
import { DriveSyncer } from './drive-syncer';
import { FolderSyncer, Syncer } from './syncer';
import { DatabaseManager } from './database';
import { ContentProcessor } from './processor';
import { EmbeddingService, InvalidApiKeyError, EmbeddingProvider, getEmbeddingDimension, LOCAL_MODELS } from './embeddings';
import { McpServer } from './mcp-server';
import { initI18n, t, changeLanguage, getCurrentLanguage, getAvailableLanguages, isInitialized } from './i18n';
import { LLMChatService, LLMProvider, ChatMessage, MCP_TOOLS, executeMcpToolCall, ToolCall } from './llm-chat';

function resolveAssetPath(...segments: string[]): string | null {
    const candidates = [
        path.join(app.getAppPath(), ...segments),
        path.join(__dirname, '..', ...segments),
        path.join(process.resourcesPath, ...segments)
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

function getAppIconPath(): string | null {
    return resolveAssetPath('assets', 'icon.png');
}

function getTrayIconPath(): string | null {
    return resolveAssetPath('assets', 'icon-tray.png') || resolveAssetPath('assets', 'icon.png');
}

// Helper to migrate old provider values to current ones
function migrateEmbeddingProvider(provider: string | undefined): EmbeddingProvider {
    // All local providers now map to 'local' (Qwen3 via llama-server)
    if (!provider || provider === 'local' || provider === 'local-minilm' ||
        provider === 'local-e5' || provider === 'local' || provider === 'local-qwen') {
        return 'local';
    }
    return provider as EmbeddingProvider;
}

interface DriveAuthResult {
    success: boolean;
    refreshToken?: string;
    email?: string;
    error?: string;
}

async function startDriveAuthFlow(clientId: string, clientSecret: string): Promise<DriveAuthResult> {
    return await new Promise((resolve) => {
        let resolved = false;
        const finish = (result: DriveAuthResult) => {
            if (resolved) return;
            resolved = true;
            resolve(result);
        };

        const server = http.createServer(async (req, res) => {
            const address = server.address();
            if (!req.url || !address) {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Invalid request');
                return;
            }
            const port = typeof address === 'string' ? 0 : address.port;
            const requestUrl = new URL(req.url, `http://127.0.0.1:${port}`);
            if (requestUrl.pathname !== '/oauth2callback') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not found');
                return;
            }

            const error = requestUrl.searchParams.get('error');
            const code = requestUrl.searchParams.get('code');
            const stateParam = requestUrl.searchParams.get('state');

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>Docs4ai</h2><p>Authorization complete. You can close this window.</p></body></html>');

            if (!code || error || stateParam !== authState) {
                server.close();
                finish({ success: false, error: error || 'Authorization failed' });
                return;
            }

            try {
                const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
                const { tokens } = await oauth2Client.getToken(code);
                oauth2Client.setCredentials(tokens);

                let email: string | undefined;
                try {
                    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
                    const userInfo = await oauth2.userinfo.get();
                    email = userInfo.data.email || undefined;
                } catch (infoError) {
                    console.warn('Failed to fetch Google user info:', infoError);
                }

                server.close();
                finish({
                    success: true,
                    refreshToken: tokens.refresh_token || undefined,
                    email
                });
            } catch (authError: any) {
                server.close();
                finish({ success: false, error: authError.message || 'Authorization failed' });
            }
        });

        const authState = Math.random().toString(36).slice(2);
        let redirectUri = '';

        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address) {
                finish({ success: false, error: 'Failed to start auth server' });
                return;
            }
            const port = typeof address === 'string' ? 0 : address.port;
            redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

            const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
            const authUrl = oauth2Client.generateAuthUrl({
                access_type: 'offline',
                prompt: 'consent',
                scope: [
                    'https://www.googleapis.com/auth/drive.readonly',
                    'https://www.googleapis.com/auth/userinfo.email'
                ],
                state: authState
            });

            shell.openExternal(authUrl);
        });

        const timeout = setTimeout(() => {
            server.close();
            finish({ success: false, error: 'Authorization timed out' });
        }, 120000);

        server.on('close', () => {
            clearTimeout(timeout);
        });
    });
}

function createDriveClient(profile: ProfileSettings): drive_v3.Drive | null {
    const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        return null;
    }

    if (!profile.driveRefreshToken) {
        return null;
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: profile.driveRefreshToken });
    return google.drive({ version: 'v3', auth: oauth2Client });
}

interface ProfileSettings {
    id: string;
    name: string;
    watchedFolder: string;
    databasePath: string;
    openAIApiKey: string;
    fileExtensions: string;
    recursive: boolean;
    syncSource?: 'local' | 'drive';
    driveFolderId?: string;
    driveFolderName?: string;
    driveFolderDriveId?: string;
    driveAccountEmail?: string;
    driveRefreshToken?: string;
    mcpServerEnabled: boolean;
    mcpServerPort: number;
    embeddingProvider: EmbeddingProvider;  // 'local' or 'openai'
    embeddingContextLength?: number;  // Context length for local embedding model (default: 8192)
    llmContextLength?: number;  // Context length for local LLM chat model (default: 8192)
    llmChatApiKey?: string;  // OpenAI API key for LLM chat (separate from embeddings)
    llmChatModel?: string;  // OpenAI model for LLM chat (default: 'gpt-4o-mini')
    llmProvider?: LLMProvider;  // 'openai' or local Qwen3 variants
}

interface AppSettings {
    profiles: ProfileSettings[];
    activeProfileId: string | null;
    language?: string;
    profileCosts?: Record<string, { totalTokens: number; totalCost: number }>;
}

interface ProfileState {
    syncer: Syncer | null;
    database: DatabaseManager | null;
    processor: ContentProcessor | null;
    embeddingService: EmbeddingService | null;
    mcpServer: McpServer | null;
    llmChatService: LLMChatService | null;
    chatActive: boolean;
    status: 'idle' | 'syncing' | 'processing';
    processedCount: number;
    totalChunks: number;
    totalTokens: number;
    totalCost: number;
    totalFilesToSync: number;  // Total files matching extensions
    filesProcessed: number;     // Files processed during current sync
    mapProjectionRunning: boolean;
    mapProjectionPending: boolean;
    mapProjectionTimer: NodeJS.Timeout | null;
    isInitialSyncing: boolean;
}

// Store for persistent settings
    const store = new Store<AppSettings>({
    defaults: {
        profiles: [],
        activeProfileId: null,
        language: undefined // Will use system locale if undefined
    }
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let profileStates: Map<string, ProfileState> = new Map();
let isQuitting = false;
let isQuittingCleanup = false;
let syncCancelled: Map<string, boolean> = new Map();

// Track which ports are in use by which profiles
const portUsage: Map<number, string> = new Map(); // port -> profileId

function createWindow() {
    const appIconPath = getAppIconPath();
    mainWindow = new BrowserWindow({
        width: 600,
        height: 750,
        icon: appIconPath || undefined,
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
    const trayPath = getTrayIconPath();
    const baseIcon = trayPath ? nativeImage.createFromPath(trayPath) : null;
    if (baseIcon && !baseIcon.isEmpty()) {
        const resized = baseIcon.resize({ width: size, height: size });
        const bitmap = resized.toBitmap();
        const hasTransparency = bitmap.some((_, index) => index % 4 === 3 && bitmap[index] < 250);
        if (process.platform === 'darwin') {
            if (hasTransparency) {
                return resized;
            }
            if (bitmap.length > 0) {
                const rgba = Buffer.alloc(bitmap.length);
                for (let i = 0; i < bitmap.length; i += 4) {
                    const r = bitmap[i + 2];
                    const g = bitmap[i + 1];
                    const b = bitmap[i];
                    const isNearWhite = r > 245 && g > 245 && b > 245;
                    rgba[i] = r;
                    rgba[i + 1] = g;
                    rgba[i + 2] = b;
                    rgba[i + 3] = isNearWhite ? 0 : 255;
                }
                return nativeImage.createFromBuffer(rgba, { width: size, height: size });
            }
        } else if (bitmap.length > 0) {
            const rgba = Buffer.alloc(bitmap.length);
            for (let i = 0; i < bitmap.length; i += 4) {
                rgba[i] = bitmap[i + 2];
                rgba[i + 1] = bitmap[i + 1];
                rgba[i + 2] = bitmap[i];
                rgba[i + 3] = bitmap[i + 3];
            }

            let statusColor = { r: 150, g: 150, b: 150 };
            if (state === 'syncing') {
                statusColor = { r: 52, g: 199, b: 89 };
            } else if (state === 'processing') {
                statusColor = { r: 255, g: 149, b: 0 };
            }

            const dotRadius = process.platform === 'linux' ? 4 : 3;
            const dotX = size - dotRadius - 2;
            const dotY = size - dotRadius - 2;

            for (let dy = -dotRadius; dy <= dotRadius; dy++) {
                for (let dx = -dotRadius; dx <= dotRadius; dx++) {
                    if (dx * dx + dy * dy <= dotRadius * dotRadius) {
                        const px = dotX + dx;
                        const py = dotY + dy;
                        if (px >= 0 && px < size && py >= 0 && py < size) {
                            const idx = (py * size + px) * 4;
                            rgba[idx] = statusColor.r;
                            rgba[idx + 1] = statusColor.g;
                            rgba[idx + 2] = statusColor.b;
                            rgba[idx + 3] = 255;
                        }
                    }
                }
            }

            return nativeImage.createFromBuffer(rgba, { width: size, height: size });
        }

        if (process.platform !== 'darwin') {
            return resized;
        }
    }

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
    
    return nativeImage.createFromBuffer(canvas, { width: size, height: size });
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
    
    // Ensure i18n is initialized before using translations
    if (!isInitialized()) {
        console.warn('i18n not initialized yet, using fallback text');
        // Use fallback English text if i18n not ready
        tray.setToolTip('Docs4ai');
        return;
    }
    
    const overall = getOverallStatus();
    const state = overall.state;
    const appSettings = store.store;
    const activeProfile = appSettings.profiles?.find(p => p.id === appSettings.activeProfileId);
    
    tray.setImage(createTrayIcon(state));
    
    // Build tooltip with profile info (using translations)
    let tooltip = t('app.name');
    if (activeProfile) {
        tooltip += ` - ${activeProfile.name}`;
    }
    if (overall.state === 'processing') {
        tooltip += ` - ${t('tray.processing')}`;
    } else if (overall.syncingCount > 0) {
        tooltip += ` - ${t('tray.syncing', { count: overall.syncingCount })}`;
    } else {
        tooltip += ` - ${t('tray.notSyncing')}`;
    }
    tray.setToolTip(tooltip);
    
    // Build context menu with profile information (using translations)
    const menuItems: Electron.MenuItemConstructorOptions[] = [];
    
    // Active profile info
    if (activeProfile) {
        menuItems.push({
            label: `${t('tray.active')}: ${activeProfile.name}`,
            enabled: false
        });
    }
    
    // Overall status
    menuItems.push({
        label: overall.syncingCount > 0 
            ? `● ${t('tray.syncing', { count: overall.syncingCount })}` 
            : `○ ${t('tray.notSyncing')}`,
        enabled: false
    });
    
    menuItems.push({
        label: `${t('tray.files')}: ${overall.totalFiles} | ${t('tray.chunks')}: ${overall.totalChunks}`,
        enabled: false
    });
    
    // Profile list with status
    if (appSettings.profiles && appSettings.profiles.length > 0) {
        menuItems.push({ type: 'separator' });
        menuItems.push({
            label: `${t('tray.profiles')}:`,
            enabled: false
        });
        
        for (const profile of appSettings.profiles) {
            const profileState = profileStates.get(profile.id);
            const isSyncing = profileState?.syncer?.isSyncing ?? false;
            const isActive = profile.id === appSettings.activeProfileId;
            const prefix = isActive ? '→ ' : (isSyncing ? '● ' : '○ ');
            
            menuItems.push({
                label: `${prefix}${profile.name}${isSyncing ? ` (${profileState?.processedCount || 0} ${t('tray.files').toLowerCase()})` : ''}`,
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
    menuItems.push({ label: t('tray.showApp'), click: () => mainWindow?.show() });
    menuItems.push({ type: 'separator' });
    menuItems.push({ label: t('tray.quit'), click: () => app.quit() });
    
    const contextMenu = Menu.buildFromTemplate(menuItems);
    tray.setContextMenu(contextMenu);
}

function createTray() {
    try {
        tray = new Tray(createTrayIcon('idle'));
        
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
                fileExtensions: '.md,.txt,.html,.pdf,.doc,.docx,.pptx,.rtf,.odt,.csv',
                recursive: true,
                syncSource: 'local',
                driveFolderId: '',
                driveFolderName: '',
                driveFolderDriveId: '',
                driveAccountEmail: '',
                driveRefreshToken: '',
                mcpServerEnabled: false,
                mcpServerPort: nextPort,
                embeddingProvider: 'local',  // Default to local embeddings
                llmProvider: 'openai'
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
    ipcMain.handle('delete-profile', async (_event: IpcMainInvokeEvent, profileId: string) => {
        const appSettings = store.store;
        
        // Stop syncing if this profile is active
        const state = profileStates.get(profileId);
        if (state) {
            syncCancelled.set(profileId, true);
            if (state.syncer) {
                await state.syncer.stop();
            }
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
        
        // Update embedding service if provider or API key changed
        // Note: embeddingContextLength changes don't trigger reload - the new value will be used next time sync starts
        const state = profileStates.get(profileId);
        if (state) {
            const profile = appSettings.profiles![profileIndex];
            if (updates.embeddingProvider !== undefined || updates.openAIApiKey !== undefined) {
                // Recreate embedding service with new settings
                if (profile.embeddingProvider === 'openai') {
                    if (profile.openAIApiKey) {
                        state.embeddingService = new EmbeddingService('openai', profile.openAIApiKey, profile.embeddingContextLength);
                    } else {
                        state.embeddingService = null;
                    }
                } else {
                    state.embeddingService = new EmbeddingService(migrateEmbeddingProvider(profile.embeddingProvider), undefined, profile.embeddingContextLength);
                }
            }
            
            // Also update MCP server for this profile if running
            if (state.mcpServer) {
                state.mcpServer.setApiKey(profile.openAIApiKey);
                state.mcpServer.setEmbeddingProvider(profile.embeddingProvider);
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
        const embeddingProvider = migrateEmbeddingProvider(profile.embeddingProvider);

        if (!dbPath) {
            return { success: false, error: 'Database path not configured for this profile' };
        }

        // Only require API key if using OpenAI
        if (embeddingProvider === 'openai' && !apiKey) {
            return { success: false, error: 'OpenAI API key required when using OpenAI embeddings' };
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
        const appSettings = store.store;
        
        if (!state) {
            // Load persisted costs if available
            const persistedCosts = appSettings.profileCosts?.[profileId];
            state = {
                syncer: null,
                database: null,
                processor: null,
                embeddingService: null,
                mcpServer: null,
                llmChatService: null,
                chatActive: false,
                status: 'idle',
                processedCount: 0,
                totalChunks: 0,
                totalTokens: persistedCosts?.totalTokens || 0,
                totalCost: persistedCosts?.totalCost || 0,
                totalFilesToSync: 0,
                filesProcessed: 0,
                mapProjectionRunning: false,
                mapProjectionPending: false,
                mapProjectionTimer: null,
                isInitialSyncing: false
            };
            profileStates.set(profileId, state);
        }

            // Stop existing server if running
            if (state.mcpServer?.isRunning()) {
                await state.mcpServer.stop();
                portUsage.delete(port);
            }

            // Create and start new server
            state.mcpServer = new McpServer(port, profile.embeddingContextLength);
            state.mcpServer.setDatabase(dbPath);
            state.mcpServer.setApiKey(apiKey);
            state.mcpServer.setEmbeddingProvider(embeddingProvider);
            // Track costs for MCP queries (only for OpenAI)
            state.mcpServer.setOnCostUpdate((tokens, cost) => {
                if (state) {
                    state.totalTokens += tokens;
                    state.totalCost += cost;
                    
                    // Persist costs
                    const appSettings = store.store;
                    if (!appSettings.profileCosts) {
                        appSettings.profileCosts = {};
                    }
                    appSettings.profileCosts[profileId] = {
                        totalTokens: state.totalTokens,
                        totalCost: state.totalCost
                    };
                    store.store = appSettings;
                    
                    sendStats(profileId);
                }
            });
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

    ipcMain.handle('start-drive-auth', async (_event: IpcMainInvokeEvent, profileId: string) => {
        const appSettings = store.store;
        const profileIndex = appSettings.profiles?.findIndex(p => p.id === profileId);
        if (profileIndex === undefined || profileIndex === -1) {
            return { success: false, error: 'Profile not found' };
        }

        const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
        const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
            return { success: false, error: 'Missing Google Drive OAuth credentials (GOOGLE_DRIVE_CLIENT_ID/GOOGLE_DRIVE_CLIENT_SECRET)' };
        }

        const authResult = await startDriveAuthFlow(clientId, clientSecret);
        if (!authResult.success) {
            return authResult;
        }

        const profile = appSettings.profiles![profileIndex];
        const refreshToken = authResult.refreshToken || profile.driveRefreshToken;
        if (!refreshToken) {
            return { success: false, error: 'No refresh token returned from Google' };
        }

        appSettings.profiles![profileIndex] = {
            ...profile,
            driveRefreshToken: refreshToken,
            driveAccountEmail: authResult.email || profile.driveAccountEmail
        };
        store.store = appSettings;

        return {
            success: true,
            email: authResult.email || profile.driveAccountEmail || ''
        };
    });

    ipcMain.handle('disconnect-drive', async (_event: IpcMainInvokeEvent, profileId: string) => {
        const appSettings = store.store;
        const profileIndex = appSettings.profiles?.findIndex(p => p.id === profileId);
        if (profileIndex === undefined || profileIndex === -1) {
            return { success: false, error: 'Profile not found' };
        }

        const profile = appSettings.profiles![profileIndex];
        appSettings.profiles![profileIndex] = {
            ...profile,
            driveRefreshToken: '',
            driveAccountEmail: '',
            driveFolderId: '',
            driveFolderName: '',
            driveFolderDriveId: ''
        };
        store.store = appSettings;

        return { success: true };
    });

    ipcMain.handle('list-drive-folders', async (_event: IpcMainInvokeEvent, profileId: string, parentId: string | null, query: string | null, pageToken?: string, driveId?: string | null) => {
        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);
        if (!profile) {
            return { success: false, error: 'Profile not found' };
        }

        if (!profile.driveRefreshToken) {
            return { success: false, error: 'Google Drive account not connected' };
        }

        const drive = createDriveClient(profile);
        if (!drive) {
            return { success: false, error: 'Google Drive credentials not configured' };
        }

        const parent = parentId || 'root';
        const sanitizedQuery = (query || '').replace(/'/g, "\\'").trim();
        let q = `'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
        if (sanitizedQuery) {
            q += ` and name contains '${sanitizedQuery}'`;
        }

        const response = await drive.files.list({
            q,
            fields: 'nextPageToken, files(id, name)',
            orderBy: 'name',
            pageToken: pageToken || undefined,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
            driveId: driveId || undefined,
            corpora: driveId ? 'drive' : undefined
        });

        const folders = (response.data.files || []).map(file => ({
            id: file.id || '',
            name: file.name || ''
        })).filter(folder => folder.id && folder.name);

        return {
            success: true,
            folders,
            nextPageToken: response.data.nextPageToken || null
        };
    });

    ipcMain.handle('list-drive-shared-drives', async (_event: IpcMainInvokeEvent, profileId: string, query: string | null, pageToken?: string) => {
        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);
        if (!profile) {
            return { success: false, error: 'Profile not found' };
        }

        if (!profile.driveRefreshToken) {
            return { success: false, error: 'Google Drive account not connected' };
        }

        const drive = createDriveClient(profile);
        if (!drive) {
            return { success: false, error: 'Google Drive credentials not configured' };
        }

        const response = await drive.drives.list({
            fields: 'nextPageToken, drives(id, name)',
            pageToken: pageToken || undefined,
            q: query ? `name contains '${query.replace(/'/g, "\\'")}'` : undefined,
            useDomainAdminAccess: false
        });

        const drives = (response.data.drives || []).map(item => ({
            id: item.id || '',
            name: item.name || ''
        })).filter(item => item.id && item.name);

        return {
            success: true,
            drives,
            nextPageToken: response.data.nextPageToken || null
        };
    });

    ipcMain.handle('get-drive-folder-path', async (_event: IpcMainInvokeEvent, profileId: string, folderId: string) => {
        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);
        if (!profile) {
            return { success: false, error: 'Profile not found' };
        }

        if (!profile.driveRefreshToken) {
            return { success: false, error: 'Google Drive account not connected' };
        }

        const drive = createDriveClient(profile);
        if (!drive) {
            return { success: false, error: 'Google Drive credentials not configured' };
        }

        if (!folderId || folderId === 'root') {
            return { success: true, path: [], driveId: null, driveName: null };
        }

        const path: { id: string; name: string }[] = [];
        let currentId = folderId;
        let driveId: string | null = null;
        let driveName: string | null = null;

        while (currentId) {
            try {
                const response = await drive.files.get({
                    fileId: currentId,
                    fields: 'id, name, parents, driveId',
                    supportsAllDrives: true
                });

                const data = response.data;
                if (!data.id || !data.name) {
                    break;
                }

                path.unshift({ id: data.id, name: data.name });
                driveId = data.driveId || driveId;

                const parents = data.parents || [];
                const parentId = parents[0];
                if (!parentId || parentId === 'root') {
                    break;
                }
                currentId = parentId;
            } catch (error) {
                // Selected folder might be a shared drive root (driveId)
                try {
                    const driveInfo = await drive.drives.get({ driveId: currentId, fields: 'name' });
                    driveId = currentId;
                    driveName = driveInfo.data.name || null;
                } catch (driveError) {
                    console.warn('Failed to resolve drive path:', driveError);
                }
                break;
            }
        }

        if (driveId) {
            try {
                const driveInfo = await drive.drives.get({ driveId, fields: 'name' });
                driveName = driveInfo.data.name || null;
            } catch (error) {
                console.warn('Failed to resolve shared drive name:', error);
            }
        }

        return { success: true, path, driveId, driveName };
    });

    // Get stats for a specific profile
    ipcMain.handle('get-stats', (_event: IpcMainInvokeEvent, profileId: string) => {
        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);
        
        // Load persisted costs
        const persistedCosts = appSettings.profileCosts?.[profileId];
        let totalTokens = persistedCosts?.totalTokens || 0;
        let totalCost = persistedCosts?.totalCost || 0;
        
        const state = profileStates.get(profileId);
        
        // If state exists, use its values (which may be more up-to-date)
        if (state) {
            totalTokens = state.totalTokens || totalTokens;
            totalCost = state.totalCost || totalCost;
        }
        
        // Try to get database stats even if sync isn't running
        let trackedFiles = 0;
        let totalChunks = 0;
        
        if (profile?.databasePath) {
            try {
                const embeddingDimension = getEmbeddingDimension(migrateEmbeddingProvider(profile.embeddingProvider));
                const db = new DatabaseManager(profile.databasePath, embeddingDimension);
                trackedFiles = db.getTrackedFilesCount();
                totalChunks = db.getTotalChunksCount();
                db.close();
            } catch (error) {
                // Database might not exist yet or might be locked
                console.log(`[${profileId}] Could not read database stats:`, error);
            }
        }
        
        // If state exists and database is initialized, prefer those values
        if (state?.database) {
            trackedFiles = state.database.getTrackedFilesCount();
            totalChunks = state.database.getTotalChunksCount();
        }
        
        return {
            isSyncing: state?.syncer?.isSyncing ?? false,
            trackedFiles,
            totalChunks,
            totalTokens,
            totalCost,
            embeddingProvider: profile?.embeddingProvider || 'local'
        };
    });

    // Get all tracked files with info for a profile
    ipcMain.handle('get-files', (_event: IpcMainInvokeEvent, profileId: string) => {
        const state = profileStates.get(profileId);
        
        // If state exists and database is initialized, use it
        if (state?.database) {
            return state.database.getAllTrackedFilesWithInfo();
        }
        
        // Otherwise, try to open database directly from profile's databasePath
        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);
        
        if (!profile?.databasePath) {
            return [];
        }
        
        try {
            const embeddingDimension = getEmbeddingDimension(migrateEmbeddingProvider(profile.embeddingProvider));
            const db = new DatabaseManager(profile.databasePath, embeddingDimension);
            const files = db.getAllTrackedFilesWithInfo();
            db.close();
            return files;
        } catch (error) {
            // Database might not exist yet or might be locked
            return [];
        }
    });

    // Get chunks for a specific file in a profile
    ipcMain.handle('get-chunks', (_event: IpcMainInvokeEvent, profileId: string, filePath: string) => {
        const state = profileStates.get(profileId);
        
        // If state exists and database is initialized, use it
        const isUrl = /^https?:\/\//i.test(filePath);
        const normalizedPath = filePath.replace(/^file:\/\//, '');

        if (state?.database) {
            return isUrl
                ? state.database.getChunksForUrl(filePath)
                : state.database.getChunksForFile(normalizedPath);
        }
        
        // Otherwise, try to open database directly from profile's databasePath
        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);
        
        if (!profile?.databasePath) {
            return [];
        }
        
        try {
            const embeddingDimension = getEmbeddingDimension(migrateEmbeddingProvider(profile.embeddingProvider));
            const db = new DatabaseManager(profile.databasePath, embeddingDimension);
            const chunks = isUrl
                ? db.getChunksForUrl(filePath)
                : db.getChunksForFile(normalizedPath);
            db.close();
            return chunks;
        } catch (error) {
            // Database might not exist yet or might be locked
            return [];
        }
    });

    // Start watching a profile
    ipcMain.handle('start-watching', async (_event: IpcMainInvokeEvent, profileId: string) => {
        return await startWatchingInternal(profileId);
    });

    // Stop watching a profile
    ipcMain.handle('stop-watching', async (_event: IpcMainInvokeEvent, profileId: string) => {
        syncCancelled.set(profileId, true);
        const state = profileStates.get(profileId);
        if (state) {
            if (state.syncer) {
                await state.syncer.stop();
            }
            state.syncer = null;
            
            // Reset sync progress
            state.totalFilesToSync = 0;
            state.filesProcessed = 0;
            
            // Terminate embedding worker to stop any ongoing download
            if (state.embeddingService) {
                await state.embeddingService.terminate();
                state.embeddingService = null;
            }
        }
        
        // Hide download progress indicator
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('model-download-progress', {
                profileId,
                status: 'ready'  // 'ready' status hides the indicator
            });
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

    // Clear database for a profile (used when changing embedding provider)
    ipcMain.handle('clear-database', async (_event: IpcMainInvokeEvent, profileId: string) => {
        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);
        
        if (!profile?.databasePath) {
            return { success: false, error: 'No database path configured' };
        }

        try {
            // Cancel any in-progress sync operations first
            syncCancelled.set(profileId, true);
            
            // If profile state exists, clean it up completely
            const state = profileStates.get(profileId);
            if (state) {
                // Stop syncer if running
                if (state.syncer) {
                    await state.syncer.stop();
                    state.syncer = null;
                }
                // Close and clear database
                if (state.database) {
                    state.database.clearAllData();
                    state.database.close();
                    state.database = null;
                }
                // Terminate embedding worker and clear service
                if (state.embeddingService) {
                    await state.embeddingService.terminate();
                    state.embeddingService = null;
                }
                // Remove the state entirely so it gets recreated fresh
                profileStates.delete(profileId);
            }
            
            // Clear the cancellation flag after state cleanup
            syncCancelled.delete(profileId);

            // Delete the database file to ensure clean slate with correct dimensions
            const fs = require('fs');
            if (fs.existsSync(profile.databasePath)) {
                fs.unlinkSync(profile.databasePath);
                console.log(`[${profileId}] Database file deleted: ${profile.databasePath}`);
            }

            // Clear persisted token/cost stats for this profile
            if (appSettings.profileCosts?.[profileId]) {
                delete appSettings.profileCosts[profileId];
                store.set('profileCosts', appSettings.profileCosts);
                console.log(`[${profileId}] Token/cost stats cleared`);
            }

            return { success: true };
        } catch (error: any) {
            console.error(`[${profileId}] Error clearing database:`, error);
            return { success: false, error: error.message };
        }
    });

    // Get current language
    ipcMain.handle('get-language', () => {
        return getCurrentLanguage();
    });

    // Get available languages
    ipcMain.handle('get-available-languages', () => {
        return getAvailableLanguages();
    });

    // Get translations for renderer process
    ipcMain.handle('get-translations', async (_event: IpcMainInvokeEvent, locale?: string) => {
        const targetLocale = locale || getCurrentLanguage();
        const fs = require('fs');
        const translationsPath = path.join(__dirname, 'locales', `${targetLocale}.json`);
        try {
            const translations = JSON.parse(fs.readFileSync(translationsPath, 'utf-8'));
            return translations;
        } catch (error) {
            // Fallback to English
            const fallbackPath = path.join(__dirname, 'locales', 'en.json');
            const fallback = JSON.parse(fs.readFileSync(fallbackPath, 'utf-8'));
            return fallback;
        }
    });

    // Set language
    ipcMain.handle('set-language', async (_event: IpcMainInvokeEvent, locale: string) => {
        try {
            await changeLanguage(locale);
            const appSettings = store.store;
            appSettings.language = locale;
            store.store = appSettings;
            updateTray(); // Update tray menu with new language

            // Notify renderer that language changed
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('language-changed', locale);
            }

            return { success: true, language: locale };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    // ==================== Chat IPC Handlers ====================

    // Start chat session for a profile (auto-starts MCP server if needed)
    ipcMain.handle('start-chat', async (_event: IpcMainInvokeEvent, profileId: string, llmProvider: LLMProvider, openaiApiKey?: string, openaiModel?: string) => {
        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);

        if (!profile) {
            return { success: false, error: 'Profile not found' };
        }

        if (!profile.databasePath) {
            return { success: false, error: 'Database not configured for this profile' };
        }

        if (llmProvider === 'openai' && !openaiApiKey) {
            return { success: false, error: 'OpenAI API key is required for OpenAI LLM provider' };
        }

        try {
            // Get or create profile state
            let state = profileStates.get(profileId);
            if (!state) {
                const persistedCosts = appSettings.profileCosts?.[profileId];
                state = {
                    syncer: null,
                    database: null,
                    processor: null,
                    embeddingService: null,
                    mcpServer: null,
                    llmChatService: null,
                    chatActive: false,
                    status: 'idle',
                    processedCount: 0,
                    totalChunks: 0,
                    totalTokens: persistedCosts?.totalTokens || 0,
                    totalCost: persistedCosts?.totalCost || 0,
                    totalFilesToSync: 0,
                    filesProcessed: 0,
                    mapProjectionRunning: false,
                    mapProjectionPending: false,
                    mapProjectionTimer: null,
                    isInitialSyncing: false
                };
                profileStates.set(profileId, state);
            }

            // Auto-start MCP server if not running
            if (!state.mcpServer?.isRunning()) {
                console.log(`[Chat] Auto-starting MCP server for profile ${profile.name}`);
                const port = profile.mcpServerPort || 3333;
                const embeddingProvider = migrateEmbeddingProvider(profile.embeddingProvider);

                // Check if port is already in use by another profile
                const portOwner = portUsage.get(port);
                if (portOwner && portOwner !== profileId) {
                    return { success: false, error: `Port ${port} is already in use by another profile` };
                }

                // Create and start MCP server
                state.mcpServer = new McpServer(port, profile.embeddingContextLength);
                state.mcpServer.setDatabase(profile.databasePath);
                state.mcpServer.setApiKey(profile.openAIApiKey || null);
                state.mcpServer.setEmbeddingProvider(embeddingProvider);

                // Track costs for MCP queries
                state.mcpServer.setOnCostUpdate((tokens, cost) => {
                    if (state) {
                        state.totalTokens += tokens;
                        state.totalCost += cost;

                        const appSettings = store.store;
                        if (!appSettings.profileCosts) {
                            appSettings.profileCosts = {};
                        }
                        appSettings.profileCosts[profileId] = {
                            totalTokens: state.totalTokens,
                            totalCost: state.totalCost
                        };
                        store.store = appSettings;
                        sendStats(profileId);
                    }
                });

                await state.mcpServer.start();
                portUsage.set(port, profileId);

                // Update profile settings
                profile.mcpServerEnabled = true;
                store.store = appSettings;

                console.log(`[Chat] MCP server started on port ${port}`);
            }

            // Stop existing LLM service if provider changed
            if (state.llmChatService && state.llmChatService.getProvider() !== llmProvider) {
                await state.llmChatService.terminate();
                state.llmChatService = null;
            }

            // Create LLM chat service
            if (!state.llmChatService) {
                state.llmChatService = new LLMChatService(llmProvider, openaiApiKey, openaiModel, profile.llmContextLength);

                // Set up download progress callback for local model
                if (llmProvider !== 'openai') {
                    state.llmChatService.setDownloadProgressCallback((progress) => {
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.webContents.send('llm-download-progress', {
                                profileId,
                                ...progress
                            });
                        }
                    });
                }
            }

            // Initialize the LLM service (downloads model if needed)
            await state.llmChatService.initialize();
            state.chatActive = true;

            return {
                success: true,
                mcpPort: state.mcpServer?.getPort(),
                llmProvider
            };

        } catch (error: any) {
            console.error('[Chat] Error starting chat:', error);
            return { success: false, error: error.message };
        }
    });

    // Stop chat session
    ipcMain.handle('stop-chat', async (_event: IpcMainInvokeEvent, profileId: string) => {
        try {
            const state = profileStates.get(profileId);
            if (state) {
                state.chatActive = false;

                // Terminate LLM service
                if (state.llmChatService) {
                    await state.llmChatService.terminate();
                    state.llmChatService = null;
                }
            }
            return { success: true };
        } catch (error: any) {
            console.error('[Chat] Error stopping chat:', error);
            return { success: false, error: error.message };
        }
    });

    // Get chat status
    ipcMain.handle('get-chat-status', (_event: IpcMainInvokeEvent, profileId: string) => {
        const state = profileStates.get(profileId);
        return {
            active: state?.chatActive ?? false,
            mcpRunning: state?.mcpServer?.isRunning() ?? false,
            mcpPort: state?.mcpServer?.getPort() ?? 3333,
            llmProvider: state?.llmChatService?.getProvider() ?? null
        };
    });

    // Send chat message and get response
    ipcMain.handle('send-chat-message', async (_event: IpcMainInvokeEvent, options: {
        profileId: string;
        messages: ChatMessage[];
        llmProvider: LLMProvider;
        openaiApiKey?: string;
        openaiModel?: string;
        enableTools?: boolean;
        temperature?: number;
        maxTokens?: number;
        requestId?: string;
    }) => {
        const { profileId, messages, enableTools = true, temperature, maxTokens, requestId } = options;

        const state = profileStates.get(profileId);
        if (!state || !state.chatActive || !state.llmChatService) {
            return { success: false, error: 'Chat session not active. Please start chat first.' };
        }

        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);
        if (!profile) {
            return { success: false, error: 'Profile not found' };
        }

        try {
            const mcpPort = state.mcpServer?.getPort() || profile.mcpServerPort || 3333;

            // Build chat options
            const chatOptions: any = {
                messages,
                temperature,
                maxTokens,
                mcpServerPort: mcpPort,
                onToolCall: (toolCall: { name: string; arguments: any; response: any }) => {
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('chat-tool-call', {
                            profileId,
                            requestId,
                            toolCall
                        });
                    }
                }
            };

            // Add tools if enabled and MCP server is running
            if (enableTools && state.mcpServer?.isRunning()) {
                chatOptions.tools = MCP_TOOLS;
            }

            // Get initial response
            let result = await state.llmChatService.chat(chatOptions);

            // Handle tool calls (function calling loop)
            const maxToolCalls = 5; // Prevent infinite loops
            let toolCallCount = 0;
            const conversationMessages = [...messages];
            const executedToolCalls: Array<{ name: string; arguments: any; response: any }> =
                (result.toolCalls ?? []) as Array<{ name: string; arguments: any; response: any }>;

            while (result.finishReason === 'tool_calls' && result.message.tool_calls && toolCallCount < maxToolCalls) {
                toolCallCount++;
                console.log(`[Chat] Processing tool calls (${toolCallCount}/${maxToolCalls})`);

                // Add assistant message with tool calls
                conversationMessages.push(result.message);

                // Execute each tool call
                for (const toolCall of result.message.tool_calls) {
                    console.log(`[Chat] Executing tool: ${toolCall.function.name}`);

                    const toolResult = await executeMcpToolCall(toolCall, mcpPort);

                    // Store executed tool call for UI display
                    let parsedArgs;
                    try {
                        parsedArgs = JSON.parse(toolCall.function.arguments);
                    } catch {
                        parsedArgs = toolCall.function.arguments;
                    }
                    const executedCall = {
                        name: toolCall.function.name,
                        arguments: parsedArgs,
                        response: toolResult
                    };
                    executedToolCalls.push(executedCall);

                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('chat-tool-call', {
                            profileId,
                            requestId,
                            toolCall: executedCall
                        });
                    }

                    // Add tool result to conversation
                    conversationMessages.push({
                        role: 'tool',
                        content: toolResult,
                        tool_call_id: toolCall.id,
                        name: toolCall.function.name
                    });
                }

                // Get next response with tool results
                result = await state.llmChatService.chat({
                    messages: conversationMessages,
                    tools: chatOptions.tools,
                    temperature,
                    maxTokens,
                    mcpServerPort: mcpPort
                });
            }

            return {
                success: true,
                message: result.message,
                finishReason: result.finishReason,
                usage: result.usage,
                toolCalls: executedToolCalls.length > 0 ? executedToolCalls : undefined
            };

        } catch (error: any) {
            console.error('[Chat] Error sending message:', error);

            // Send error to renderer
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('chat-error', {
                    profileId,
                    error: error.message
                });
            }

            return { success: false, error: error.message };
        }
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
    const syncSource = profile.syncSource || 'local';
    const embeddingProvider = migrateEmbeddingProvider(profile.embeddingProvider);

    if (syncSource === 'local' && !watchedFolder) {
        return { success: false, error: 'No folder selected' };
    }

    if (!databasePath) {
        return { success: false, error: 'No database path selected' };
    }

    // Only require API key if using OpenAI embeddings
    if (embeddingProvider === 'openai' && !openAIApiKey) {
        return { success: false, error: 'OpenAI API key is required when using OpenAI embeddings' };
    }

    try {
        // Get or create profile state
        let state = profileStates.get(profileId);
        const appSettings = store.store;
        
        if (!state) {
            // Load persisted costs if available
            const persistedCosts = appSettings.profileCosts?.[profileId];
            state = {
                syncer: null,
                database: null,
                processor: null,
                embeddingService: null,
                mcpServer: null,
                llmChatService: null,
                chatActive: false,
                status: 'idle',
                processedCount: 0,
                totalChunks: 0,
                totalTokens: persistedCosts?.totalTokens || 0,
                totalCost: persistedCosts?.totalCost || 0,
                totalFilesToSync: 0,
                filesProcessed: 0,
                mapProjectionRunning: false,
                mapProjectionPending: false,
                mapProjectionTimer: null,
                isInitialSyncing: false
            };
            profileStates.set(profileId, state);
        }

        // Determine embedding dimension based on provider
        const embeddingDimension = getEmbeddingDimension(embeddingProvider);

        // Initialize database
        if (state.database) {
            state.database.close();
        }
        state.database = new DatabaseManager(databasePath, embeddingDimension);

        // Initialize processor
        state.processor = new ContentProcessor();

        if (state.database.getTotalChunksCount() > 0 && state.database.getChunkCoordsCount() === 0) {
            state.mapProjectionPending = true;
            scheduleMapProjection(profileId, 2000);
        }

        // Terminate existing embedding service if any (cleanup from previous run)
        if (state.embeddingService) {
            console.log(`[${profile.name}] Terminating existing embedding service...`);
            await state.embeddingService.terminate();
            state.embeddingService = null;
        }

        // Initialize embedding service
        if (embeddingProvider === 'openai') {
            state.embeddingService = new EmbeddingService('openai', openAIApiKey, profile.embeddingContextLength);
            
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
        } else {
            // Use local embeddings
            const modelConfig = LOCAL_MODELS[embeddingProvider];
            console.log(`[${profile.name}] Using local embedding model: ${modelConfig?.name || embeddingProvider}...`);
            state.embeddingService = new EmbeddingService(embeddingProvider, undefined, profile.embeddingContextLength);
            
            // Set up download progress callback to notify UI
            state.embeddingService.setDownloadProgressCallback((progress) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    try {
                        mainWindow.webContents.send('model-download-progress', {
                            profileId,
                            ...progress
                        });
                    } catch (err) {
                        console.error('Error sending download progress:', err);
                    }
                }
            });
            
            // Wait for local model to be ready in the background
            // Don't block - let the sync setup continue
            const embeddingService = state.embeddingService;
            embeddingService.validateApiKey().then(() => {
                console.log(`[${profile.name}] Local embedding model ready`);
            }).catch(async (error: any) => {
                console.error(`[${profile.name}] Failed to load local embedding model:`, error);
                // Stop sync and show error
                if (state && state.embeddingService === embeddingService) {
                    await embeddingService.terminate();
                    state.embeddingService = null;
                    if (state.syncer) {
                        await state.syncer.stop();
                    }
                    state.syncer = null;
                    // Notify UI about the error
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('api-key-error', {
                            profileId,
                            message: `Failed to load embedding model: ${error.message}`
                        });
                    }
                    sendStats(profileId);
                    updateTray();
                }
            });
        }

    // Parse extensions
    const extensions = fileExtensions.split(',').map(e => e.trim().toLowerCase()).filter(e => e);

    // Stop existing syncer if any
    if (state.syncer) {
        await state.syncer.stop();
    }

    if (syncSource === 'drive') {
        if (!profile.driveFolderId) {
            return { success: false, error: 'No Google Drive folder selected' };
        }

        if (!profile.driveRefreshToken) {
            return { success: false, error: 'Google Drive account not connected' };
        }

        const drive = createDriveClient(profile);
        if (!drive) {
            return { success: false, error: 'Google Drive credentials not configured' };
        }

        const cacheDir = path.join(app.getPath('userData'), 'drive-cache', profileId);
        const rootName = profile.driveFolderName || 'My Drive';
        let driveId = profile.driveFolderDriveId || null;

        if (!driveId && profile.driveFolderId && profile.driveFolderId !== 'root') {
            try {
                const driveInfo = await drive.files.get({
                    fileId: profile.driveFolderId,
                    fields: 'driveId',
                    supportsAllDrives: true
                });
                driveId = driveInfo.data.driveId || null;
                if (driveId) {
                    const appSettings = store.store;
                    const profileIndex = appSettings.profiles?.findIndex(p => p.id === profileId) ?? -1;
                    if (profileIndex >= 0) {
                        appSettings.profiles![profileIndex] = {
                            ...appSettings.profiles![profileIndex],
                            driveFolderDriveId: driveId
                        };
                        store.store = appSettings;
                    }
                }
            } catch (error) {
                console.warn('Failed to resolve Drive ID for folder:', error);
            }
        }
        const driveSyncer = new DriveSyncer(drive, profile.driveFolderId, cacheDir, {
            recursive,
            extensions,
            onFileAdd: async (filePath, sourceUrl, displayPath) => {
                await processFile(profileId, filePath, false, sourceUrl, displayPath);
                sendStats(profileId);
            },
            onFileChange: async (filePath, sourceUrl, displayPath) => {
                await processFile(profileId, filePath, false, sourceUrl, displayPath);
                sendStats(profileId);
            },
            onFileDelete: async (filePath) => {
                state.database?.removeChunksForFile(filePath);
                state.database?.removeFileInfo(filePath);
                state.mapProjectionPending = true;
                if (!state.isInitialSyncing) {
                    scheduleMapProjection(profileId);
                }
                sendStats(profileId);
            }
        });
        driveSyncer.setRootName(rootName);
        driveSyncer.setDriveId(driveId);
        state.syncer = driveSyncer;
    } else {
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
                state.mapProjectionPending = true;
                if (!state.isInitialSyncing) {
                    scheduleMapProjection(profileId);
                }
                sendStats(profileId);
            }
        });
    }

    // Reset sync cancelled flag
    syncCancelled.set(profileId, false);

    // Kick off initial scan without blocking UI
    state.totalFilesToSync = 0;
    state.filesProcessed = 0;
    sendStats(profileId);

    if (syncSource === 'drive' && state.syncer instanceof DriveSyncer) {
        const driveSyncer = state.syncer;
        driveSyncer.beginSync();

        (async () => {
            try {
                state.isInitialSyncing = true;
                const driveFiles = await driveSyncer.listRemoteFiles();
                console.log(`[${profile.name}] Sync source: ${syncSource} (${driveFiles.length} files)`);
                state.totalFilesToSync = driveFiles.length;
                state.filesProcessed = 0;
                sendStats(profileId);

                for (const file of driveFiles) {
                    if (syncCancelled.get(profileId)) {
                        break;
                    }
                    const cached = await driveSyncer.downloadToCache(file);
                    if (!cached) {
                        continue;
                    }
                    await processFile(profileId, cached.localPath, false, cached.sourceUrl, cached.displayPath);
                    state.filesProcessed++;
                    sendStats(profileId);
                    await new Promise(resolve => setImmediate(resolve));
                }

                if (!syncCancelled.get(profileId)) {
                    const hasCoords = state.database ? state.database.getChunkCoordsCount() > 0 : false;
                    const hasChunks = state.database ? state.database.getTotalChunksCount() > 0 : false;
                    if (state.mapProjectionPending || (hasChunks && !hasCoords)) {
                        state.mapProjectionPending = false;
                        await runMapProjection(profileId, 'initial-sync');
                    }
                }

                if (!syncCancelled.get(profileId)) {
                    state.totalFilesToSync = 0;
                    state.filesProcessed = 0;
                    sendStats(profileId);
                }
            } catch (error: any) {
                console.error(`[${profile.name}] Error during initial sync:`, error);
            } finally {
                state.isInitialSyncing = false;
                if (!syncCancelled.get(profileId)) {
                    driveSyncer.startPolling();
                }
                sendStats(profileId);
                updateTray();
            }
        })();
    } else {
        state.syncer.start();
        state.syncer.getSyncedFiles().then((initialFiles) => {
            console.log(`[${profile.name}] Sync source: ${syncSource} (${initialFiles.length} files)`);
            state.totalFilesToSync = initialFiles.length;
            state.filesProcessed = 0;
            sendStats(profileId);

            return performInitialSync(profileId, false, initialFiles);
        }).then(() => {
            sendStats(profileId);
            updateTray();
        }).catch((error: any) => {
            console.error(`[${profile.name}] Error during initial sync:`, error);
            sendStats(profileId);
            updateTray();
        });
    }

    // Return immediately so UI can show "Stop Sync" button
    sendStats(profileId);
    updateTray();
    return { success: true };
    } catch (error: any) {
        console.error(`[${profile.name}] Error starting syncer:`, error);
        return { success: false, error: error.message };
    }
}

function normalizeEmbedding(embedding: Float32Array | Buffer | number[]): Float32Array | null {
    if (!embedding) return null;
    if (embedding instanceof Float32Array) return embedding;
    if (Array.isArray(embedding)) return new Float32Array(embedding);
    if (Buffer.isBuffer(embedding)) {
        return new Float32Array(embedding.buffer, embedding.byteOffset, Math.floor(embedding.byteLength / 4));
    }
    return null;
}

function scheduleMapProjection(profileId: string, delayMs: number = 15000) {
    const state = profileStates.get(profileId);
    if (!state) return;
    state.mapProjectionPending = true;
    if (state.mapProjectionTimer) {
        clearTimeout(state.mapProjectionTimer);
    }
    state.mapProjectionTimer = setTimeout(() => {
        runMapProjection(profileId, 'debounced');
    }, delayMs);
}

async function runMapProjection(profileId: string, reason: string) {
    const state = profileStates.get(profileId);
    if (!state || !state.database) return;
    if (state.mapProjectionRunning) {
        state.mapProjectionPending = true;
        return;
    }

    if (state.mapProjectionTimer) {
        clearTimeout(state.mapProjectionTimer);
        state.mapProjectionTimer = null;
    }

    state.mapProjectionRunning = true;
    state.mapProjectionPending = false;

    try {
        const embeddings = state.database.getAllEmbeddings();
        if (embeddings.length === 0) {
            state.database.clearChunkCoords();
            return;
        }

        const vectors: number[][] = [];
        const chunkIds: string[] = [];
        for (const row of embeddings) {
            const vector = normalizeEmbedding(row.embedding);
            if (!vector) continue;
            vectors.push(Array.from(vector));
            chunkIds.push(row.chunkId);
        }

        if (vectors.length === 0) {
            state.database.clearChunkCoords();
            return;
        }

        console.log(`[${profileId}] Projecting ${vectors.length} embeddings (${reason})`);

        const workerPath = path.join(__dirname, 'umap-worker.js');
        const coords = await new Promise<Array<{ x: number; y: number }>>((resolve, reject) => {
            const worker = new Worker(workerPath);
            const cleanup = () => {
                worker.removeAllListeners();
                worker.terminate();
            };
            worker.on('message', (message: { coords?: Array<{ x: number; y: number }>; error?: string }) => {
                if (message.error) {
                    cleanup();
                    reject(new Error(message.error));
                    return;
                }
                cleanup();
                resolve(message.coords || []);
            });
            worker.on('error', (error) => {
                cleanup();
                reject(error);
            });
            worker.postMessage({ embeddings: vectors });
        });

        if (coords.length !== chunkIds.length) {
            console.warn(`[${profileId}] UMAP returned ${coords.length} points for ${chunkIds.length} embeddings`);
        }

        const projected = coords.map((point, index) => ({
            chunkId: chunkIds[index],
            x: point.x,
            y: point.y
        })).filter(item => item.chunkId !== undefined);

        state.database.upsertChunkCoords(projected);
    } catch (error: any) {
        console.error(`[${profileId}] Map projection failed:`, error);
    } finally {
        state.mapProjectionRunning = false;
        if (state.mapProjectionPending) {
            state.mapProjectionPending = false;
            scheduleMapProjection(profileId, 5000);
        }
    }
}

    async function processFile(profileId: string, filePath: string, forceReprocess: boolean = false, sourceUrl?: string, displayPath?: string) {
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

        // Re-check after async operation - database might have been cleared
        if (syncCancelled.get(profileId) || !state.database) {
            return;
        }

        // Check content hash - skip if content is identical
        const hash = state.processor.generateHash(content);
        if (!forceReprocess) {
            const fileInfo = state.database.getFileInfo(filePath);
            if (fileInfo && fileInfo.hash === hash) {
                console.log(`[${profileId}] Skipping (same hash): ${filePath}`);
                // Update modification time even if content unchanged
                state.database.upsertFileInfo(filePath, hash, new Date(), fileInfo.chunkCount, displayPath, sourceUrl);
                state.status = state.syncer?.isSyncing ? 'syncing' : 'idle';
                updateTray();
                return;
            }
        }

        const chunks = state.processor.chunkContent(content, filePath, sourceUrl);

        // Remove old chunks
        state.database.removeChunksForFile(filePath);

        // Generate embeddings and insert chunks
        for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
            const chunk = chunks[chunkIdx];
            let embedding: number[] | null = null;

            // Yield to event loop periodically to keep UI responsive (every 2 chunks for local models)
            if (chunkIdx > 0 && chunkIdx % 2 === 0) {
                await new Promise(resolve => setImmediate(resolve));
            }

            if (state.embeddingService && !syncCancelled.get(profileId)) {
                try {
                    const result = await state.embeddingService.generateEmbedding(chunk.content);
                    embedding = result.embedding;
                    
                    // Track tokens and cost (only for OpenAI - local is free)
                    // Re-check embeddingService in case it was nullified during async operation
                    if (state.embeddingService && state.embeddingService.getProvider() === 'openai') {
                        const tokens = result.tokens;
                        const cost = (tokens / 1_000_000) * 0.13; // $0.13 per million tokens
                        state.totalTokens += tokens;
                        state.totalCost += cost;
                        
                        // Persist costs
                        const appSettings = store.store;
                        if (!appSettings.profileCosts) {
                            appSettings.profileCosts = {};
                        }
                        appSettings.profileCosts[profileId] = {
                            totalTokens: state.totalTokens,
                            totalCost: state.totalCost
                        };
                        store.store = appSettings;
                    }
                } catch (error) {
                    if (error instanceof InvalidApiKeyError) {
                        console.error(`[${profileId}] Invalid API key detected - stopping sync`);
                        await handleInvalidApiKey(profileId);
                        return; // Stop processing this file
                    }
                    console.error(`[${profileId}] Error generating embedding:`, error);
                }
            }

            // Check if sync was cancelled or database was closed during async operation
            if (syncCancelled.get(profileId) || !state.database) {
                return;
            }

            state.database.insertChunk(chunk, embedding);
        }

        // Final check before updating file info
        if (syncCancelled.get(profileId) || !state.database) {
            return;
        }

        // Update file info with current timestamp
        state.database.upsertFileInfo(filePath, hash, new Date(), chunks.length, displayPath, sourceUrl);

        state.mapProjectionPending = true;
        if (!state.isInitialSyncing) {
            scheduleMapProjection(profileId);
        }

        console.log(`[${profileId}] Processed: ${filePath} (${chunks.length} chunks)`);
    } catch (error) {
        console.error(`[${profileId}] Error processing ${filePath}:`, error);
    } finally {
        state.status = state.syncer?.isSyncing ? 'syncing' : 'idle';
        updateTray();
    }
}

async function performInitialSync(profileId: string, forceReprocess: boolean = false, initialFiles?: string[]) {
    const state = profileStates.get(profileId);
    if (!state || !state.syncer || !state.database) return;

    state.isInitialSyncing = true;

    const appSettings = store.store;
    const profile = appSettings.profiles?.find(p => p.id === profileId);
    const profileName = profile?.name || profileId;

    const files = initialFiles || await state.syncer.getSyncedFiles();
    console.log(`[${profileName}] Initial sync: ${files.length} files (force=${forceReprocess})`);

    // Update total files to sync if not already set
    state.totalFilesToSync = files.length;
    state.filesProcessed = 0;
    sendStats(profileId); // Send initial progress

    let processed = 0;
    let skipped = 0;

    for (let i = 0; i < files.length; i++) {
        // Check if sync was cancelled or database was cleared
        if (syncCancelled.get(profileId) || !state.database) {
            console.log(`[${profileName}] Sync cancelled`);
            break;
        }
        
        const filePath = files[i];
        
        try {
            // Get current database reference (defensive copy)
            const currentDb = state.database;
            if (!currentDb) {
                console.log(`[${profileName}] Sync cancelled - database cleared`);
                break;
            }
            
            // Check if file needs processing before logging
            const fileInfo = currentDb.getFileInfo(filePath);
            const needsProcessing = forceReprocess || !fileInfo;
            
            if (!needsProcessing && fileInfo) {
                const fs = require('fs');
                try {
                    const stats = fs.statSync(filePath);
                    if (stats.mtime <= fileInfo.modifiedAt) {
                        skipped++;
                        // Still count skipped files as processed for progress
                        state.filesProcessed++;
                        continue; // Skip unchanged files silently
                    }
                } catch {
                    // Process if we can't stat
                }
            }
            
            console.log(`[${profileName}] Processing ${i + 1}/${files.length}: ${filePath}`);
            await processFile(profileId, filePath, forceReprocess);
            processed++;
            state.filesProcessed = processed + skipped;
            // Update stats after each file during initial sync
            sendStats(profileId);
            
            // Yield to event loop to keep UI responsive
            await new Promise(resolve => setImmediate(resolve));
        } catch (error: any) {
            // Handle case where database was cleared during sync
            if (error?.message?.includes('null') || error?.message?.includes('undefined')) {
                console.log(`[${profileName}] Sync interrupted - database was cleared`);
                break;
            }
            console.error(`[${profileName}] Error checking file ${filePath}:`, error);
        }
    }
    
    if (!syncCancelled.get(profileId)) {
        console.log(`[${profileName}] Sync complete: ${processed} processed, ${skipped} skipped (unchanged)`);
        // Reset progress tracking when sync completes
        state.totalFilesToSync = 0;
        state.filesProcessed = 0;
        sendStats(profileId);
    }

    state.isInitialSyncing = false;
    if (!syncCancelled.get(profileId) && state.mapProjectionPending) {
        await runMapProjection(profileId, 'initial-sync');
    }
}

function sendStats(profileId?: string) {
    if (profileId) {
        // Send stats for a specific profile
        const appSettings = store.store;
        const profile = appSettings.profiles?.find(p => p.id === profileId);
        const state = profileStates.get(profileId);
        
        // Load persisted costs
        const persistedCosts = appSettings.profileCosts?.[profileId];
        let totalTokens = persistedCosts?.totalTokens || 0;
        let totalCost = persistedCosts?.totalCost || 0;
        
        // If state exists, use its values (which may be more up-to-date)
        if (state) {
            totalTokens = state.totalTokens || totalTokens;
            totalCost = state.totalCost || totalCost;
        }
        
        // Try to get database stats even if sync isn't running
        let trackedFiles = 0;
        let totalChunks = 0;
        
        if (profile?.databasePath) {
            try {
                const embeddingDimension = getEmbeddingDimension(migrateEmbeddingProvider(profile.embeddingProvider));
                const db = new DatabaseManager(profile.databasePath, embeddingDimension);
                trackedFiles = db.getTrackedFilesCount();
                totalChunks = db.getTotalChunksCount();
                db.close();
            } catch (error) {
                // Database might not exist yet or might be locked
            }
        }
        
        // If state exists and database is initialized, prefer those values
        if (state?.database) {
            trackedFiles = state.database.getTrackedFilesCount();
            totalChunks = state.database.getTotalChunksCount();
        }
        
        const stats = {
            profileId,
            isSyncing: state?.syncer?.isSyncing ?? false,
            trackedFiles,
            totalChunks,
            totalTokens,
            totalCost,
            embeddingProvider: profile?.embeddingProvider || 'local',
            syncProgress: state ? {
                filesProcessed: state.filesProcessed || 0,
                totalFiles: state.totalFilesToSync || 0
            } : { filesProcessed: 0, totalFiles: 0 }
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
            
            // Load persisted costs
            const persistedCosts = appSettings.profileCosts?.[profile.id];
            let totalTokens = persistedCosts?.totalTokens || 0;
            let totalCost = persistedCosts?.totalCost || 0;
            
            // If state exists, use its values (which may be more up-to-date)
            if (state) {
                totalTokens = state.totalTokens || totalTokens;
                totalCost = state.totalCost || totalCost;
            }
            
            // Try to get database stats even if sync isn't running
            let trackedFiles = 0;
            let totalChunks = 0;
            
            if (profile.databasePath) {
                try {
                    const embeddingDimension = getEmbeddingDimension(migrateEmbeddingProvider(profile.embeddingProvider));
                    const db = new DatabaseManager(profile.databasePath, embeddingDimension);
                    trackedFiles = db.getTrackedFilesCount();
                    totalChunks = db.getTotalChunksCount();
                    db.close();
                } catch (error) {
                    // Database might not exist yet or might be locked
                }
            }
            
            // If state exists and database is initialized, prefer those values
            if (state?.database) {
                trackedFiles = state.database.getTrackedFilesCount();
                totalChunks = state.database.getTotalChunksCount();
            }
            
            return {
                profileId: profile.id,
                isSyncing: state?.syncer?.isSyncing ?? false,
                trackedFiles,
                totalChunks,
                totalTokens,
                totalCost,
                embeddingProvider: migrateEmbeddingProvider(profile.embeddingProvider),
                syncProgress: state ? {
                    filesProcessed: state.filesProcessed || 0,
                    totalFiles: state.totalFilesToSync || 0
                } : { filesProcessed: 0, totalFiles: 0 }
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

async function handleInvalidApiKey(profileId: string) {
    // Cancel sync and stop watching
    syncCancelled.set(profileId, true);
    const state = profileStates.get(profileId);
    if (state) {
                if (state.syncer) {
                    await state.syncer.stop();
                    state.syncer = null;
                }
        
        // Terminate embedding worker and clear service
        if (state.embeddingService) {
            await state.embeddingService.terminate();
            state.embeddingService = null;
        }
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

app.whenReady().then(async () => {
    const appIconPath = getAppIconPath();
    if (appIconPath && process.platform === 'darwin') {
        app.dock.setIcon(appIconPath);
    }
    // Initialize i18n before creating UI
    const appSettings = store.store;
    await initI18n(appSettings.language);
    
    // Initialize profile states with persisted costs on startup
    if (appSettings.profiles) {
        for (const profile of appSettings.profiles) {
            if (!profileStates.has(profile.id)) {
                const persistedCosts = appSettings.profileCosts?.[profile.id];
                profileStates.set(profile.id, {
                    syncer: null,
                    database: null,
                    processor: null,
                    embeddingService: null,
                    mcpServer: null,
                    llmChatService: null,
                    chatActive: false,
                    status: 'idle',
                    processedCount: 0,
                    totalChunks: 0,
                    totalTokens: persistedCosts?.totalTokens || 0,
                    totalCost: persistedCosts?.totalCost || 0,
                    totalFilesToSync: 0,
                    filesProcessed: 0,
                    mapProjectionRunning: false,
                    mapProjectionPending: false,
                    mapProjectionTimer: null,
                    isInitialSyncing: false
                });
            }
        }
    }
    
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
    
    // Send initial stats for all profiles after window is ready and translations are loaded
    if (mainWindow) {
        mainWindow.webContents.once('did-finish-load', () => {
            // Wait a bit for translations to load in renderer before sending stats
            setTimeout(() => {
                sendStats(); // Send stats for all profiles
            }, 500);
        });
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        } else {
            mainWindow?.show();
        }
    });
});


app.on('before-quit', async (event) => {
    if (isQuittingCleanup) {
        return;
    }

    isQuittingCleanup = true;
    event.preventDefault();

    isQuitting = true;
    console.log('Quitting app...');

    // Stop all syncers, close all databases, stop all MCP servers, and terminate LLM services
    for (const [profileId, state] of profileStates.entries()) {
        syncCancelled.set(profileId, true);
        if (state.syncer) {
            await state.syncer.stop();
        }

        if (state.mcpServer?.isRunning()) {
            const port = state.mcpServer.getPort();
            await state.mcpServer.stop();
            portUsage.delete(port);
        }

        if (state.embeddingService) {
            try {
                await state.embeddingService.terminate();
            } catch (error) {
                console.error(`Error terminating embedding service for ${profileId}:`, error);
            }
            state.embeddingService = null;
        }

        if (state.llmChatService) {
            try {
                await state.llmChatService.terminate();
            } catch (error) {
                console.error(`Error terminating chat service for ${profileId}:`, error);
            }
            state.llmChatService = null;
        }

        state.database?.close();
    }
    profileStates.clear();
    syncCancelled.clear();
    portUsage.clear();

    tray?.destroy();
    console.log('Cleanup complete');
    app.exit(0);
});
