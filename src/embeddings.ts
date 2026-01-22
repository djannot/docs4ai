import OpenAI from 'openai';
import * as path from 'path';
import { app } from 'electron';
import * as fs from 'fs';
import { QWEN3_EMBEDDING_MODEL } from './llama-server';
import type { Llama, LlamaEmbeddingContext, LlamaModel } from 'node-llama-cpp';
import * as https from 'https';
import * as http from 'http';

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

export class EmbeddingService {
    private client: OpenAI | null = null;
    private openaiModel = 'text-embedding-3-large';
    private _isValid = true;
    private provider: EmbeddingProvider;
    private llama: Llama | null = null;
    private model: LlamaModel | null = null;
    private embeddingContext: LlamaEmbeddingContext | null = null;
    private initPromise: Promise<void> | null = null;
    private modelConfig: LocalModelConfig | null = null;
    private downloadProgressCallback: ((progress: DownloadProgress) => void) | null = null;
    private isModelReady = false;
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
            // Local model via node-llama-cpp
            this.modelConfig = LOCAL_MODEL;
            this.initPromise = this.initializeLocalModel();
        }
    }

    setDownloadProgressCallback(callback: (progress: DownloadProgress) => void) {
        this.downloadProgressCallback = callback;
    }

    private async initializeLocalModel(): Promise<void> {
        if (!this.modelConfig) {
            throw new Error('No local model config available');
        }

        const modelsDir = getModelCacheDir();
        const modelPath = path.join(modelsDir, this.modelConfig.filename);

        await this.downloadModelIfNeeded(modelPath, this.modelConfig);

        const nodeLlama = await this.loadNodeLlama();
        const llama = await nodeLlama.getLlama();
        const model = await llama.loadModel({ modelPath });
        const embeddingContext = await model.createEmbeddingContext({
            contextSize: this.contextLength,
            threads: 4,
            batchSize: 512
        });

        this.llama = llama;
        this.model = model;
        this.embeddingContext = embeddingContext;
        this.isModelReady = true;
        console.log(`Embedding model ready: ${this.modelConfig.name}`);
    }

    private async loadNodeLlama(): Promise<typeof import('node-llama-cpp')> {
        const globalMock = (globalThis as any).__docs4aiNodeLlamaMock;
        if (globalMock) {
            return globalMock as typeof import('node-llama-cpp');
        }

        const loader = new Function('specifier', 'return import(specifier);');
        return loader('node-llama-cpp') as Promise<typeof import('node-llama-cpp')>;
    }

    private reportDownloadProgress(progress: DownloadProgress) {
        if (this.downloadProgressCallback) {
            this.downloadProgressCallback(progress);
        }
    }

    private async downloadModelIfNeeded(modelPath: string, modelConfig: LocalModelConfig): Promise<void> {
        if (process.env.DOCS4AI_SKIP_MODEL_DOWNLOAD === '1') {
            return;
        }

        if (fs.existsSync(modelPath)) {
            return;
        }

        console.log(`Downloading embedding model: ${modelConfig.name}...`);
        this.reportDownloadProgress({
            status: 'downloading',
            file: modelConfig.filename,
            percent: 0,
            modelName: modelConfig.name
        });

        await this.downloadModel(modelConfig.repoId, modelConfig.filename, modelPath, modelConfig.name);
        this.reportDownloadProgress({ status: 'ready', modelName: modelConfig.name });
    }

    private async downloadModel(
        repoId: string,
        filename: string,
        targetPath: string,
        modelName: string
    ): Promise<void> {
        const modelsDir = path.dirname(targetPath);
        if (!fs.existsSync(modelsDir)) {
            fs.mkdirSync(modelsDir, { recursive: true });
        }

        const url = `https://huggingface.co/${repoId}/resolve/main/${filename}`;

        return new Promise((resolve, reject) => {
            const request = https.get(url, {
                headers: { 'User-Agent': 'Docs4ai/1.0' }
            }, (response) => {
                if (response.statusCode === 302 || response.statusCode === 301) {
                    const redirectUrl = response.headers.location;
                    if (redirectUrl) {
                        this.downloadFromUrl(redirectUrl, targetPath, modelName, filename)
                            .then(resolve)
                            .catch(reject);
                        return;
                    }
                }

                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download model: HTTP ${response.statusCode}`));
                    return;
                }

                const totalSize = parseInt(response.headers['content-length'] || '0', 10);
                let downloadedSize = 0;

                const fileStream = fs.createWriteStream(targetPath);

                response.on('data', (chunk: Buffer) => {
                    downloadedSize += chunk.length;
                    const percent = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0;
                    this.reportDownloadProgress({
                        status: 'downloading',
                        file: filename,
                        percent,
                        modelName
                    });
                });

                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve();
                });

                fileStream.on('error', (err) => {
                    fs.unlink(targetPath, () => {});
                    reject(err);
                });
            });

            request.on('error', reject);
        });
    }

    private async downloadFromUrl(
        url: string,
        targetPath: string,
        modelName: string,
        filename: string
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const protocol = url.startsWith('https') ? https : http;

            const request = protocol.get(url, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
                    return;
                }

                const totalSize = parseInt(response.headers['content-length'] || '0', 10);
                let downloadedSize = 0;

                const fileStream = fs.createWriteStream(targetPath);

                response.on('data', (chunk: Buffer) => {
                    downloadedSize += chunk.length;
                    const percent = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0;
                    this.reportDownloadProgress({
                        status: 'downloading',
                        file: filename,
                        percent,
                        modelName
                    });
                });

                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    resolve();
                });

                fileStream.on('error', (err) => {
                    fs.unlink(targetPath, () => {});
                    reject(err);
                });
            });

            request.on('error', reject);
        });
    }

    private async ensureLocalModelReady(): Promise<void> {
        if (this.initPromise) {
            await this.initPromise;
        }

        if (!this.embeddingContext) {
            this.isModelReady = false;
            this.initPromise = this.initializeLocalModel();
            await this.initPromise;
        }

        if (!this.embeddingContext) {
            throw new Error('Embedding model not ready');
        }
    }

    /**
     * Terminate the llama-server. Call this when shutting down.
     */
    async terminate(): Promise<void> {
        if (this.embeddingContext) {
            await this.embeddingContext.dispose();
            this.embeddingContext = null;
        }
        if (this.model) {
            await this.model.dispose();
            this.model = null;
        }
        this.llama = null;
        this.isModelReady = false;
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
            // For local model, ensure model is ready
            await this.ensureLocalModelReady();
            return true;
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
        await this.ensureLocalModelReady();

        if (!this.embeddingContext) {
            throw new Error('Embedding model not initialized');
        }

        try {
            const embedding = await this.embeddingContext.getEmbeddingFor(text);
            const vector = Array.from(embedding.vector as Iterable<number>);
            const tokens = this.model ? this.model.tokenize(text).length : Math.ceil(text.length / 4);

            return {
                embedding: vector,
                tokens
            };
        } catch (error: any) {
            console.error('Local embedding error:', error);
            throw new Error(`Failed to generate embedding: ${error.message || 'Unknown error'}`);
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
