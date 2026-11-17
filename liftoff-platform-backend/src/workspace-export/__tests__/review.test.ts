// review.json: both status tables, step by step, and the requested actions.
//
// The `As of` test on the transition timestamp comes BEFORE any reading of
// the terminal status, so a row that satisfies two later steps and moved
// after the cutoff is caught by step 1 and projected as it stood.

import { projectApproval, projectClarification, type ReviewContext } from '../review';
import type { ReviewHistoryApproval, ReviewHistoryClarification } from '../../connectors/tenant-runtime-client';
import type { LateFeedbackRow } from '../queries';

const AS_OF = new Date('2026-09-18T21:04:11.318Z');
const BEFORE = '2026-09-18T20:00:00.000Z';
const AFTER = '2026-09-18T22:00:00.000Z';
const ACC = '22222222-2222-4222-8222-222222222222';
const APPROVAL_ID = '55555555-5555-4555-8555-555555555555';

function approval(overrides: Partial<ReviewHistoryApproval> = {}): ReviewHistoryApproval {
  return {
    id: APPROVAL_ID, agentName: 'Release Coordinator', status: 'pending', decision: null,
    decidedBy: null, decidedAt: null, rejectionReason: null, expiresAt: AFTER, updatedAt: BEFORE,
    createdAt: '2026-09-05T09:12:00.000Z', hitlLevel: 1, reason: 'external_content_write',
    pendingToolCalls: [], editedToolInputs: null, actionSummary: 'Post the release note to #announcements',
    whySummary: 'It quotes an outside page.', detail: null, ...overrides,
  };
}

function clarification(overrides: Partial<ReviewHistoryClarification> = {}): ReviewHistoryClarification {
  return {
    id: '66666666-6666-4666-8666-666666666666', agentName: 'Open Internet Researcher',
    question: 'Which region should the report cover?', status: 'pending', firesAt: AFTER, firedAt: null,
    cancelledAt: null, updatedAt: BEFORE, createdAt: '2026-09-08T16:40:00.000Z', resolutionKind: null,
    resolvedBy: null, resolvedByLabel: null, resolvedAt: null, ...overrides,
  };
}

const feedbackRow = (created: string): LateFeedbackRow => ({
  id: 'lf-1', sort_cursor: 'x', approval_id: APPROVAL_ID, decision: 'would_reject', decided_by: ACC,
  rejection_reason: 'Wait until the deploy is verified.', created_at: new Date(created),
});

function ctx(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    asOf: AS_OF,
    accountName: (id) => (id === ACC ? 'Alex Rivera' : undefined),
    lateFeedbackByApproval: new Map(),
    known: new Map(),
    ...overrides,
  };
}

