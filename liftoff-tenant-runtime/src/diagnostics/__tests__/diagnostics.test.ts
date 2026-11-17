// Diagnostics harness — unit + FAULT-INJECTION tests for the pure analysis
// core (no DB / network). Each fault-injection case constructs a known-bad
// reconstructed run and asserts the correct invariant fires (plan Verification:
// "reconstruct a known-bad run … and confirm the right invariant fires").

import { auditHybridLoop } from '../analyze/invariants/hybrid-loop';
import { auditPlatformAgent } from '../analyze/invariants/platform-agent';
import { auditToolConformance } from '../analyze/invariants/tool-conformance';
import { computeMetrics } from '../analyze/metrics';
import { buildScorecard } from '../report/scorecard';
import { clusterFailures } from '../report/cluster';
import { normalizeFailureMode } from '../analyze/taxonomy';
import { computeCohenKappa } from '../analyze/judge/calibrate';
import { collectToolUses, collectToolResults } from '../analyze/trajectory-util';
import type { CanonicalContentBlock, CanonicalMessage, ReconstructedRun, RawEngineEvidence, AgentKind, Finding } from '../reconstruct/trace-model';
import type { EvaluatedRun } from '../analyze/evaluate';

// --- fixture builders --------------------------------------------------------

function toolUse(id: string, name: string, input: Record<string, unknown> = {}): CanonicalContentBlock {
  return { type: 'tool_use', id, name, input };
}
function toolResult(id: string, isError = false): CanonicalContentBlock {
  return { type: 'tool_result', tool_use_id: id, content: isError ? 'err' : 'ok', ...(isError ? { is_error: true } : {}) };
}
function userText(text: string): CanonicalMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function mkRun(agentKind: AgentKind, messages: CanonicalMessage[], raw: RawEngineEvidence = {}): ReconstructedRun {
  return {
    ref: { agentKind, tenantId: 't1', agentId: 'a1', key: 'k1' },
    runtime: agentKind === 'user-created' ? 'tenant-runtime' : agentKind === 'insights' ? 'platform-backend' : 'workforce-service',
    trajectory: {
      schema_version: '1.0',
      trajectory_meta: {
        tenant_id: 't1',
        agent_id: 'a1',
        invocation_id: 'k1',
        provider: 'anthropic',
        model: 'm',
        started_at: '2026-06-24T00:00:00.000Z',
        completed: true,
        tool_call_count: 0,
        outcome: 'success',
      },
      system: [],
      messages,
      tools: [],
    },
    raw,
    spec: { agentKind, text: 'spec' },
  };
}

const has = (fs: Finding[], inv: string): boolean => fs.some((f) => f.invariant === inv);

// --- trajectory-util ---------------------------------------------------------

describe('trajectory-util', () => {
  it('collects tool uses and results by id', () => {
    const run = mkRun('user-created', [
      userText('go'),
      { role: 'assistant', content: [toolUse('u1', 'memory_save')] },
      { role: 'user', content: [toolResult('u1')] },
    ]);
    expect(collectToolUses(run.trajectory).map((u) => u.name)).toEqual(['memory_save']);
    expect(collectToolResults(run.trajectory).get('u1')?.isError).toBe(false);
  });
});

// --- hybrid-loop invariants (fault injection) --------------------------------

