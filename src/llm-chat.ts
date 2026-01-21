import { Worker } from 'worker_threads';
import * as path from 'path';
import OpenAI from 'openai';

// LLM Provider types
export type LLMProvider = 'local-qwen3' | 'openai';

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
        parameters: {
            type: string;
            properties: Record<string, any>;
            required?: string[];
        };
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
    finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

export interface DownloadProgress {
    status: 'downloading' | 'ready' | 'error';
    file?: string;
    progress?: number;
    loaded?: number;
    total?: number;
    error?: string;
}

// MCP Tools available for function calling
export const MCP_TOOLS: ToolDefinition[] = [
    {
        type: 'function',
        function: {
            name: 'query_documents',
            description: 'Search through synced documents using semantic vector search. Returns relevant document chunks based on the query.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'The natural language search query'
                    },
                    limit: {
                        type: 'number',
                        description: 'Maximum number of results to return (1-20). Defaults to 5.'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_chunks',
            description: 'Retrieve chunks from a specific document by file path. Use this to get more context from a document after finding it with query_documents.',
            parameters: {
                type: 'object',
                properties: {
                    file_path: {
                        type: 'string',
                        description: 'The file path (url) of the document to retrieve chunks from'
                    },
                    startIndex: {
                        type: 'number',
                        description: 'The starting chunk index (0-based, inclusive). If not provided, starts from the first chunk.'
                    },
                    endIndex: {
                        type: 'number',
                        description: 'The ending chunk index (0-based, inclusive). If not provided, retrieves all chunks from startIndex to the end.'
                    }
                },
                required: ['file_path']
            }
        }
    }
];

interface WorkerMessage {
    type: 'ready' | 'response' | 'error' | 'download-progress';
    requestId?: string;
    message?: ChatMessage;
    finishReason?: string;
    usage?: any;
    error?: string;
    progress?: DownloadProgress;
}

interface PendingRequest {
    resolve: (result: ChatCompletionResult) => void;
    reject: (error: Error) => void;
}

export class LLMChatService {
    private provider: LLMProvider;
    private openaiClient: OpenAI | null = null;
    private openaiApiKey: string | null = null;
    private openaiModel: string = 'gpt-4o-mini';
    private worker: Worker | null = null;
    private workerReady: boolean = false;
    private pendingRequests: Map<string, PendingRequest> = new Map();
    private requestCounter: number = 0;
    private downloadProgressCallback: ((progress: DownloadProgress) => void) | null = null;
    private isTerminating: boolean = false;

    constructor(provider: LLMProvider, apiKey?: string, model?: string) {
        this.provider = provider;

        if (provider === 'openai') {
            if (!apiKey) {
                throw new Error('OpenAI API key is required for OpenAI provider');
            }
            this.openaiApiKey = apiKey;
            this.openaiModel = model || 'gpt-4o-mini';
            this.openaiClient = new OpenAI({ apiKey });
        }
    }

    getProvider(): LLMProvider {
        return this.provider;
    }

    setDownloadProgressCallback(callback: (progress: DownloadProgress) => void): void {
        this.downloadProgressCallback = callback;
    }

    /**
     * Initialize the local LLM worker (only needed for local provider)
     */
    async initialize(): Promise<void> {
        if (this.provider === 'openai') {
            // OpenAI doesn't need initialization
            return;
        }

        if (this.worker && this.workerReady) {
            return;
        }

        return new Promise((resolve, reject) => {
            try {
                const workerPath = path.join(__dirname, 'llm-worker.js');
                this.worker = new Worker(workerPath);

                this.worker.on('message', (message: WorkerMessage) => {
                    this.handleWorkerMessage(message, resolve);
                });

                this.worker.on('error', (error) => {
                    console.error('LLM Worker error:', error);
                    if (!this.workerReady) {
                        reject(error);
                    }
                    // Reject all pending requests
                    for (const [id, pending] of this.pendingRequests) {
                        pending.reject(error);
                        this.pendingRequests.delete(id);
                    }
                });

                this.worker.on('exit', (code) => {
                    console.log(`LLM Worker exited with code ${code}`);
                    this.workerReady = false;
                    this.worker = null;
                });

                // Send initialization message
                this.worker.postMessage({ type: 'init' });

            } catch (error) {
                reject(error);
            }
        });
    }

