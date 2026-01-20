import OpenAI from 'openai';

export class InvalidApiKeyError extends Error {
    constructor(message: string = 'Invalid OpenAI API key') {
        super(message);
        this.name = 'InvalidApiKeyError';
    }
}

export class EmbeddingService {
    private client: OpenAI;
    private model = 'text-embedding-3-large';
    private _isValid = true;

    constructor(apiKey: string) {
        this.client = new OpenAI({ apiKey });
    }

    get isValid(): boolean {
        return this._isValid;
    }

    async validateApiKey(): Promise<boolean> {
        try {
            // Make a minimal API call to validate the key
            await this.client.embeddings.create({
                model: this.model,
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

        try {
            const response = await this.client.embeddings.create({
                model: this.model,
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
            
            // Small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        return { embeddings, totalTokens };
    }
}
