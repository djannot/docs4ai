import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

interface Stats {
    isSyncing: boolean;
    trackedFiles: number;
    totalChunks: number;
}

interface ProfileStats extends Stats {
    profileId: string;
}

interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
            name: string;
            arguments: string;
        };
    }>;
    tool_call_id?: string;
    name?: string;
}

interface ChatOptions {
    profileId: string;
    messages: ChatMessage[];
    llmProvider: 'local-qwen3' | 'local-qwen3-4b' | 'openai';
    openaiApiKey?: string;
    openaiModel?: string;
    enableTools?: boolean;
    temperature?: number;
    maxTokens?: number;
    requestId?: string;
}

interface ChatResult {
    message: ChatMessage;
    finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

contextBridge.exposeInMainWorld('api', {
    getProfiles: () => ipcRenderer.invoke('get-profiles'),
    getProfileSettings: (profileId: string) => ipcRenderer.invoke('get-profile-settings', profileId),
    createProfile: (name: string) => ipcRenderer.invoke('create-profile', name),
    deleteProfile: (profileId: string) => ipcRenderer.invoke('delete-profile', profileId),
    updateProfile: (profileId: string, updates: Record<string, unknown>) => ipcRenderer.invoke('update-profile', profileId, updates),
    setActiveProfile: (profileId: string) => ipcRenderer.invoke('set-active-profile', profileId),
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    selectDatabase: () => ipcRenderer.invoke('select-database'),
    startDriveAuth: (profileId: string) => ipcRenderer.invoke('start-drive-auth', profileId),
    disconnectDrive: (profileId: string) => ipcRenderer.invoke('disconnect-drive', profileId),
    listDriveFolders: (profileId: string, parentId: string | null, query: string | null, pageToken?: string) =>
        ipcRenderer.invoke('list-drive-folders', profileId, parentId, query, pageToken),
    listDriveFoldersWithDrive: (profileId: string, parentId: string | null, query: string | null, pageToken: string | undefined, driveId: string | null) =>
        ipcRenderer.invoke('list-drive-folders', profileId, parentId, query, pageToken, driveId),
    listDriveSharedDrives: (profileId: string, query: string | null, pageToken?: string) =>
        ipcRenderer.invoke('list-drive-shared-drives', profileId, query, pageToken),
    getDriveFolderPath: (profileId: string, folderId: string) =>
        ipcRenderer.invoke('get-drive-folder-path', profileId, folderId),
    getStats: (profileId: string) => ipcRenderer.invoke('get-stats', profileId),
    getFiles: (profileId: string) => ipcRenderer.invoke('get-files', profileId),
    getChunks: (profileId: string, filePath: string) => ipcRenderer.invoke('get-chunks', profileId, filePath),
    startWatching: (profileId: string) => ipcRenderer.invoke('start-watching', profileId),
    stopWatching: (profileId: string) => ipcRenderer.invoke('stop-watching', profileId),
    forceSync: (profileId: string) => ipcRenderer.invoke('force-sync', profileId),
    clearDatabase: (profileId: string) => ipcRenderer.invoke('clear-database', profileId),
    startMcpServer: (profileId: string) => ipcRenderer.invoke('start-mcp-server', profileId),
    stopMcpServer: (profileId: string) => ipcRenderer.invoke('stop-mcp-server', profileId),
    getMcpStatus: (profileId: string) => ipcRenderer.invoke('get-mcp-status', profileId),
    updateMcpPort: (profileId: string, port: number) => ipcRenderer.invoke('update-mcp-port', profileId, port),
    onStatsUpdate: (callback: (stats: ProfileStats) => void) => {
        ipcRenderer.on('stats-update', (_event: IpcRendererEvent, stats: ProfileStats) => callback(stats));
    },
    onStatsUpdateAll: (callback: (stats: ProfileStats[]) => void) => {
        ipcRenderer.on('stats-update-all', (_event: IpcRendererEvent, stats: ProfileStats[]) => callback(stats));
    },
    onApiKeyError: (callback: (data: { profileId: string; message: string }) => void) => {
        ipcRenderer.on('api-key-error', (_event: IpcRendererEvent, data: { profileId: string; message: string }) => callback(data));
    },
    onSwitchProfile: (callback: (profileId: string) => void) => {
        ipcRenderer.on('switch-profile', (_event: IpcRendererEvent, profileId: string) => callback(profileId));
    },
    getLanguage: () => ipcRenderer.invoke('get-language'),
    getAvailableLanguages: () => ipcRenderer.invoke('get-available-languages'),
    setLanguage: (locale: string) => ipcRenderer.invoke('set-language', locale),
    getTranslations: (locale?: string) => ipcRenderer.invoke('get-translations', locale),
    onLanguageChanged: (callback: (locale: string) => void) => {
        ipcRenderer.on('language-changed', (_event: IpcRendererEvent, locale: string) => callback(locale));
    },
    onModelDownloadProgress: (callback: (data: { profileId: string; status: string; file?: string; percent?: number; modelName?: string }) => void) => {
        ipcRenderer.on('model-download-progress', (_event: IpcRendererEvent, data) => callback(data));
    },

    // Chat API
    startChat: (profileId: string, llmProvider: 'local-qwen3' | 'local-qwen3-4b' | 'openai', openaiApiKey?: string, openaiModel?: string) =>
        ipcRenderer.invoke('start-chat', profileId, llmProvider, openaiApiKey, openaiModel),
    stopChat: (profileId: string) => ipcRenderer.invoke('stop-chat', profileId),
    sendChatMessage: (options: ChatOptions) => ipcRenderer.invoke('send-chat-message', options),
    getChatStatus: (profileId: string) => ipcRenderer.invoke('get-chat-status', profileId),
    onChatResponse: (callback: (data: { profileId: string; message: ChatMessage; finishReason: string; usage?: any }) => void) => {
        ipcRenderer.on('chat-response', (_event: IpcRendererEvent, data) => callback(data));
    },
    onChatError: (callback: (data: { profileId: string; error: string }) => void) => {
        ipcRenderer.on('chat-error', (_event: IpcRendererEvent, data) => callback(data));
    },
    onChatToolCall: (callback: (data: { profileId: string; requestId?: string; toolCall: { name: string; arguments: any; response: any } }) => void) => {
        ipcRenderer.on('chat-tool-call', (_event: IpcRendererEvent, data) => callback(data));
    },
    onLlmDownloadProgress: (callback: (data: { profileId: string; status: string; file?: string; progress?: number; loaded?: number; total?: number; error?: string }) => void) => {
        ipcRenderer.on('llm-download-progress', (_event: IpcRendererEvent, data) => callback(data));
    }
});
