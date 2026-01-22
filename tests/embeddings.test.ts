import { EmbeddingService, getEmbeddingDimension, MINILM_EMBEDDING_DIMENSION, OPENAI_EMBEDDING_DIMENSION } from '../src/embeddings';

const openAiCreateMock = jest.fn();

jest.mock('openai', () => ({
  __esModule: true,
  default: class OpenAI {
    embeddings = { create: openAiCreateMock };
    constructor() {}
  }
}));

describe('EmbeddingService', () => {
  beforeEach(() => {
    openAiCreateMock.mockReset();
  });

  it('returns expected dimensions for providers', () => {
    expect(getEmbeddingDimension('local-minilm')).toBe(MINILM_EMBEDDING_DIMENSION);
    expect(getEmbeddingDimension('openai')).toBe(OPENAI_EMBEDDING_DIMENSION);
  });

  it('normalizes legacy local providers to local', async () => {
    const service = new EmbeddingService('local-e5');
    expect(service.getProvider()).toBe('local');
    await service.terminate();
  });

  it('reports invalid OpenAI API keys', async () => {
    openAiCreateMock.mockRejectedValue({ status: 401, message: 'invalid_api_key' });

    const service = new EmbeddingService('openai', 'bad-key');
    const isValid = await service.validateApiKey();

    expect(isValid).toBe(false);
    expect(service.isValid).toBe(false);
  });

  it('bubbles local model startup failures', async () => {
    const originalMock = (globalThis as any).__docs4aiNodeLlamaMock;
    (globalThis as any).__docs4aiNodeLlamaMock = {
      ...originalMock,
      getLlama: async () => {
        throw new Error('startup failed');
      }
    };

    const service = new EmbeddingService('local');
    await expect(service.validateApiKey()).rejects.toThrow('startup failed');
    await service.terminate();

    (globalThis as any).__docs4aiNodeLlamaMock = originalMock;
  });
});
