// Argument-scoring dimension — unit tests for the deterministic schema-validity
// critic + the advisory appropriateness judge + their scorecard/calibrate wiring.
// Mirrors diagnostics.test.ts (pure fixtures, no DB; the LLM client is mocked).

// Mock the LLM client so the appropriateness judge / calibration never hit the
// network. Must be declared before importing the judge modules.
jest.mock('../../llm', () => ({ llmClient: { complete: jest.fn() } }));

import { scoreArgValidity, argValidityFindings, ARG_FAIL_THRESHOLD } from '../analyze/critics/schema-validity';
import { judgeArgumentAppropriateness } from '../analyze/judge/arguments';
import { calibrateJudges } from '../analyze/judge/calibrate';
import { buildScorecard } from '../report/scorecard';
import { clusterFailures } from '../report/cluster';
import { normalizeFailureMode } from '../analyze/taxonomy';
import { llmClient } from '../../llm';
import type {
  CanonicalContentBlock,
  CanonicalMessage,
  ReconstructedRun,
  RawEngineEvidence,
  InvocationRow,
  AgentKind,
} from '../reconstruct/trace-model';
import type { EvaluatedRun } from '../analyze/evaluate';
import type { TrajectoryMetrics } from '../analyze/metrics';

const mockComplete = llmClient.complete as jest.Mock;

// --- fixture builders --------------------------------------------------------

function toolUse(name: string, input: Record<string, unknown> = {}, id = 'u1'): CanonicalContentBlock {
  return { type: 'tool_use', id, name, input };
}
function userText(text: string): CanonicalMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}
function assistant(blocks: CanonicalContentBlock[]): CanonicalMessage {
  return { role: 'assistant', content: blocks };
}

function invocation(triggeredBy: string): InvocationRow {
  return {
    id: 'i', tenantId: 't', agentId: 'a', parentInvocationId: null, triggeredBy,
    outcome: 'success', errorMessage: null, inputTokens: 0, outputTokens: 0, costUsd: null,
    toolCalls: [], startedAt: '2026-06-24T00:00:00.000Z', completedAt: null,
  };
}

interface MkOpts {
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  inputsReliable?: boolean;
  synthesized?: boolean;
  triggeredBy?: string;
}

function mkRun(agentKind: AgentKind, messages: CanonicalMessage[], opts: MkOpts = {}): ReconstructedRun {
  const raw: RawEngineEvidence = opts.triggeredBy ? { invocation: invocation(opts.triggeredBy) } : {};
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
        ...(opts.inputsReliable === false ? { inputs_reliable: false } : {}),
        ...(opts.synthesized ? { synthesized_objective: true } : {}),
      },
      system: [],
      messages,
      tools: opts.tools ?? [],
    },
    raw,
    spec: { agentKind, text: 'spec' },
  };
}

// --- schema-validity critic --------------------------------------------------

