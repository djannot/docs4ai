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

// Model configuration - FunctionGemma 270M for function calling
// This model is specifically designed for function calling tasks
// See: https://huggingface.co/onnx-community/functiongemma-270m-it-ONNX
const MODEL_ID = 'onnx-community/functiongemma-270m-it-ONNX';

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
 * Format messages for the model using FunctionGemma format
 * FunctionGemma uses developer-user roles and special function call tags
 * See: https://huggingface.co/onnx-community/functiongemma-270m-it-ONNX
 */
function formatMessages(messages: ChatMessage[], tools?: ToolDefinition[]): string {
    let prompt = '';

    // Build developer message with tool definitions
    let developerContent = 'You are a helpful assistant that can search through documents to answer questions.';

    if (tools && tools.length > 0) {
        developerContent += ' You have access to the following functions:\n\n';
        for (const tool of tools) {
            developerContent += JSON.stringify(tool, null, 2) + '\n\n';
        }
        developerContent += 'When you need to search for information, use the appropriate function. ';
        developerContent += 'Format function calls as: <start_function_call>call:FUNCTION_NAME{param:<escape>value<escape>}<end_function_call>';
    }

    // Add developer message
    prompt += `<start_of_turn>developer\n${developerContent}<end_of_turn>\n`;

    // Process messages
    for (const msg of messages) {
        if (msg.role === 'system') {
            // System messages are merged into developer
            continue;
        } else if (msg.role === 'user') {
            prompt += `<start_of_turn>user\n${msg.content}<end_of_turn>\n`;
        } else if (msg.role === 'assistant') {
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                // Format as function call
                const tc = msg.tool_calls[0];
                let args;
                try {
                    args = JSON.parse(tc.function.arguments);
                } catch {
                    args = tc.function.arguments;
                }

                let argsStr = '';
                if (typeof args === 'object') {
                    argsStr = Object.entries(args)
                        .map(([k, v]) => `${k}:<escape>${v}<escape>`)
                        .join(',');
                }

                prompt += `<start_of_turn>model\n<start_function_call>call:${tc.function.name}{${argsStr}}<end_function_call><end_of_turn>\n`;
            } else {
                prompt += `<start_of_turn>model\n${msg.content}<end_of_turn>\n`;
            }
        } else if (msg.role === 'tool') {
            // Tool results
            prompt += `<start_function_response>${msg.content}<end_function_response>\n`;
        }
    }

    // Add model start token
    prompt += `<start_of_turn>model\n`;

    return prompt;
}

/**
 * Parse tool calls from model output (FunctionGemma format)
 * Format: <start_function_call>call:FUNCTION_NAME{param:<escape>value<escape>}<end_function_call>
 */
function parseToolCalls(content: string): { content: string; toolCalls?: ToolCall[] } {
    // Try to find FunctionGemma function call format
    const functionCallMatch = content.match(/<start_function_call>call:(\w+)\{([^}]*)\}<end_function_call>/);

    if (functionCallMatch) {
        const funcName = functionCallMatch[1];
        const argsStr = functionCallMatch[2];

        // Parse arguments from format: param1:<escape>value1<escape>,param2:<escape>value2<escape>
        const args: Record<string, any> = {};
        if (argsStr) {
            const argPairs = argsStr.split(',');
            for (const pair of argPairs) {
                const colonIndex = pair.indexOf(':');
                if (colonIndex > 0) {
                    const key = pair.substring(0, colonIndex).trim();
                    let value = pair.substring(colonIndex + 1).trim();
                    // Remove escape tags
                    value = value.replace(/<escape>/g, '').replace(/<\/escape>/g, '');
                    args[key] = value;
                }
            }
        }

        const toolCall: ToolCall = {
            id: `call_${Date.now()}`,
            type: 'function',
            function: {
                name: funcName,
                arguments: JSON.stringify(args)
            }
        };

        // Remove the function call from content
        const cleanContent = content.replace(functionCallMatch[0], '').trim();

        return {
            content: cleanContent,
            toolCalls: [toolCall]
        };
    }

    // Also try JSON format as fallback
    const jsonMatch = content.match(/\{"tool_call":\s*\{[^}]+\}\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.tool_call && parsed.tool_call.name) {
                const toolCall: ToolCall = {
                    id: `call_${Date.now()}`,
                    type: 'function',
                    function: {
                        name: parsed.tool_call.name,
                        arguments: JSON.stringify(parsed.tool_call.arguments || {})
                    }
                };
                const cleanContent = content.replace(jsonMatch[0], '').trim();
                return { content: cleanContent, toolCalls: [toolCall] };
            }
        } catch (e) {
            // Not valid JSON
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

        // Clean up the response - remove end tokens (FunctionGemma format)
        generatedText = generatedText
            .replace(/<end_of_turn>/g, '')
            .replace(/<start_of_turn>.*$/s, '')
            .replace(/<start_function_response>.*$/s, '')
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
