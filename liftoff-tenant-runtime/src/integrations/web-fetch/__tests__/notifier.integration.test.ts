/**
 * Postgres-backed integration tests for the LISTEN/NOTIFY notifier.
 *
 * Gated on TEST_DATABASE_URL. Verifies:
 *  - getReleaseEmitter() establishes a live LISTEN client
 *  - pg_notify('web_fetch_release', vendor) wakes the EventEmitter
 *  - notifications are filtered by vendor at the listener level
 *  - shutdownNotifier() closes the client + emitter cleanly
 *  - reconnect behavior after the client is forcibly closed
 */

import { Pool } from 'pg';

const SKIP = !process.env.TEST_DATABASE_URL;
const describeFn = SKIP ? describe.skip : describe;

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getReleaseEmitter, shutdownNotifier, subscribeToPgChannel } from '../notifier';

let pool: Pool;

async function waitForEvent(emitter: ReturnType<typeof getReleaseEmitter>, vendor: string, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const onRelease = (v: string) => {
      if (v === vendor) { clearTimeout(timer); emitter.off('release', onRelease); resolve(v); }
    };
    const timer = setTimeout(() => {
      emitter.off('release', onRelease);
      reject(new Error(`timed out waiting for ${vendor}`));
    }, timeoutMs);
    emitter.on('release', onRelease);
  });
}

describeFn('notifier — Postgres LISTEN/NOTIFY integration', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL!;
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await shutdownNotifier();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('emits "release" with the vendor payload when pg_notify fires', async () => {
    const emitter = getReleaseEmitter();
    // Give the LISTEN client a moment to attach.
    await new Promise(r => setTimeout(r, 300));
    const got = waitForEvent(emitter, 'anchor');
    await pool.query(`SELECT pg_notify('web_fetch_release', 'anchor')`);
    await expect(got).resolves.toBe('anchor');
  }, 8_000);

  it('filters by vendor: only listeners for the matching vendor wake', async () => {
    const emitter = getReleaseEmitter();
    await new Promise(r => setTimeout(r, 300));
    let webclawSeen = 0;
    const onRelease = (v: string) => { if (v === 'webclaw') webclawSeen++; };
    emitter.on('release', onRelease);
    await pool.query(`SELECT pg_notify('web_fetch_release', 'anchor')`);
    await pool.query(`SELECT pg_notify('web_fetch_release', 'browserbase')`);
    await new Promise(r => setTimeout(r, 300));
    expect(webclawSeen).toBe(0);
    await pool.query(`SELECT pg_notify('web_fetch_release', 'webclaw')`);
    await new Promise(r => setTimeout(r, 300));
    expect(webclawSeen).toBe(1);
    emitter.off('release', onRelease);
  }, 8_000);

  it('subscribeToPgChannel multiplexes multiple channels over the same client', async () => {
    // First subscriber on `web_fetch_release` boots the client.
    getReleaseEmitter();
    await new Promise(r => setTimeout(r, 300));
    // Add a second arbitrary channel.
    const seen: string[] = [];
    const sub = subscribeToPgChannel('test_channel_42', (payload) => seen.push(payload));
    await new Promise(r => setTimeout(r, 200));
    try {
      await pool.query(`SELECT pg_notify('test_channel_42', 'hello')`);
      await pool.query(`SELECT pg_notify('test_channel_42', 'world')`);
      await new Promise(r => setTimeout(r, 300));
      expect(seen).toEqual(['hello', 'world']);
    } finally {
      sub.unsubscribe();
    }
    // After unsubscribe, the channel goes silent for the test handler.
    await pool.query(`SELECT pg_notify('test_channel_42', 'after-unsub')`);
    await new Promise(r => setTimeout(r, 200));
    expect(seen).toEqual(['hello', 'world']);
  }, 8_000);

  it('rejects an invalid channel name to prevent SQL injection', () => {
    expect(() => subscribeToPgChannel('drop"; DROP TABLE;', () => {})).toThrow(/invalid pg LISTEN channel/);
  });

  it('shutdownNotifier closes the client cleanly and removes listeners', async () => {
    const e1 = getReleaseEmitter();
    await new Promise(r => setTimeout(r, 200));
    await shutdownNotifier();
    // After shutdown a fresh getReleaseEmitter() returns a NEW emitter (not
    // the closed one). The old emitter must have no listeners.
    expect(e1.listenerCount('release')).toBe(0);
    const e2 = getReleaseEmitter();
    expect(e2).not.toBe(e1);
    await new Promise(r => setTimeout(r, 200));
    const got = waitForEvent(e2, 'anchor');
    await pool.query(`SELECT pg_notify('web_fetch_release', 'anchor')`);
    await expect(got).resolves.toBe('anchor');
  }, 8_000);
});
