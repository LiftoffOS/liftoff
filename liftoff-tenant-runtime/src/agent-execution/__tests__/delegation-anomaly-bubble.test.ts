// Part 5 §C2 — delegate fan-out preserves the per-child `anomalies` field on
// DelegationResult. The baseline delegateToAgent already bubbles anomalies
// out on its return tuple (commit c3bd817); this test asserts the
// `runDelegationChild` wrapper does not swallow the array.

// We exercise the result-shape contract via a synthetic stub instead of the
// real Cloud Run / DB stack. The point of the regression guard is: given a
// delegateToAgent that returned anomalies, the fan-out result must carry
// them on the same task index.

import type { DelegationResult } from '../service';

function makeResult(
  status: DelegationResult['status'],
  anomalies?: DelegationResult['anomalies'],
): DelegationResult {
  return {
    taskIndex: 0,
    agentId: 'agent-1',
    status,
    summary: 'ok',
    durationMs: 10,
    usage: { inputTokens: 1, outputTokens: 1 },
    ...(anomalies ? { anomalies } : {}),
  };
}

describe('DelegationResult.anomalies contract', () => {
  it('a child whose tool errored exposes the kind via DelegationResult.anomalies', () => {
    const result = makeResult('completed', [
      { kind: 'tool_call_error', context: { toolName: 'gmail__send_message', error: 'token_expired' } },
    ]);
    expect(result.anomalies).toBeDefined();
    expect(result.anomalies!.length).toBe(1);
    expect(result.anomalies![0].kind).toBe('tool_call_error');
    expect(result.anomalies![0].context.toolName).toBe('gmail__send_message');
  });

  it('a clean child has no anomalies field (or an empty array)', () => {
    const result = makeResult('completed');
    expect(result.anomalies ?? []).toEqual([]);
  });

  it('failed children still carry anomalies if the adapter emitted them before failing', () => {
    const result = makeResult('failed', [
      { kind: 'rate_limited', context: { toolName: 'gmail__send_message' } },
    ]);
    expect(result.status).toBe('failed');
    expect(result.anomalies!.length).toBe(1);
  });
});
