// B4 — every adversarial scenario must be well-formed against AgentTestScenario, carry the
// 'adversarial' tag, and be evaluable by assertScenario without throwing.

import { ADVERSARIAL_SCENARIOS } from './scenarios-adversarial.js';
import { assertScenario } from './assert.js';
import type { AgentHarnessRunResult } from './types.js';

function baseResp(over: Partial<AgentHarnessRunResult> = {}): AgentHarnessRunResult {
  return {
    ok: true,
    invocationId: 'inv-1',
    threadId: 'thr-1',
    finalText: 'I will not do that.',
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    outcome: 'success',
    exposedToolNames: [],
    durationMs: 1,
    auditLogs: [],
    pauseState: { kind: 'none' },
    ...over,
  };
}

describe('ADVERSARIAL_SCENARIOS', () => {
  it('contains exactly the seven launch scenarios', () => {
    expect(ADVERSARIAL_SCENARIOS).toHaveLength(7);
    const ids = ADVERSARIAL_SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(7); // unique ids
    expect(ids).toEqual(
      expect.arrayContaining([
        'adv.inj_workitem_email_exfil',
        'adv.destructive_direct',
        'adv.inj_workitem_tool_pivot',
        'adv.exfil_memory_dump',
        'adv.escalation_selfapprove',
        'adv.pii_launder',
        'adv.merge_bypass',
      ]),
    );
  });

  it('every entry is well-formed and tagged adversarial', () => {
    for (const s of ADVERSARIAL_SCENARIOS) {
      expect(typeof s.id).toBe('string');
      expect(s.id.length).toBeGreaterThan(0);
      expect(typeof s.description).toBe('string');
      expect(typeof s.prompt).toBe('string');
      expect(s.tags).toContain('adversarial');
    }
  });

  it('each scenario is evaluable by assertScenario without throwing', () => {
    for (const s of ADVERSARIAL_SCENARIOS) {
      // A benign run (no forbidden tool fired, no pause) — the point is that the matcher runs.
      expect(() => assertScenario(s, baseResp())).not.toThrow();
    }
  });

  it('a forbidden tool firing fails the tool-absence assertion', () => {
    const s = ADVERSARIAL_SCENARIOS.find((x) => x.id === 'adv.inj_workitem_email_exfil')!;
    const result = assertScenario(
      s,
      baseResp({
        exposedToolNames: ['send_email'], // required tool present ⇒ not skipped
        toolCalls: [{ callId: 'c1', toolName: 'send_email' }],
      }),
    );
    expect(result.status).toBe('fail');
    expect(result.failures.join(' ')).toMatch(/send_email/);
  });
});
