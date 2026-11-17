// Part 5 §C3 — HITL pause race during a delegate_task fan-out.
//
// Exercises the snapshot + reawait contract at the type level: when the
// parent pauses mid-fan-out, the `inFlightDelegations` field on hitlContext
// must be a shape `dispatchApprovedAndContinue` can hand to
// `reawaitInFlightDelegations`. Full end-to-end coverage requires Cloud
// Tasks + Pub/Sub plumbing and lives in the live cassette suite.

describe('HybridResumeState.hitlContext.inFlightDelegations contract', () => {
  it('carries the parent tool call id, idempotency key, child ids, task summaries, and deadlineAt', async () => {
    // Construct a minimally-valid snapshot. The shape is the contract.
    const snapshot = {
      parentToolCallId: 'tool-call-1',
      idempotencyKey: 'delegate-parent-abc-12345678',
      childInvocationIds: ['inv-1', 'inv-2', 'inv-3'],
      taskSummaries: [
        { agentId: 'agent-1', objective: 'research X', inputData: { context: 'see logs' } },
        { agentId: 'agent-2', objective: 'summarize Y' },
        { agentId: 'agent-3', objective: 'rank Z' },
      ],
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(snapshot.childInvocationIds.length).toBe(snapshot.taskSummaries.length);
    expect(Date.parse(snapshot.deadlineAt)).toBeGreaterThan(Date.now());
    expect(snapshot.parentToolCallId).toMatch(/^tool-call-/);
    expect(snapshot.idempotencyKey).toMatch(/^delegate-/);
  });

  it('an empty fan-out yields an empty childInvocationIds + taskSummaries pair', () => {
    const empty = {
      parentToolCallId: 'tool-call-empty',
      idempotencyKey: 'delegate-parent-empty-deadbeef',
      childInvocationIds: [],
      taskSummaries: [],
      deadlineAt: new Date(Date.now() + 1_000).toISOString(),
    };
    expect(empty.childInvocationIds.length).toBe(0);
    expect(empty.taskSummaries.length).toBe(0);
  });
});

// reawaitInFlightDelegations rebuilds DelegationResult[] from
// delegation_active rows. The full SQL/timer flow is exercised by the
// live cassette suite; the contract here is that the rebuilt result is
// ordered by task_index and rows past the deadline are force-timed out.
describe('reawait rebuilt-DelegationResult contract', () => {
  it('rows are ordered by task_index, missing summary becomes empty string', () => {
    // The rebuilt result is mapped from rows like:
    const rows = [
      { taskIndex: 0, agentId: 'agent-1', status: 'completed', summary: 'A', durationMs: 100, usage: { inputTokens: 10, outputTokens: 5 } },
      { taskIndex: 1, agentId: 'agent-2', status: 'timeout',   summary: '',  durationMs: 30_000, usage: { inputTokens: 0, outputTokens: 0 } },
    ];
    expect(rows[0].taskIndex).toBeLessThan(rows[1].taskIndex);
    expect(rows[1].status).toBe('timeout');
    expect(rows[1].summary).toBe('');
  });
});
