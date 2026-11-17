// Every escalation occurrence leaves an audit row, deduped or not.
//
// `createEscalation` collapses repeat escalations of one still-open issue into
// a single `workflow_escalations` row — deliberately, so a stuck agent does not
// pile up a new row plus an SSE plus a notification on every scheduled run.
// That decision is correct and is not changed here.
//
// What was wrong is what the collapse took with it. The early return sat ABOVE
// the audit write, the SSE emit and the notification, so a deduped escalation
// recorded nothing but `occurrence_count += 1` — while the same UPDATE did
// `SET reason = $4`, overwriting the previous reason. An agent at
// occurrence_count 18 had one audit row and one reason, the newest, and nothing
// anywhere could say whether that was one recurring blocker or eighteen
// different ones.
//
// The audit row is the only per-occurrence record that exists, so it is the one
// thing the collapse must not drop. Notification policy is a separate question
// and is left exactly as it was.

const mockPoolQuery = jest.fn();
const mockInsertAuditLog = jest.fn();

jest.mock('../../../infrastructure/database', () => {
  const fakePool = { query: (...args: unknown[]) => mockPoolQuery(...args) };
  return {
    getPool: jest.fn(() => fakePool),
    getPoolForService: jest.fn(() => fakePool),
    pool: fakePool,
  };
});
jest.mock('../../../audit/service', () => ({
  insertAuditLog: (...args: unknown[]) => { mockInsertAuditLog(...args); return Promise.resolve(); },
}));
jest.mock('../../../streaming/service', () => ({
  streamingService: { emitHitlRequired: jest.fn() },
}));
jest.mock('../../evidence-totals', () => ({ recordEscalationRaised: jest.fn() }));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createEscalation } from '../escalation-helper';
import type { ExecutionContext } from '../../types';

const ctx = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  agentId: '00000000-0000-0000-0000-0000000000aa',
  invocationId: '00000000-0000-0000-0000-0000000000bb',
  workflowId: '00000000-0000-0000-0000-0000000000cc',
  taskId: '00000000-0000-0000-0000-0000000000dd',
  threadId: null,
} as unknown as ExecutionContext;

/** The reason recorded on the audit row, if one was written. */
function auditedReason(): string | undefined {
  const call = mockInsertAuditLog.mock.calls[0];
  if (!call) return undefined;
  const args = call[2] as { inputArgs?: { reason?: string } };
  return args?.inputArgs?.reason;
}

beforeEach(() => jest.clearAllMocks());

describe('createEscalation records every occurrence', () => {
  it('audits the occurrence that was collapsed into an existing row', async () => {
    // The dedupe UPDATE finds an open row: the escalation is a repeat.
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 'esc-1', occurrence_count: 18 }] });

    const id = await createEscalation(ctx, 'Workflow left step s9 unsatisfied', { kind: 'system_internal' });

    expect(id).toBe('esc-1');
    expect(mockInsertAuditLog).toHaveBeenCalledTimes(1);
    expect(auditedReason()).toBe('Workflow left step s9 unsatisfied');
  });

  it('records the occurrence\'s OWN reason, not the row it merged into', async () => {
    // The row's `reason` column is overwritten by the newest text, so the audit
    // row is the only place a distinct second blocker survives.
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 'esc-1', occurrence_count: 2 }] });

    await createEscalation(ctx, 'a different blocker entirely', { kind: 'escalation' });

    expect(auditedReason()).toBe('a different blocker entirely');
  });

  it('still audits when it opens a new row', async () => {
    // No open row to merge into: the INSERT path. Unchanged behaviour, asserted
    // so the refactor that shared this write cannot drop the original caller.
    mockPoolQuery.mockResolvedValue({ rows: [] });

    await createEscalation(ctx, 'first time this has happened', { kind: 'system_internal' });

    expect(mockInsertAuditLog).toHaveBeenCalledTimes(1);
    expect(auditedReason()).toBe('first time this has happened');
  });
});
