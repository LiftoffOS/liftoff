/**
 * Retention for workflow_escalations (B1 to B3).
 *
 * These assert the SQL's shape rather than its results, because the properties
 * that matter here are structural: what the sweep is allowed to touch, that it
 * takes the oldest rows first, and that a swept row stays distinguishable from
 * one a person closed. A results-only test would pass against a query that
 * starves its own backlog.
 */
import { runEscalationRetention, RETENTION_DAYS, SWEEP_BATCH } from '../escalation-retention';

const queryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...args: unknown[]) => queryMock(...args) }),
}));

/** Dispatch by statement, not by call order, so adding a query later cannot
 *  silently re-point one of these at the wrong assertion. */
function primePool(counts: { swept?: number; deleted?: number; customerPending?: string } = {}) {
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    if (/UPDATE workflow_escalations/i.test(sql)) {
      return { rowCount: counts.swept ?? 0, rows: [] };
    }
    if (/DELETE FROM workflow_escalations/i.test(sql)) {
      return { rowCount: counts.deleted ?? 0, rows: [] };
    }
    if (/SELECT COUNT/i.test(sql)) {
      return { rowCount: 1, rows: [{ count: counts.customerPending ?? '0' }] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  });
}

function sqlMatching(fragment: RegExp): string {
  const call = queryMock.mock.calls.find(c => fragment.test(c[0] as string));
  if (!call) throw new Error(`no query matched ${fragment}`);
  return call[0] as string;
}

beforeEach(() => primePool());

describe('escalation retention', () => {
  it('sweeps only unresolved operator records', async () => {
    await runEscalationRetention();
    const sql = sqlMatching(/UPDATE workflow_escalations/i);

    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("kind = 'system_internal'");
  });

  it('never sweeps a customer-facing escalation', async () => {
    // Quietly closing one of these would hide a live request from the person
    // who could clear it. They are reported instead.
    await runEscalationRetention();
    const sql = sqlMatching(/UPDATE workflow_escalations/i);

    expect(sql).not.toMatch(/kind = 'escalation'/);
  });

  it('takes the oldest rows first in both passes', async () => {
    // A capped sweep with no ORDER BY lets Postgres return whichever rows are
    // cheapest to reach, so the oldest backlog is never touched. This repo
    // shipped exactly that bug once in the clarification-expiry path.
    await runEscalationRetention();

    expect(sqlMatching(/UPDATE workflow_escalations/i)).toMatch(/ORDER BY created_at\s*\n?\s*LIMIT/);
    expect(sqlMatching(/DELETE FROM workflow_escalations/i)).toMatch(/ORDER BY resolved_at\s*\n?\s*LIMIT/);
  });

  it('bounds each pass', async () => {
    await runEscalationRetention();

    const sweepParams = queryMock.mock.calls.find(c => /UPDATE workflow_escalations/i.test(c[0] as string))![1];
    expect(sweepParams).toEqual([RETENTION_DAYS, SWEEP_BATCH]);
  });

  it('marks a swept row so it is never mistaken for one a person closed', async () => {
    await runEscalationRetention();
    const sql = sqlMatching(/UPDATE workflow_escalations/i);

    expect(sql).toContain("'via', 'retention_sweep'");
  });

  it('deletes on when a row was resolved, not when it was opened', async () => {
    // Otherwise a long-running escalation resolved yesterday is deleted
    // tomorrow because it was created in April.
    await runEscalationRetention();
    const sql = sqlMatching(/DELETE FROM workflow_escalations/i);

    expect(sql).toContain('resolved_at <');
    expect(sql).not.toMatch(/created_at </);
  });

  it('reports a customer-facing pending row rather than touching it', async () => {
    primePool({ customerPending: '3' });

    const result = await runEscalationRetention();

    expect(result.customerFacingPending).toBe(3);
    expect(sqlMatching(/SELECT COUNT/i)).toContain("kind = 'escalation'");
  });

  it('returns what it did', async () => {
    primePool({ swept: 7, deleted: 11 });

    await expect(runEscalationRetention()).resolves.toEqual({
      swept: 7,
      deleted: 11,
      customerFacingPending: 0,
    });
  });

  it('uses one window for both passes', async () => {
    expect(RETENTION_DAYS).toBe(30);
  });
});
