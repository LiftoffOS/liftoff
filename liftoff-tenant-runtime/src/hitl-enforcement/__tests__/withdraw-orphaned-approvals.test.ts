// A question can outlive the work it was about.
//
// The gate fires, an approval is created, the agent pauses — and then the run
// ends anyway, down a step's onFailure branch. The approval stays pending, but
// answering it can no longer do anything: there is no paused run left to
// release. Left alone it is swept to `expired`, which files "Pause expired
// without resolution" and reads as a person who ignored a question.
//
// Dev: "a gated tool call logged 'HITL gate triggered, execution paused', then
// the loop routed to the step's failure handler and the invocation completed
// 'success' 8s later with a pending approval still outstanding… deciding it
// could change nothing."

const queryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...a: unknown[]) => queryMock(...a) },
  getPoolForService: () => ({ query: (...a: unknown[]) => queryMock(...a) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const auditMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../audit', () => ({ insertAuditLog: (...a: unknown[]) => auditMock(...a) }));

import { withdrawOrphanedApprovals } from '../withdraw-orphaned-approvals';
import { WITHDRAWN_BY_SYSTEM } from '../types';

beforeEach(() => {
  queryMock.mockReset();
  auditMock.mockClear();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});

/** The single UPDATE the function issues. */
function sql(): string {
  return String(queryMock.mock.calls[0][0]);
}

describe('what it will and will not close', () => {
  it('only touches approvals that are still pending', async () => {
    // Or it would overwrite a decision a person already made.
    await withdrawOrphanedApprovals();
    expect(sql()).toMatch(/a\.status = 'pending'/);
  });

  it('NEVER touches an approval whose run is still gated', async () => {
    // THE safety property. 'gated' means the run is paused on this very
    // approval — closing one of those would shut a live question and strand the
    // run. Migration 329 exists to make this distinguishable at all: a
    // governance stop used to record 'success'.
    await withdrawOrphanedApprovals();
    expect(sql()).toMatch(/i\.outcome <> 'gated'/);
  });

  it('requires the run to have reached a terminal outcome', async () => {
    // A NULL outcome is a run still going. Its approval is live.
    await withdrawOrphanedApprovals();
    expect(sql()).toMatch(/i\.outcome IS NOT NULL/);
  });

  it('decides nothing — `decision` is never written', async () => {
    // A withdrawal is not a verdict. Nobody decided anything, which is the
    // point; writing a decision would put one back on the row.
    await withdrawOrphanedApprovals();
    expect(sql()).not.toMatch(/\bdecision\s*=/);
  });

  it('names a non-human actor', async () => {
    await withdrawOrphanedApprovals();
    expect(queryMock.mock.calls[0][1][0]).toBe(WITHDRAWN_BY_SYSTEM);
    expect(WITHDRAWN_BY_SYSTEM.startsWith('system:')).toBe(true);
  });

  it('closes and selects in ONE statement', async () => {
    // Selecting then updating would race the operator: a person deciding
    // between the two would have their decision overwritten by a withdrawal,
    // which is worse than the false expiry this prevents.
    await withdrawOrphanedApprovals();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(sql()).toMatch(/^UPDATE hitl_approval_requests/);
  });
});

describe('what it records', () => {
  const row = {
    id: 'appr-1', tenant_id: 't1', agent_id: 'a1',
    reason: 'sensitive_work', outcome: 'success',
  };

  it('writes an audit row per withdrawal', async () => {
    // A status that exists to make the record honest has to leave a record.
    queryMock.mockResolvedValue({ rows: [row], rowCount: 1 });
    const out = await withdrawOrphanedApprovals();

    expect(out).toHaveLength(1);
    expect(auditMock).toHaveBeenCalledTimes(1);
    const [, tenantId, entry] = auditMock.mock.calls[0];
    expect(tenantId).toBe('t1');
    expect(entry.action).toBe('hitl_approval_withdrawn');
    expect(entry.triggeredBy).toBe(WITHDRAWN_BY_SYSTEM);
    expect(entry.inputArgs).toMatchObject({ approvalId: 'appr-1', invocationOutcome: 'success' });
  });

  it('records WHY on the approval itself', async () => {
    await withdrawOrphanedApprovals();
    expect(sql()).toContain('withdrawnReason');
    expect(sql()).toContain('invocationOutcome');
  });

  it('merges into context rather than replacing it', async () => {
    // The card's step provenance already lives there. Overwriting it would trade
    // one lost record for another.
    await withdrawOrphanedApprovals();
    expect(sql()).toMatch(/COALESCE\(a\.context, '\{\}'::jsonb\) \|\|/);
  });

  it('returns an empty list and audits nothing when there is nothing to close', async () => {
    const out = await withdrawOrphanedApprovals();
    expect(out).toEqual([]);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('the sweeper wiring', () => {
  const SRC = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'handlers', 'internal-cron-handler.ts'), 'utf8',
  ) as string;

  it('runs BEFORE the expiry pass', async () => {
    // Both touch pending approvals, and expiry files "Pause expired without
    // resolution" — the false record. The honest disposition has to win.
    const withdrawAt = SRC.indexOf('withdrawOrphanedApprovals');
    const expireAt = SRC.indexOf("SET status = 'expired'");
    expect(withdrawAt).toBeGreaterThan(-1);
    expect(expireAt).toBeGreaterThan(-1);
    expect(withdrawAt).toBeLessThan(expireAt);
  });

  it('never blocks the sweeper when it fails', async () => {
    // A withdrawal that does not happen leaves today's behaviour; a sweeper that
    // dies leaves every stale pause behind it.
    const at = SRC.indexOf('withdrawOrphanedApprovals');
    expect(SRC.slice(at - 200, at + 700)).toMatch(/catch \(e\)/);
  });
});
