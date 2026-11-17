// Telling a customer's own system what happened.
//
// The tests that carry weight here are the ones about what this must NEVER do:
// block a run, send to somewhere private, retry a refusal, or grow without
// bound. The happy path is a POST — it is the failure modes that make an
// outbound call from a control plane dangerous.

import {
  CLAIM_LEASE_MS,
  DELIVERY_TIMEOUT_MS,
  MAX_DELIVERY_ATTEMPTS,
  MAX_ENDPOINT_FAILURES,
  MAX_QUEUED_PER_TENANT,
  OUTBOUND_EVENT_TYPES,
  backoffMs,
  enqueueLifecycleEvent,
  drainOutboundWebhooks,
  generateSigningSecret,
  isOutboundEventType,
  signOutboundBody,
  WORKER_BATCH,
} from '../outbound-webhooks';

const tenantQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: string, fn: (c: unknown) => unknown) =>
    fn({ query: (...a: unknown[]) => tenantQuery(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const assertPublicUrl = jest.fn();
class FakeBlockedUrlError extends Error {}
jest.mock('../../common/url-guard', () => ({
  assertPublicUrl: (...a: unknown[]) => assertPublicUrl(...a),
  BlockedUrlError: class extends Error {},
}));

jest.mock('../secret-encryption', () => ({
  encryptSecret: (s: string) => Buffer.from(s),
  decryptSecret: (b: Buffer) => b.toString(),
}));

const TENANT = '00000000-0000-0000-0000-0000000000aa';

beforeEach(() => {
  jest.clearAllMocks();
  assertPublicUrl.mockResolvedValue(undefined);
  tenantQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('the event list', () => {
  it('is closed', () => {
    // Every entry is a promise to keep sending that shape. A firehose of
    // everything the platform does is both a data-egress question and an
    // interface nobody could depend on.
    expect(isOutboundEventType('run.completed')).toBe(true);
    expect(isOutboundEventType('anything.else')).toBe(false);
  });

  it('covers a run ending both ways', () => {
    expect(OUTBOUND_EVENT_TYPES).toContain('run.completed');
    expect(OUTBOUND_EVENT_TYPES).toContain('run.failed');
  });
});

describe('signing', () => {
  it('matches the inbound header format exactly', () => {
    // One format in both directions means a customer writes one verifier, and
    // our own docs cannot disagree with themselves.
    const { header } = signOutboundBody('{"a":1}', 'secret', 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  it('signs the timestamp, not just sends it', () => {
    // A signature that does not cover its own timestamp can be replayed
    // forever with a fresh one pasted on.
    const a = signOutboundBody('{}', 'secret', 1_700_000_000).header;
    const b = signOutboundBody('{}', 'secret', 1_700_000_001).header;
    expect(a.split('v1=')[1]).not.toBe(b.split('v1=')[1]);
  });

  it('changes with the body', () => {
    const a = signOutboundBody('{"a":1}', 's', 1).header;
    const b = signOutboundBody('{"a":2}', 's', 1).header;
    expect(a).not.toBe(b);
  });

  it('changes with the secret', () => {
    expect(signOutboundBody('{}', 'one', 1).header).not.toBe(signOutboundBody('{}', 'two', 1).header);
  });

  it('mints a secret with real entropy', () => {
    const a = generateSigningSecret();
    expect(a).toHaveLength(64);
    expect(a).not.toBe(generateSigningSecret());
  });
});

describe('backoff', () => {
  it('grows', () => {
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1));
  });

  it('is capped, so a retry never lands a week out', () => {
    // A retry that far away is indistinguishable from dropping it, except it
    // keeps the row.
    expect(backoffMs(50)).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
  });
});

describe('enqueueing', () => {
  it('writes rows and opens no socket', async () => {
    // The whole design rests on this: a lifecycle event does one INSERT and
    // returns. Anything that awaits a customer's server here would put their
    // downtime inside our run.
    tenantQuery
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'd1' }], rowCount: 1 });
    const r = await enqueueLifecycleEvent({
      tenantId: TENANT, eventType: 'run.completed', payload: { ok: true },
    });
    expect(r.queued).toBe(1);
    const sql = tenantQuery.mock.calls[1][0] as string;
    expect(sql).toMatch(/INSERT INTO outbound_webhook_deliveries/);
  });

  it('only queues for endpoints that asked for this event', async () => {
    tenantQuery
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await enqueueLifecycleEvent({ tenantId: TENANT, eventType: 'run.failed', payload: {} });
    const sql = tenantQuery.mock.calls[1][0] as string;
    expect(sql).toMatch(/= ANY\(w\.event_types\)/);
  });

  it('only queues for endpoints that are switched on', async () => {
    tenantQuery
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await enqueueLifecycleEvent({ tenantId: TENANT, eventType: 'run.failed', payload: {} });
    expect(tenantQuery.mock.calls[1][0] as string).toMatch(/w\.enabled = true/);
  });

  it('drops rather than growing past the cap', async () => {
    // One customer's broken receiver must not become everybody's disk. And a
    // receiver down long enough to bank ten thousand events does not want them
    // all at once when it returns.
    tenantQuery.mockResolvedValueOnce({ rows: [{ count: String(MAX_QUEUED_PER_TENANT) }] });
    const r = await enqueueLifecycleEvent({ tenantId: TENANT, eventType: 'run.completed', payload: {} });
    expect(r.queued).toBe(0);
    expect(tenantQuery).toHaveBeenCalledTimes(1);
  });

  it('never throws, whatever the database does', async () => {
    // A failure to notify an external system is not a reason for a run to fail.
    tenantQuery.mockRejectedValue(new Error('db down'));
    await expect(enqueueLifecycleEvent({
      tenantId: TENANT, eventType: 'run.completed', payload: {},
    })).resolves.toEqual({ queued: 0 });
  });
});

describe('delivering', () => {
  const dueRow = {
    id: 'd1',
    tenant_id: TENANT,
    webhook_id: 'w1',
    event_type: 'run.completed',
    payload: { ok: true },
    attempts: 0,
    created_at: new Date('2026-08-05T10:00:00.000Z'),
    url: 'https://customer.example.com/hook',
    secret_enc: Buffer.from('the-secret'),
  };

  const withAdminScope = (rows: unknown[]) =>
    jest.fn(async (fn: (c: { query: () => Promise<{ rows: unknown[] }> }) => unknown) =>
      fn({ query: async () => ({ rows }) }));

  it('sends byte-identical bodies on every attempt', async () => {
    // A receiver deduplicating on the payload, or a hash of it, would otherwise
    // treat three retries of one event as three events — which is exactly what
    // at-least-once delivery is supposed to be survivable against.
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    await drainOutboundWebhooks({ withAdminScope: withAdminScope([dueRow]) as never, fetchImpl });
    await drainOutboundWebhooks({
      withAdminScope: withAdminScope([{ ...dueRow, attempts: 1 }]) as never, fetchImpl,
    });
    expect(fetchImpl.mock.calls[0][1].body).toBe(fetchImpl.mock.calls[1][1].body);
  });

  it('stamps the event time, not the attempt time', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await drainOutboundWebhooks({ withAdminScope: withAdminScope([dueRow]) as never, fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).createdAt)
      .toBe('2026-08-05T10:00:00.000Z');
  });

  it('still signs each attempt freshly, or the receiver would reject the retry', () => {
    // The body is stable; the SIGNATURE must not be. It covers a timestamp,
    // and a stale one falls outside the receiver's replay window.
    const a = signOutboundBody('{"same":"body"}', 'secret', 1_700_000_000).header;
    const b = signOutboundBody('{"same":"body"}', 'secret', 1_700_000_600).header;
    expect(a).not.toBe(b);
  });

  it('signs what it sends', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await drainOutboundWebhooks({ withAdminScope: withAdminScope([dueRow]) as never, fetchImpl });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['X-Liftoff-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(init.headers['X-Liftoff-Event']).toBe('run.completed');
    expect(init.headers['X-Liftoff-Delivery']).toBe('d1');
  });

  it('bounds how long it waits on somebody else\'s server', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await drainOutboundWebhooks({ withAdminScope: withAdminScope([dueRow]) as never, fetchImpl });
    expect(fetchImpl.mock.calls[0][1].signal).toBeDefined();
  });

  it('re-checks the URL immediately before sending', async () => {
    // A hostname that resolved publicly when it was registered can be
    // re-pointed at an internal address afterwards. This is the last moment we
    // can refuse.
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await drainOutboundWebhooks({ withAdminScope: withAdminScope([dueRow]) as never, fetchImpl });
    expect(assertPublicUrl).toHaveBeenCalledWith(dueRow.url, { allowHttp: false });
  });

  it('does not send at all when the URL has gone private', async () => {
    assertPublicUrl.mockRejectedValue(new FakeBlockedUrlError('private address'));
    const fetchImpl = jest.fn();
    const r = await drainOutboundWebhooks({ withAdminScope: withAdminScope([dueRow]) as never, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.abandoned).toBe(1);
  });

  it('marks a 2xx delivered', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const r = await drainOutboundWebhooks({ withAdminScope: withAdminScope([dueRow]) as never, fetchImpl });
    expect(r.delivered).toBe(1);
  });

  it('retries a 5xx', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const r = await drainOutboundWebhooks({ withAdminScope: withAdminScope([dueRow]) as never, fetchImpl });
    expect(r.abandoned).toBe(0);
  });

  it('retries a 429, which is a receiver asking for time', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 429 });
    const r = await drainOutboundWebhooks({ withAdminScope: withAdminScope([dueRow]) as never, fetchImpl });
    expect(r.abandoned).toBe(0);
  });

  it('does NOT retry a 400, which is a receiver refusing', async () => {
    // Retrying a refusal is how a broken integration becomes a sustained load
    // on somebody else's server.
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 400 });
    const r = await drainOutboundWebhooks({ withAdminScope: withAdminScope([dueRow]) as never, fetchImpl });
    expect(r.abandoned).toBe(1);
  });

  it('gives up after the attempt cap', async () => {
    const spent = { ...dueRow, attempts: MAX_DELIVERY_ATTEMPTS - 1 };
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const r = await drainOutboundWebhooks({ withAdminScope: withAdminScope([spent]) as never, fetchImpl });
    expect(r.abandoned).toBe(1);
  });

  it('treats a network throw as a retryable failure, not a crash', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(drainOutboundWebhooks({
      withAdminScope: withAdminScope([dueRow]) as never, fetchImpl,
    })).resolves.toEqual(expect.objectContaining({ attempted: 1 }));
  });

  it('claims by WRITING, so an overlapping pass cannot send the same event twice', async () => {
    // The property, not the mechanism. A row lock is released when the claiming
    // transaction ends — which is before a single delivery has been attempted —
    // so `SELECT … FOR UPDATE` alone lets two passes each POST the same rows.
    // Pushing next_attempt_at past a lease is what actually hides them.
    let sql = '';
    const withScope = jest.fn(async (fn: (c: { query: (q: string) => Promise<{ rows: unknown[] }> }) => unknown) =>
      fn({ query: async (q: string) => { sql = q; return { rows: [] }; } }));
    await drainOutboundWebhooks({ withAdminScope: withScope as never, fetchImpl: jest.fn() });

    expect(sql).toMatch(/UPDATE outbound_webhook_deliveries/);
    expect(sql).toMatch(/SET next_attempt_at = NOW\(\) \+/);
    expect(sql).toMatch(/RETURNING/);
  });

  it('leases rather than claiming forever, so a dead worker does not strand its batch', () => {
    // At-least-once is the right guarantee for a webhook, and every request
    // carries a delivery id the receiver can deduplicate on.
    expect(CLAIM_LEASE_MS).toBeGreaterThan(WORKER_BATCH * DELIVERY_TIMEOUT_MS);
    expect(CLAIM_LEASE_MS).toBeLessThanOrEqual(60 * 60_000);
  });

  it('only claims deliveries whose endpoint is still enabled', async () => {
    let sql = '';
    const withScope = jest.fn(async (fn: (c: { query: (q: string) => Promise<{ rows: unknown[] }> }) => unknown) =>
      fn({ query: async (q: string) => { sql = q; return { rows: [] }; } }));
    await drainOutboundWebhooks({ withAdminScope: withScope as never, fetchImpl: jest.fn() });
    expect(sql).toMatch(/w2\.enabled = true/);
  });
});

