import OpenAI from 'openai';
import * as path from 'path';
import { app } from 'electron';
import * as fs from 'fs';
import { Worker } from 'worker_threads';

// CRITICAL: Pre-load onnxruntime-node in the main thread to avoid
// "Module did not self-register" errors when worker threads restart.
// See: https://github.com/xenova/transformers.js/issues/651
try {
    require('onnxruntime-node');
} catch (error) {
    // It's okay if this fails - optional dependency might not be installed
    // but we still want to try
}

// Get the cache directory for models
export function getModelCacheDir(): string {
    if (app?.isPackaged) {
        // Production: use app's userData directory
        return path.join(app.getPath('userData'), 'models');
    } else {
        // Development: use local cache in project directory
        return path.join(__dirname, '..', 'models');
    }
}

// Provider types
export type EmbeddingProvider = 'local-minilm' | 'local-e5' | 'local-e5-large' | 'openai';

// Model configurations
export interface LocalModelConfig {
    id: string;
    name: string;
    huggingFaceId: string;
    dimension: number;
    sizeApprox: string;
    description: string;
    quantized: boolean;
}

export const LOCAL_MODELS: Record<string, LocalModelConfig> = {
    'local-minilm': {
        id: 'local-minilm',
        name: 'MiniLM-L6 (Fast)',
        huggingFaceId: 'Xenova/all-MiniLM-L6-v2',
        dimension: 384,
        sizeApprox: '~23 MB',
        description: 'Fast and lightweight, good for general use',
        quantized: true
    },
    'local-e5': {
        id: 'local-e5',
        name: 'E5 Multilingual Base',
        huggingFaceId: 'Xenova/multilingual-e5-base',
        dimension: 768,
        sizeApprox: '~440 MB',
        description: 'Good quality, 100+ languages',
        quantized: true
    },
    'local-e5-large': {
        id: 'local-e5-large',
        name: 'E5 Multilingual Large',
        huggingFaceId: 'Xenova/multilingual-e5-large',
        dimension: 1024,
        sizeApprox: '~1.1 GB',
        description: 'Best quality, 100+ languages, largest download',
        quantized: true
    }
};

// Dimension constants for backward compatibility
export const MINILM_EMBEDDING_DIMENSION = 384;
export const E5_EMBEDDING_DIMENSION = 768;
export const E5_LARGE_EMBEDDING_DIMENSION = 1024;
export const OPENAI_EMBEDDING_DIMENSION = 3072;

// Legacy constant for backward compatibility
export const LOCAL_EMBEDDING_DIMENSION = MINILM_EMBEDDING_DIMENSION;

// Get embedding dimension for a provider
export function getEmbeddingDimension(provider: EmbeddingProvider): number {
    if (provider === 'openai') {
        return OPENAI_EMBEDDING_DIMENSION;
    }
    const model = LOCAL_MODELS[provider];
    return model?.dimension || MINILM_EMBEDDING_DIMENSION;
}

export class InvalidApiKeyError extends Error {
    constructor(message: string = 'Invalid OpenAI API key') {
        super(message);
        this.name = 'InvalidApiKeyError';
    }
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

export interface DownloadProgress {
    status: 'loading' | 'downloading' | 'done' | 'ready';
    file?: string;
    percent?: number;
    modelName?: string;
}

// Queue item for sequential processing
interface QueuedRequest {
    id: string;
    text: string;
    resolve: (value: { embedding: number[]; tokens: number }) => void;
    reject: (error: Error) => void;
    retried: boolean;
}

export class EmbeddingService {
    private client: OpenAI | null = null;
    private openaiModel = 'text-embedding-3-large';
    private _isValid = true;
    private provider: EmbeddingProvider;
    private worker: Worker | null = null;
    private initPromise: Promise<void> | null = null;
    private modelConfig: LocalModelConfig | null = null;
    private downloadProgressCallback: ((progress: DownloadProgress) => void) | null = null;
    private requestId = 0;
    private pendingRequests: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; text: string; retried: boolean }> = new Map();
    private isWorkerReady = false;
    private isShuttingDown = false; // Prevent restart during shutdown
    private restartAttempts = 0;
    private readonly MAX_RESTART_ATTEMPTS = 3;
    private readonly RESTART_DELAY_MS = 1000;