describe('schema-validity critic', () => {
  it('a valid CAIO call scores 1.0', () => {
    const run = mkRun('caio', [assistant([toolUse('agent_templates__get', { templateId: 'tmpl-1' })])]);
    const r = scoreArgValidity(run);
    expect(r.score).toBe(1);
    expect(argValidityFindings(r).filter((f) => f.severity === 'warn')).toHaveLength(0);
  });

  it('a missing required field → graded partial (< 1) and a warn finding', () => {
    const run = mkRun('caio', [assistant([toolUse('agent_templates__get', {})])]);
    const r = scoreArgValidity(run);
    expect(r.score).toBe(0); // single required check fails
    expect(r.score! < 1).toBe(true);
    const warns = argValidityFindings(r).filter((f) => f.invariant === 'critic.arg_validity');
    expect(warns).toHaveLength(1);
  });

  it('an out-of-enum value → graded partial (0 < score < 1)', () => {
    const run = mkRun('caio', [assistant([toolUse('memory_save', { content: 'hi', layer: 'bogus' })])]);
    const r = scoreArgValidity(run);
    // required content+layer present, types ok, enum(layer) fails → 4/5.
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });

  it('a wrong-typed value → graded partial', () => {
    const run = mkRun('caio', [assistant([toolUse('memory_retrieve', { query: 123 })])]);
    const r = scoreArgValidity(run);
    // required query present (1) + type query number-vs-string (0) → 0.5.
    expect(r.score).toBe(0.5);
  });

  it('an unparseable date-time (user-created captured schema) → graded partial', () => {
    const run = mkRun('user-created', [assistant([toolUse('book', { when: 'not-a-date' })])], {
      tools: [{ name: 'book', description: '', input_schema: { type: 'object', properties: { when: { type: 'string', format: 'date-time' } }, required: ['when'] } }],
    });
    const r = scoreArgValidity(run);
    // required when present (1) + type string (1) + format date-time (0) → 2/3.
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });

  it('a tool with no captured schema → coverage note, not scoreable (null)', () => {
    const run = mkRun('user-created', [assistant([toolUse('mystery_tool', { x: 1 })])]);
    const r = scoreArgValidity(run);
    expect(r.score).toBeNull();
    expect(r.coverageNotes).toContain('mystery_tool');
    expect(r.perCall[0].hasSchema).toBe(false);
    const infos = argValidityFindings(r).filter((f) => f.severity === 'info');
    expect(infos).toHaveLength(1);
  });

  it('inputs_reliable=false → null (never a fabricated 0)', () => {
    const run = mkRun('user-created', [assistant([toolUse('book', { when: 'x' })])], {
      inputsReliable: false,
      tools: [{ name: 'book', description: '', input_schema: { type: 'object', properties: { when: { type: 'string' } }, required: ['when'] } }],
    });
    const r = scoreArgValidity(run);
    expect(r.score).toBeNull();
  });

  it('a user-created run scores against its trajectory-captured schema', () => {
    const run = mkRun('user-created', [assistant([toolUse('book', { when: '2026-06-24T00:00:00Z' })])], {
      tools: [{ name: 'book', description: '', input_schema: { type: 'object', properties: { when: { type: 'string', format: 'date-time' } }, required: ['when'] } }],
    });
    expect(scoreArgValidity(run).score).toBe(1);
  });

  it('HRBP fallback (synthetic {specId} args, inputs_reliable=false) → null, never scored', () => {
    // The adapter marks the ledger-synthetic fallback path unreliable so validity
    // nulls instead of grading fake args against the (now replicated) HRBP schema.
    const run = mkRun('hrbp', [assistant([toolUse('teambuilder__distill', { specId: 's1' })])], { inputsReliable: false });
    expect(scoreArgValidity(run).score).toBeNull();
  });

  it('HRBP with REAL args (recovered from audit logs) scores against the replicated schema', () => {
    const run = mkRun('hrbp', [assistant([toolUse('teambuilder__distill', { role: 'SDR', responsibilities: 'outbound prospecting' })])]);
    // required role + responsibilities present, both strings → 1.0.
    expect(scoreArgValidity(run).score).toBe(1);
  });

  it('findings carry field NAMES + check outcomes only — never raw values (PII)', () => {
    const secret = 'sk-super-secret-value';
    const run = mkRun('user-created', [assistant([toolUse('book', { when: secret })])], {
      tools: [{ name: 'book', description: '', input_schema: { type: 'object', properties: { when: { type: 'string', format: 'date-time' } }, required: ['when'] } }],
    });
    const findings = argValidityFindings(scoreArgValidity(run));
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('when'); // field name IS present
    expect(serialized).toContain('format'); // check kind IS present
  });

  it('single reachable threshold — warn below ARG_FAIL_THRESHOLD, none for a valid call', () => {
    const good = scoreArgValidity(mkRun('caio', [assistant([toolUse('agent_templates__get', { templateId: 't' })])]));
    const bad = scoreArgValidity(mkRun('caio', [assistant([toolUse('agent_templates__get', {})])]));
    expect(good.score! >= ARG_FAIL_THRESHOLD).toBe(true);
    expect(bad.score! < ARG_FAIL_THRESHOLD).toBe(true);
    expect(argValidityFindings(good).some((f) => f.invariant === 'critic.arg_validity')).toBe(false);
    expect(argValidityFindings(bad).some((f) => f.invariant === 'critic.arg_validity')).toBe(true);
  });
});

