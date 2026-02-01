declare module 'umap-js' {
    export class UMAP {
        constructor(options?: Record<string, unknown>);
        fit(data: number[][]): number[][];
    }
}