describe('the endpoint failure streak', () => {
  it('counts and decides in one statement', () => {
    // Reading the count and writing it back races two workers into disabling
    // nothing at all.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'outbound-webhooks.ts'), 'utf8',
    ) as string;
    expect(src).toMatch(/consecutive_failures = consecutive_failures \+ 1[\s\S]{0,600}RETURNING consecutive_failures, enabled/);
  });

  it('has a threshold that is more than a bad minute', () => {
    expect(MAX_ENDPOINT_FAILURES).toBeGreaterThan(5);
  });

  it('clears the streak on any success', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'outbound-webhooks.ts'), 'utf8',
    ) as string;
    expect(src).toMatch(/SET consecutive_failures = 0, last_success_at = NOW\(\)/);
  });
});

describe('the wiring', () => {
  const read = (rel: string): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', '..', rel), 'utf8') as string;

  it('is fed by a run ending', () => {
    // A queue nothing writes to is the failure mode that makes a feature look
    // finished and do nothing.
    const src = read('agent-audit-logs/service.ts');
    expect(src).toMatch(/enqueueLifecycleEvent\(/);
    expect(src).toMatch(/'run\.completed' : 'run\.failed'/);
  });

  it('is fed by an approval decision', () => {
    // Every surface's approve and reject go through decideReview
    // (workspace-actions/review.ts), so the one enqueue there is fed by the
    // dashboard, Slack, Teams and the assistants alike; the oversight routes
    // are adapters over it and enqueue nothing of their own.
    const src = read('workspace-actions/review.ts');
    expect((src.match(/enqueueLifecycleEvent\(\{/g) ?? []).length).toBe(1);
    expect(src).toMatch(/eventType: 'approval\.decided'/);
    expect(read('internal-agent-oversight/router.ts')).not.toMatch(/enqueueLifecycleEvent\(/);
  });

  it('never awaits the enqueue on a hot path', () => {
    // `void` and `.catch()` rather than `await`: recording a run's outcome must
    // not be able to wait on a queue write, let alone on anybody's server.
    expect(read('agent-audit-logs/service.ts')).toMatch(/void enqueueLifecycleEvent\(/);
    expect(read('workspace-actions/review.ts')).toMatch(/void enqueueLifecycleEvent\(/);
  });

  it('drains from a cron, not from a request that matters', () => {
    expect(read('maintenance/expire-agent-messages.ts')).toMatch(/drain-outbound-webhooks/);
  });

  it('keeps the signing secret out of every read path', () => {
    const src = read('event-sources/outbound-webhooks.ts');
    const listBody = src.slice(src.indexOf('export async function listWebhooks'));
    const select = listBody.slice(listBody.indexOf('SELECT'), listBody.indexOf('FROM outbound_webhooks'));
    expect(select).not.toMatch(/secret_enc/);
  });

  it('registers disabled, so enabling is a separate deliberate act', () => {
    const migration = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', '..', 'migrations', '324_outbound_webhooks.sql'),
      'utf8',
    ) as string;
    expect(migration).toMatch(/enabled\s+BOOLEAN NOT NULL DEFAULT false/);
    expect(migration).toMatch(/FORCE ROW LEVEL SECURITY/);
  });
});
