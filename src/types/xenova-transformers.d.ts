declare module '@xenova/transformers' {
    export const env: {
        cacheDir: string;
        localModelPath: string;
        allowRemoteModels: boolean;
        backends: {
            onnx: any;
        };
    };

    export function pipeline(
        task: string,
        model?: string,
        options?: {
            quantized?: boolean;
            progress_callback?: (progress: any) => void;
            cache_dir?: string;
            local_files_only?: boolean;
        }
    ): Promise<any>;

    export class Tensor {
        data: Float32Array | Int32Array | BigInt64Array;
        dims: number[];
        type: string;
    }
}