describe('hybrid-loop invariants', () => {
  it('clean run produces no error findings', () => {
    const run = mkRun(
      'user-created',
      [userText('go'), { role: 'assistant', content: [toolUse('u1', 'memory_save')] }, { role: 'user', content: [toolResult('u1')] }],
      { invocation: invRow({ outcome: 'success' }) },
    );
    expect(auditHybridLoop(run).filter((f) => f.severity === 'error' || f.severity === 'critical')).toHaveLength(0);
  });

  it('FAULT: tool_use without tool_result fires integrity invariant', () => {
    const run = mkRun('user-created', [userText('go'), { role: 'assistant', content: [toolUse('u1', 'gmail_send')] }]);
    expect(has(auditHybridLoop(run), 'hybrid.toolcall_result_integrity')).toBe(true);
  });

  it('FAULT: live pause present but no run-state → coherence violation', () => {
    const run = mkRun('user-created', [userText('go')], {
      livePauses: [{ invocationId: 'k1', pauseReason: 'hitl_approval', approvalId: null, status: 'pending', firedAt: null, createdAt: '2026-06-24T00:00:00Z', expiresAt: '2999-01-01T00:00:00Z' }],
    });
    expect(has(auditHybridLoop(run), 'hybrid.runstate_session_coherence')).toBe(true);
  });

  it('FAULT: HITL pause past deadline but still pending → stuck_pending', () => {
    const run = mkRun('user-created', [userText('go')], {
      invocation: invRow({ outcome: null }),
      runState: { schemaVersion: '1.0', state: {} },
      livePauses: [{ invocationId: 'k1', pauseReason: 'hitl_approval', approvalId: 'a1', status: 'pending', firedAt: null, createdAt: '2026-06-01T00:00:00Z', expiresAt: '2026-06-02T00:00:00Z' }],
    });
    expect(has(auditHybridLoop(run), 'hybrid.hitl_stuck_pending')).toBe(true);
  });

  it('OK: a HITL pause that already fired is NOT flagged stuck', () => {
    const run = mkRun('user-created', [userText('go')], {
      invocation: invRow({ outcome: null }),
      runState: { schemaVersion: '1.0', state: {} },
      livePauses: [{ invocationId: 'k1', pauseReason: 'hitl_approval', approvalId: 'a1', status: 'fired', firedAt: '2026-06-02T00:00:00Z', createdAt: '2026-06-01T00:00:00Z', expiresAt: '2026-06-02T00:00:00Z' }],
    });
    expect(has(auditHybridLoop(run), 'hybrid.hitl_stuck_pending')).toBe(false);
  });

  it('FAULT: idempotency double-exec (same call twice, both success)', () => {
    const run = mkRun('user-created', [
      userText('go'),
      { role: 'assistant', content: [toolUse('u1', 'send', { to: 'x' }), toolUse('u2', 'send', { to: 'x' })] },
      { role: 'user', content: [toolResult('u1'), toolResult('u2')] },
    ]);
    expect(has(auditHybridLoop(run), 'hybrid.idempotency_double_exec')).toBe(true);
  });

  it('FAULT: loop (same call ≥3×) fires loop_detected', () => {
    const run = mkRun('user-created', [
      userText('go'),
      { role: 'assistant', content: [toolUse('u1', 'poll', { q: 1 }), toolUse('u2', 'poll', { q: 1 }), toolUse('u3', 'poll', { q: 1 })] },
      { role: 'user', content: [toolResult('u1'), toolResult('u2'), toolResult('u3')] },
    ]);
    expect(has(auditHybridLoop(run), 'hybrid.loop_detected')).toBe(true);
  });

  it('FIX: loop/idempotency NOT flagged when inputs_reliable=false (lossy raw-table reconstruction)', () => {
    // The SAME 3× identical-signature pattern that fires loop_detected above,
    // but on a run whose tool inputs were not reliably captured (empty {} args
    // collapse the signature). Must suppress both signature detectors and leave
    // only the non-gating info note — no false MAST-1.3.
    const run = mkRun('user-created', [
      userText('go'),
      { role: 'assistant', content: [toolUse('u1', 'poll', { q: 1 }), toolUse('u2', 'poll', { q: 1 }), toolUse('u3', 'poll', { q: 1 })] },
      { role: 'user', content: [toolResult('u1'), toolResult('u2'), toolResult('u3')] },
    ]);
    run.trajectory.trajectory_meta.inputs_reliable = false;
    const fs = auditHybridLoop(run);
    expect(has(fs, 'hybrid.loop_detected')).toBe(false);
    expect(has(fs, 'hybrid.idempotency_double_exec')).toBe(false);
    expect(has(fs, 'hybrid.loop_detection_skipped_unreliable_inputs')).toBe(true);
    expect(fs.filter((f) => f.severity === 'error' || f.severity === 'critical')).toHaveLength(0);
  });

  it('FAULT: delegation orphan (parent success, child unterminated)', () => {
    const run = mkRun('user-created', [userText('go')], {
      invocation: invRow({ outcome: 'success' }),
      childInvocations: [invRow({ id: 'child1', outcome: null })],
    });
    expect(has(auditHybridLoop(run), 'hybrid.delegation_orphan')).toBe(true);
  });

  it('FAULT: timer/delay resume lost (past-deadline timer pause still pending, no terminal outcome)', () => {
    const run = mkRun('user-created', [userText('go')], {
      invocation: invRow({ outcome: null }),
      runState: { schemaVersion: '1.0', state: {} },
      livePauses: [{ invocationId: 'k1', pauseReason: 'timer_delay', approvalId: null, status: 'pending', firedAt: null, createdAt: '2026-06-01T00:00:00Z', expiresAt: '2026-06-02T00:00:00Z' }],
    });
    expect(has(auditHybridLoop(run), 'hybrid.timer_resume_lost')).toBe(true);
  });

  it('FAULT: HITL double-exec (gated then success, identical args)', () => {
    const run = mkRun('user-created', [userText('go')], {
      auditLogs: [
        { id: '1', action: 'gmail_send', outcome: 'gated', errorCode: null, inputArgs: { to: 'x' }, triggeredBy: 'agent', createdAt: '2026-06-24T00:00:00Z' },
        { id: '2', action: 'gmail_send', outcome: 'success', errorCode: null, inputArgs: { to: 'x' }, triggeredBy: 'agent', createdAt: '2026-06-24T00:01:00Z' },
      ],
    });
    expect(has(auditHybridLoop(run), 'hybrid.hitl_double_exec')).toBe(true);
  });

  it('only applies to user-created agents', () => {
    expect(auditHybridLoop(mkRun('caio', [userText('go')]))).toHaveLength(0);
  });
});

