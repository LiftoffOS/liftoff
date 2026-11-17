import { VoyageEmbeddingProvider } from '../../src/providers/voyage';
import { EmbeddingError } from '../../src/types';

describe('VoyageEmbeddingProvider', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });

  it('passes API key as Bearer and orders embeddings by index', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { embedding: [0.3], index: 1 },
          { embedding: [0.1], index: 0 },
        ],
        usage: { total_tokens: 11 },
      }),
    });
    const p = new VoyageEmbeddingProvider('sk-voyage');
    const r = await p.embed({ input: ['a', 'b'], model: 'voyage-4-lite', dimensions: 512 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.voyageai.com/v1/embeddings');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sk-voyage');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.model).toBe('voyage-4-lite');
    expect(body.input).toEqual(['a', 'b']);
    expect(body.output_dimension).toBe(512);
    expect(r.embeddings).toEqual([[0.1], [0.3]]);
    expect(r.provider).toBe('voyage');
  });

  it('maps taskType: retrieval_query to input_type: query', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.5], index: 0 }], usage: { total_tokens: 1 } }),
    });
    const p = new VoyageEmbeddingProvider('k');
    await p.embed({ input: 'q', taskType: 'retrieval_query' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.input_type).toBe('query');
  });

  it('maps taskType: retrieval_document to input_type: document', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.5], index: 0 }], usage: { total_tokens: 1 } }),
    });
    const p = new VoyageEmbeddingProvider('k');
    await p.embed({ input: 'doc', taskType: 'retrieval_document' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.input_type).toBe('document');
  });

  it('omits input_type when taskType undefined', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.5], index: 0 }], usage: { total_tokens: 1 } }),
    });
    const p = new VoyageEmbeddingProvider('k');
    await p.embed({ input: 'x' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('input_type');
  });

  it('chunks input into ≤128 per API call', async () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ embedding: [i], index: i }));
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: make(128), usage: { total_tokens: 100 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: make(72),  usage: { total_tokens: 50 } }) });
    const p = new VoyageEmbeddingProvider('k');
    const inputs = Array.from({ length: 200 }, (_, i) => `t${i}`);
    const r = await p.embed({ input: inputs });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toHaveLength(128);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).input).toHaveLength(72);
    expect(r.embeddings).toHaveLength(200);
    expect(r.promptTokens).toBe(150);
  });

  it('throws EmbeddingError on count mismatch', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1], index: 0 }], usage: { total_tokens: 1 } }),
    });
    const p = new VoyageEmbeddingProvider('k');
    await expect(p.embed({ input: ['a', 'b'] })).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('classifies 401 from fetchJsonWithRetry as auth', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'bad key', headers: { get: () => null } });
    const p = new VoyageEmbeddingProvider('k');
    await expect(p.embed({ input: 'x' })).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('rejects construction with empty apiKey', () => {
    expect(() => new VoyageEmbeddingProvider('')).toThrow(/apiKey required/);
  });
});
