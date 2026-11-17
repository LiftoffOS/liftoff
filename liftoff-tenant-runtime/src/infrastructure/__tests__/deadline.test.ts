// withDeadline against a real server that accepts and never answers.
//
// The failure it exists for: a pooled connection that died in a network reset
// is still handed out, and a request on it waits for its caller's own timer.
// Both halves are pinned here, because both have been the gap: a request whose
// headers never come, and a response whose BODY never finishes (a timer cleared
// before `await response.json()` bounds the first and not the second).

import http from 'http';
import type { AddressInfo } from 'net';
import { withDeadline, DeadlineExceededError, isDeadlineExceeded } from '../deadline';

interface Hanging {
  url: string;
  /** Requests still open on the server side. */
  open: () => number;
  close: () => Promise<void>;
}

async function hangingServer(mode: 'no-headers' | 'no-body-end'): Promise<Hanging> {
  let open = 0;
  const server = http.createServer((req, res) => {
    open += 1;
    res.on('close', () => { open -= 1; });
    if (mode === 'no-body-end') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"partial":');
    }
    // never ends
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    open: () => open,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('withDeadline', () => {
  let server: Hanging | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it('ends a request whose answer never comes, with a typed error, and closes the socket', async () => {
    server = await hangingServer('no-headers');
    const startedAt = Date.now();
    const err = await withDeadline('test call', 200, (signal) => fetch(server!.url, { signal }))
      .catch((e: unknown) => e);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(err).toBeInstanceOf(DeadlineExceededError);
    expect(isDeadlineExceeded(err)).toBe(true);
    expect((err as DeadlineExceededError).message).toBe('test call timed out after 200ms');
    await settle();
    expect(server.open()).toBe(0);
  });

  it('bounds the body read too, not only the headers', async () => {
    server = await hangingServer('no-body-end');
    const startedAt = Date.now();
    const err = await withDeadline('test call', 200, async (signal) => {
      const resp = await fetch(server!.url, { signal });
      return resp.json();
    }).catch((e: unknown) => e);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(err).toBeInstanceOf(DeadlineExceededError);
    await settle();
    expect(server.open()).toBe(0);
  });

  it('bounds work that ignores the signal', async () => {
    const err = await withDeadline('deaf', 50, () => new Promise(() => undefined)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeadlineExceededError);
  });

  it('passes a result and a failure through untouched, and clears its timer', async () => {
    const spy = jest.spyOn(global, 'clearTimeout');
    await expect(withDeadline('ok', 1_000, async () => 42)).resolves.toBe(42);
    await expect(withDeadline('bad', 1_000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('leaves no unhandled rejection when the work fails after the deadline', async () => {
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let rejectLate: (_e: Error) => void = () => undefined;
      const late = new Promise<never>((_r, reject) => { rejectLate = reject; });
      await expect(withDeadline('late', 20, () => late)).rejects.toBeInstanceOf(DeadlineExceededError);
      rejectLate(new Error('after the deadline'));
      await settle();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
