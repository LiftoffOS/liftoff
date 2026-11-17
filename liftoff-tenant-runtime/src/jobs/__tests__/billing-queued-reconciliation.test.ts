// The reconciliation job's selection window.
//
// This job was safe only because nothing had ever run it. Its query bounded
// completed_at on the recent side and not at all on the older side, so a first
// run would have replayed every pending invocation ever recorded — including
// rows predating the billing pipeline itself. Each replayed event writes spend,
// drains prepaid balance and can trigger an auto-reload charge, while Stripe
// refuses any meter event older than 35 calendar days. The result would have
// been charges for usage the meter could not accept.

import { jest } from '@jest/globals';

const mockQuery = jest.fn<() => Promise<{ rows: unknown[]; rowCount: number }>>();
const mockPublish = jest.fn<() => Promise<string>>().mockResolvedValue('msg-1');
const mockMarkBillingQueued = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...a: unknown[]) => mockQuery(...(a as [])) },
}));
jest.mock('../../infrastructure/pubsub', () => ({
  publisher: { publish: (...a: unknown[]) => mockPublish(...(a as [])) },
}));
jest.mock('../../invocations/service', () => ({
  invocationsService: {
    markBillingQueued: (...a: unknown[]) => mockMarkBillingQueued(...(a as [])),
  },
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { runBillingQueuedReconciliation } from '../billing-queued-reconciliation';

/** Stripe's documented ceiling for a meter event timestamp. */
const STRIPE_MAX_AGE_DAYS = 35;

beforeEach(() => {
  mockQuery.mockReset();
  mockPublish.mockClear();
  mockMarkBillingQueued.mockClear();
  // First call is the expiry UPDATE, second is the pending SELECT.
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

it('bounds the replay selection at the age Stripe stops accepting meter events', async () => {
  await runBillingQueuedReconciliation();

  const select = mockQuery.mock.calls.find(
    (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT'),
  );
  expect(select).toBeDefined();

  const [sql, params] = select as [string, unknown[]];
  // An upper bound alone is the bug: it lets the job reach back to the first
  // row ever written.
  expect(sql).toContain("completed_at < NOW() - INTERVAL '5 minutes'");
  expect(sql).toMatch(/completed_at > NOW\(\) - \(\$1::int \* INTERVAL '1 day'\)/);
  expect(params).toEqual([STRIPE_MAX_AGE_DAYS]);
});

it('expires rows past the horizon so the pending count can converge', async () => {
  await runBillingQueuedReconciliation();

  const update = mockQuery.mock.calls.find(
    (c) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE invocations'),
  );
  expect(update).toBeDefined();

  const [sql, params] = update as [string, unknown[]];
  expect(sql).toContain("SET billing_queued = 'expired'");
  expect(sql).toContain("billing_queued = 'pending'");
  // Complement of the SELECT's lower bound: together they partition pending
  // rows into replay-or-expire with no row left in both and none in neither.
  expect(sql).toMatch(/completed_at <= NOW\(\) - \(\$1::int \* INTERVAL '1 day'\)/);
  expect(params).toEqual([STRIPE_MAX_AGE_DAYS]);
});

it('expires before it replays, so a backlog cannot mask a live failure', async () => {
  await runBillingQueuedReconciliation();

  const kinds = mockQuery.mock.calls.map(([sql]) =>
    (sql as string).includes('UPDATE invocations') ? 'expire' : 'select',
  );
  expect(kinds[0]).toBe('expire');
});

it('still expires when there is nothing to replay', async () => {
  // The early return on an empty SELECT must not skip the sweep — otherwise a
  // backlog of unbillable rows sits there forever.
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 12 });
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

  await runBillingQueuedReconciliation();

  expect(mockQuery.mock.calls[0][0]).toContain('UPDATE invocations');
  expect(mockPublish).not.toHaveBeenCalled();
});

it('publishes and marks the rows inside the window', async () => {
  mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  mockQuery.mockResolvedValueOnce({
    rows: [{
      id: 'inv-1',
      tenant_id: 'tenant-1',
      agent_id: 'agent-1',
      cost_usd: '0.25',
      started_at: new Date('2026-08-01T00:00:00Z'),
      provider: 'anthropic',
      model_id: 'claude-opus-5',
      input_tokens: 100,
      output_tokens: 50,
      cached_tokens: 0,
      cached_input_price_per_million: null,
      grounding_queries: null,
      grounding_cost_usd: null,
      thread_id: null,
      triggered_by: null,
      trigger_ref: null,
    }],
    rowCount: 1,
  });

  await runBillingQueuedReconciliation();

  expect(mockPublish).toHaveBeenCalledTimes(1);
  const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
  expect(payload.invocationId).toBe('inv-1');
  expect(payload.isReconciliation).toBe(true);
  expect(mockMarkBillingQueued).toHaveBeenCalledWith('inv-1', 'published');
});
