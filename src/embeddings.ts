import OpenAI from 'openai';
import * as path from 'path';
import { app } from 'electron';
import * as fs from 'fs';
import { LlamaServer, QWEN3_EMBEDDING_MODEL, ModelDownloadProgress } from './llama-server';

// Get the models directory
export function getModelCacheDir(): string {
    const userDataPath = app.getPath('userData');
    return path.join(userDataPath, 'models');
}

// Provider types - includes legacy types for backward compatibility
// All local-* variants map to the same Qwen3 embedding model via llama-server
export type EmbeddingProvider = 'local' | 'local-minilm' | 'local-e5' | 'local-e5-large' | 'openai';

// Model configuration
export interface LocalModelConfig {
    id: string;
    name: string;
    repoId: string;
    filename: string;
    dimension: number;
    sizeApprox: string;
    description: string;
}

// Single local model using Qwen3 Embedding via llama-server
export const LOCAL_MODEL: LocalModelConfig = {
    id: 'local',
    name: QWEN3_EMBEDDING_MODEL.name,
    repoId: QWEN3_EMBEDDING_MODEL.repoId,
    filename: QWEN3_EMBEDDING_MODEL.filename,
    dimension: QWEN3_EMBEDDING_MODEL.dimension,
    sizeApprox: '~639 MB',
    description: 'High quality embeddings via llama.cpp'
};

// Legacy LOCAL_MODELS for backward compatibility (all map to same model)
export const LOCAL_MODELS: Record<string, LocalModelConfig> = {
    'local': LOCAL_MODEL,
    'local-minilm': LOCAL_MODEL,
    'local-e5': LOCAL_MODEL,
    'local-e5-large': LOCAL_MODEL
};

// Dimension constants
export const LOCAL_EMBEDDING_DIMENSION = QWEN3_EMBEDDING_MODEL.dimension;
export const OPENAI_EMBEDDING_DIMENSION = 3072;

// Legacy dimension constants for backward compatibility
export const MINILM_EMBEDDING_DIMENSION = LOCAL_EMBEDDING_DIMENSION;
export const E5_EMBEDDING_DIMENSION = LOCAL_EMBEDDING_DIMENSION;
export const E5_LARGE_EMBEDDING_DIMENSION = LOCAL_EMBEDDING_DIMENSION;

// Get embedding dimension for a provider
export function getEmbeddingDimension(provider: EmbeddingProvider): number {
    if (provider === 'openai') {
        return OPENAI_EMBEDDING_DIMENSION;
    }
    return LOCAL_EMBEDDING_DIMENSION;
}

export class InvalidApiKeyError extends Error {
    constructor(message: string = 'Invalid OpenAI API key') {
        super(message);
        this.name = 'InvalidApiKeyError';
    }
}

export interface DownloadProgress {
    status: 'loading' | 'downloading' | 'done' | 'ready';
    file?: string;
    percent?: number;
    modelName?: string;
}

// Port for embedding server (different from chat server)
const EMBEDDING_SERVER_PORT = 8788;

export class EmbeddingService {
    private client: OpenAI | null = null;
    private openaiModel = 'text-embedding-3-large';
    private _isValid = true;
    private provider: EmbeddingProvider;
    private llamaServer: LlamaServer | null = null;
    private initPromise: Promise<void> | null = null;
    private modelConfig: LocalModelConfig | null = null;
    private downloadProgressCallback: ((progress: DownloadProgress) => void) | null = null;
    private isServerReady = false;
    private contextLength: number;

    constructor(provider: EmbeddingProvider = 'local', apiKey?: string, contextLength?: number) {
        // Normalize legacy providers to new simplified providers
        if (provider === 'local-minilm' || provider === 'local-e5' || provider === 'local-e5-large') {
            this.provider = 'local';
        } else {
            this.provider = provider;
        }

        // Set context length (default: 8192)
        this.contextLength = contextLength ?? 8192;

        if (this.provider === 'openai') {
            if (!apiKey) {
                throw new Error('OpenAI API key is required when using OpenAI provider');
            }
            this.client = new OpenAI({ apiKey });
        } else {
            // Local model via llama-server
            this.modelConfig = LOCAL_MODEL;
            this.llamaServer = new LlamaServer();
            this.initPromise = this.initializeServer();
        }
    }

    setDownloadProgressCallback(callback: (progress: DownloadProgress) => void) {
        this.downloadProgressCallback = callback;
    }

    private async initializeServer(): Promise<void> {
        if (!this.llamaServer || !this.modelConfig) {
            throw new Error('No llama server or model config available');
        }

        const modelsDir = getModelCacheDir();
        const modelPath = path.join(modelsDir, this.modelConfig.filename);

        // Download model if needed
        if (!this.llamaServer.modelExists(modelPath)) {
            console.log(`Downloading embedding model: ${this.modelConfig.name}...`);

            const progressCallback = (progress: ModelDownloadProgress) => {
                if (this.downloadProgressCallback) {
                    this.downloadProgressCallback({
                        status: progress.status === 'downloading' ? 'downloading' :
                               progress.status === 'ready' ? 'ready' : 'loading',
                        file: progress.file,
                        percent: progress.progress,
                        modelName: this.modelConfig!.name
                    });
                }
            };

            await this.llamaServer.downloadModel(
                this.modelConfig.repoId,
                this.modelConfig.filename,
                modelPath,
                progressCallback
            );
        }

        // Start the llama-server with embedding mode
        console.log(`Starting embedding server on port ${EMBEDDING_SERVER_PORT}...`);

        const progressCallback = (progress: ModelDownloadProgress) => {
            if (this.downloadProgressCallback && progress.status === 'ready') {
                this.downloadProgressCallback({
                    status: 'ready',
                    modelName: this.modelConfig!.name
                });
            }
        };

        await this.llamaServer.start({
            modelPath,
            port: EMBEDDING_SERVER_PORT,
            contextSize: this.contextLength,  // Use configured context length
            threads: 4,
            embedding: true    // Enable embedding mode
        }, progressCallback);

        this.isServerReady = true;
        console.log(`Embedding server ready: ${this.modelConfig.name}`);
    }

    /**
     * Terminate the llama-server. Call this when shutting down.
     */
    async terminate(): Promise<void> {
        if (this.llamaServer) {
            await this.llamaServer.stop();
            this.llamaServer = null;
        }
        this.isServerReady = false;
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

    async validateApiKey(): Promise<boolean> {
        if (this.provider !== 'openai') {
            // For local model, just ensure server is ready
            if (this.initPromise) {
                await this.initPromise;
            }
            return this.isServerReady;
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
        // Wait for server to be ready
        if (this.initPromise) {
            await this.initPromise;
        }

        if (!this.llamaServer || !this.isServerReady) {
            throw new Error('Embedding server not ready');
        }

        try {
            const embeddings = await this.llamaServer.embeddings(text);

            if (!embeddings || embeddings.length === 0) {
                throw new Error('No embedding returned from server');
            }

            return {
                embedding: embeddings[0],
                tokens: Math.ceil(text.length / 4)  // Rough estimate
            };
        } catch (error: any) {
            console.error('Local embedding error:', error);
            throw new Error(`Failed to generate embedding: ${error.message}`);
        }
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

// Check if local embedding model is downloaded
export function isModelDownloaded(provider?: EmbeddingProvider): boolean {
    if (provider === 'openai') return true; // Not applicable

    const modelsDir = getModelCacheDir();
    const modelPath = path.join(modelsDir, LOCAL_MODEL.filename);
    return fs.existsSync(modelPath);
}
