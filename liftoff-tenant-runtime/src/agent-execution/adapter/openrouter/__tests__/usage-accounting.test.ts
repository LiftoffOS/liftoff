/**
 * The gateway is asked what the call cost, and nothing else is disturbed.
 *
 * This wrapper is the only thing that makes the real charge available: without
 * the flag OpenRouter returns no `usage.cost`, every call silently reverts to
 * the max-across-endpoints estimate (about 2x the median), and nothing anywhere
 * reports a problem. So the test that matters is that the flag reaches the body
 * — and that a body it cannot safely rewrite is forwarded untouched, because a
 * corrupted body fails a customer's run while a missing flag only costs accuracy.
 */

import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { fetchRequestingUsageAccounting } from '../usage-accounting';

/** Captures what the wrapped fetch was actually called with. */
function spy() {
  const calls: Array<{ url: unknown; init?: RequestInit }> = [];
  const inner = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, wrapped: fetchRequestingUsageAccounting(inner) };
}

const parse = (init?: RequestInit): Record<string, unknown> =>
  JSON.parse(String(init?.body)) as Record<string, unknown>;

const POST = 'https://openrouter.ai/api/v1/chat/completions';

describe('a chat-completions request asks for usage accounting', () => {
  it('adds the flag', async () => {
    const { calls, wrapped } = spy();
    await wrapped(POST, { method: 'POST', body: JSON.stringify({ model: 'z-ai/glm-5.3' }) });
    expect(parse(calls[0].init).usage).toEqual({ include: true });
  });

  it('leaves the rest of the body exactly as it was', async () => {
    const { calls, wrapped } = spy();
    const original = { model: 'z-ai/glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true };
    await wrapped(POST, { method: 'POST', body: JSON.stringify(original) });
    const sent = parse(calls[0].init);
    const { usage, ...rest } = sent;
    expect(usage).toEqual({ include: true });
    expect(rest).toEqual(original);
  });

  it('works when the URL is a URL object', async () => {
    const { calls, wrapped } = spy();
    await wrapped(new URL(POST), { method: 'POST', body: JSON.stringify({ model: 'x' }) });
    expect(parse(calls[0].init).usage).toEqual({ include: true });
  });

  it('never overwrites a usage field the caller already set', async () => {
    const { calls, wrapped } = spy();
    await wrapped(POST, { method: 'POST', body: JSON.stringify({ model: 'x', usage: { include: false } }) });
    expect(parse(calls[0].init).usage).toEqual({ include: false });
  });
});

describe('anything it cannot safely rewrite is forwarded untouched', () => {
  it('a non-POST', async () => {
    const { calls, wrapped } = spy();
    await wrapped('https://openrouter.ai/api/v1/models', { method: 'GET' });
    expect(calls[0].init?.body).toBeUndefined();
  });

  it('a different endpoint', async () => {
    const { calls, wrapped } = spy();
    const body = JSON.stringify({ model: 'x' });
    await wrapped('https://openrouter.ai/api/v1/credits', { method: 'POST', body });
    expect(calls[0].init?.body).toBe(body);
  });

  it('a body that is not JSON', async () => {
    const { calls, wrapped } = spy();
    await wrapped(POST, { method: 'POST', body: 'not json at all' });
    expect(calls[0].init?.body).toBe('not json at all');
  });

  it('a JSON body that is not an object', async () => {
    const { calls, wrapped } = spy();
    await wrapped(POST, { method: 'POST', body: '[1,2,3]' });
    expect(calls[0].init?.body).toBe('[1,2,3]');
  });

  it('a streamed (non-string) body', async () => {
    const { calls, wrapped } = spy();
    await wrapped(POST, { method: 'POST', body: new Uint8Array([1, 2]) as unknown as BodyInit });
    expect(typeof calls[0].init?.body).not.toBe('string');
  });
});

describe('a rewritten body is sent with a length that matches it', () => {
  // The OpenAI SDK sets content-length from the body it serialised. The flag
  // makes the body longer, and Node's fetch refuses the mismatch, so every
  // request fails as "Connection error." while the tests above, which set no
  // headers, still pass.
  const body = JSON.stringify({ model: 'z-ai/glm-5.3' });
  const shapes: Array<[string, () => HeadersInit]> = [
    ['a header record', () => ({ 'Content-Length': String(body.length), 'x-keep': 'yes' })],
    ['a Headers object', () => new Headers({ 'content-length': String(body.length), 'x-keep': 'yes' })],
    ['a header array', () => [['content-length', String(body.length)], ['x-keep', 'yes']]],
  ];

  it.each(shapes)('drops the stale content-length from %s and keeps the rest', async (_shape, make) => {
    const { calls, wrapped } = spy();
    await wrapped(POST, { method: 'POST', headers: make(), body });
    const sent = new Headers(calls[0].init?.headers);
    expect(sent.get('content-length')).toBeNull();
    expect(sent.get('x-keep')).toBe('yes');
  });

  it('leaves the headers alone when it forwards the request untouched', async () => {
    const { calls, wrapped } = spy();
    const headers = { 'content-length': '9', 'x-keep': 'yes' };
    await wrapped(POST, { method: 'POST', headers, body: JSON.stringify({ model: 'x', usage: {} }) });
    expect(calls[0].init?.headers).toBe(headers);
  });

  describe('through the real fetch', () => {
    let server: Server;
    let received: string | undefined;
    beforeAll(async () => {
      server = createServer((req, res) => {
        let data = '';
        req.on('data', (c) => { data += c; });
        req.on('end', () => { received = data; res.end('{}'); });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    });
    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('arrives with the flag, where it used to fail before sending', async () => {
      const { port } = server.address() as AddressInfo;
      const wrapped = fetchRequestingUsageAccounting(fetch);
      const res = await wrapped(`http://127.0.0.1:${port}/api/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
        body,
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(String(received)).usage).toEqual({ include: true });
    });
  });
});
