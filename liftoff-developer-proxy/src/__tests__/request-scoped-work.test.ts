// developer-proxy runs on request-based CPU: work left running after its
// request stalls until the next request or shutdown. These pin the three
// mechanisms that keep work inside a request or settle it at shutdown.

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Outbox mocks (must precede the dynamic import of the worker)
// ---------------------------------------------------------------------------

let publisherDrains: number[] = [];
let publisherActive = 0;
let publisherMaxActive = 0;
const publisherDrain = jest.fn(async () => {
  publisherActive++;
  publisherMaxActive = Math.max(publisherMaxActive, publisherActive);
  await new Promise((r) => setTimeout(r, 5));
  publisherActive--;
  return publisherDrains.shift() ?? 0;
});

jest.unstable_mockModule('@liftoffos/outbox', () => ({
  OutboxPublisher: jest.fn().mockImplementation(() => ({ drain: publisherDrain })),
}));
jest.unstable_mockModule('@google-cloud/pubsub', () => ({ PubSub: jest.fn() }));
jest.unstable_mockModule('@google-cloud/secret-manager', () => ({ SecretManagerServiceClient: jest.fn() }));

let auditRows: Array<{ id: number; event_id: string; event_type: string; tenant_id: string; payload: object; retry_count: number }> = [];
const queries: string[] = [];
jest.unstable_mockModule('../infrastructure/database.js', () => ({
  getPool: jest.fn(async () => ({
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SELECT id, event_id')) {
        const rows = auditRows;
        auditRows = [];
        return { rows };
      }
      return { rows: [] };
    }),
  })),
}));
jest.unstable_mockModule('../infrastructure/config.js', () => ({
  loadConfig: () => ({
    GCP_PROJECT_ID: 'p',
    ENVIRONMENT: 'test',
    OUTBOX_POLL_INTERVAL_MS: 500,
    OUTBOX_BATCH_SIZE: 100,
    CONTROL_PLANE_API_URL: 'https://pb.test',
    TENANT_RUNTIME_SERVICE_TOKEN_SECRET: 's',
  }),
}));

const { track, settleInFlight } = await import('../infrastructure/in-flight.js');
const { closeAfter } = await import('../proxy/close-after.js');
const { drainOutboxes } = await import('../outbox/worker.js');

beforeAll(() => {
  process.env.NODE_ENV = 'test';
});

describe('in-flight tracking', () => {
  it('settles every tracked promise, including one tracked while settling', async () => {
    const done: string[] = [];
    track(new Promise<void>((r) => setTimeout(() => {
      done.push('first');
      track(new Promise<void>((r2) => setTimeout(() => { done.push('second'); r2(); }, 5)));
      r();
    }, 5)));
    await settleInFlight();
    expect(done).toEqual(['first', 'second']);
  });

  it('a rejected promise still settles and never throws out of settleInFlight', async () => {
    track(Promise.reject(new Error('write failed'))).catch(() => undefined);
    await expect(settleInFlight()).resolves.toBeUndefined();
  });
});

describe('closeAfter: the stream closes once its usage row is written', () => {
  it('waits for the record before closing', async () => {
    const order: string[] = [];
    const recorded = new Promise<void>((r) => setTimeout(() => { order.push('recorded'); r(); }, 10));
    await closeAfter(recorded, () => order.push('closed'));
    expect(order).toEqual(['recorded', 'closed']);
  });

  it('closes at the cap when the record is slow, and the record carries on', async () => {
    let recordedAt = 0;
    const recorded = new Promise<void>((r) => setTimeout(() => { recordedAt = Date.now(); r(); }, 60));
    let closedAt = 0;
    await closeAfter(recorded, () => { closedAt = Date.now(); }, 10);
    expect(closedAt).toBeGreaterThan(0);
    expect(recordedAt).toBe(0);
    await recorded;
    expect(recordedAt).toBeGreaterThan(closedAt);
  });

  it('closes when the record fails, without throwing', async () => {
    const close = jest.fn();
    await expect(closeAfter(Promise.reject(new Error('db down')), close)).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('drainOutboxes', () => {
  beforeEach(() => {
    publisherDrains = [];
    publisherActive = 0;
    publisherMaxActive = 0;
    publisherDrain.mockClear();
    auditRows = [];
    queries.length = 0;
  });

  it('delivers Pub/Sub batches until one comes back empty', async () => {
    publisherDrains = [100, 100, 3, 0, 7];
    await drainOutboxes();
    // Three batches with rows, then the empty one that ends it; the fifth never runs.
    expect(publisherDrain).toHaveBeenCalledTimes(4);
  });

  it('never runs two drains at once: neither path locks its rows', async () => {
    publisherDrains = [5, 0, 5, 0];
    await Promise.all([drainOutboxes(), drainOutboxes()]);
    expect(publisherMaxActive).toBe(1);
  });

  it('stops at a Platform Backend 5xx instead of spending the row\'s retries', async () => {
    auditRows = [{ id: 1, event_id: 'e1', event_type: 'audit.x', tenant_id: 't', payload: {}, retry_count: 0 }];
    const fetchMock = jest.fn(async () => new Response('', { status: 503 }));
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      await drainOutboxes();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const retryUpdates = queries.filter((q) => q.includes('SET retry_count = $2, last_error = $3 WHERE id = $1'));
    expect(retryUpdates).toHaveLength(1);
  });
});
