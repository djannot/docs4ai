import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import { app } from 'electron';

export interface LlamaServerConfig {
    modelPath: string;
    port: number;
    contextSize?: number;
    gpuLayers?: number;
    threads?: number;
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, any>;
    };
}

export interface ChatCompletionOptions {
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
}

export interface ChatCompletionResult {
    message: ChatMessage;
    finishReason: 'stop' | 'tool_calls' | 'length';
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

export interface ModelDownloadProgress {
    status: 'downloading' | 'ready' | 'error';
    file?: string;
    progress?: number;
    loaded?: number;
    total?: number;
    error?: string;
}

type ProgressCallback = (progress: ModelDownloadProgress) => void;

/**
 * LlamaServer - Manages a llama-server (llama.cpp) binary as a sidecar process
 * This can be used for both chat completions and embeddings
 */
export class LlamaServer {
    private process: ChildProcess | null = null;
    private config: LlamaServerConfig | null = null;
    private isReady: boolean = false;
    private startPromise: Promise<void> | null = null;

    /**
     * Get the path to the llama-server binary for the current platform
     */
    private getBinaryPath(): string {
        const platform = process.platform;
        const arch = process.arch;

        let binaryName = 'llama-server';
        if (platform === 'win32') {
            binaryName = 'llama-server.exe';
        }

        // In development, look in project's bin directory
        // In production, look in app resources
        const isDev = !app.isPackaged;

        if (isDev) {
            return path.join(process.cwd(), 'bin', platform, arch, binaryName);
        } else {
            return path.join(process.resourcesPath, 'bin', platform, arch, binaryName);
        }
    }

    /**
     * Get the default models directory
     */
    getModelsDir(): string {
        const userDataPath = app.getPath('userData');
        return path.join(userDataPath, 'models');
    }

    /**
     * Check if a model file exists
     */
    modelExists(modelPath: string): boolean {
        return fs.existsSync(modelPath);
    }

