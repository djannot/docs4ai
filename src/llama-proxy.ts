import { spawn } from 'child_process';

const argv = process.argv.slice(2);
const binaryPath = argv.shift();

if (!binaryPath) {
    console.error('[LlamaProxy] Missing llama-server binary path');
    process.exit(1);
}

console.error(`[LlamaProxy] Starting: ${binaryPath} ${argv.join(' ')}`);
console.error(`[LlamaProxy] GGML_METAL=${process.env.GGML_METAL || '(unset)'}`);

const child = spawn(binaryPath, argv, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env
});

child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
});

child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
});

child.on('error', (error) => {
    console.error(`[LlamaProxy] Failed to spawn llama-server: ${error.message}`);
    process.exit(1);
});

child.on('exit', (code, signal) => {
    console.error(`[LlamaProxy] llama-server exited: code=${code ?? 'null'} signal=${signal ?? 'none'}`);
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 0);
});

process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
