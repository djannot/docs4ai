import * as path from 'path';
import OpenAI from 'openai';
import { LlamaServer, QWEN3_CHAT_MODEL, ModelDownloadProgress } from './llama-server';

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

// Default port for llama-server (different from MCP server port)
const LLAMA_SERVER_PORT = 8787;

export class LLMChatService {
    private provider: LLMProvider;
    private openaiClient: OpenAI | null = null;
    private openaiApiKey: string | null = null;
    private openaiModel: string = 'gpt-4o-mini';
    private llamaServer: LlamaServer | null = null;
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
        } else {
            // Create LlamaServer instance for local provider
            this.llamaServer = new LlamaServer();
        }
    }

    getProvider(): LLMProvider {
        return this.provider;
    }

    setDownloadProgressCallback(callback: (progress: DownloadProgress) => void): void {
        this.downloadProgressCallback = callback;
    }

    /**
     * Initialize the local LLM server (only needed for local provider)
     */
    async initialize(): Promise<void> {
        if (this.provider === 'openai') {
            // OpenAI doesn't need initialization
            return;
        }

        if (!this.llamaServer) {
            this.llamaServer = new LlamaServer();
        }

        if (this.llamaServer.isRunning()) {
            return;
        }

        // Get model path
        const modelsDir = this.llamaServer.getModelsDir();
        const modelPath = path.join(modelsDir, QWEN3_CHAT_MODEL.filename);

        // Download model if not present
        if (!this.llamaServer.modelExists(modelPath)) {
            console.log(`[LLMChat] Downloading model ${QWEN3_CHAT_MODEL.name}...`);
            this.downloadProgressCallback?.({
                status: 'downloading',
                file: QWEN3_CHAT_MODEL.filename,
                progress: 0
            });

            await this.llamaServer.downloadModel(
                QWEN3_CHAT_MODEL.repoId,
                QWEN3_CHAT_MODEL.filename,
                modelPath,
                (progress) => {
                    this.downloadProgressCallback?.(progress);
                }
            );
        }

        // Start llama-server
        console.log(`[LLMChat] Starting llama-server with model ${QWEN3_CHAT_MODEL.name}...`);
        await this.llamaServer.start({
            modelPath,
            port: LLAMA_SERVER_PORT,
            contextSize: 4096,
            threads: 4
        }, (progress) => {
            this.downloadProgressCallback?.(progress);
        });

        console.log('[LLMChat] LlamaServer is ready');
    }

    /**
     * Generate a chat completion
     */
    async chat(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
        if (this.provider === 'openai') {
            return this.chatWithOpenAI(options);
        } else {
            return this.chatWithLlamaServer(options);
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

    private async chatWithLlamaServer(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
        if (!this.llamaServer || !this.llamaServer.isRunning()) {
            await this.initialize();
        }

        try {
            const result = await this.llamaServer!.chatCompletion({
                messages: options.messages,
                tools: options.tools,
                temperature: options.temperature ?? 0.7,
                maxTokens: options.maxTokens ?? 2048
            });

            return {
                message: result.message,
                finishReason: result.finishReason as 'stop' | 'tool_calls' | 'length' | 'error',
                usage: result.usage
            };
        } catch (error: any) {
            console.error('LlamaServer chat error:', error);
            throw error;
        }
    }

    /**
     * Terminate the LLM service
     */
    async terminate(): Promise<void> {
        if (this.isTerminating) {
            return;
        }
        this.isTerminating = true;

        if (this.llamaServer) {
            await this.llamaServer.stop();
            this.llamaServer = null;
        }

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
