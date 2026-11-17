// An escalation is written under a real (workflowId, taskId) pair, whatever the
// run brought.
//
// `workflow_escalations.workflow_id` and `.task_id` are NOT NULL foreign keys,
// so the escalation boundary is the one place an absent id must become a real
// one. The order is fixed: the context's own ids when well-formed; a present
// task's ACTUAL parent workflow when only the workflow is missing; and a
// synthetic id derived from the run — not drawn at random — when nothing else
// holds one, so a retry resolves to the same rows. These tests assert the exact
// parameters each INSERT receives, not merely that the call succeeded.

const mockPoolQuery = jest.fn();
const mockLoggerInfo = jest.fn();

jest.mock('../../../infrastructure/database', () => {
  const fakePool = { query: (...args: unknown[]) => mockPoolQuery(...args) };
  return {
    getPool: jest.fn(() => fakePool),
    getPoolForService: jest.fn(() => fakePool),
    pool: fakePool,
  };
});
jest.mock('../../../audit/service', () => ({ insertAuditLog: jest.fn(() => Promise.resolve()) }));
jest.mock('../../../streaming/service', () => ({ streamingService: { emitHitlRequired: jest.fn() } }));
jest.mock('../../evidence-totals', () => ({ recordEscalationRaised: jest.fn() }));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: (...a: unknown[]) => mockLoggerInfo(...a), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { createEscalation } from '../escalation-helper';
import type { ExecutionContext } from '../../types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT = '00000000-0000-0000-0000-000000000001';
const AGENT = '00000000-0000-0000-0000-0000000000aa';
const INVOCATION = '00000000-0000-0000-0000-0000000000bb';
const WF = '00000000-0000-0000-0000-0000000000cc';
const TASK = '00000000-0000-0000-0000-0000000000dd';
const PARENT_OF_TASK = '00000000-0000-0000-0000-0000000000ee';

function contextWith(ids: { workflowId?: string; taskId?: string; invocationId?: string; traceId?: string }): ExecutionContext {
  return {
    tenantId: TENANT, agentId: AGENT, invocationId: INVOCATION, threadId: null, traceId: 'trace-1',
    ...ids,
  } as unknown as ExecutionContext;
}

/** Route the pool by statement: no open escalation to dedupe into; the task's
 *  parent lookup answers from `parentByTask`; every INSERT is captured. */
function routePool(parentByTask: Record<string, string | null> = {}) {
  const inserts: Record<string, unknown[]> = {};
  mockPoolQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('UPDATE workflow_escalations')) return { rows: [] };
    if (sql.includes('SELECT workflow_id FROM workflow_tasks')) {
      const parent = parentByTask[params[0] as string];
      return { rows: parent === undefined ? [] : [{ workflow_id: parent }] };
    }
    if (sql.includes('INSERT INTO workflows ')) inserts.workflows = params;
    else if (sql.includes('INSERT INTO workflow_tasks')) inserts.workflow_tasks = params;
    else if (sql.includes('INSERT INTO workflow_escalations')) inserts.workflow_escalations = params;
    return { rows: [] };
  });
  return inserts;
}

/** The (workflowId, taskId) each of the three rows was written with. */
function writtenIdentity(inserts: Record<string, unknown[]>) {
  return {
    workflows: { id: inserts.workflows?.[0] },
    workflow_tasks: { id: inserts.workflow_tasks?.[0], workflowId: inserts.workflow_tasks?.[1] },
    workflow_escalations: { workflowId: inserts.workflow_escalations?.[1], taskId: inserts.workflow_escalations?.[2] },
  };
}

beforeEach(() => jest.clearAllMocks());

describe('the context’s own ids, when well-formed', () => {
  it('are written to all three rows unchanged, and nothing is minted', async () => {
    const inserts = routePool();
    const ctx = contextWith({ workflowId: WF, taskId: TASK });

    await createEscalation(ctx, 'blocked');

    const w = writtenIdentity(inserts);
    expect(w.workflows.id).toBe(WF);
    expect(w.workflow_tasks).toEqual({ id: TASK, workflowId: WF });
    expect(w.workflow_escalations).toEqual({ workflowId: WF, taskId: TASK });
    expect(mockLoggerInfo.mock.calls.some((c) => (c[0] as { event?: string })?.event === 'escalation_identity_minted')).toBe(false);
  });
});

