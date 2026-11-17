import { GoogleEmbeddingProvider } from '../../src/providers/google';
import { EmbeddingError } from '../../src/types';

jest.mock('google-auth-library', () => {
  return {
    GoogleAuth: jest.fn().mockImplementation(() => ({
      getClient: jest.fn().mockResolvedValue({
        getAccessToken: jest.fn().mockResolvedValue({ token: 'fake-token' }),
      }),
    })),
  };
});

describe('GoogleEmbeddingProvider', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });

  it('hits the right endpoint with bearer + outputDimensionality', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        predictions: [
          { embeddings: { values: [0.1, 0.2], statistics: { token_count: 3 } } },
          { embeddings: { values: [0.3, 0.4], statistics: { token_count: 4 } } },
        ],
      }),
    });

    const p = new GoogleEmbeddingProvider({ projectId: 'proj-1', location: 'us-west1' });
    const r = await p.embed({ input: ['x', 'y'], dimensions: 768 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://us-west1-aiplatform.googleapis.com/v1/projects/proj-1/locations/us-west1/publishers/google/models/gemini-embedding-001:predict',
    );
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer fake-token');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.instances).toEqual([{ content: 'x' }, { content: 'y' }]);
    expect(body.parameters.outputDimensionality).toBe(768);
    expect(r.embeddings).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(r.promptTokens).toBe(7);
    expect(r.provider).toBe('google');
  });

  it('passes task_type when taskType: retrieval_document', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ predictions: [{ embeddings: { values: [0.5] } }] }),
    });
    const p = new GoogleEmbeddingProvider({ projectId: 'p', location: 'us-west1' });
    await p.embed({ input: 'x', taskType: 'retrieval_document' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.instances[0].task_type).toBe('RETRIEVAL_DOCUMENT');
  });

  it('omits task_type when taskType not set', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ predictions: [{ embeddings: { values: [0.5] } }] }),
    });
    const p = new GoogleEmbeddingProvider({ projectId: 'p', location: 'us-west1' });
    await p.embed({ input: 'x' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.instances[0]).not.toHaveProperty('task_type');
  });

  it('chunks input into ≤250 per API call and aggregates results', async () => {
    // 300 inputs → two calls: 250 + 50
    const make = (count: number) => Array.from({ length: count }, (_, i) => ({
      embeddings: { values: [i] },
    }));
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ predictions: make(250) }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ predictions: make(50) }) });

    const p = new GoogleEmbeddingProvider({ projectId: 'p', location: 'us-west1' });
    const inputs = Array.from({ length: 300 }, (_, i) => `t${i}`);
    const r = await p.embed({ input: inputs });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).instances).toHaveLength(250);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).instances).toHaveLength(50);
    expect(r.embeddings).toHaveLength(300);
  });

  it('throws EmbeddingError when predictions length mismatches inputs', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ predictions: [{ embeddings: { values: [0.1] } }] }),
    });
    const p = new GoogleEmbeddingProvider({ projectId: 'p', location: 'us-west1' });
    await expect(p.embed({ input: ['a', 'b'] }))
      .rejects.toMatchObject({ name: 'EmbeddingError', provider: 'google' });
  });

  it('throws EmbeddingError when a prediction has no embeddings.values', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ predictions: [{ embeddings: { values: [0.1] } }, {}] }),
    });
    const p = new GoogleEmbeddingProvider({ projectId: 'p', location: 'us-west1' });
    await expect(p.embed({ input: ['a', 'b'] })).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('falls back to ~4 chars/token when statistics omitted', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ predictions: [{ embeddings: { values: [0.5] } }] }),
    });
    const p = new GoogleEmbeddingProvider({ projectId: 'p', location: 'us-west1' });
    const r = await p.embed({ input: 'abcdefgh' }); // 8 chars → 2 tokens
    expect(r.promptTokens).toBe(2);
  });

  it('classifies HTTP errors via fetchJsonWithRetry (no manual classification)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'bad', headers: { get: () => null } });
    const p = new GoogleEmbeddingProvider({ projectId: 'p', location: 'us-west1' });
    await expect(p.embed({ input: 'x' })).rejects.toMatchObject({ kind: 'auth', status: 401 });
  });

  it('rejects construction with empty projectId/location', () => {
    expect(() => new GoogleEmbeddingProvider({ projectId: '', location: 'us' })).toThrow(/projectId required/);
    expect(() => new GoogleEmbeddingProvider({ projectId: 'p', location: '' })).toThrow(/location required/);
  });
});
