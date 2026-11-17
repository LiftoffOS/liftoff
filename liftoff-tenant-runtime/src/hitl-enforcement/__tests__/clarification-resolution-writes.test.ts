/**
 * Migration 419: how a clarification was resolved, and by whom, is written IN
 * THE SAME STATEMENT that moves the row off `pending`.
 *
 * Six sites resolve a clarification: the review answer, the review decline,
 * the in-chat answer (with an account, or with only a guest's display name),
 * and the two expiry operations. Each is checked for the same three
 * properties: the outcome rides the transition, the transition is guarded on
 * a pending clarification row so a settled row is left alone, and nothing
 * else in the file is taught the four columns. The two later `fired` flips on
 * an answered anchor clarification (the inline UPDATE in the chat-turn handler
 * and `markClarificationFired`) must leave them untouched, or an answer would
 * be overwritten by the row's own bookkeeping.
 *
 * The chat-turn handler mounts a router that pulls the execution engine
 * transitively, so its statement is asserted on the source, in the idiom of
 * the other *.source tests here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const poolQueryMock = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
  withTenantScope: jest.fn(),
  getPool: () => ({ query: (...args: unknown[]) => poolQueryMock(...args) }),
  getPoolForService: () => ({ query: (...args: unknown[]) => poolQueryMock(...args) }),
}));

jest.mock('../../audit', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const enqueueResumeForRecoveryClarificationMock = jest.fn();
jest.mock('../../interactive-chat/clarification-resume-helpers', () => ({
  enqueueResumeForRecoveryClarification: (...args: unknown[]) =>
    enqueueResumeForRecoveryClarificationMock(...args),
}));

jest.mock('../../integrations/web-fetch/anchor-intervention-bridge', () => ({
  forwardAnchorInterventionResponse: jest.fn(),
}));

jest.mock('../../learning/correction-capture', () => ({
  captureClarificationOutcome: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../reflection-engine/trigger-service', () => ({
  reflectionTriggerService: { onLateFeedbackFlagged: jest.fn().mockResolvedValue(undefined) },
}));

import { hitlEnforcementService } from '../service';
import { agentScheduledInvocationsRepo } from '../../scheduling/agent-scheduled-invocations-repo';

const RECOVERY_ROW = {
  id: 'c-1',
  clarification_source: 'recovery_llm',
  vendor_request_id: null,
  scheduled_by_invocation_id: 'inv-1',
  tenant_id: 't',
  agent_id: 'a',
  thread_id: 'th',
};

beforeEach(() => {
  jest.clearAllMocks();
});

/** The one statement that both moves the row and records the outcome. */
function transitionStatement(): { sql: string; params: unknown[] } {
  const call = poolQueryMock.mock.calls.find(([sql]) =>
    typeof sql === 'string' && sql.includes('UPDATE agent_scheduled_invocations') && sql.includes('resolution_kind'),
  );
  if (!call) throw new Error('no UPDATE carrying resolution_kind was issued');
  return { sql: call[0] as string, params: call[1] as unknown[] };
}

describe('review answer', () => {
  it("records 'answered' and the actor in the statement that flips pending → resume_inflight", async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [RECOVERY_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    await hitlEnforcementService.respondToClarification({
      tenantId: 't', clarificationId: 'c-1', response: 'the north region', resolvedBy: 'acc-1',
    });

    const { sql, params } = transitionStatement();
    expect(sql).toContain("SET status = 'resume_inflight'");
    expect(sql).toContain("resolution_kind = 'answered'");
    expect(sql).toContain('resolved_by = $3');
    expect(sql).toContain('resolved_at = NOW()');
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("objective = 'clarification-expiry'");
    expect(params).toEqual(['c-1', 't', 'acc-1']);
    // Exactly one statement moves the row; the outcome is not a second write.
    expect(poolQueryMock.mock.calls.filter(([s]) => String(s).includes('UPDATE agent_scheduled_invocations'))).toHaveLength(1);
  });

  it('does nothing to a row that is no longer pending', async () => {
    poolQueryMock.mockResolvedValueOnce({ rowCount: 0 });
    await expect(hitlEnforcementService.respondToClarification({
      tenantId: 't', clarificationId: 'c-1', response: 'x', resolvedBy: 'acc-1',
    })).rejects.toThrow(/already resolved/);
    expect(enqueueResumeForRecoveryClarificationMock).not.toHaveBeenCalled();
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
  });
});

