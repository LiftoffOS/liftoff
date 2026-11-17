import { fetchJsonWithRetry } from '../../src/providers/http';
import { EmbeddingError } from '../../src/types';

describe('fetchJsonWithRetry', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });

  it('returns parsed JSON on first-attempt success', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ x: 1 }) });
    const r = await fetchJsonWithRetry<{ x: number }>('https://e', {
      method: 'POST', headers: {}, provider: 'google',
    });
    expect(r).toEqual({ x: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx and succeeds on the second attempt', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable', headers: { get: () => null } })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: 1 }) });
    const r = await fetchJsonWithRetry<{ ok: number }>('https://e', {
      method: 'POST', headers: {}, provider: 'google', retries: 2,
    });
    expect(r).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies 401 as auth and does NOT retry', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'no auth', headers: { get: () => null } });
    await expect(fetchJsonWithRetry('https://e', { method: 'POST', headers: {}, provider: 'voyage', retries: 3 }))
      .rejects.toMatchObject({ kind: 'auth', status: 401, provider: 'voyage' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies 429 as rate_limit and respects integer Retry-After', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false, status: 429, text: async () => 'slow down',
        headers: { get: (h: string) => h.toLowerCase() === 'retry-after' ? '0' : null },
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ done: true }) });
    const r = await fetchJsonWithRetry<{ done: boolean }>('https://e', {
      method: 'POST', headers: {}, provider: 'voyage', retries: 1,
    });
    expect(r).toEqual({ done: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws EmbeddingError after retries exhausted on transient class', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'oops', headers: { get: () => null } });
    await expect(fetchJsonWithRetry('https://e', { method: 'POST', headers: {}, provider: 'google', retries: 1 }))
      .rejects.toMatchObject({ kind: 'transient', status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('aborts on timeout and surfaces as transient', async () => {
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          (e as Error & { name: string }).name = 'AbortError';
          reject(e);
        });
      }),
    );
    await expect(fetchJsonWithRetry('https://e', {
      method: 'POST', headers: {}, provider: 'google', timeoutMs: 50, retries: 0,
    })).rejects.toMatchObject({ kind: 'transient', provider: 'google' });
  });

  it('wraps network errors as transient', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('socket hangup'));
    await expect(fetchJsonWithRetry('https://e', {
      method: 'POST', headers: {}, provider: 'google', retries: 0,
    })).rejects.toBeInstanceOf(EmbeddingError);
  });
});
