/**
 * hitlEnforcementService.respondToClarification
 *
 * Verifies the cross-surface race window: chat-turn-handler and the /review
 * queue can both try to resolve the same clarification within ms of each
 * other. The atomic pending → resume_inflight UPDATE must close the race;
 * the loser sees rowCount === 0 and throws "already resolved" (becomes 409
 * upstream).
 */
const poolQueryMock = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
  withTenantScope: jest.fn(),
}));

jest.mock('../../audit', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));

const enqueueResumeForRecoveryClarificationMock = jest.fn();
jest.mock('../../interactive-chat/clarification-resume-helpers', () => ({
  enqueueResumeForRecoveryClarification: (...args: unknown[]) =>
    enqueueResumeForRecoveryClarificationMock(...args),
}));

const forwardAnchorInterventionResponseMock = jest.fn();
jest.mock('../../integrations/web-fetch/anchor-intervention-bridge', () => ({
  forwardAnchorInterventionResponse: (...args: unknown[]) =>
    forwardAnchorInterventionResponseMock(...args),
}));

const markClarificationFiredMock = jest.fn();
jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: {
    markClarificationFired: (...args: unknown[]) => markClarificationFiredMock(...args),
  },
}));

const captureClarificationOutcomeMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../learning/correction-capture', () => ({
  captureClarificationOutcome: (...args: unknown[]) => captureClarificationOutcomeMock(...args),
}));

const onLateFeedbackFlaggedMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../../reflection-engine/trigger-service', () => ({
  reflectionTriggerService: {
    onLateFeedbackFlagged: (...args: unknown[]) => onLateFeedbackFlaggedMock(...args),
  },
}));

import { hitlEnforcementService } from '../service';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('respondToClarification', () => {
  it('throws "already resolved" when the atomic pending → resume_inflight UPDATE returns no rows', async () => {
    // Atomic transition returns 0 rows (lost the race).
    poolQueryMock.mockResolvedValueOnce({ rowCount: 0 });
    await expect(hitlEnforcementService.respondToClarification({
      tenantId: 't',
      clarificationId: 'c-1',
      response: 'sure',
      resolvedBy: 'acc-1',
    })).rejects.toThrow(/already resolved/);

    expect(enqueueResumeForRecoveryClarificationMock).not.toHaveBeenCalled();
    expect(forwardAnchorInterventionResponseMock).not.toHaveBeenCalled();
  });

  it('routes recovery_llm rows through the resume helper + writes user message', async () => {
    poolQueryMock
      // 1. atomic transition
      .mockResolvedValueOnce({ rowCount: 1 })
      // 2. re-fetch row
      .mockResolvedValueOnce({
        rows: [{
          id: 'c-1',
          clarification_source: 'recovery_llm',
          vendor_request_id: null,
          scheduled_by_invocation_id: 'inv-1',
          tenant_id: 't',
          agent_id: 'a',
          thread_id: 'th',
        }],
      })
      // 3. INSERT user message
      .mockResolvedValueOnce({ rows: [] });

    await hitlEnforcementService.respondToClarification({
      tenantId: 't',
      clarificationId: 'c-1',
      response: 'go ahead',
      resolvedBy: 'acc-1',
    });

    expect(enqueueResumeForRecoveryClarificationMock).toHaveBeenCalledWith({
      tenantId: 't',
      agentId: 'a',
      threadId: 'th',
      scheduledRowId: 'c-1',
      scheduledByInvocationId: 'inv-1',
      userAnswer: 'go ahead',
    });
    // anchor_intervention path NOT taken.
    expect(forwardAnchorInterventionResponseMock).not.toHaveBeenCalled();
    expect(markClarificationFiredMock).not.toHaveBeenCalled();

    // User message inserted into the thread.
    const userMsgQuery = poolQueryMock.mock.calls[2];
    expect(userMsgQuery[0]).toContain('INSERT INTO messages');
    expect(userMsgQuery[0]).toContain("'user'");
    expect(userMsgQuery[1]).toEqual(['t', 'th', 'go ahead']);
  });

  it('routes anchor_intervention rows through forwardAnchorInterventionResponse + marks fired', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: 'c-2',
          clarification_source: 'anchor_intervention',
          vendor_request_id: 'req-99',
          scheduled_by_invocation_id: 'inv-2',
          tenant_id: 't',
          agent_id: 'a',
          thread_id: 'th',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await hitlEnforcementService.respondToClarification({
      tenantId: 't',
      clarificationId: 'c-2',
      response: 'click',
      resolvedBy: 'acc-1',
    });

    expect(forwardAnchorInterventionResponseMock).toHaveBeenCalledWith('req-99', 'click');
    expect(markClarificationFiredMock).toHaveBeenCalledWith('c-2');
    expect(enqueueResumeForRecoveryClarificationMock).not.toHaveBeenCalled();
  });

  it('rejects anchor_intervention rows missing a vendor_request_id (corrupt state)', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: 'c-3',
          clarification_source: 'anchor_intervention',
          vendor_request_id: null,
          scheduled_by_invocation_id: 'inv-3',
          tenant_id: 't',
          agent_id: 'a',
          thread_id: 'th',
        }],
      });

    await expect(hitlEnforcementService.respondToClarification({
      tenantId: 't',
      clarificationId: 'c-3',
      response: 'click',
      resolvedBy: 'acc-1',
    })).rejects.toThrow(/missing vendor_request_id/);

    expect(forwardAnchorInterventionResponseMock).not.toHaveBeenCalled();
  });
});