describe('review decline', () => {
  it("records 'declined' and the actor in the transition statement", async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ clarification_source: 'recovery_llm' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [RECOVERY_ROW] })
      .mockResolvedValueOnce({ rows: [] });

    await hitlEnforcementService.declineClarification({
      tenantId: 't', clarificationId: 'c-1', reason: 'not my call', resolvedBy: 'acc-2',
    });

    const { sql, params } = transitionStatement();
    expect(sql).toContain("SET status = 'resume_inflight'");
    expect(sql).toContain("resolution_kind = 'declined'");
    expect(sql).toContain('resolved_by = $3');
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("objective = 'clarification-expiry'");
    expect(params).toEqual(['c-1', 't', 'acc-2']);
  });

  it('does nothing to a row that is no longer pending', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ clarification_source: 'recovery_llm' }] })
      .mockResolvedValueOnce({ rowCount: 0 });
    await expect(hitlEnforcementService.declineClarification({
      tenantId: 't', clarificationId: 'c-1', resolvedBy: 'acc-2',
    })).rejects.toThrow(/already resolved/);
    expect(enqueueResumeForRecoveryClarificationMock).not.toHaveBeenCalled();
  });
});

describe('in-chat answer (chat-turn-handler source)', () => {
  const HANDLER = readFileSync(
    join(__dirname, '..', '..', 'interactive-chat', 'chat-turn-handler.ts'),
    'utf8',
  );
  const start = HANDLER.indexOf("context_ref LIKE 'clarification:%'");
  const block = HANDLER.slice(start, start + 4000);

  it("records 'answered' in the statement that flips pending → resume_inflight", () => {
    const stmt = block.indexOf("SET status = 'resume_inflight'");
    expect(stmt).toBeGreaterThan(-1);
    const statement = block.slice(stmt, block.indexOf('RETURNING id', stmt));
    expect(statement).toContain("resolution_kind = 'answered'");
    expect(statement).toContain('resolved_by = $2');
    expect(statement).toContain('resolved_by_label = $3');
    expect(statement).toContain('resolved_at = NOW()');
    expect(statement).toContain("status = 'pending'");
    expect(statement).toContain("objective = 'clarification-expiry'");
  });

  it('writes the account when the sender has one, and the display name only when there is none', () => {
    // $2 is the account or null; $3 is the label ONLY when there is no account,
    // so a signed-in person is never recorded twice and a guest is never lost.
    expect(block).toMatch(/body\.senderAccountId \?\? null,\s*\n\s*body\.senderAccountId \? null : body\.userDisplayName,/);
  });

  it('leaves the four columns alone on the later fired flip of an answered anchor row', () => {
    const flip = block.indexOf("SET status = 'fired', fired_at = NOW(), updated_at = NOW()");
    expect(flip).toBeGreaterThan(-1);
    const statement = block.slice(flip, block.indexOf('WHERE id = $1', flip) + 20);
    expect(statement).not.toContain('resolution_kind');
    expect(statement).not.toContain('resolved_');
  });
});

describe('expiry operations', () => {
  it('markClarificationExpiredById flips and records in one guarded statement', async () => {
    poolQueryMock.mockResolvedValueOnce({ rowCount: 1 });
    const n = await agentScheduledInvocationsRepo.markClarificationExpiredById('c-9');
    expect(n).toBe(1);
    const [sql, params] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("SET status = 'fired'");
    expect(sql).toContain("resolution_kind = 'expired'");
    expect(sql).toContain('resolved_at = NOW()');
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("objective = 'clarification-expiry'");
    expect(params).toEqual(['c-9']);
  });

  it('markClarificationExpiredByInvocationId does the same, addressed by invocation', async () => {
    poolQueryMock.mockResolvedValueOnce({ rowCount: 0 });
    const n = await agentScheduledInvocationsRepo.markClarificationExpiredByInvocationId('inv-9');
    // Zero rows: the ask was already settled, and the caller reads it as such.
    expect(n).toBe(0);
    const [sql, params] = poolQueryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('scheduled_by_invocation_id = $1');
    expect(sql).toContain("resolution_kind = 'expired'");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("objective = 'clarification-expiry'");
    expect(params).toEqual(['inv-9']);
  });

  it('a failed resume clears the recorded outcome in the statement that releases the row', async () => {
    // The answer moved the row to resume_inflight and recorded itself; the
    // release undoes that transition, so the record goes with it. A released
    // ask then reads as awaiting an answer and an exhausted one as failed,
    // never as "answered" by somebody whose answer was never delivered.
    poolQueryMock.mockResolvedValueOnce({ rows: [{ status: 'pending' }] });
    await agentScheduledInvocationsRepo.releaseFailedClarificationResume('c-1', 'engine down');
    const [sql] = poolQueryMock.mock.calls[0] as [string];
    expect(sql).toContain('resolution_kind = NULL');
    expect(sql).toContain('resolved_by = NULL');
    expect(sql).toContain('resolved_by_label = NULL');
    expect(sql).toContain('resolved_at = NULL');
    expect(sql).toContain("status = 'resume_inflight'");
  });

  it('the generic fired transitions are not taught the resolution columns', async () => {
    poolQueryMock.mockResolvedValue({ rowCount: 1 });
    await agentScheduledInvocationsRepo.markClarificationFired('c-1');
    await agentScheduledInvocationsRepo.markFiredByInvocationId('inv-1');
    for (const [sql] of poolQueryMock.mock.calls as Array<[string]>) {
      expect(sql).not.toContain('resolution_kind');
      expect(sql).not.toContain('resolved_');
    }
  });
});
