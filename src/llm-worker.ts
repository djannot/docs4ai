import { parentPort } from 'worker_threads';

// Types for messages
interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
}

interface ToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

interface ToolDefinition {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, any>;
    };
}

interface WorkerRequest {
    type: 'init' | 'chat';
    requestId?: string;
    messages?: ChatMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
}

// Model configuration - Qwen2.5-0.5B-Instruct for better stability
// Note: Qwen3-1.7B causes SIGTRAP crashes on macOS ARM64 due to ONNX runtime issues
// Qwen2.5-0.5B is smaller (~1GB) but still supports function calling
const MODEL_ID = 'onnx-community/Qwen2.5-0.5B-Instruct';

// Global state
let pipeline: any = null;
let isInitializing = false;
let initPromiseResolve: ((value: void) => void) | null = null;

/**
 * Send download progress to main thread
 */
function sendProgress(status: 'downloading' | 'ready' | 'error', file?: string, progress?: number, loaded?: number, total?: number, error?: string) {
    parentPort?.postMessage({
        type: 'download-progress',
        progress: { status, file, progress, loaded, total, error }
    });
}

/**
 * Initialize the model pipeline
 */
async function initializeModel() {
    if (pipeline) {
        parentPort?.postMessage({ type: 'ready' });
        return;
    }

    if (isInitializing) {
        // Wait for existing initialization
        return;
    }

    isInitializing = true;

    try {
        console.log('LLM Worker: Loading transformers.js...');
        const transformers = await import('@huggingface/transformers');
        const createPipeline = transformers.pipeline;
        const env = transformers.env as any;

        // Configure environment for Node.js
        if (env) {
            env.allowRemoteModels = true;
            // Use ONNX backend for Node.js
            if (env.backends && env.backends.onnx) {
                env.backends.onnx.wasm = { numThreads: 1 };
            }
        }

        console.log(`LLM Worker: Loading model ${MODEL_ID}...`);
        sendProgress('downloading', 'model files');

        // Create text generation pipeline with progress tracking
        // Use cpu device for Node.js/Electron environment
        console.log('LLM Worker: Creating text generation pipeline...');
        pipeline = await createPipeline('text-generation', MODEL_ID, {
            device: 'cpu',
            progress_callback: (progress: any) => {
                if (progress.status === 'progress') {
                    const percent = progress.progress ? Math.round(progress.progress) : 0;
                    sendProgress('downloading', progress.file || 'model', percent, progress.loaded, progress.total);
                } else if (progress.status === 'done') {
                    console.log(`LLM Worker: Downloaded ${progress.file}`);
                }
            }
        } as any);

        console.log('LLM Worker: Model loaded successfully');
        sendProgress('ready');
        isInitializing = false;

        parentPort?.postMessage({ type: 'ready' });

    } catch (error: any) {
        console.error('LLM Worker: Failed to initialize model:', error);
        isInitializing = false;
        sendProgress('error', undefined, undefined, undefined, undefined, error.message);
        parentPort?.postMessage({ type: 'error', error: error.message });
    }
}

/**
 * Format messages for the model using ChatML format
 * Qwen2.5 uses the standard ChatML format with im_start/im_end tokens
 */
function formatMessages(messages: ChatMessage[], tools?: ToolDefinition[]): string {
    let prompt = '';

    // Add system message with tools if available
    let systemContent = '';
    const nonSystemMessages: ChatMessage[] = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            systemContent += msg.content + '\n';
        } else {
            nonSystemMessages.push(msg);
        }
    }

    // Add tool descriptions to system message if tools are provided
    if (tools && tools.length > 0) {
        systemContent += '\n\nYou have access to the following tools:\n\n';
        for (const tool of tools) {
            systemContent += `### ${tool.function.name}\n`;
            systemContent += `${tool.function.description}\n`;
            systemContent += `Parameters: ${JSON.stringify(tool.function.parameters, null, 2)}\n\n`;
        }
        systemContent += `\nTo use a tool, respond with a JSON object in this exact format:
{"tool_call": {"name": "tool_name", "arguments": {"arg1": "value1"}}}

Only use this format when you need to search or retrieve information. For normal conversation, respond naturally without the JSON format.`;
    }

    // Build the prompt using ChatML format
    if (systemContent.trim()) {
        prompt += `<|im_start|>system\n${systemContent.trim()}<|im_end|>\n`;
    }

    for (const msg of nonSystemMessages) {
        if (msg.role === 'user') {
            prompt += `<|im_start|>user\n${msg.content}<|im_end|>\n`;
        } else if (msg.role === 'assistant') {
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                // Format tool calls
                const toolCallJson = JSON.stringify({
                    tool_call: {
                        name: msg.tool_calls[0].function.name,
                        arguments: JSON.parse(msg.tool_calls[0].function.arguments)
                    }
                });
                prompt += `<|im_start|>assistant\n${toolCallJson}<|im_end|>\n`;
            } else {
                prompt += `<|im_start|>assistant\n${msg.content}<|im_end|>\n`;
            }
        } else if (msg.role === 'tool') {
            // Tool results are added as user messages with context
            prompt += `<|im_start|>user\nTool result for ${msg.name || 'tool'}:\n${msg.content}<|im_end|>\n`;
        }
    }

    // Add assistant start token
    prompt += `<|im_start|>assistant\n`;

    return prompt;
}