describe('schema-validity — individual check kinds', () => {
  function userTool(schema: Record<string, unknown>, input: Record<string, unknown>) {
    const run = mkRun('user-created', [assistant([toolUse('t', input)])], {
      tools: [{ name: 't', description: '', input_schema: schema }],
    });
    return scoreArgValidity(run);
  }

  it('numeric range → partial credit outside [min,max]', () => {
    const r = userTool({ type: 'object', properties: { temp: { type: 'number', minimum: 0, maximum: 100 } } }, { temp: 150 });
    // type ok (1) + range partial (150 is 50 over a span of 100 → 0.5) → mean 0.75.
    expect(r.score).toBe(0.75);
  });

  it('email format → penalized for a non-email', () => {
    const r = userTool({ type: 'object', properties: { to: { type: 'string', format: 'email' } } }, { to: 'nope' });
    expect(r.score).toBe(0.5); // type string ok (1) + format email fail (0)
  });

  it('uri format → 1 for a valid url, penalized for junk', () => {
    expect(userTool({ type: 'object', properties: { u: { type: 'string', format: 'uri' } } }, { u: 'https://x.com' }).score).toBe(1);
    expect(userTool({ type: 'object', properties: { u: { type: 'string', format: 'uri' } } }, { u: 'not a url' }).score).toBeLessThan(1);
  });

  it('pattern → penalized when the value does not match', () => {
    const r = userTool({ type: 'object', properties: { slug: { type: 'string', pattern: '^[a-z]+$' } } }, { slug: 'ABC123' });
    expect(r.score).toBe(0.5); // type string ok (1) + pattern fail (0)
  });

  it('additionalProperties:false → unknown key penalized + surfaced in findings', () => {
    const r = userTool({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }, { a: 'x', b: 'y' });
    expect(r.score).toBe(0.5); // a type ok (1) + b unknown-key (0)
    expect(JSON.stringify(argValidityFindings(r))).toContain('additional');
  });
});

// --- appropriateness judge ---------------------------------------------------