// --- platform-agent invariants (CAIO/HRBP/Insights) --------------------------

describe('platform-agent invariants', () => {
  it('FAULT: HRBP create success with no internal_agent_id → silent failure', () => {
    const run = mkRun('hrbp', [], {
      loopMeta: { iterations: 2, maxIterations: 10, cumulativeInputTokens: 0, cumulativeOutputTokens: 0, terminator: 'normal' },
      hrbp: {
        run: { id: 'r1', planId: 'p1', status: 'completed', specCount: 1 },
        events: [{ specId: 's1', step: 'teambuilder__create', status: 'success', internalAgentId: null, idempotencyKey: 'i1', errorMessage: null, createdAt: '2026-06-24T00:00:00Z' }],
        compensations: [],
      },
    });
    expect(has(auditPlatformAgent(run), 'hrbp.silent_failure_no_created_agent')).toBe(true);
  });

  it('FAULT: loop exceeds max iterations', () => {
    const run = mkRun('insights', [], { loopMeta: { iterations: 11, maxIterations: 10, cumulativeInputTokens: 0, cumulativeOutputTokens: 0 } });
    expect(has(auditPlatformAgent(run), 'platform.max_iterations_exceeded')).toBe(true);
  });

  it('FAULT: HRBP idempotency double-delivery (same spec/key create twice)', () => {
    const ev = (s: string) => ({ specId: 's1', step: 'teambuilder__create', status: 'success', internalAgentId: 'ia1', idempotencyKey: 'i1', errorMessage: null, createdAt: s });
    const run = mkRun('hrbp', [], {
      hrbp: { run: { id: 'r1', planId: 'p1', status: 'completed', specCount: 1 }, events: [ev('2026-06-24T00:00:00Z'), ev('2026-06-24T00:00:01Z')], compensations: [] },
    });
    expect(has(auditPlatformAgent(run), 'hrbp.idempotency_double_delivery')).toBe(true);
  });
});