    // Request queue for sequential processing
    private requestQueue: QueuedRequest[] = [];
    private isProcessingQueue = false;
    private currentRequestId: string | null = null;

    constructor(provider: EmbeddingProvider = 'local-minilm', apiKey?: string) {
        this.provider = provider;
        
        if (provider === 'openai') {
            if (!apiKey) {
                throw new Error('OpenAI API key is required when using OpenAI provider');
            }
            this.client = new OpenAI({ apiKey });
        } else {
            // Local model
            this.modelConfig = LOCAL_MODELS[provider];
            if (!this.modelConfig) {
                throw new Error(`Unknown local model provider: ${provider}`);
            }
            this.initPromise = this.initializeWorker();
        }
    }

    setDownloadProgressCallback(callback: (progress: DownloadProgress) => void) {
        this.downloadProgressCallback = callback;
    }

    private async initializeWorker(): Promise<void> {
        if (!this.modelConfig) {
            throw new Error('No model config available');
        }

        return new Promise((resolve, reject) => {
            try {
                // Get the path to the worker script
                // When running via ts-jest, __dirname is 'src/', but compiled worker is in 'dist/'
                // So we need to check both locations
                let workerPath = path.join(__dirname, 'embedding-worker.js');
                if (!fs.existsSync(workerPath)) {
                    // Try dist/ directory (when running from src/ via ts-jest)
                    workerPath = path.join(__dirname, '..', 'dist', 'embedding-worker.js');
                }
                
                // Ensure cache directory exists
                const cacheDir = getModelCacheDir();
                if (!fs.existsSync(cacheDir)) {
                    fs.mkdirSync(cacheDir, { recursive: true });
                }
                
                console.log(`Starting embedding worker for: ${this.modelConfig!.name}...`);
                console.log(`Model: ${this.modelConfig!.huggingFaceId}`);
                console.log(`Worker path: ${workerPath}`);
                console.log(`Cache dir: ${cacheDir}`);
                
                // Create worker with model configuration
                this.worker = new Worker(workerPath, {
                    workerData: {
                        modelId: this.modelConfig!.huggingFaceId,
                        quantized: this.modelConfig!.quantized,
                        cacheDir
                    }
                });

                // Handle messages from worker
                this.worker.on('message', (response: EmbeddingResponse) => {
                    if (response.type === 'ready') {
                        this.isWorkerReady = true;
                        console.log(`Embedding worker ready: ${this.modelConfig!.name}`);
                        // Send ready progress notification
                        if (this.downloadProgressCallback) {
                            this.downloadProgressCallback({
                                status: 'ready',
                                modelName: this.modelConfig!.name
                            });
                        }
                        resolve();
                    } else if (response.type === 'progress') {
                        // Forward progress to callback
                        if (this.downloadProgressCallback && response.progress) {
                            this.downloadProgressCallback({
                                status: response.progress.status as 'loading' | 'downloading' | 'done',
                                file: response.progress.file,
                                percent: response.progress.percent,
                                modelName: this.modelConfig!.name
                            });
                        }
                    } else if (response.type === 'embedding') {
                        const pending = this.pendingRequests.get(response.id);
                        if (pending) {
                            this.pendingRequests.delete(response.id);
                            pending.resolve({
                                embedding: response.embedding!,
                                tokens: response.tokens!
                            });
                        }
                        // Process next item in queue
                        this.currentRequestId = null;
                        this.processNextInQueue();
                    } else if (response.type === 'error') {
                        if (response.id === 'init') {
                            reject(new Error(response.error || 'Failed to initialize worker'));
                        } else {
                            const pending = this.pendingRequests.get(response.id);
                            if (pending) {
                                this.pendingRequests.delete(response.id);
                                pending.reject(new Error(response.error || 'Worker error'));
                            }
                            // Process next item in queue even on error
                            this.currentRequestId = null;
                            this.processNextInQueue();
                        }
                    }
                });

                // Handle worker errors
                this.worker.on('error', (error) => {
                    console.error('Embedding worker error:', error);
                    this.isWorkerReady = false;
                    this.currentRequestId = null;

                    // Reject all pending requests
                    for (const [id, pending] of this.pendingRequests) {
                        pending.reject(error);
                    }
                    this.pendingRequests.clear();

                    // Reject all queued requests
                    for (const req of this.requestQueue) {
                        req.reject(error);
                    }
                    this.requestQueue = [];
                });

                // Handle worker exit
                this.worker.on('exit', (code) => {
                    console.log(`Embedding worker exited with code: ${code}`);
                    this.isWorkerReady = false;
                    this.worker = null;

                    // If not shutting down and exit was unexpected, try to restart
                    if (!this.isShuttingDown && code !== 0) {
                        console.log('Worker crashed unexpectedly, will attempt restart...');
                        this.handleWorkerCrash();
                    } else {
                        // Normal shutdown - reject all pending requests
                        for (const [id, pending] of this.pendingRequests) {
                            pending.reject(new Error(`Worker exited with code ${code}`));
                        }
                        this.pendingRequests.clear();
                    }
                });

            } catch (error) {
                console.error('Failed to create embedding worker:', error);
                reject(error);
            }
        });
    }