    private handleWorkerMessage(message: WorkerMessage, initResolve?: (value: void) => void): void {
        switch (message.type) {
            case 'ready':
                console.log('LLM Worker is ready');
                this.workerReady = true;
                if (initResolve) {
                    initResolve();
                }
                break;

            case 'download-progress':
                if (this.downloadProgressCallback && message.progress) {
                    this.downloadProgressCallback(message.progress);
                }
                break;

            case 'response':
                if (message.requestId) {
                    const pending = this.pendingRequests.get(message.requestId);
                    if (pending) {
                        pending.resolve({
                            message: message.message!,
                            finishReason: message.finishReason as any,
                            usage: message.usage
                        });
                        this.pendingRequests.delete(message.requestId);
                    }
                }
                break;

            case 'error':
                if (message.requestId) {
                    const pending = this.pendingRequests.get(message.requestId);
                    if (pending) {
                        pending.reject(new Error(message.error || 'Unknown error'));
                        this.pendingRequests.delete(message.requestId);
                    }
                } else if (initResolve) {
                    // Error during initialization
                    throw new Error(message.error || 'Failed to initialize LLM worker');
                }
                break;
        }
    }

    /**
     * Generate a chat completion
     */
    async chat(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
        if (this.provider === 'openai') {
            return this.chatWithOpenAI(options);
        } else {
            return this.chatWithLocalLLM(options);
        }
    }

    private async chatWithOpenAI(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
        if (!this.openaiClient) {
            throw new Error('OpenAI client not initialized');
        }

        try {
            const messages = options.messages.map(msg => {
                if (msg.role === 'tool') {
                    return {
                        role: 'tool' as const,
                        content: msg.content,
                        tool_call_id: msg.tool_call_id!
                    };
                }
                return {
                    role: msg.role as 'system' | 'user' | 'assistant',
                    content: msg.content,
                    ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {})
                };
            });

            const requestParams: any = {
                model: this.openaiModel,
                messages,
                temperature: options.temperature ?? 0.7,
                max_tokens: options.maxTokens ?? 2048
            };

            if (options.tools && options.tools.length > 0) {
                requestParams.tools = options.tools;
                requestParams.tool_choice = 'auto';
            }

            const response = await this.openaiClient.chat.completions.create(requestParams);

            const choice = response.choices[0];
            const assistantMessage: ChatMessage = {
                role: 'assistant',
                content: choice.message.content || ''
            };

            if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
                assistantMessage.tool_calls = choice.message.tool_calls.map(tc => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: {
                        name: tc.function.name,
                        arguments: tc.function.arguments
                    }
                }));
            }

            let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';
            if (choice.finish_reason === 'tool_calls') {
                finishReason = 'tool_calls';
            } else if (choice.finish_reason === 'length') {
                finishReason = 'length';
            }

            return {
                message: assistantMessage,
                finishReason,
                usage: response.usage ? {
                    promptTokens: response.usage.prompt_tokens,
                    completionTokens: response.usage.completion_tokens,
                    totalTokens: response.usage.total_tokens
                } : undefined
            };

        } catch (error: any) {
            console.error('OpenAI chat error:', error);
            throw error;
        }
    }

    private async chatWithLocalLLM(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
        if (!this.worker || !this.workerReady) {
            await this.initialize();
        }

        return new Promise((resolve, reject) => {
            const requestId = `req-${++this.requestCounter}`;

            this.pendingRequests.set(requestId, { resolve, reject });

            this.worker!.postMessage({
                type: 'chat',
                requestId,
                messages: options.messages,
                tools: options.tools,
                temperature: options.temperature ?? 0.7,
                maxTokens: options.maxTokens ?? 2048
            });

            // Timeout after 5 minutes for local model
            setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error('LLM request timed out after 5 minutes'));
                }
            }, 5 * 60 * 1000);
        });
    }

    /**
     * Terminate the worker
     */
    async terminate(): Promise<void> {
        if (this.isTerminating) {
            return;
        }
        this.isTerminating = true;

        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
            pending.reject(new Error('LLM service terminated'));
            this.pendingRequests.delete(id);
        }

        if (this.worker) {
            try {
                await this.worker.terminate();
            } catch (error) {
                console.error('Error terminating LLM worker:', error);
            }
            this.worker = null;
        }

        this.workerReady = false;
        this.isTerminating = false;
    }
}

/**
 * Execute a tool call by making a request to the MCP server
 */
export async function executeMcpToolCall(
    toolCall: ToolCall,
    mcpServerPort: number
): Promise<string> {
    const { name, arguments: argsStr } = toolCall.function;

    let args: Record<string, any>;
    try {
        args = JSON.parse(argsStr);
    } catch (error) {
        return `Error: Invalid JSON arguments for tool ${name}`;
    }

    try {
        const response = await fetch(`http://localhost:${mcpServerPort}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: toolCall.id,
                method: 'tools/call',
                params: {
                    name,
                    arguments: args
                }
            })
        });

        if (!response.ok) {
            return `Error: MCP server returned status ${response.status}`;
        }

        const result = await response.json();

        if (result.error) {
            return `Error: ${result.error.message}`;
        }

        if (result.result?.content?.[0]?.text) {
            return result.result.content[0].text;
        }

        return JSON.stringify(result.result);

    } catch (error: any) {
        console.error(`Error executing tool ${name}:`, error);
        return `Error executing tool ${name}: ${error.message}`;
    }
}
