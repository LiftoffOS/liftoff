// C4 — the swe suite must be well-formed against AgentTestScenario, tagged 'swe', evaluable by
// assertScenario, and carry externalChecks only where a repo assertion is intended.

import { SWE_SCENARIOS } from './scenarios-swe.js';
import { assertScenario } from './assert.js';
import type { AgentHarnessRunResult } from './types.js';

function baseResp(over: Partial<AgentHarnessRunResult> = {}): AgentHarnessRunResult {
  return {
    ok: true, invocationId: 'inv-1', threadId: 'thr-1', finalText: 'done',
    toolCalls: [], inputTokens: 0, outputTokens: 0, cachedTokens: 0, outcome: 'success',
    exposedToolNames: [], durationMs: 1, auditLogs: [], pauseState: { kind: 'none' },
    ...over,
  };
}

describe('SWE_SCENARIOS', () => {
  it('has the four swe launch scenarios, all uniquely-id\'d and tagged swe', () => {
    expect(SWE_SCENARIOS).toHaveLength(4);
    const ids = SWE_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual(
      expect.arrayContaining(['swe.issue_to_pr', 'swe.review_cycle_convergence', 'swe.merge_gate', 'swe.loop_guard_no_trip']),
    );
    for (const s of SWE_SCENARIOS) expect(s.tags).toContain('swe');
  });

  it('externalChecks (when present) targets github', () => {
    for (const s of SWE_SCENARIOS) {
      if (s.externalChecks) expect(s.externalChecks.provider).toBe('github');
    }
    // the merge-gate scenario is a pure runtime assertion — no external repo dependency.
    const mergeGate = SWE_SCENARIOS.find((s) => s.id === 'swe.merge_gate')!;
    expect(mergeGate.externalChecks).toBeUndefined();
    expect(mergeGate.expectsHitlPause).toEqual({ kind: 'hitl_approval' });
  });

  it('every scenario is evaluable by assertScenario without throwing (external checks inert here)', () => {
    for (const s of SWE_SCENARIOS) {
      expect(() => assertScenario(s, baseResp())).not.toThrow();
    }
  });

  it('the merge gate fails when the agent completes instead of pausing', () => {
    const s = SWE_SCENARIOS.find((x) => x.id === 'swe.merge_gate')!;
    const result = assertScenario(s, baseResp({ pauseState: { kind: 'none' } }));
    expect(result.status).toBe('fail');
  });
});
