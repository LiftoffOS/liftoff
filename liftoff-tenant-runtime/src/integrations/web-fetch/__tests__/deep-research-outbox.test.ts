const mockPoolQuery = jest.fn();
const mockPublishWebToolEvent = jest.fn();

jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../event-publisher', () => ({
  publishWebToolEvent: (...a: unknown[]) => mockPublishWebToolEvent(...a),
}));

import { enqueueOutbox, drainOnce, getOutboxBacklog, startOutboxDrainer, stopOutboxDrainer } from '../deep-research-outbox';
import type { WebToolSpendEvent } from '../event-publisher';

beforeEach(() => { jest.clearAllMocks(); });

const DR_ID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EVENT: WebToolSpendEvent = {
  tenantId:       'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  connector:      'perplexity',
  eventType:      'web_deep_research',
  costUsd:        0.40,
  occurredAt:     '2026-06-01T10:00:00Z',
  idempotencyKey: DR_ID,
};

describe('enqueueOutbox', () => {
  it('INSERTs with ON CONFLICT DO NOTHING for idempotency', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rowCount: 1 });
    await enqueueOutbox(DR_ID, 'pre_charge', EVENT, 'publish returned false');
    const [sql, params] = mockPoolQuery.mock.calls[0];
    expect(sql as string).toMatch(/ON CONFLICT \(deep_research_id, kind\) DO NOTHING/);
    expect(params?.[0]).toBe(DR_ID);
    expect(params?.[1]).toBe('pre_charge');
  });
});

describe('drainOnce', () => {
  it('publishes due rows and DELETEs on success', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({                     // selectDue
        rows: [{
          outbox_id: 'ox-1', deep_research_id: DR_ID, kind: 'pre_charge' as const,
          payload_json: EVENT, attempts: 0,
          next_attempt_at: new Date(), created_at: new Date(), last_error: null,
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });     // deleteRow
    mockPublishWebToolEvent.mockResolvedValueOnce(true);

    const result = await drainOnce();
    expect(result).toEqual({ drained: 1, failed: 0, given_up: 0 });
    expect(mockPoolQuery.mock.calls[1][0]).toMatch(/DELETE FROM deep_research_outbox/);
  });

  it('bumps attempts with exponential backoff on publish=false', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [{
          outbox_id: 'ox-1', deep_research_id: DR_ID, kind: 'delta' as const,
          payload_json: EVENT, attempts: 2,           // 3rd attempt → 40s backoff
          next_attempt_at: new Date(), created_at: new Date(), last_error: null,
        }],
      })
      .mockResolvedValueOnce({ rowCount: 1 });        // bumpAttempt
    mockPublishWebToolEvent.mockResolvedValueOnce(false);

    const result = await drainOnce();
    expect(result).toEqual({ drained: 0, failed: 1, given_up: 0 });
    const [sql, params] = mockPoolQuery.mock.calls[1];
    expect(sql as string).toMatch(/UPDATE deep_research_outbox/);
    expect(params?.[1]).toBe(3);                      // attempts + 1
    expect(params?.[2]).toBe(String(40_000));         // 10s × 2^2 = 40s
  });

  it('emits deep_research_outbox_giving_up and skips delete at MAX_ATTEMPTS', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        outbox_id: 'ox-1', deep_research_id: DR_ID, kind: 'delta' as const,
        payload_json: EVENT, attempts: 20,            // MAX_ATTEMPTS
        next_attempt_at: new Date(), created_at: new Date(),
        last_error: 'pub/sub topic missing',
      }],
    });
    const result = await drainOnce();
    expect(result).toEqual({ drained: 0, failed: 0, given_up: 1 });
    expect(mockPublishWebToolEvent).not.toHaveBeenCalled();
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);    // no DELETE/UPDATE
  });

  it('SELECT does NOT use FOR UPDATE / SKIP LOCKED (pool-based multi-replica)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await drainOnce();
    const sql = mockPoolQuery.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/FOR UPDATE/);
    expect(sql).not.toMatch(/SKIP LOCKED/);
  });
});

describe('getOutboxBacklog', () => {
  it('returns count of rows with attempts > 0', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ n: '13' }] });
    expect(await getOutboxBacklog()).toBe(13);
    expect(mockPoolQuery.mock.calls[0][0] as string).toMatch(/WHERE attempts > 0/);
  });
});

describe('startOutboxDrainer — env disable (runbook kill-switch)', () => {
  const originalEnv = process.env.DEEP_RESEARCH_OUTBOX_DRAINER_DISABLED;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DEEP_RESEARCH_OUTBOX_DRAINER_DISABLED;
    else process.env.DEEP_RESEARCH_OUTBOX_DRAINER_DISABLED = originalEnv;
  });

  it('is a no-op when DEEP_RESEARCH_OUTBOX_DRAINER_DISABLED=true', () => {
    process.env.DEEP_RESEARCH_OUTBOX_DRAINER_DISABLED = 'true';
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    startOutboxDrainer();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});

describe('stopOutboxDrainer', () => {
  it('resolves quickly when nothing is in flight', async () => {
    const t0 = Date.now();
    await stopOutboxDrainer();
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
