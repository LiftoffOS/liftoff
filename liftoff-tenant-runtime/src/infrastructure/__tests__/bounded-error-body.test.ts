// I2 — bounded error-body reads.
//
// The case that matters is the second one: a server that opens a body and then
// stalls. `response.text()` waits for the stream to end, so an agent turn that
// hit such a server would hang indefinitely. Everything else here guards the
// ordinary paths against regression.

import { readBoundedErrorText } from '../bounded-error-body';

/** A response whose body yields the given chunks, then (optionally) never ends. */
function streamingResponse(chunks: string[], opts: { stall?: boolean } = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  let cancelled = false;

  const body = {
    getReader() {
      return {
        async read(): Promise<{ done: boolean; value?: Uint8Array }> {
          if (index < chunks.length) {
            return { done: false, value: encoder.encode(chunks[index++]) };
          }
          if (opts.stall) {
            // The hostile case: the body is open and nothing more is coming.
            return new Promise(() => { /* never settles */ });
          }
          return { done: true };
        },
        async cancel() { cancelled = true; },
      };
    },
  };

  return {
    response: { body } as unknown as { body: ReadableStream<Uint8Array> },
    wasCancelled: () => cancelled,
  };
}

describe('readBoundedErrorText', () => {
  it('reads a small body in full', async () => {
    const { response } = streamingResponse(['{"error":"not found"}']);
    await expect(readBoundedErrorText(response)).resolves.toBe('{"error":"not found"}');
  });

  it('joins multiple chunks', async () => {
    const { response } = streamingResponse(['{"err', 'or":"bad"}']);
    await expect(readBoundedErrorText(response)).resolves.toBe('{"error":"bad"}');
  });

  it('stops at the byte cap and says it truncated', async () => {
    const { response } = streamingResponse(['a'.repeat(500)]);
    const out = await readBoundedErrorText(response, { maxBytes: 100 });
    expect(out).toContain('[truncated]');
    expect(out.length).toBeLessThan(200);
  });

  it('does not read past the cap across many chunks', async () => {
    const { response } = streamingResponse(Array(50).fill('x'.repeat(100)));
    const out = await readBoundedErrorText(response, { maxBytes: 250 });
    expect(out.replace('… [truncated]', '').length).toBeLessThanOrEqual(250);
  });

  it('gives up on a stalled body instead of hanging', async () => {
    const { response, wasCancelled } = streamingResponse(['partial'], { stall: true });

    const started = Date.now();
    const out = await readBoundedErrorText(response, { deadlineMs: 50 });
    const elapsed = Date.now() - started;

    // The point of the whole module: this returns rather than waiting forever.
    expect(elapsed).toBeLessThan(2000);
    expect(out).toContain('partial');
    expect(out).toContain('[truncated]');
    expect(wasCancelled()).toBe(true);
  });

  it('releases the socket after a normal read', async () => {
    const { response, wasCancelled } = streamingResponse(['done']);
    await readBoundedErrorText(response);
    expect(wasCancelled()).toBe(true);
  });

  it('falls back to text() when there is no stream', async () => {
    const response = { body: null, text: async () => 'plain body' };
    await expect(readBoundedErrorText(response)).resolves.toBe('plain body');
  });

  it('bounds the text() fallback by the deadline too', async () => {
    const response = { body: null, text: () => new Promise<string>(() => { /* never */ }) };
    const started = Date.now();
    await expect(readBoundedErrorText(response, { deadlineMs: 50 })).resolves.toBe('');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns empty rather than throwing when there is nothing to read', async () => {
    await expect(readBoundedErrorText({ body: null })).resolves.toBe('');
  });

  it('never throws when the body errors mid-read', async () => {
    const response = {
      body: {
        getReader() {
          return {
            async read() { throw new Error('socket reset'); },
            async cancel() { /* no-op */ },
          };
        },
      },
    } as unknown as { body: ReadableStream<Uint8Array> };
    await expect(readBoundedErrorText(response)).resolves.toBe('');
  });
});
