// Change 0 (semantic recall v2): a call bounded by timeoutMs is truly
// ABORTED at the transport (fetchJsonWithRetry's AbortController fires the
// fetch signal), rejects with the classified timeout EmbeddingError, and
// still emits a failure usage event — no orphan request, no lost usage row.
// Uses the REAL http transport (no jest.mock of ./http) with a fetch fake
// that only settles when its abort signal fires.

import { EmbeddingClient } from '../src/client';
import { VoyageEmbeddingProvider } from '../src/providers/voyage';
import type { EmbeddingUsageEvent } from '../src/types';

describe('transport abort at timeoutMs', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('aborted call rejects with the classified timeout error and emits a failure usage event', async () => {
    // Never resolves on its own; rejects with AbortError when the transport's
    // AbortController fires — the behavior of a hung provider connection.
    global.fetch = jest.fn((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      })) as unknown as typeof fetch;

    const client = new EmbeddingClient();
    const events: EmbeddingUsageEvent[] = [];
    client.init({ providers: { voyage: new VoyageEmbeddingProvider('vk') } });
    client.onUsage((e) => { events.push(e); });

    await expect(
      client.embed({ input: 'q', timeoutMs: 25, retries: 0 }),
    ).rejects.toMatchObject({
      name: 'EmbeddingError',
      kind: 'transient',
      message: expect.stringContaining('timed out after 25ms'),
    });

    expect(events).toHaveLength(1);
    expect(events[0].success).toBe(false);
    expect(events[0].error).toContain('timed out after 25ms');
  });
});