// --- tool-conformance --------------------------------------------------------

describe('tool-conformance', () => {
  it('FAULT: out-of-set tool (CAIO calls a tool not in its designed set)', () => {
    const run = mkRun('caio', [{ role: 'assistant', content: [toolUse('u1', 'delete_everything')] }, { role: 'user', content: [toolResult('u1')] }]);
    expect(has(auditToolConformance(run), 'conformance.out_of_set')).toBe(true);
  });

  it('FAULT: role violation (member calls a mutating CAIO tool)', () => {
    const run = mkRun('caio', [{ role: 'assistant', content: [toolUse('u1', 'workforce_plan__commit')] }, { role: 'user', content: [toolResult('u1')] }]);
    expect(has(auditToolConformance(run, { role: 'member' }), 'conformance.role_violation')).toBe(true);
  });

  it('FAULT: sequence break (CAIO approves before drafting)', () => {
    const run = mkRun('caio', [{ role: 'assistant', content: [toolUse('u1', 'workforce_plan__approve')] }, { role: 'user', content: [toolResult('u1')] }]);
    const fs = auditToolConformance(run);
    expect(fs.some((f) => f.invariant.startsWith('conformance.sequence'))).toBe(true);
  });

  it('FAULT: insights fetched data but rendered no visualization blocks', () => {
    const run = mkRun('insights', [{ role: 'assistant', content: [toolUse('u1', 'get_cost_breakdown')] }, { role: 'user', content: [toolResult('u1')] }], { visualizationBlockCount: 0 });
    expect(has(auditToolConformance(run), 'conformance.missing_expected_output')).toBe(true);
  });

  it('clean CAIO designed flow passes conformance', () => {
    const run = mkRun('caio', [
      { role: 'assistant', content: [toolUse('u1', 'org__get_existing_structure'), toolUse('u2', 'workforce_plan__draft'), toolUse('u3', 'workforce_plan__commit'), toolUse('u4', 'workforce_plan__approve')] },
      { role: 'user', content: [toolResult('u1'), toolResult('u2'), toolResult('u3'), toolResult('u4')] },
    ]);
    expect(auditToolConformance(run, { role: 'owner' }).filter((f) => f.severity === 'error' || f.severity === 'critical')).toHaveLength(0);
  });

  it('user-created: judges against the runtime-captured toolset (not a reconstruction)', () => {
    // A connector tool the lossy reconstruction would miss; it IS in the
    // trajectory-captured toolset, so it must NOT be out-of-set — even with no
    // reconstructedCatalog supplied.
    const run = mkRun('user-created', [
      { role: 'assistant', content: [toolUse('u1', 'mcp__acme__send')] },
      { role: 'user', content: [toolResult('u1')] },
    ]);
    run.trajectory.tools = [{ name: 'mcp__acme__send', description: '', input_schema: {} }];
    expect(has(auditToolConformance(run), 'conformance.out_of_set')).toBe(false);
    expect(has(auditToolConformance(run), 'conformance.designed_set_unresolved')).toBe(false);
  });

  it('user-created: flags a tool absent from BOTH the captured toolset and the injected primitives', () => {
    const run = mkRun('user-created', [
      { role: 'assistant', content: [toolUse('u1', 'totally_made_up_tool')] },
      { role: 'user', content: [toolResult('u1')] },
    ]);
    run.trajectory.tools = [{ name: 'mcp__acme__send', description: '', input_schema: {} }];
    expect(has(auditToolConformance(run), 'conformance.out_of_set')).toBe(true);
  });

  it('user-created: adapter-injected claude_code tools (Bash/Read/TodoWrite/RemoteTrigger) are NOT out-of-set', () => {
    // The Anthropic SDK injects the claude_code preset alongside the MCP
    // catalog; the API only permits calling provided tools, so these are
    // available-by-construction even though the captured catalog lists only
    // the liftoff MCP tools.
    const run = mkRun('user-created', [
      { role: 'assistant', content: [toolUse('u1', 'Bash'), toolUse('u2', 'Read'), toolUse('u3', 'TodoWrite'), toolUse('u4', 'RemoteTrigger')] },
      { role: 'user', content: [toolResult('u1'), toolResult('u2'), toolResult('u3'), toolResult('u4')] },
    ]);
    run.trajectory.tools = [{ name: 'memory_save', description: '', input_schema: {} }];
    expect(has(auditToolConformance(run), 'conformance.out_of_set')).toBe(false);
  });

  it('user-created: out-of-set against a LOSSY reconstructed set → coverage gap, not a violation', () => {
    // Raw-table run: no captured trajectory.tools. The only designed set is the
    // (lossy) reconstructed catalog, which misses dynamically-surfaced tools. A
    // call it doesn't contain must NOT be flagged out_of_set (false positive);
    // it's reported as an unreliable-set coverage gap instead.
    const run = mkRun('user-created', [
      { role: 'assistant', content: [toolUse('u1', 'mcp__github-x__get_me')] },
      { role: 'user', content: [toolResult('u1')] },
    ]); // mkRun defaults trajectory.tools = []
    const ctx = { reconstructedCatalog: ['memory_save'] };
    expect(has(auditToolConformance(run, ctx), 'conformance.out_of_set')).toBe(false);
    expect(has(auditToolConformance(run, ctx), 'conformance.designed_set_unreliable')).toBe(true);
  });

  it('user-created: empty captured toolset + no catalog → coverage gap (unchanged fallback)', () => {
    const run = mkRun('user-created', [
      { role: 'assistant', content: [toolUse('u1', 'totally_made_up_tool')] },
      { role: 'user', content: [toolResult('u1')] },
    ]); // mkRun defaults trajectory.tools = []
    expect(has(auditToolConformance(run), 'conformance.designed_set_unresolved')).toBe(true);
  });

  it('user-created: a BOUND vendor-MCP tool (mcp__<server>__*) is in-set', () => {
    const run = mkRun('user-created', [
      { role: 'assistant', content: [toolUse('u1', 'mcp__github-7d07a896__get_me')] },
      { role: 'user', content: [toolResult('u1')] },
    ]);
    run.trajectory.tools = [{ name: 'memory_save', description: '', input_schema: {} }]; // captured catalog excludes vendor MCP
    run.trajectory.trajectory_meta.vendor_mcp_servers = ['github-7d07a896'];
    expect(has(auditToolConformance(run), 'conformance.out_of_set')).toBe(false);
  });

  it('user-created: an UNBOUND vendor-MCP tool is still out-of-set', () => {
    const run = mkRun('user-created', [
      { role: 'assistant', content: [toolUse('u1', 'mcp__stripe-x__create_charge')] },
      { role: 'user', content: [toolResult('u1')] },
    ]);
    run.trajectory.tools = [{ name: 'memory_save', description: '', input_schema: {} }];
    run.trajectory.trajectory_meta.vendor_mcp_servers = ['github-7d07a896']; // stripe-x NOT bound
    expect(has(auditToolConformance(run), 'conformance.out_of_set')).toBe(true);
  });
});