    /**
     * Handle worker crash by attempting to restart and retry pending requests
     */
    private async handleWorkerCrash(): Promise<void> {
        if (this.isShuttingDown) {
            return;
        }

        this.restartAttempts++;

        if (this.restartAttempts > this.MAX_RESTART_ATTEMPTS) {
            console.error(`Worker crashed ${this.MAX_RESTART_ATTEMPTS} times, giving up. Manual restart required.`);
            // Reject all pending requests
            for (const [id, pending] of this.pendingRequests) {
                pending.reject(new Error('Worker crashed repeatedly, service unavailable'));
            }
            this.pendingRequests.clear();
            // Reject all queued requests
            for (const req of this.requestQueue) {
                req.reject(new Error('Worker crashed repeatedly, service unavailable'));
            }
            this.requestQueue = [];
            this.currentRequestId = null;
            return;
        }

        console.log(`Attempting worker restart (attempt ${this.restartAttempts}/${this.MAX_RESTART_ATTEMPTS})...`);

        // Save pending requests that haven't been retried yet
        const requestsToRetry: QueuedRequest[] = [];

        // Save the current in-flight request
        for (const [id, pending] of this.pendingRequests) {
            if (!pending.retried) {
                requestsToRetry.push({
                    id,
                    text: pending.text,
                    resolve: pending.resolve,
                    reject: pending.reject,
                    retried: true // Mark as retried
                });
            } else {
                // Already retried once, reject it
                pending.reject(new Error('Worker crashed during retry'));
            }
        }
        this.pendingRequests.clear();
        this.currentRequestId = null;

        // Save queued requests (they haven't been sent yet, so don't mark as retried)
        const queuedToRetry = [...this.requestQueue];
        this.requestQueue = [];

        // Wait before restart (allows ONNX runtime to fully unload)
        await new Promise(resolve => setTimeout(resolve, this.RESTART_DELAY_MS));

        if (this.isShuttingDown) {
            // Shutdown was requested during the delay
            for (const req of requestsToRetry) {
                req.reject(new Error('Service shutting down'));
            }
            for (const req of queuedToRetry) {
                req.reject(new Error('Service shutting down'));
            }
            return;
        }

        try {
            // Restart the worker
            this.initPromise = this.initializeWorker();
            await this.initPromise;

            // Reset restart attempts on successful restart
            this.restartAttempts = 0;

            // Re-queue all requests (in-flight first, then queued)
            const totalToRetry = requestsToRetry.length + queuedToRetry.length;
            console.log(`Worker restarted, re-queueing ${totalToRetry} request(s)...`);

            // Add in-flight requests back to queue first (they were being processed)
            for (const req of requestsToRetry) {
                this.requestQueue.push(req);
            }

            // Add previously queued requests
            for (const req of queuedToRetry) {
                this.requestQueue.push(req);
            }

            // Start processing the queue
            this.processNextInQueue();
        } catch (error) {
            console.error('Failed to restart worker:', error);
            // Reject all saved requests
            for (const req of requestsToRetry) {
                req.reject(new Error(`Worker restart failed: ${error}`));
            }
            for (const req of queuedToRetry) {
                req.reject(new Error(`Worker restart failed: ${error}`));
            }
        }
    }