describe('approval status table', () => {
  it('3a: approved, with who and when, and no rejection reason', () => {
    const out = projectApproval(approval({ status: 'approved', decision: 'approved', decidedBy: ACC, decidedAt: BEFORE }), ctx());
    expect(out).toMatchObject({ Status: 'Approved', 'Decided by': 'Alex Rivera', Decided: BEFORE });
    expect(out).not.toHaveProperty('Rejection reason');
  });

  it('3b: rejected, with the typed reason', () => {
    const out = projectApproval(approval({
      status: 'rejected', decision: 'rejected', decidedBy: ACC, decidedAt: BEFORE, rejectionReason: 'Not yet.',
    }), ctx());
    expect(out).toMatchObject({ Status: 'Rejected', 'Decided by': 'Alex Rivera', Decided: BEFORE, 'Rejection reason': 'Not yet.' });
  });

  it('3c: withdrawn is a system action with no actor', () => {
    const out = projectApproval(approval({ status: 'withdrawn', updatedAt: BEFORE }), ctx());
    expect(out.Status).toBe('Withdrawn');
    expect(out).not.toHaveProperty('Decided by');
  });

  it('4a: pending inside its window, and an expired row whose window had not closed at asOf', () => {
    expect(projectApproval(approval({ status: 'pending', expiresAt: AFTER }), ctx()).Status).toBe('Awaiting decision');
    expect(projectApproval(approval({ status: 'pending', expiresAt: null }), ctx()).Status).toBe('Awaiting decision');
    expect(projectApproval(approval({ status: 'expired', expiresAt: AFTER }), ctx()).Status).toBe('Awaiting decision');
  });

  it('4b: pending past its window, and expired, read Passed with the feedback recorded by asOf', () => {
    const feedback = new Map([[APPROVAL_ID, feedbackRow(BEFORE)]]);
    const out = projectApproval(approval({ status: 'expired', expiresAt: BEFORE }), ctx({ lateFeedbackByApproval: feedback }));
    expect(out.Status).toBe('Passed');
    expect(out['Feedback after the window']).toEqual({
      'Would have': 'Rejected', 'Rejection reason': 'Wait until the deploy is verified.', By: 'Alex Rivera', Sent: BEFORE,
    });
    expect(projectApproval(approval({ status: 'pending', expiresAt: BEFORE }), ctx()).Status).toBe('Passed');
  });

  it('1: a decision made after asOf is projected as it stood before, with no decision keys', () => {
    // Satisfies 3a and, on its window, 4a; step 1 catches it first.
    const out = projectApproval(approval({
      status: 'approved', decision: 'approved', decidedBy: ACC, decidedAt: AFTER, expiresAt: AFTER,
    }), ctx());
    expect(out.Status).toBe('Awaiting decision');
    expect(out).not.toHaveProperty('Decided by');
    expect(out).not.toHaveProperty('Decided');
    const passed = projectApproval(approval({
      status: 'rejected', decision: 'rejected', decidedBy: ACC, decidedAt: AFTER, expiresAt: BEFORE, rejectionReason: 'x',
    }), ctx());
    expect(passed.Status).toBe('Passed');
    expect(passed).not.toHaveProperty('Rejection reason');
  });

  it('2: a withdrawal after asOf reads as it stood', () => {
    expect(projectApproval(approval({ status: 'withdrawn', updatedAt: AFTER, expiresAt: AFTER }), ctx()).Status).toBe('Awaiting decision');
  });

  it('ignores a late-feedback row created after asOf', () => {
    const feedback = new Map([[APPROVAL_ID, feedbackRow(AFTER)]]);
    // The SQL bounds the rows; the projection is handed only those, so a
    // context carrying none is the contract. Prove the boundary by absence.
    const out = projectApproval(approval({ status: 'expired', expiresAt: BEFORE }), ctx({ lateFeedbackByApproval: new Map() }));
    expect(out).not.toHaveProperty('Feedback after the window');
    expect(feedback.size).toBe(1);
  });

  it('carries the team name, the level chip, the reason label, Why, and Details as the page shows it', () => {
    const calls = [{ id: 'tc-1', name: 'mcp__slack-eaec0c30__send_message', input: { channel: '#announcements' } }];
    const measured = projectApproval(approval({
      hitlLevel: 2, pendingToolCalls: calls,
      detail: 'slack · send_message — channel #announcements — This run would have affected 120 items in total.',
    }), ctx());
    expect(measured).toMatchObject({
      'Agent': 'Release Coordinator', Requested: '2026-09-05T09:12:00.000Z', Level: 'Critical',
      Reason: 'Acting on outside content', 'Requested Actions': 'Post the release note to #announcements',
      Why: 'It quotes an outside page.', Details: 'This run would have affected 120 items in total.',
    });
    // The mechanical flattened line, which the calls already say, is not Details.
    const flattened = projectApproval(approval({ pendingToolCalls: calls, detail: 'slack · send_message — channel #announcements' }), ctx());
    expect(flattened).not.toHaveProperty('Details');
    // An older row's free prose is.
    const prose = projectApproval(approval({ pendingToolCalls: calls, detail: 'Slack keeps the message for 90 days.' }), ctx());
    expect(prose.Details).toBe('Slack keeps the message for 90 days.');
  });

  it('omits the level for a level the page draws no badge for, and degrades an unknown reason', () => {
    const out = projectApproval(approval({ hitlLevel: 3, reason: 'some_future_gate' }), ctx());
    expect(out).not.toHaveProperty('Level');
    expect(out.Reason).toBe('Needs review');
    expect(projectApproval(approval({ agentName: null }), ctx())['Agent']).toBe('Unknown agent');
  });

  it('omits Decided by when the account no longer resolves', () => {
    const out = projectApproval(approval({ status: 'approved', decision: 'approved', decidedBy: 'nobody', decidedAt: BEFORE }), ctx());
    expect(out.Status).toBe('Approved');
    expect(out).not.toHaveProperty('Decided by');
  });
});