// --- metrics -----------------------------------------------------------------

describe('metrics', () => {
  it('scores tool correctness against the designed set and flags redundancy', () => {
    const run = mkRun('caio', [
      { role: 'assistant', content: [toolUse('u1', 'memory_retrieve', { q: 1 }), toolUse('u2', 'memory_retrieve', { q: 1 })] },
      { role: 'user', content: [toolResult('u1'), toolResult('u2')] },
    ]);
    const m = computeMetrics(run);
    expect(m.toolCallCount).toBe(2);
    expect(m.redundantCallCount).toBe(1);
    expect(m.stepEfficiency).toBeCloseTo(0.5);
    expect(m.toolCorrectness).toBe(1); // both in the designed set
  });
});

// --- taxonomy + cluster + scorecard ------------------------------------------

describe('taxonomy + reporting', () => {
  it('normalizes failure-mode labels to canonical MAST/TRAIL codes', () => {
    expect(normalizeFailureMode('MAST.silent_failure')).toBe('MAST-3.2');
    expect(normalizeFailureMode('TRAIL.repetitive_actions')).toBe('MAST-1.3');
    expect(normalizeFailureMode(undefined)).toBe('unknown');
  });

  it('clusters findings by canonical code, ranked by frequency × severity', () => {
    const f = (mode: string): Finding => ({ invariant: 'x', severity: 'critical', component: 'output', message: 'm', evidence: {}, failureMode: mode });
    const runs: EvaluatedRun[] = [
      evalRun([f('MAST.silent_failure')]),
      evalRun([f('MAST.silent_failure')]),
      evalRun([f('TRAIL.repetitive_actions')]),
    ];
    const clusters = clusterFailures(runs);
    expect(clusters[0].failureMode).toBe('MAST-3.2');
    expect(clusters[0].frequency).toBe(2);
    expect(clusters[0].taxonomy).toContain('MAST-3.2');
  });

  it('builds a scorecard aggregating gating + metrics', () => {
    const runs: EvaluatedRun[] = [evalRun([], { gating: false }), evalRun([{ invariant: 'x', severity: 'error', component: 'engine', message: 'm', evidence: {} }], { gating: true })];
    const sc = buildScorecard('user-created', 't1', 'a1', runs, '2026-06-24T00:00:00Z');
    expect(sc.runCount).toBe(2);
    expect(sc.gatingFailureRate).toBeCloseTo(0.5);
  });
});