    /**
     * Terminate the worker thread. Call this when shutting down.
     */
    async terminate(): Promise<void> {
        this.isShuttingDown = true; // Prevent auto-restart

        // Reject all queued requests
        for (const req of this.requestQueue) {
            req.reject(new Error('Service shutting down'));
        }
        this.requestQueue = [];
        this.currentRequestId = null;

        if (this.worker) {
            const request: EmbeddingRequest = { id: 'shutdown', type: 'shutdown' };
            this.worker.postMessage(request);

            // Give worker time to clean up, then force terminate
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    if (this.worker) {
                        this.worker.terminate();
                        this.worker = null;
                    }
                    resolve();
                }, 1000);

                if (this.worker) {
                    this.worker.once('exit', () => {
                        clearTimeout(timeout);
                        this.worker = null;
                        resolve();
                    });
                } else {
                    clearTimeout(timeout);
                    resolve();
                }
            });

            // CRITICAL: Add delay after worker exit to ensure native modules (onnxruntime-node)
            // are fully unloaded before a new worker can load them. Without this delay,
            // restarting the worker causes "Module did not self-register" errors.
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    get isValid(): boolean {
        return this._isValid;
    }

    get embeddingDimension(): number {
        return getEmbeddingDimension(this.provider);
    }

    getProvider(): EmbeddingProvider {
        return this.provider;
    }

    getModelConfig(): LocalModelConfig | null {
        return this.modelConfig;
    }

    /**
     * Get the current queue size (for monitoring/debugging)
     */
    getQueueSize(): number {
        return this.requestQueue.length;
    }

    /**
     * Check if currently processing a request
     */
    isProcessing(): boolean {
        return this.currentRequestId !== null;
    }

    async validateApiKey(): Promise<boolean> {
        if (this.provider !== 'openai') {
            // For local model, just ensure worker is ready
            if (this.initPromise) {
                await this.initPromise;
            }
            return this.isWorkerReady;
        }

        try {
            // Make a minimal API call to validate the key
            await this.client!.embeddings.create({
                model: this.openaiModel,
                input: 'test'
            });
            return true;
        } catch (error: any) {
            if (error?.status === 401 || error?.code === 'invalid_api_key' || 
                error?.message?.includes('Incorrect API key') ||
                error?.message?.includes('invalid_api_key')) {
                this._isValid = false;
                return false;
            }
            // Other errors (rate limit, etc.) - key might still be valid
            throw error;
        }
    }

    async generateEmbedding(text: string): Promise<{ embedding: number[]; tokens: number }> {
        if (!this._isValid) {
            throw new InvalidApiKeyError();
        }

        if (this.provider === 'openai') {
            return this.generateOpenAIEmbedding(text);
        } else {
            return this.generateLocalEmbedding(text);
        }
    }

    private async generateLocalEmbedding(text: string): Promise<{ embedding: number[]; tokens: number }> {
        // Wait for worker to be ready
        if (this.initPromise) {
            await this.initPromise;
        }

        if (!this.worker || !this.isWorkerReady) {
            throw new Error('Embedding worker not ready');
        }

        return new Promise((resolve, reject) => {
            const id = `req_${++this.requestId}`;

            // Add to queue instead of sending directly
            const queuedRequest: QueuedRequest = {
                id,
                text,
                resolve,
                reject,
                retried: false
            };

            this.requestQueue.push(queuedRequest);
            console.log(`[Queue] Added request ${id}, queue size: ${this.requestQueue.length}`);

            // Start processing if not already
            this.processNextInQueue();
        });
    }

    /**
     * Process the next request in the queue (one at a time)
     */
    private processNextInQueue(): void {
        // Don't process if already processing or queue is empty
        if (this.isProcessingQueue || this.requestQueue.length === 0) {
            return;
        }

        // Don't process if worker is not ready
        if (!this.worker || !this.isWorkerReady) {
            console.log('[Queue] Worker not ready, waiting...');
            return;
        }

        // Get next request from queue
        const queuedRequest = this.requestQueue.shift();
        if (!queuedRequest) {
            return;
        }

        this.isProcessingQueue = true;
        this.currentRequestId = queuedRequest.id;

        console.log(`[Queue] Processing request ${queuedRequest.id}, remaining in queue: ${this.requestQueue.length}`);

        // Store in pending requests for response handling
        this.pendingRequests.set(queuedRequest.id, {
            resolve: queuedRequest.resolve,
            reject: queuedRequest.reject,
            text: queuedRequest.text,
            retried: queuedRequest.retried
        });

        // Send request to worker
        const request: EmbeddingRequest = {
            id: queuedRequest.id,
            type: 'embed',
            text: queuedRequest.text
        };

        this.worker!.postMessage(request);
        this.isProcessingQueue = false;
    }

    private async generateOpenAIEmbedding(text: string): Promise<{ embedding: number[]; tokens: number }> {
        try {
            const response = await this.client!.embeddings.create({
                model: this.openaiModel,
                input: text
            });

            if (!response.data?.[0]?.embedding) {
                throw new Error('Failed to get embedding from OpenAI');
            }

            // Extract token count from usage (total_tokens includes input tokens)
            const tokens = response.usage?.total_tokens || 0;

            return {
                embedding: response.data[0].embedding,
                tokens
            };
        } catch (error: any) {
            // Check for authentication errors (401)
            if (error?.status === 401 || error?.code === 'invalid_api_key' || 
                error?.message?.includes('Incorrect API key') ||
                error?.message?.includes('invalid_api_key')) {
                this._isValid = false;
                throw new InvalidApiKeyError(error.message || 'Invalid OpenAI API key');
            }
            throw error;
        }
    }

    async generateEmbeddings(texts: string[]): Promise<{ embeddings: number[][]; totalTokens: number }> {
        const embeddings: number[][] = [];
        let totalTokens = 0;

        for (const text of texts) {
            const result = await this.generateEmbedding(text);
            embeddings.push(result.embedding);
            totalTokens += result.tokens;
            
            // Small delay to avoid rate limits (only needed for OpenAI)
            if (this.provider === 'openai') {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        return { embeddings, totalTokens };
    }
}

// Check if a local model is downloaded
export function isModelDownloaded(provider: EmbeddingProvider): boolean {
    if (provider === 'openai') return true; // Not applicable
    
    const model = LOCAL_MODELS[provider];
    if (!model) return false;
    
    const cacheDir = getModelCacheDir();
    // Check for the model directory in cache
    // Transformers.js stores models in a specific format
    const modelPath = path.join(cacheDir, model.huggingFaceId.replace('/', '--'));
    return fs.existsSync(modelPath);
}
