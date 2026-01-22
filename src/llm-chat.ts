import * as path from 'path';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import type { ChatHistoryItem, Llama, LlamaChatSession, LlamaContext, LlamaModel } from 'node-llama-cpp';
import { QWEN3_CHAT_MODEL } from './llama-server';
import { getModelCacheDir } from './embeddings';

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
    mcpServerPort?: number;
}

export interface ChatCompletionResult {
    message: ChatMessage;
    finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
    toolCalls?: Array<{ name: string; arguments: any; response: any }>;
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

export class LLMChatService {
    private provider: LLMProvider;
    private openaiClient: OpenAI | null = null;
    private openaiApiKey: string | null = null;
    private openaiModel: string = 'gpt-5-mini';
    private downloadProgressCallback: ((progress: DownloadProgress) => void) | null = null;
    private isTerminating: boolean = false;
    private contextLength: number;
    private llama: Llama | null = null;
    private model: LlamaModel | null = null;
    private context: LlamaContext | null = null;
    private session: LlamaChatSession | null = null;

    constructor(provider: LLMProvider, apiKey?: string, model?: string, contextLength?: number) {
        this.provider = provider;
        
        // Set context length (default: 8192)
        this.contextLength = contextLength ?? 8192;

        if (provider === 'openai') {
            if (!apiKey) {
                throw new Error('OpenAI API key is required for OpenAI provider');
            }
            this.openaiApiKey = apiKey;
            this.openaiModel = model || 'gpt-5-mini';
            this.openaiClient = new OpenAI({ apiKey });
        }
    }

    getProvider(): LLMProvider {
        return this.provider;
    }

    setDownloadProgressCallback(callback: (progress: DownloadProgress) => void): void {
        this.downloadProgressCallback = callback;
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
        this.downloadProgressCallback?.(progress);
    }

    private async downloadModelIfNeeded(modelPath: string): Promise<void> {
        if (process.env.DOCS4AI_SKIP_MODEL_DOWNLOAD === '1') {
            return;
        }

        if (fs.existsSync(modelPath)) {
            return;
        }

        console.log(`[LLMChat] Downloading model ${QWEN3_CHAT_MODEL.name}...`);
        this.reportDownloadProgress({
            status: 'downloading',
            file: QWEN3_CHAT_MODEL.filename,
            progress: 0
        });

        await this.downloadModel(QWEN3_CHAT_MODEL.repoId, QWEN3_CHAT_MODEL.filename, modelPath);
        this.reportDownloadProgress({ status: 'ready', file: QWEN3_CHAT_MODEL.filename, progress: 100 });
    }

    private async downloadModel(repoId: string, filename: string, targetPath: string): Promise<void> {
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
                        this.downloadFromUrl(redirectUrl, targetPath)
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
                        progress: percent
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

    private async downloadFromUrl(url: string, targetPath: string): Promise<void> {
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
                        file: QWEN3_CHAT_MODEL.filename,
                        progress: percent
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

    private async initializeLocalModel(): Promise<void> {
        if (this.session) {
            return;
        }

        const modelsDir = getModelCacheDir();
        const modelPath = path.join(modelsDir, QWEN3_CHAT_MODEL.filename);
        await this.downloadModelIfNeeded(modelPath);

        const nodeLlama = await this.loadNodeLlama();
        const llama = await nodeLlama.getLlama();
        const model = await llama.loadModel({ modelPath });
        const context = await model.createContext({
            contextSize: this.contextLength,
            threads: 4
        });
        const session = new nodeLlama.LlamaChatSession({
            contextSequence: context.getSequence()
        });

        this.llama = llama;
        this.model = model;
        this.context = context;
        this.session = session;

        console.log('[LLMChat] Local model ready');
    }

    private buildChatHistory(messages: ChatMessage[]): { history: ChatHistoryItem[]; prompt: string } {
        let lastUserIndex = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'user') {
                lastUserIndex = i;
                break;
            }
        }

        const prompt = lastUserIndex >= 0
            ? messages[lastUserIndex].content
            : messages[messages.length - 1]?.content || '';

        const historyMessages = lastUserIndex >= 0
            ? messages.slice(0, lastUserIndex)
            : messages;

        const history: ChatHistoryItem[] = historyMessages.map((message) => {
            if (message.role === 'system') {
                return { type: 'system', text: message.content };
            }

            if (message.role === 'assistant') {
                return { type: 'model', response: [message.content] };
            }

            if (message.role === 'tool') {
                const toolName = message.name || 'tool';
                return { type: 'user', text: `Tool result for ${toolName}: ${message.content}` };
            }

            return { type: 'user', text: message.content };
        });

        return { history, prompt };
    }