// --- Cohen's kappa -----------------------------------------------------------

describe('judge calibration', () => {
  it('perfect agreement → κ = 1', () => {
    expect(computeCohenKappa([{ human: true, judge: true }, { human: false, judge: false }, { human: true, judge: true }])).toBeCloseTo(1);
  });
  it('systematic disagreement → κ ≤ 0', () => {
    expect(computeCohenKappa([{ human: true, judge: false }, { human: false, judge: true }])).toBeLessThanOrEqual(0);
  });
  it('empty set → NaN', () => {
    expect(Number.isNaN(computeCohenKappa([]))).toBe(true);
  });
});

// --- helpers -----------------------------------------------------------------

function invRow(over: Partial<{ id: string; outcome: 'success' | 'error' | 'escalated' | null }>): NonNullable<RawEngineEvidence['invocation']> {
  return {
    id: over.id ?? 'k1',
    tenantId: 't1',
    agentId: 'a1',
    parentInvocationId: null,
    triggeredBy: 'human',
    // Preserve an explicit null (do NOT coerce to 'success').
    outcome: 'outcome' in over ? (over.outcome ?? null) : 'success',
    errorMessage: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    toolCalls: [],
    startedAt: '2026-06-24T00:00:00.000Z',
    completedAt: '2026-06-24T00:00:01.000Z',
  };
}

let evalRunCounter = 0;
function evalRun(findings: Finding[], over: Partial<EvaluatedRun> = {}): EvaluatedRun {
  return {
    ref: { agentKind: 'user-created', tenantId: 't1', agentId: 'a1', key: `run-${evalRunCounter++}` },
    runtime: 'tenant-runtime',
    findings,
    metrics: { toolCorrectness: 1, stepEfficiency: 1, toolCallCount: 0, redundantCallCount: 0, loopDetected: false, costUsd: 0, latencyMs: 0, inputTokens: 0, outputTokens: 0, perStep: [] },
    gating: findings.some((f) => f.severity === 'error' || f.severity === 'critical'),
    ...over,
  };
}
