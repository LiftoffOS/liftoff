import { OpenAIEmbeddingProvider } from '../../src/providers/openai';
import { EmbeddingError } from '../../src/types';

describe('OpenAIEmbeddingProvider', () => {
  it('forwards input + model + dimensions to the OpenAI client', async () => {
    const create = jest.fn().mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
      usage: { prompt_tokens: 42 },
    });
    const fakeClient = { embeddings: { create } } as unknown as ConstructorParameters<typeof OpenAIEmbeddingProvider>[0];
    const provider = new OpenAIEmbeddingProvider(fakeClient);
    const r = await provider.embed({ input: ['a', 'b'], model: 'text-embedding-3-large', dimensions: 768 });
    expect(create).toHaveBeenCalledWith({ model: 'text-embedding-3-large', input: ['a', 'b'], dimensions: 768 }, {});
    expect(r.embeddings).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(r.promptTokens).toBe(42);
    expect(r.provider).toBe('openai');
  });

  it('defaults model and dimensions when omitted', async () => {
    const create = jest.fn().mockResolvedValue({
      data: [{ embedding: [0.5] }], usage: { prompt_tokens: 5 },
    });
    const fakeClient = { embeddings: { create } } as unknown as ConstructorParameters<typeof OpenAIEmbeddingProvider>[0];
    const provider = new OpenAIEmbeddingProvider(fakeClient);
    const r = await provider.embed({ input: 'hello' });
    expect(create).toHaveBeenCalledWith({ model: 'text-embedding-3-small', input: ['hello'], dimensions: 1536 }, {});
    expect(r.model).toBe('text-embedding-3-small');
  });

  it('chunks input >2048 into multiple calls', async () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ embedding: [i] }));
    const create = jest.fn()
      .mockResolvedValueOnce({ data: make(2048), usage: { prompt_tokens: 1000 } })
      .mockResolvedValueOnce({ data: make(100),  usage: { prompt_tokens: 50 } });
    const fakeClient = { embeddings: { create } } as unknown as ConstructorParameters<typeof OpenAIEmbeddingProvider>[0];
    const provider = new OpenAIEmbeddingProvider(fakeClient);
    const inputs = Array.from({ length: 2148 }, (_, i) => `t${i}`);
    const r = await provider.embed({ input: inputs });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].input).toHaveLength(2048);
    expect(create.mock.calls[1][0].input).toHaveLength(100);
    expect(r.embeddings).toHaveLength(2148);
    expect(r.promptTokens).toBe(1050);
  });

  it('wraps SDK 401 errors into EmbeddingError(auth)', async () => {
    const sdkErr = Object.assign(new Error('invalid api key'), { status: 401 });
    const create = jest.fn().mockRejectedValue(sdkErr);
    const fakeClient = { embeddings: { create } } as unknown as ConstructorParameters<typeof OpenAIEmbeddingProvider>[0];
    const provider = new OpenAIEmbeddingProvider(fakeClient);
    await expect(provider.embed({ input: 'x' })).rejects.toMatchObject({
      name: 'EmbeddingError', kind: 'auth', status: 401, provider: 'openai',
    });
  });

  it('wraps SDK 5xx as transient', async () => {
    const sdkErr = Object.assign(new Error('server error'), { status: 500 });
    const create = jest.fn().mockRejectedValue(sdkErr);
    const fakeClient = { embeddings: { create } } as unknown as ConstructorParameters<typeof OpenAIEmbeddingProvider>[0];
    const provider = new OpenAIEmbeddingProvider(fakeClient);
    await expect(provider.embed({ input: 'x' })).rejects.toMatchObject({ kind: 'transient', status: 500 });
  });

  it('throws on count mismatch and missing embedding fields', async () => {
    const create = jest.fn().mockResolvedValueOnce({
      data: [{ embedding: [0.1] }], usage: { prompt_tokens: 1 },
    });
    const fakeClient = { embeddings: { create } } as unknown as ConstructorParameters<typeof OpenAIEmbeddingProvider>[0];
    const provider = new OpenAIEmbeddingProvider(fakeClient);
    await expect(provider.embed({ input: ['a', 'b'] })).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('ignores taskType (OpenAI is symmetric)', async () => {
    const create = jest.fn().mockResolvedValue({
      data: [{ embedding: [0.1] }], usage: { prompt_tokens: 1 },
    });
    const fakeClient = { embeddings: { create } } as unknown as ConstructorParameters<typeof OpenAIEmbeddingProvider>[0];
    const provider = new OpenAIEmbeddingProvider(fakeClient);
    await provider.embed({ input: 'x', taskType: 'retrieval_query' });
    // No task_type or input_type field forwarded to the API
    expect(create).toHaveBeenCalledWith(expect.not.objectContaining({ task_type: expect.anything() }), expect.anything());
    expect(create).toHaveBeenCalledWith(expect.not.objectContaining({ input_type: expect.anything() }), expect.anything());
  });
});