    /**
     * Initialize the local LLM server (only needed for local provider)
     */
    async initialize(): Promise<void> {
        if (this.provider === 'openai') {
            // OpenAI doesn't need initialization
            return;
        }
        await this.initializeLocalModel();
    }

    /**
     * Generate a chat completion
     */
    async chat(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
        if (this.provider === 'openai') {
            return this.chatWithOpenAI(options);
        } else {
            return this.chatWithLocalModel(options);
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
                temperature: options.temperature ?? 1.0,
            };

            // Use appropriate token limit parameter based on model
            // Newer models (gpt-4o, gpt-5, etc.) use max_completion_tokens
            // Older models (gpt-4-turbo, gpt-3.5-turbo) use max_tokens
            const isNewModel = this.openaiModel.startsWith('gpt-4') || this.openaiModel.startsWith('gpt-5') || this.openaiModel.startsWith('gpt-o1');
            if (options.maxTokens !== undefined) {
                if (isNewModel) {
                    requestParams.max_completion_tokens = options.maxTokens;
                } else {
                    requestParams.max_tokens = options.maxTokens;
                }
            }

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

    private async chatWithLocalModel(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
        await this.initialize();

        if (!this.session) {
            throw new Error('Local chat session not initialized');
        }

        const { history, prompt } = this.buildChatHistory(options.messages);
        this.session.setChatHistory(history);

        const executedToolCalls: Array<{ name: string; arguments: any; response: any }> = [];
        let functions: Record<string, any> | undefined;

        if (options.tools && options.tools.length > 0) {
            const nodeLlama = await this.loadNodeLlama();

            functions = Object.fromEntries(options.tools.map((tool) => {
                const functionName = tool.function.name;
                return [functionName, nodeLlama.defineChatSessionFunction({
                    description: tool.function.description,
                    params: tool.function.parameters as any,
                    handler: async (params: any) => {
                        if (!options.mcpServerPort) {
                            return 'Error: MCP server port not available';
                        }

                        const toolCall: ToolCall = {
                            id: `call_${Date.now()}_${functionName}`,
                            type: 'function',
                            function: {
                                name: functionName,
                                arguments: JSON.stringify(params)
                            }
                        };

                        const response = await executeMcpToolCall(toolCall, options.mcpServerPort);
                        executedToolCalls.push({ name: functionName, arguments: params, response });
                        return response;
                    }
                })];
            }));
        }

        const responseText = await this.session.prompt(prompt, {
            temperature: options.temperature ?? 0.7,
            maxTokens: options.maxTokens,
            functions
        });

        const promptTokens = this.model ? this.model.tokenize(prompt).length : 0;
        const completionTokens = this.model ? this.model.tokenize(responseText).length : 0;

        return {
            message: {
                role: 'assistant',
                content: responseText
            },
            finishReason: 'stop',
            usage: this.model ? {
                promptTokens,
                completionTokens,
                totalTokens: promptTokens + completionTokens
            } : undefined,
            toolCalls: executedToolCalls.length > 0 ? executedToolCalls : undefined
        };
    }

    /**
     * Terminate the LLM service
     */
    async terminate(): Promise<void> {
        if (this.isTerminating) {
            return;
        }
        this.isTerminating = true;

        if (this.session) {
            await this.session.dispose();
            this.session = null;
        }
        if (this.context) {
            await this.context.dispose();
            this.context = null;
        }
        if (this.model) {
            await this.model.dispose();
            this.model = null;
        }
        this.llama = null;

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
