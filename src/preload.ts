import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

interface Stats {
    isSyncing: boolean;
    trackedFiles: number;
    totalChunks: number;
}

contextBridge.exposeInMainWorld('api', {
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings: Record<string, unknown>) => ipcRenderer.invoke('save-settings', settings),
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    selectDatabase: () => ipcRenderer.invoke('select-database'),
    getStats: () => ipcRenderer.invoke('get-stats'),
    getFiles: () => ipcRenderer.invoke('get-files'),
    getChunks: (filePath: string) => ipcRenderer.invoke('get-chunks', filePath),
    startWatching: () => ipcRenderer.invoke('start-watching'),
    stopWatching: () => ipcRenderer.invoke('stop-watching'),
    forceSync: () => ipcRenderer.invoke('force-sync'),
    startMcpServer: () => ipcRenderer.invoke('start-mcp-server'),
    stopMcpServer: () => ipcRenderer.invoke('stop-mcp-server'),
    getMcpStatus: () => ipcRenderer.invoke('get-mcp-status'),
    onStatsUpdate: (callback: (stats: Stats) => void) => {
        ipcRenderer.on('stats-update', (_event: IpcRendererEvent, stats: Stats) => callback(stats));
    },
    onApiKeyError: (callback: (message: string) => void) => {
        ipcRenderer.on('api-key-error', (_event: IpcRendererEvent, message: string) => callback(message));
    }
});
