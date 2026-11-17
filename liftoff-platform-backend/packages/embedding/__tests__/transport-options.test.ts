// Change 0 (semantic recall v2): timeoutMs/retries must flow from the PUBLIC
// EmbeddingClient.embed() call all the way into the provider transport.
// The client rebuilds the provider request from an explicit destructuring
// (client.ts), so an un-forwarded field is SILENTLY dropped — these tests
// exercise the full client → provider → transport path, not provider
// methods in isolation.

const mockFetchJsonWithRetry = jest.fn();
jest.mock('../src/providers/http', () => ({
  fetchJsonWithRetry: (...args: unknown[]) => mockFetchJsonWithRetry(...args),
}));

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: async () => ({ getAccessToken: async () => ({ token: 'fake-token' }) }),
  })),
}));

import { EmbeddingClient } from '../src/client';
import { GoogleEmbeddingProvider } from '../src/providers/google';
import { VoyageEmbeddingProvider } from '../src/providers/voyage';
import { OpenAIEmbeddingProvider } from '../src/providers/openai';
import type OpenAI from 'openai';

describe('transport options threading (client → provider → transport)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('google: timeoutMs + retries reach fetchJsonWithRetry through embed()', async () => {
    mockFetchJsonWithRetry.mockResolvedValue({
      predictions: [{ embeddings: { values: [0.1], statistics: { token_count: 3 } } }],
    });
    const client = new EmbeddingClient();
    client.init({
      providers: { google: new GoogleEmbeddingProvider({ projectId: 'p', location: 'us-west1' }) },
    });

    await client.embed({ input: 'q', timeoutMs: 2500, retries: 0 });

    expect(mockFetchJsonWithRetry).toHaveBeenCalledTimes(1);
    const opts = mockFetchJsonWithRetry.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.timeoutMs).toBe(2500);
    expect(opts.retries).toBe(0);
  });

  it('google: omitted options arrive undefined (transport ?? defaults apply)', async () => {
    mockFetchJsonWithRetry.mockResolvedValue({
      predictions: [{ embeddings: { values: [0.1] } }],
    });
    const client = new EmbeddingClient();
    client.init({
      providers: { google: new GoogleEmbeddingProvider({ projectId: 'p', location: 'us-west1' }) },
    });

    await client.embed({ input: 'q' });

    const opts = mockFetchJsonWithRetry.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.timeoutMs).toBeUndefined();
    expect(opts.retries).toBeUndefined();
  });

  it('voyage: timeoutMs + retries reach fetchJsonWithRetry through embed()', async () => {
    mockFetchJsonWithRetry.mockResolvedValue({
      data: [{ embedding: [0.2], index: 0 }],
      usage: { total_tokens: 2 },
    });
    const client = new EmbeddingClient();
    client.init({ providers: { voyage: new VoyageEmbeddingProvider('vk') } });

    await client.embed({ input: 'q', timeoutMs: 1234, retries: 1 });

    const opts = mockFetchJsonWithRetry.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.timeoutMs).toBe(1234);
    expect(opts.retries).toBe(1);
  });

  it('openai: timeoutMs/retries map to SDK per-request { timeout, maxRetries } through embed()', async () => {
    const create = jest.fn().mockResolvedValue({
      data: [{ embedding: [0.3] }],
      usage: { prompt_tokens: 4 },
    });
    const fakeOpenAI = { embeddings: { create } } as unknown as OpenAI;
    const client = new EmbeddingClient();
    client.init({ providers: { openai: new OpenAIEmbeddingProvider(fakeOpenAI) } });

    await client.embed({ input: 'q', timeoutMs: 2500, retries: 0 });

    expect(create).toHaveBeenCalledTimes(1);
    const requestOptions = create.mock.calls[0][1] as Record<string, unknown>;
    expect(requestOptions.timeout).toBe(2500);
    expect(requestOptions.maxRetries).toBe(0);
  });

  it('openai: omitted options arrive undefined in the per-request options (SDK defaults apply)', async () => {
    const create = jest.fn().mockResolvedValue({
      data: [{ embedding: [0.3] }],
      usage: { prompt_tokens: 4 },
    });
    const fakeOpenAI = { embeddings: { create } } as unknown as OpenAI;
    const client = new EmbeddingClient();
    client.init({ providers: { openai: new OpenAIEmbeddingProvider(fakeOpenAI) } });

    await client.embed({ input: 'q' });

    const requestOptions = create.mock.calls[0][1] as Record<string, unknown>;
    expect(requestOptions.timeout).toBeUndefined();
    expect(requestOptions.maxRetries).toBeUndefined();
  });
});

describe('getDefaultEmbeddingSpace', () => {
  it('is undefined before init', () => {
    const client = new EmbeddingClient();
    expect(client.getDefaultEmbeddingSpace()).toBeUndefined();
  });

  it('returns the default provider + its defaultModel after init', () => {
    const client = new EmbeddingClient();
    client.init({ providers: { voyage: new VoyageEmbeddingProvider('vk') } });
    expect(client.getDefaultEmbeddingSpace()).toEqual({ provider: 'voyage', model: 'voyage-4' });
  });

  it('respects the resolved default among multiple providers', () => {
    const client = new EmbeddingClient();
    client.init({
      providers: {
        google: new GoogleEmbeddingProvider({ projectId: 'p', location: 'us-west1' }),
        voyage: new VoyageEmbeddingProvider('vk'),
      },
      // BUILTIN_PREFERENCE puts google first; make the choice explicit here.
      defaultProvider: 'google',
    });
    expect(client.getDefaultEmbeddingSpace()).toEqual({ provider: 'google', model: 'gemini-embedding-001' });
  });
});