describe('a present task with an absent workflow', () => {
  it('uses the task’s actual parent workflow, never an unrelated minted one', async () => {
    const inserts = routePool({ [TASK]: PARENT_OF_TASK });
    const ctx = contextWith({ taskId: TASK });

    await createEscalation(ctx, 'blocked');

    const w = writtenIdentity(inserts);
    expect(w.workflows.id).toBe(PARENT_OF_TASK);
    expect(w.workflow_tasks).toEqual({ id: TASK, workflowId: PARENT_OF_TASK });
    expect(w.workflow_escalations).toEqual({ workflowId: PARENT_OF_TASK, taskId: TASK });
    expect(ctx.workflowId).toBe(PARENT_OF_TASK);
  });

  it('mints the workflow only when the task has no recorded parent', async () => {
    const inserts = routePool({});
    const ctx = contextWith({ taskId: TASK });

    await createEscalation(ctx, 'blocked');

    const w = writtenIdentity(inserts);
    expect(w.workflows.id).toMatch(UUID);
    expect(w.workflows.id).not.toBe(TASK);
    // One pair, consistent across all three rows.
    expect(w.workflow_tasks).toEqual({ id: TASK, workflowId: w.workflows.id });
    expect(w.workflow_escalations).toEqual({ workflowId: w.workflows.id, taskId: TASK });
  });
});

describe('a run with no identity at all', () => {
  it('mints a consistent pair, writes it back onto the context, and says so', async () => {
    const inserts = routePool();
    const ctx = contextWith({});

    await createEscalation(ctx, 'blocked');

    const w = writtenIdentity(inserts);
    expect(w.workflows.id).toMatch(UUID);
    expect(w.workflow_tasks.id).toMatch(UUID);
    expect(w.workflow_tasks.workflowId).toBe(w.workflows.id);
    expect(w.workflow_escalations).toEqual({ workflowId: w.workflows.id, taskId: w.workflow_tasks.id });
    expect(ctx.workflowId).toBe(w.workflows.id);
    expect(ctx.taskId).toBe(w.workflow_tasks.id);
    const minted = mockLoggerInfo.mock.calls.find((c) => (c[0] as { event?: string })?.event === 'escalation_identity_minted');
    expect(minted?.[0]).toMatchObject({ minted: ['workflowId', 'taskId'], deterministic: true });
  });

  it('derives the same pair on a retry of the same run, so the retry is idempotent', async () => {
    const first = routePool();
    await createEscalation(contextWith({}), 'blocked');
    const a = writtenIdentity(first);

    const second = routePool();
    await createEscalation(contextWith({}), 'blocked');
    const b = writtenIdentity(second);

    expect(b.workflows.id).toBe(a.workflows.id);
    expect(b.workflow_tasks.id).toBe(a.workflow_tasks.id);
  });

  it('derives a different pair for a different run', async () => {
    const first = routePool();
    await createEscalation(contextWith({}), 'blocked');
    const a = writtenIdentity(first);

    const second = routePool();
    await createEscalation(contextWith({ invocationId: '00000000-0000-0000-0000-0000000000ff' }), 'blocked');
    const b = writtenIdentity(second);

    expect(b.workflows.id).not.toBe(a.workflows.id);
  });

  it('keys on the trace when there is no invocation (a sweeper), still deterministically', async () => {
    const first = routePool();
    await createEscalation(contextWith({ invocationId: undefined, traceId: 'hybrid-sweeper-row-7' }), 'blocked');
    const a = writtenIdentity(first);
    const second = routePool();
    await createEscalation(contextWith({ invocationId: undefined, traceId: 'hybrid-sweeper-row-7' }), 'blocked');
    const b = writtenIdentity(second);

    expect(a.workflows.id).toMatch(UUID);
    expect(b.workflows.id).toBe(a.workflows.id);
  });
});

describe('a blank or a label is not an id', () => {
  it('is treated as absent and resolved like one', async () => {
    const inserts = routePool();
    const ctx = contextWith({ workflowId: '', taskId: 'resume-hitl-abc' });

    await createEscalation(ctx, 'blocked');

    const w = writtenIdentity(inserts);
    expect(w.workflows.id).toMatch(UUID);
    expect(w.workflow_tasks.id).toMatch(UUID);
    expect(w.workflow_escalations.workflowId).not.toBe('');
    expect(w.workflow_escalations.taskId).not.toBe('resume-hitl-abc');
  });
});

describe('deduplication is untouched', () => {
  it('collapses into an open escalation before any identity is resolved', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ id: 'esc-open', occurrence_count: 3 }] });
    const ctx = contextWith({});

    const id = await createEscalation(ctx, 'blocked again');

    expect(id).toBe('esc-open');
    const statements = mockPoolQuery.mock.calls.map((c) => c[0] as string);
    expect(statements.some((s) => s.includes('INSERT INTO workflows'))).toBe(false);
    expect(statements.some((s) => s.includes('SELECT workflow_id FROM workflow_tasks'))).toBe(false);
    expect(ctx.workflowId).toBeUndefined();
  });
});