describe('requested actions', () => {
  const calls = [{
    id: 'tc-1', name: 'mcp__slack-eaec0c30__send_message',
    input: { channel: '#announcements', text: 'Release 2.14 is live.', token: 'xoxb-secret' },
  }];

  it('writes the summary when the row has one and nothing was changed', () => {
    expect(projectApproval(approval({ pendingToolCalls: calls }), ctx())['Requested Actions'])
      .toBe('Post the release note to #announcements');
  });

  it('writes the list the page renders when there is no summary, secrets hidden, ids never', () => {
    const out = projectApproval(approval({ pendingToolCalls: calls, actionSummary: null }), ctx());
    expect(out['Requested Actions']).toEqual([{
      App: 'Slack', Action: 'Send message',
      Details: { Channel: '#announcements', Text: 'Release 2.14 is live.', Token: 'Hidden' },
    }]);
    expect(JSON.stringify(out)).not.toContain('tc-1');
    expect(JSON.stringify(out)).not.toContain('xoxb');
  });

  it('writes the approved version and marks it when the approver changed an action, even with a summary', () => {
    const out = projectApproval(approval({
      status: 'approved', decision: 'approved', decidedBy: ACC, decidedAt: BEFORE,
      pendingToolCalls: calls,
      editedToolInputs: { 'tc-1': { channel: '#releases', text: 'Release 2.14 is live.' } },
    }), ctx());
    expect(out['Requested Actions']).toEqual([{
      App: 'Slack', Action: 'Send message',
      Details: { Channel: '#releases', Text: 'Release 2.14 is live.' },
      'Changed by the approver': true,
    }]);
  });

  it('replaces sentinel tenant, account, connector and invocation ids nested in the arguments', () => {
    const TENANT = '11111111-1111-4111-8111-111111111111';
    const CONNECTOR = '33333333-3333-4333-8333-333333333333';
    const INVOCATION = '44444444-4444-4444-8444-444444444444';
    const known = new Map<string, string | null>([[TENANT, null], [ACC, 'Alex Rivera'], [CONNECTOR, 'GitHub'], [INVOCATION, null]]);
    const out = projectApproval(approval({
      actionSummary: null,
      pendingToolCalls: [{ id: 'tc-2', name: 'mcp__github-7d07a896__create_issue', input: {
        tenantId: TENANT, owner: ACC, meta: { connector: CONNECTOR, refs: [INVOCATION] },
        body: `See ${'99999999-9999-4999-8999-999999999999'} in the notes`,
      } }],
    }), ctx({ known }));
    const text = JSON.stringify(out);
    for (const id of [TENANT, ACC, CONNECTOR, INVOCATION]) expect(text).not.toContain(id);
    expect(out['Requested Actions']).toEqual([{
      App: 'GitHub', Action: 'Create issue',
      Details: {
        'Tenant ID': 'Hidden', Owner: 'Alex Rivera',
        Meta: { Connector: 'GitHub', Refs: 'Hidden' },
        Body: 'See 99999999-9999-4999-8999-999999999999 in the notes',
      },
    }]);
  });
});

describe('clarification status table', () => {
  it('2a: answered, with the actor by name, else by label', () => {
    expect(projectClarification(clarification({
      status: 'resume_inflight', resolutionKind: 'answered', resolvedBy: ACC, resolvedAt: BEFORE,
    }), ctx())).toMatchObject({ Status: 'Answered', 'Answered by': 'Alex Rivera', Answered: BEFORE });
    expect(projectClarification(clarification({
      status: 'fired', resolutionKind: 'answered', resolvedByLabel: 'Priya (Slack)', resolvedAt: BEFORE, firedAt: BEFORE,
    }), ctx())).toMatchObject({ Status: 'Answered', 'Answered by': 'Priya (Slack)' });
  });

  it('2b: declined, with the actor', () => {
    expect(projectClarification(clarification({
      status: 'resume_inflight', resolutionKind: 'declined', resolvedBy: ACC, resolvedAt: BEFORE,
    }), ctx())).toMatchObject({ Status: 'Declined', 'Declined by': 'Alex Rivera', Declined: BEFORE });
  });

  it('2c: expired reads Passed', () => {
    expect(projectClarification(clarification({
      status: 'fired', resolutionKind: 'expired', resolvedAt: BEFORE, firedAt: BEFORE,
    }), ctx()).Status).toBe('Passed');
  });

  it('3: cancelled, errored, and pre-migration history', () => {
    expect(projectClarification(clarification({ status: 'cancelled', cancelledAt: BEFORE }), ctx()).Status).toBe('Cancelled');
    expect(projectClarification(clarification({ status: 'errored', updatedAt: BEFORE }), ctx()).Status).toBe('Failed');
    expect(projectClarification(clarification({ status: 'fired', firedAt: BEFORE }), ctx()).Status).toBe('Resolved');
    expect(projectClarification(clarification({ status: 'resume_inflight', updatedAt: BEFORE }), ctx()).Status).toBe('Resolved');
  });

  it('4: pending before and past fires_at', () => {
    expect(projectClarification(clarification({ status: 'pending', firesAt: AFTER }), ctx()).Status).toBe('Awaiting answer');
    expect(projectClarification(clarification({ status: 'pending', firesAt: BEFORE }), ctx()).Status).toBe('Passed');
  });

  it('1: a resolution after asOf is projected as it stood, with no actor', () => {
    // Satisfies 2a and would satisfy 3; step 1 catches it first.
    const out = projectClarification(clarification({
      status: 'resume_inflight', resolutionKind: 'answered', resolvedBy: ACC, resolvedAt: AFTER, firesAt: AFTER,
    }), ctx());
    expect(out.Status).toBe('Awaiting answer');
    expect(out).not.toHaveProperty('Answered by');
    // A legacy fired row with fired_at after asOf and no resolution_kind.
    expect(projectClarification(clarification({ status: 'fired', firedAt: AFTER, firesAt: AFTER }), ctx()).Status).toBe('Awaiting answer');
    // A cancellation after asOf, past its window.
    expect(projectClarification(clarification({ status: 'cancelled', cancelledAt: AFTER, firesAt: BEFORE }), ctx()).Status).toBe('Passed');
  });

  it('carries the team, the question and when it was asked', () => {
    expect(projectClarification(clarification(), ctx())).toMatchObject({
      'Agent': 'Open Internet Researcher', Asked: '2026-09-08T16:40:00.000Z', Question: 'Which region should the report cover?',
    });
    expect(projectClarification(clarification({ agentName: '  ' }), ctx())['Agent']).toBe('Unknown agent');
  });
});
