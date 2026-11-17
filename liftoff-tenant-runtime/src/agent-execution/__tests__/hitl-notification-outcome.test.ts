// The announcement ledger (migration 366).
//
// The property under test is that "the gate paused a run and told nobody" is
// recorded and distinguishable — from "nobody was assigned", from "a person saw
// it and did not act", and from a gate that never pushes at all because the
// dashboard is its surface.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_t: string, fn: (c: { query: typeof mockQuery }) => unknown) =>
    fn({ query: mockQuery })),
  pool: { query: mockQuery },
}));

const mockWarn = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  logger: { warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), error: jest.fn() },
  log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { recordApprovalNotificationOutcome } from '../hitl-notification-outcome';

const TENANT = '11111111-1111-1111-1111-111111111111';
const APPROVAL = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [] });
});

describe('recordApprovalNotificationOutcome', () => {
  it('accumulates across channels rather than overwriting', async () => {
    await recordApprovalNotificationOutcome(TENANT, APPROVAL, { targets: 2, delivered: 1 });
    const sql = mockQuery.mock.calls[0][0] as string;
    // Slack and Teams both fan out for one approval; the second write must not
    // erase the first.
    expect(sql).toContain('COALESCE(notify_delivered_count, 0) + $4');
    expect(sql).toContain('COALESCE(notify_target_count, 0) + $3');
    // The first attempt stamps the time; a later one must not move it.
    expect(sql).toContain('COALESCE(notify_attempted_at, NOW())');
    expect(mockQuery.mock.calls[0][1]).toEqual([APPROVAL, TENANT, 2, 1, null]);
  });

  it('warns per CHANNEL, and does not claim the approval reached nobody', async () => {
    // Slack and Teams fan out separately and this function accumulates, so a
    // channel delivering 0 says nothing about the approval as a whole. Wording
    // that makes the global claim from the per-channel fact can print
    // "announced to nobody" beside a row just written saying delivered=2 of 4,
    // and the line gets believed over the row.
    await recordApprovalNotificationOutcome(TENANT, APPROVAL, { targets: 3, delivered: 0 });
    expect(mockWarn).toHaveBeenCalledWith(
      'HITL approval: this notification channel reached nobody',
      expect.objectContaining({ approval_id: APPROVAL, channel_targets: 3, channel_delivered: 0 }),
    );
    // NO global claim is made at all — not even from the accumulated row.
    //
    // The row is accumulated by channels running under `setImmediate` with no
    // ordering and no completion barrier, so a total read from inside one
    // channel's callback counts only the channels that have finished. Teams
    // can record 2 targets and 0 delivered, compute `reached_nobody_overall:
    // true` from that snapshot, and Slack deliver to BOTH assignees a second
    // later. The line would say the approval reached nobody while everybody
    // had been told.
    //
    // So the boolean is gone rather than made accurate. Only the 24h expiry
    // path reads the row after every channel has settled, and it is the only
    // reader that can answer the question.
    const payload = mockWarn.mock.calls[0][1];
    expect(payload).not.toHaveProperty('reached_nobody_overall');
    // The snapshot is still logged, named so it cannot be read as a verdict.
    expect(payload).toHaveProperty('approval_delivered_total_so_far');
    expect(payload).toHaveProperty('approval_target_total_so_far');
  });

  it('does not warn when at least one person was reached', async () => {
    await recordApprovalNotificationOutcome(TENANT, APPROVAL, { targets: 3, delivered: 1 });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('records a zero-target routing failure distinctly from a delivery failure', async () => {
    await recordApprovalNotificationOutcome(TENANT, APPROVAL, { targets: 0, delivered: 0 });
    expect(mockQuery.mock.calls[0][1]).toEqual([APPROVAL, TENANT, 0, 0, null]);
    // Still flagged: a run is paused behind it either way.
    expect(mockWarn).toHaveBeenCalled();
  });

  it('carries the error text when the attempt threw', async () => {
    await recordApprovalNotificationOutcome(TENANT, APPROVAL, {
      targets: 0, delivered: 0, error: 'slack: HTTP 500',
    });
    expect(mockQuery.mock.calls[0][1][4]).toBe('slack: HTTP 500');
  });

  it('never throws — bookkeeping must not break the path it observes', async () => {
    mockQuery.mockRejectedValue(new Error('db down'));
    await expect(
      recordApprovalNotificationOutcome(TENANT, APPROVAL, { targets: 1, delivered: 1 }),
    ).resolves.toBeUndefined();
  });
});