/** Declining is an answer.
 *
 *  Before it existed the only way to say no was silence: the ask sat for its
 *  whole window, the agent stayed parked, and the lapse became a record only
 *  operators read. The agent was never told the question had been considered
 *  and refused, so it asked again the next time the same work ran. */
describe('declineClarification', () => {
  function mockDeclineRow(overrides: Record<string, unknown> = {}) {
    poolQueryMock
      // 0. source lookup — the Anchor refusal happens before any write
      .mockResolvedValueOnce({ rows: [{ clarification_source: 'recovery_llm' }] })
      // 1. atomic transition
      .mockResolvedValueOnce({ rowCount: 1 })
      // 2. re-fetch row, question included
      .mockResolvedValueOnce({
        rows: [{
          id: 'c-9',
          clarification_source: 'recovery_llm',
          clarification_origin: 'question',
          vendor_request_id: null,
          scheduled_by_invocation_id: 'inv-9',
          tenant_id: 't',
          agent_id: 'a',
          thread_id: 'th',
          question: 'Which spreadsheet holds the Q3 figures?',
          ...overrides,
        }],
      })
      // 3. INSERT user message
      .mockResolvedValueOnce({ rows: [] });
  }

  it('refuses an Anchor intervention before touching the row', async () => {
    // It resumes by handing text to a live browser session and the vendor
    // exposes no abort, so the decline text would arrive as the instruction the
    // person was waiting for. Checked before the status transition so a refusal
    // never strands the row in resume_inflight.
    poolQueryMock.mockResolvedValueOnce({ rows: [{ clarification_source: 'anchor_intervention' }] });

    await expect(hitlEnforcementService.declineClarification({
      tenantId: 't', clarificationId: 'c-anchor', resolvedBy: 'acc-1',
    })).rejects.toThrow(/cannot be declined/);

    // The source lookup and nothing else.
    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    expect(enqueueResumeForRecoveryClarificationMock).not.toHaveBeenCalled();
    expect(forwardAnchorInterventionResponseMock).not.toHaveBeenCalled();
  });

  it('loses the same race the answer path loses, and resumes nothing', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ clarification_source: 'recovery_llm' }] })
      .mockResolvedValueOnce({ rowCount: 0 });

    await expect(hitlEnforcementService.declineClarification({
      tenantId: 't', clarificationId: 'c-9', resolvedBy: 'acc-1',
    })).rejects.toThrow(/already resolved/);

    expect(enqueueResumeForRecoveryClarificationMock).not.toHaveBeenCalled();
  });

  it('resumes the run with text that tells the agent to stop waiting', async () => {
    mockDeclineRow();

    await hitlEnforcementService.declineClarification({
      tenantId: 't', clarificationId: 'c-9', resolvedBy: 'acc-1',
    });

    const call = enqueueResumeForRecoveryClarificationMock.mock.calls[0][0];
    expect(call.scheduledRowId).toBe('c-9');
    // The agent has to be told no answer is coming, not handed an empty one.
    expect(call.userAnswer).toContain('No answer is available');
    expect(call.userAnswer).toContain('Do not wait for one');
  });

  it('carries the reason into the resume text when one was given', async () => {
    mockDeclineRow();

    await hitlEnforcementService.declineClarification({
      tenantId: 't', clarificationId: 'c-9', resolvedBy: 'acc-1',
      reason: 'Nobody here owns that system',
    });

    const call = enqueueResumeForRecoveryClarificationMock.mock.calls[0][0];
    expect(call.userAnswer).toContain('Nobody here owns that system');
  });

  it('writes the decline into the thread so it is not a silent resume', async () => {
    mockDeclineRow();

    await hitlEnforcementService.declineClarification({
      tenantId: 't', clarificationId: 'c-9', resolvedBy: 'acc-1',
    });

    // source lookup, transition, re-fetch, then the message.
    const userMsgQuery = poolQueryMock.mock.calls[3];
    expect(userMsgQuery[0]).toContain('INSERT INTO messages');
    expect(userMsgQuery[1][0]).toBe('t');
    expect(userMsgQuery[1][1]).toBe('th');
    expect(userMsgQuery[1][2]).toContain('No answer is available');
  });

  it('records the decline as memory and reflects on it', async () => {
    mockDeclineRow();

    await hitlEnforcementService.declineClarification({
      tenantId: 't', clarificationId: 'c-9', resolvedBy: 'acc-1',
      reason: 'Nobody here owns that system',
    });

    expect(captureClarificationOutcomeMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't',
      agentId: 'a',
      clarificationId: 'c-9',
      question: 'Which spreadsheet holds the Q3 figures?',
      outcome: 'declined',
      response: 'Nobody here owns that system',
    }));
    // A question nobody could answer is the agent asking this workspace for
    // something it cannot give, which is what reflection exists to notice.
    expect(onLateFeedbackFlaggedMock).toHaveBeenCalledWith('a', 't', 'c-9');
  });

  it('does not let a broken learning module fail a decline that already resumed', async () => {
    mockDeclineRow();
    captureClarificationOutcomeMock.mockRejectedValueOnce(new Error('memory down'));

    await expect(hitlEnforcementService.declineClarification({
      tenantId: 't', clarificationId: 'c-9', resolvedBy: 'acc-1',
    })).resolves.toBeUndefined();
  });
});

describe('respondToClarification — learning', () => {
  it('records an answer as memory but does not trigger reflection', async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: 'c-1',
          clarification_source: 'recovery_llm',
          clarification_origin: 'question',
          vendor_request_id: null,
          scheduled_by_invocation_id: 'inv-1',
          tenant_id: 't',
          agent_id: 'a',
          thread_id: 'th',
          question: 'Which sheet?',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    await hitlEnforcementService.respondToClarification({
      tenantId: 't', clarificationId: 'c-1', response: 'The Q3 one', resolvedBy: 'acc-1',
    });

    expect(captureClarificationOutcomeMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'answered',
      question: 'Which sheet?',
      response: 'The Q3 one',
    }));
    // Being answered is the system working, not a pattern worth reflecting on.
    expect(onLateFeedbackFlaggedMock).not.toHaveBeenCalled();
  });
})
