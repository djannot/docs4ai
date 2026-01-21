/**
 * Worker thread for generating embeddings with local models.
 * This runs in a separate thread to avoid blocking the main Electron process.
 */

import { parentPort, workerData } from 'worker_threads';

interface WorkerData {
    modelId: string;
    quantized: boolean;
    cacheDir: string;
}

interface EmbeddingRequest {
    id: string;
    type: 'embed' | 'init' | 'shutdown';
    text?: string;
}

interface EmbeddingResponse {
    id: string;
    type: 'ready' | 'embedding' | 'error' | 'progress';
    embedding?: number[];
    tokens?: number;
    error?: string;
    progress?: {
        status: string;
        file?: string;
        loaded?: number;
        total?: number;
        percent?: number;
    };
}

let pipeline: any = null;
let localPipeline: any = null;

// Track total download progress
let filesDownloading = new Map<string, { loaded: number; total: number }>();
let hasStartedDownload = false;
let lastSentPercent = -1;
let hasModelFile = false; // Track if we've seen the main model file
let downloadStartTime = 0; // Track when download started

// Use Function constructor to create a dynamic import that bypasses TypeScript's transformation
async function dynamicImport(modulePath: string): Promise<any> {
    const importFn = new Function('modulePath', 'return import(modulePath)');
    return importFn(modulePath);
}

function sendTotalProgress() {
    if (!hasStartedDownload) return;
    
    // Don't send progress until we've seen the main model file (onnx)
    // This prevents showing 100% from small config files
    if (!hasModelFile) return;
    
    // Calculate total progress from all files
    let totalLoaded = 0;
    let totalSize = 0;
    
    for (const [file, info] of filesDownloading) {
        totalLoaded += info.loaded;
        totalSize += info.total;
    }
    
    if (totalSize > 0) {
        const percent = Math.round((totalLoaded / totalSize) * 100);
        
        // Only send if percent changed (avoid spamming)
        if (percent !== lastSentPercent) {
            lastSentPercent = percent;
            parentPort?.postMessage({
                id: 'progress',
                type: 'progress',
                progress: {
                    status: 'downloading',
                    loaded: totalLoaded,
                    total: totalSize,
                    percent
                }
            });
        }
    }
}

async function initializeModel() {
    const { modelId, quantized, cacheDir } = workerData as WorkerData;

    try {
        // Dynamic import for transformers.js (using workaround for ESM)
        const transformers = await dynamicImport('@huggingface/transformers');
        pipeline = transformers.pipeline;
        const env = transformers.env;

        // Configure cache directory
        env.cacheDir = cacheDir;
        env.localModelPath = cacheDir;
        env.allowRemoteModels = true;

        console.log(`[Worker] Loading model: ${modelId}...`);
        
        localPipeline = await pipeline('feature-extraction', modelId, {
            quantized,
            progress_callback: (progress: any) => {
                if (progress.status === 'progress' && progress.total) {
                    // Track this file's progress
                    if (!filesDownloading.has(progress.file)) {
                        // First time seeing this file - it's a new download
                        filesDownloading.set(progress.file, { loaded: progress.loaded, total: progress.total });
                        
                        // Only consider it a real download if progress is less than 90%
                        // (cached files might show 100% immediately)
                        const filePercent = (progress.loaded / progress.total) * 100;
                        if (filePercent < 90) {
                            if (!hasStartedDownload) {
                                hasStartedDownload = true;
                                downloadStartTime = Date.now();
                                console.log(`[Worker] Started downloading model...`);
                            }
                        }
                        
                        // Check if this is the main model file (onnx files are the largest)
                        if (progress.file && progress.file.includes('.onnx')) {
                            hasModelFile = true;
                        }
                    } else {
                        // Update existing file progress
                        filesDownloading.set(progress.file, { loaded: progress.loaded, total: progress.total });
                    }
                    sendTotalProgress();
                } else if (progress.status === 'done' && progress.file) {
                    // Only log if this was an actual download (not cached)
                    if (hasStartedDownload) {
                        console.log(`[Worker] Downloaded: ${progress.file}`);
                    }
                    // Mark file as complete
                    const info = filesDownloading.get(progress.file);
                    if (info) {
                        filesDownloading.set(progress.file, { loaded: info.total, total: info.total });
                        sendTotalProgress();
                    }
                }
            }
        });
        
        console.log(`[Worker] Model loaded successfully: ${modelId}`);
        
        // Send ready message
        const response: EmbeddingResponse = { id: 'init', type: 'ready' };
        parentPort?.postMessage(response);
    } catch (error: any) {
        console.error(`[Worker] Failed to load model:`, error);
        const response: EmbeddingResponse = {
            id: 'init',
            type: 'error',
            error: error.message || 'Failed to load model'
        };
        parentPort?.postMessage(response);
    }
}

async function generateEmbedding(id: string, text: string) {
    console.log(`[Worker] Received embedding request ${id} (text length: ${text.length})`);
    const startTime = Date.now();

    if (!localPipeline) {
        console.log(`[Worker] Error: Model not loaded for request ${id}`);
        const response: EmbeddingResponse = {
            id,
            type: 'error',
            error: 'Model not loaded'
        };
        parentPort?.postMessage(response);
        return;
    }

    try {
        console.log(`[Worker] Starting embedding generation for ${id}...`);
        const output = await localPipeline(text, {
            pooling: 'mean',
            normalize: true
        });

        const elapsed = Date.now() - startTime;
        const embedding = Array.from(output.data as Float32Array);
        const tokens = Math.ceil(text.length / 4); // Rough estimate

        console.log(`[Worker] Completed ${id} in ${elapsed}ms (embedding size: ${embedding.length})`);

        const response: EmbeddingResponse = {
            id,
            type: 'embedding',
            embedding,
            tokens
        };
        parentPort?.postMessage(response);
    } catch (error: any) {
        const elapsed = Date.now() - startTime;
        console.log(`[Worker] Error for ${id} after ${elapsed}ms: ${error.message}`);
        const response: EmbeddingResponse = {
            id,
            type: 'error',
            error: error.message || 'Failed to generate embedding'
        };
        parentPort?.postMessage(response);
    }
}

// Handle messages from main thread
parentPort?.on('message', async (message: EmbeddingRequest) => {
    switch (message.type) {
        case 'embed':
            if (message.text) {
                await generateEmbedding(message.id, message.text);
            }
            break;
        case 'shutdown':
            process.exit(0);
            break;
    }
});

// Initialize model on worker start
initializeModel();