describe('argument-appropriateness judge', () => {
  beforeEach(() => mockComplete.mockReset());

  it('non-interactive run → unavailable (no LLM call)', async () => {
    const run = mkRun('user-created', [assistant([toolUse('get_x', {})])], { triggeredBy: 'cron' });
    const v = await judgeArgumentAppropriateness(run);
    expect(v.unavailable).toBe(true);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('no tool calls → unavailable', async () => {
    const run = mkRun('user-created', [userText('hi')], { triggeredBy: 'human' });
    const v = await judgeArgumentAppropriateness(run);
    expect(v.unavailable).toBe(true);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('unreliable inputs → unavailable', async () => {
    const run = mkRun('user-created', [userText('hi'), assistant([toolUse('get_x', {})])], { triggeredBy: 'human', inputsReliable: false });
    const v = await judgeArgumentAppropriateness(run);
    expect(v.unavailable).toBe(true);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('interactive run with tool calls → uses the judge verdict', async () => {
    mockComplete.mockResolvedValue({ content: JSON.stringify({ score: 0.9, pass: true, reasoning: 'ok' }) });
    const run = mkRun('user-created', [userText('do x'), assistant([toolUse('get_x', { q: 'y' })])], { triggeredBy: 'human' });
    const v = await judgeArgumentAppropriateness(run);
    expect(v.unavailable).toBeUndefined();
    expect(v.pass).toBe(true);
    expect(v.score).toBe(0.9);
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });
});

// --- scorecard aggregation ---------------------------------------------------

describe('scorecard argument aggregates', () => {
  const metrics: TrajectoryMetrics = {
    toolCorrectness: null, stepEfficiency: 1, toolCallCount: 0, redundantCallCount: 0,
    loopDetected: false, costUsd: null, latencyMs: null, inputTokens: 0, outputTokens: 0, perStep: [],
  };
  function mkEval(over: Partial<EvaluatedRun>): EvaluatedRun {
    return {
      ref: { agentKind: 'user-created', tenantId: 't', agentId: 'a', key: 'k' },
      runtime: 'tenant-runtime',
      findings: [],
      metrics,
      gating: false,
      ...over,
    };
  }

  it('avgArgValidity averages non-null scores; argAppropriatenessRate ignores unavailable', () => {
    const runs = [
      mkEval({ argValidity: { score: 1, perCall: [], coverageNotes: [] }, argJudge: { score: 0.9, pass: true, reasoning: '' } }),
      mkEval({ argValidity: { score: 0.5, perCall: [], coverageNotes: [] }, argJudge: { score: 0, pass: false, reasoning: '', unavailable: true } }),
      mkEval({ argValidity: { score: null, perCall: [], coverageNotes: [] }, argJudge: { score: 0.2, pass: false, reasoning: '' } }),
    ];
    const sc = buildScorecard('user-created', 't', 'a', runs, '2026-06-24T00:00:00.000Z');
    expect(sc.avgArgValidity).toBe(0.75); // mean of 1 and 0.5 (null skipped)
    expect(sc.argAppropriatenessRate).toBe(0.5); // 1 pass / 2 available (unavailable skipped)
  });

  it('null when nothing scoreable', () => {
    const sc = buildScorecard('hrbp', 't', 'a', [mkEval({})], '2026-06-24T00:00:00.000Z');
    expect(sc.avgArgValidity).toBeNull();
    expect(sc.argAppropriatenessRate).toBeNull();
  });
});

// --- calibration -------------------------------------------------------------

describe('calibrate — arg_appropriateness dimension', () => {
  beforeEach(() => mockComplete.mockReset());

  it('computes κ for the new arg_appropriateness dimension', async () => {
    mockComplete.mockResolvedValue({ content: JSON.stringify({ score: 0.9, pass: true, reasoning: 'ok' }) });
    const labeled = [
      { agentKind: 'user-created' as const, tenantId: 't', agentId: 'a', key: 'k1', argAppropriatenessPass: true },
      { agentKind: 'user-created' as const, tenantId: 't', agentId: 'a', key: 'k2', argAppropriatenessPass: false },
    ];
    const reconstruct = async () =>
      mkRun('user-created', [userText('do x'), assistant([toolUse('get_x', { q: 'y' })])], { triggeredBy: 'human' });
    const results = await calibrateJudges(labeled, reconstruct);
    const arg = results.find((r) => r.dimension === 'arg_appropriateness');
    expect(arg).toBeDefined();
    expect(arg!.n).toBe(2);
  });
});

// --- taxonomy / clustering ---------------------------------------------------

describe('arg-validity clustering (taxonomy)', () => {
  it('warn findings normalize to TRAIL-exec.invalid_tool_args and cluster distinctly (not unknown)', () => {
    const run = mkRun('caio', [assistant([toolUse('agent_templates__get', {})])]); // missing required → warn
    const findings = argValidityFindings(scoreArgValidity(run));
    const warn = findings.find((f) => f.invariant === 'critic.arg_validity');
    expect(warn).toBeDefined();
    expect(normalizeFailureMode(warn!.failureMode)).toBe('TRAIL-exec.invalid_tool_args');

    const evaluated: EvaluatedRun = {
      ref: { agentKind: 'caio', tenantId: 't', agentId: 'a', key: 'k' },
      runtime: 'workforce-service',
      findings,
      metrics: { toolCorrectness: null, stepEfficiency: 1, toolCallCount: 0, redundantCallCount: 0, loopDetected: false, costUsd: null, latencyMs: null, inputTokens: 0, outputTokens: 0, perStep: [] },
      gating: false,
    };
    const clusters = clusterFailures([evaluated]);
    expect(clusters.some((c) => c.failureMode === 'TRAIL-exec.invalid_tool_args')).toBe(true);
    expect(clusters.some((c) => c.failureMode === 'unknown')).toBe(false);
  });
});
