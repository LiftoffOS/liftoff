// The web app sends `Content-Type: application/json` on a body-less DELETE,
// which Fastify refuses before the route runs. Without the fix, "Disable" on
// auto-reload fails: the DELETE answers 400 and never reaches
// platform-backend.

import { describe, it, expect } from '@jest/globals';
import Fastify from 'fastify';
import { ignoreContentTypeWithoutBody } from '../empty-body';

async function app(withFix: boolean) {
  const a = Fastify({ logger: false });
  if (withFix) ignoreContentTypeWithoutBody(a);
  a.delete('/auto-reload', async () => ({ ok: true }));
  a.post('/echo', async (req) => ({ body: req.body ?? null }));
  await a.ready();
  return a;
}

const JSON_HEADER = { 'content-type': 'application/json' };

describe('ignoreContentTypeWithoutBody', () => {
  it('reproduces the refusal without it', async () => {
    const a = await app(false);
    const res = await a.inject({ method: 'DELETE', url: '/auto-reload', headers: JSON_HEADER });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('FST_ERR_CTP_EMPTY_JSON_BODY');
    await a.close();
  });

  it('lets a body-less DELETE with a JSON content type through', async () => {
    const a = await app(true);
    const res = await a.inject({ method: 'DELETE', url: '/auto-reload', headers: JSON_HEADER });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await a.close();
  });

  it('parses a request that carries a body exactly as before', async () => {
    const a = await app(true);
    const ok = await a.inject({ method: 'POST', url: '/echo', headers: JSON_HEADER, payload: '{"thresholdUsd":1}' });
    expect(ok.json()).toEqual({ body: { thresholdUsd: 1 } });
    const bad = await a.inject({ method: 'POST', url: '/echo', headers: JSON_HEADER, payload: '{not json' });
    expect(bad.statusCode).toBe(400);
    await a.close();
  });
});