/**
 * Parse tool calls from model output
 */
function parseToolCalls(content: string): { content: string; toolCalls?: ToolCall[] } {
    // Try to find JSON tool call format
    const toolCallMatch = content.match(/\{"tool_call":\s*\{[^}]+\}\}/);

    if (toolCallMatch) {
        try {
            const parsed = JSON.parse(toolCallMatch[0]);
            if (parsed.tool_call && parsed.tool_call.name) {
                const toolCall: ToolCall = {
                    id: `call_${Date.now()}`,
                    type: 'function',
                    function: {
                        name: parsed.tool_call.name,
                        arguments: JSON.stringify(parsed.tool_call.arguments || {})
                    }
                };

                // Remove the tool call JSON from content
                const cleanContent = content.replace(toolCallMatch[0], '').trim();

                return {
                    content: cleanContent,
                    toolCalls: [toolCall]
                };
            }
        } catch (e) {
            // Not valid JSON, return as regular content
        }
    }

    return { content };
}

/**
 * Handle chat request
 */
async function handleChat(request: WorkerRequest) {
    const { requestId, messages, tools, temperature = 0.7, maxTokens = 2048 } = request;

    if (!pipeline) {
        parentPort?.postMessage({
            type: 'error',
            requestId,
            error: 'Model not initialized'
        });
        return;
    }

    try {
        // Format messages for the model
        const prompt = formatMessages(messages!, tools);

        console.log('LLM Worker: Generating response...');

        // Generate response
        const outputs = await pipeline(prompt, {
            max_new_tokens: maxTokens,
            temperature,
            do_sample: temperature > 0,
            top_p: 0.9,
            repetition_penalty: 1.1,
            return_full_text: false
        });

        let generatedText = outputs[0]?.generated_text || '';

        // Clean up the response - remove end tokens
        generatedText = generatedText
            .replace(/<\|im_end\|>/g, '')
            .replace(/<\|im_start\|>.*$/s, '')
            .trim();

        console.log('LLM Worker: Generated response length:', generatedText.length);

        // Parse for tool calls
        const { content, toolCalls } = parseToolCalls(generatedText);

        const responseMessage: ChatMessage = {
            role: 'assistant',
            content
        };

        if (toolCalls && toolCalls.length > 0) {
            responseMessage.tool_calls = toolCalls;
        }

        parentPort?.postMessage({
            type: 'response',
            requestId,
            message: responseMessage,
            finishReason: toolCalls ? 'tool_calls' : 'stop',
            usage: {
                promptTokens: 0,  // Could estimate from tokenizer
                completionTokens: 0,
                totalTokens: 0
            }
        });

    } catch (error: any) {
        console.error('LLM Worker: Chat error:', error);
        parentPort?.postMessage({
            type: 'error',
            requestId,
            error: error.message
        });
    }
}

// Message handler
parentPort?.on('message', async (request: WorkerRequest) => {
    switch (request.type) {
        case 'init':
            await initializeModel();
            break;

        case 'chat':
            await handleChat(request);
            break;

        default:
            console.warn('LLM Worker: Unknown request type:', request.type);
    }
});

// Handle errors
process.on('uncaughtException', (error) => {
    console.error('LLM Worker uncaught exception:', error);
    parentPort?.postMessage({ type: 'error', error: error.message });
});

process.on('unhandledRejection', (reason) => {
    console.error('LLM Worker unhandled rejection:', reason);
    parentPort?.postMessage({ type: 'error', error: String(reason) });
});