    /**
     * Download a model from HuggingFace
     */
    async downloadModel(
        repoId: string,
        filename: string,
        targetPath: string,
        onProgress?: ProgressCallback
    ): Promise<void> {
        const modelsDir = path.dirname(targetPath);
        if (!fs.existsSync(modelsDir)) {
            fs.mkdirSync(modelsDir, { recursive: true });
        }

        const url = `https://huggingface.co/${repoId}/resolve/main/${filename}`;

        return new Promise((resolve, reject) => {
            onProgress?.({ status: 'downloading', file: filename, progress: 0 });

            const request = https.get(url, {
                headers: { 'User-Agent': 'Docs4ai/1.0' }
            }, (response) => {
                // Handle redirects
                if (response.statusCode === 302 || response.statusCode === 301) {
                    const redirectUrl = response.headers.location;
                    if (redirectUrl) {
                        this.downloadFromUrl(redirectUrl, targetPath, onProgress)
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
                    const progress = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0;
                    onProgress?.({
                        status: 'downloading',
                        file: filename,
                        progress,
                        loaded: downloadedSize,
                        total: totalSize
                    });
                });

                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    onProgress?.({ status: 'ready' });
                    resolve();
                });

                fileStream.on('error', (err) => {
                    fs.unlink(targetPath, () => {}); // Delete partial file
                    onProgress?.({ status: 'error', error: err.message });
                    reject(err);
                });
            });

            request.on('error', (err) => {
                onProgress?.({ status: 'error', error: err.message });
                reject(err);
            });
        });
    }

    /**
     * Download from a direct URL (used for redirects)
     */
    private downloadFromUrl(
        url: string,
        targetPath: string,
        onProgress?: ProgressCallback
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
                    const progress = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0;
                    onProgress?.({
                        status: 'downloading',
                        file: path.basename(targetPath),
                        progress,
                        loaded: downloadedSize,
                        total: totalSize
                    });
                });

                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    onProgress?.({ status: 'ready' });
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

    /**
     * Start the llama-server process
     */
    async start(config: LlamaServerConfig, onProgress?: ProgressCallback): Promise<void> {
        if (this.isReady && this.config?.port === config.port) {
            return;
        }

        // If already starting, wait for that
        if (this.startPromise) {
            return this.startPromise;
        }

        this.startPromise = this._start(config, onProgress);
        try {
            await this.startPromise;
        } finally {
            this.startPromise = null;
        }
    }

    private async _start(config: LlamaServerConfig, onProgress?: ProgressCallback): Promise<void> {
        // Stop any existing process
        await this.stop();

        this.config = config;
        const binaryPath = this.getBinaryPath();

        // Check if binary exists
        if (!fs.existsSync(binaryPath)) {
            throw new Error(`llama-server binary not found at ${binaryPath}. Please ensure the binary is installed.`);
        }

        // Check if model exists
        if (!fs.existsSync(config.modelPath)) {
            throw new Error(`Model not found at ${config.modelPath}`);
        }

        // Make binary executable on Unix
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(binaryPath, '755');
            } catch (e) {
                console.warn('Could not set binary permissions:', e);
            }
        }

        // Build command arguments
        const args: string[] = [
            '--model', config.modelPath,
            '--port', config.port.toString(),
            '--ctx-size', (config.contextSize || 4096).toString(),
            '--threads', (config.threads || 4).toString(),
            '--host', '127.0.0.1',
        ];

        if (config.gpuLayers !== undefined && config.gpuLayers > 0) {
            args.push('--n-gpu-layers', config.gpuLayers.toString());
        }

        console.log(`[LlamaServer] Starting: ${binaryPath} ${args.join(' ')}`);
        onProgress?.({ status: 'downloading', file: 'Starting server...' });

        return new Promise((resolve, reject) => {
            this.process = spawn(binaryPath, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env }
            });

            let startupOutput = '';
            const timeout = setTimeout(() => {
                if (!this.isReady) {
                    this.stop();
                    reject(new Error('Server startup timeout'));
                }
            }, 60000); // 60 second timeout

            this.process.stdout?.on('data', (data: Buffer) => {
                const output = data.toString();
                startupOutput += output;
                console.log('[LlamaServer stdout]', output.trim());

                // Check if server is ready
                if (output.includes('HTTP server listening') || output.includes('all slots are idle')) {
                    clearTimeout(timeout);
                    this.isReady = true;
                    onProgress?.({ status: 'ready' });
                    resolve();
                }
            });

            this.process.stderr?.on('data', (data: Buffer) => {
                const output = data.toString();
                console.log('[LlamaServer stderr]', output.trim());

                // llama-server outputs progress to stderr
                if (output.includes('HTTP server listening') || output.includes('all slots are idle')) {
                    clearTimeout(timeout);
                    this.isReady = true;
                    onProgress?.({ status: 'ready' });
                    resolve();
                }
            });

            this.process.on('error', (err) => {
                clearTimeout(timeout);
                console.error('[LlamaServer] Process error:', err);
                onProgress?.({ status: 'error', error: err.message });
                reject(err);
            });

            this.process.on('exit', (code) => {
                clearTimeout(timeout);
                console.log(`[LlamaServer] Process exited with code ${code}`);
                this.isReady = false;
                this.process = null;

                if (!this.isReady) {
                    reject(new Error(`Server exited with code ${code}. Output: ${startupOutput.slice(-500)}`));
                }
            });
        });
    }

    /**
     * Stop the llama-server process
     */
    async stop(): Promise<void> {
        if (this.process) {
            console.log('[LlamaServer] Stopping server...');
            this.process.kill('SIGTERM');

            // Wait for process to exit
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    if (this.process) {
                        this.process.kill('SIGKILL');
                    }
                    resolve();
                }, 5000);

                if (this.process) {
                    this.process.on('exit', () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                } else {
                    clearTimeout(timeout);
                    resolve();
                }
            });

            this.process = null;
        }
        this.isReady = false;
    }

    /**
     * Check if server is running
     */
    isRunning(): boolean {
        return this.isReady && this.process !== null;
    }

    /**
     * Get the server port
     */
    getPort(): number | null {
        return this.config?.port || null;
    }

    /**
     * Send a chat completion request to the server
     */
    async chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
        if (!this.isReady) {
            throw new Error('Server not ready');
        }

        const port = this.config!.port;

        // Build the request body in OpenAI-compatible format
        const body: any = {
            messages: options.messages.map(msg => ({
                role: msg.role === 'tool' ? 'user' : msg.role,
                content: msg.role === 'tool'
                    ? `Tool result for ${msg.name}: ${msg.content}`
                    : msg.content
            })),
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 2048,
            stream: false
        };

        // Add tools if provided (llama-server supports function calling)
        if (options.tools && options.tools.length > 0) {
            body.tools = options.tools;
            body.tool_choice = 'auto';
        }

        const response = await this.httpPost(`http://127.0.0.1:${port}/v1/chat/completions`, body);

        const choice = response.choices?.[0];
        if (!choice) {
            throw new Error('No response from server');
        }

        const message: ChatMessage = {
            role: 'assistant',
            content: choice.message?.content || ''
        };

        // Check for tool calls
        if (choice.message?.tool_calls && choice.message.tool_calls.length > 0) {
            message.tool_calls = choice.message.tool_calls.map((tc: any) => ({
                id: tc.id || `call_${Date.now()}`,
                type: 'function',
                function: {
                    name: tc.function.name,
                    arguments: typeof tc.function.arguments === 'string'
                        ? tc.function.arguments
                        : JSON.stringify(tc.function.arguments)
                }
            }));
        }

        return {
            message,
            finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' :
                         choice.finish_reason === 'length' ? 'length' : 'stop',
            usage: response.usage ? {
                promptTokens: response.usage.prompt_tokens || 0,
                completionTokens: response.usage.completion_tokens || 0,
                totalTokens: response.usage.total_tokens || 0
            } : undefined
        };
    }

    /**
     * Generate embeddings (for future use)
     */
    async embeddings(text: string | string[]): Promise<number[][]> {
        if (!this.isReady) {
            throw new Error('Server not ready');
        }

        const port = this.config!.port;
        const input = Array.isArray(text) ? text : [text];

        const response = await this.httpPost(`http://127.0.0.1:${port}/v1/embeddings`, {
            input,
            model: 'default'
        });

        return response.data.map((item: any) => item.embedding);
    }

    /**
     * HTTP POST helper
     */
    private httpPost(url: string, body: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(url);
            const postData = JSON.stringify(body);

            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port,
                path: urlObj.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            const req = http.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
                    }
                });
            });

            req.on('error', reject);
            req.write(postData);
            req.end();
        });
    }
}

// Default model configuration for Qwen2.5
export const QWEN3_MODEL = {
    repoId: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
    filename: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    name: 'Qwen2.5 1.5B'
};
