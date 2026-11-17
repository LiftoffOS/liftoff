// Test servers must never bind inside the OS ephemeral port range.
//
// Guards the fix in setup.ts for a flake that failed ~1 full-suite run in 6
// under load, in a different HTTP suite each time, wearing three faces:
// `socket hang up`, a 404 from a route that demonstrably exists, and a 10s
// timeout. One cause: `supertest(app)` binds a fresh server per request via
// `app.listen(0)`, which draws from the same ephemeral pool client sockets use
// (49152-65535 on this machine). Closed connections linger in TIME_WAIT for
// 2*MSL, and because Node sets SO_REUSEADDR the bind SUCCEEDS onto a port that
// still has an entry — after which a stale segment reaches the new listener.
//
// If someone removes or breaks the port-band patch, this fails loudly instead
// of the suite going quietly flaky again months later.

import express from 'express';
import request from 'supertest';

/** Lowest ephemeral port on Linux (32768) and macOS (49152); staying under the
 *  smaller of the two keeps this valid on both CI and dev machines. */
const LOWEST_EPHEMERAL = 32768;

async function bindAndReadPort(): Promise<number> {
  const server = express().listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('test server port allocation', () => {
  it('binds below the ephemeral range, so a listener can never collide with a client socket', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await bindAndReadPort()).toBeLessThan(LOWEST_EPHEMERAL);
    }
  });

  it('hands out a different port each time, so a port is not reused while TIME_WAIT is live', async () => {
    const ports: number[] = [];
    for (let i = 0; i < 8; i++) ports.push(await bindAndReadPort());
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('leaves supertest working end to end', async () => {
    const app = express();
    app.get('/ping', (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('does not touch an explicitly requested port', async () => {
    const server = express().listen(38123);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    expect((server.address() as { port: number }).port).toBe(38123);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
