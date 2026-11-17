// The ask check (ask-check.ts): its entry conditions, what each confident
// answer does and only that, the once-per-fingerprint continuation, and the
// bounds and sanitisation on what it sends.

const mockAsk = jest.fn();
jest.mock('../../../typesafe/client', () => ({ ask: (...a: unknown[]) => mockAsk(...a) }));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  checkAsk,
  askCheckState,
  markContinued,
  wasContinued,
  SELF_ANSWER_HINTS,
  _resetContinuationsForTesting,
  type AskCheckInput,
} from '../ask-check';
import { ASK_INPUTS_MAX_CHARS, ASK_RECENT_RESULTS_MAX_CHARS, ASK_STEP_OUTPUTS_MAX_CHARS } from '../../../typesafe/questions';

type Head = { choice: string; confidence: number; probabilities: Record<string, number> };
function reply(a: { answerable?: [string, number]; canAct?: [string, number]; source?: string }) {
  const head = (choice: string, p: number, keys: string[]): Head => ({
    choice, confidence: 0.9,
    probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? p : (1 - p) / (keys.length - 1)])),
  });
  return {
    answers: {
      answerable_from_context: head(a.answerable?.[0] ?? 'unclear', a.answerable?.[1] ?? 0.5, ['yes', 'no', 'unclear']),
      person_can_act: head(a.canAct?.[0] ?? 'unclear', a.canAct?.[1] ?? 0.5, ['yes', 'no', 'unclear']),
      answer_source: head(a.source ?? 'none', 0.9, ['inputs', 'step_output', 'instructions', 'none']),
    },
    model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 0 }, callId: 'c1', attempts: 1, latencyMs: 3,
  };
}

const question = (over: Partial<AskCheckInput> = {}): AskCheckInput => ({
  ask: { kind: 'question', text: 'Which sheet should I write the summary to?' },
  contract: { kind: 'instructions', instructions: 'Write the weekly summary to the Sales sheet.', role: 'You are the Sales Ops assistant.' },
  known: { inputs: { sheet: 'Sales Q3' }, recentToolResults: [], stepOutputs: null },
  setting: 'important',
  origin: 'question',
  source: 'recovery_llm',
  fingerprint: 'ask_user:s2:tool_error',
  tenantId: 't1',
  agentId: 'ra-1',
  invocationId: 'inv-1',
  ...over,
});
const escalation = (over: Partial<AskCheckInput> = {}): AskCheckInput => ({
  ask: { kind: 'escalation', text: 'The provider returned 529 three times.', requestedAction: 'Retry later', whoCanUnblock: 'customer' },
  known: { inputs: {}, recentToolResults: [{ error: '529 overloaded' }], stepOutputs: null },
  setting: 'important',
  escalationKind: 'escalation',
  source: 'recovery_llm',
  fingerprint: 'recovery_decision:s2:tool_error',
  tenantId: 't1',
  agentId: 'ra-1',
  invocationId: 'inv-1',
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TR_ASK_CHECK_ENABLED;
  _resetContinuationsForTesting();
  mockAsk.mockResolvedValue(reply({}));
});

describe('entry conditions', () => {
  it('a blocker → no call', async () => {
    expect(await checkAsk(question({ origin: 'blocker' }))).toEqual({ kind: 'unchanged' });
    expect(mockAsk).not.toHaveBeenCalled();
  });
  it('a system_internal escalation → no call', async () => {
    expect(await checkAsk(escalation({ escalationKind: 'system_internal' }))).toEqual({ kind: 'unchanged' });
    expect(mockAsk).not.toHaveBeenCalled();
  });
  it('an anchor_intervention clarification → no call', async () => {
    expect(await checkAsk(question({ source: 'anchor_intervention' }))).toEqual({ kind: 'unchanged' });
    expect(mockAsk).not.toHaveBeenCalled();
  });
  it('the kill → no call', async () => {
    process.env.TR_ASK_CHECK_ENABLED = '0';
    expect(await checkAsk(question())).toEqual({ kind: 'unchanged' });
    expect(mockAsk).not.toHaveBeenCalled();
  });
});

describe('a question the run can answer itself', () => {
  it('yes above threshold with a source → the continuation, with the fixed hint for that source', async () => {
    mockAsk.mockResolvedValue(reply({ answerable: ['yes', 0.93], source: 'inputs' }));
    expect(await checkAsk(question())).toEqual({ kind: 'self_answer', source: 'inputs', hint: SELF_ANSWER_HINTS.inputs, p: 0.93 });
    mockAsk.mockResolvedValue(reply({ answerable: ['yes', 0.85], source: 'step_output' }));
    expect(await checkAsk(question({ fingerprint: 'f2' }))).toMatchObject({ kind: 'self_answer', source: 'step_output', hint: SELF_ANSWER_HINTS.step_output });
    mockAsk.mockResolvedValue(reply({ answerable: ['yes', 0.85], source: 'instructions' }));
    expect(await checkAsk(question({ fingerprint: 'f3' }))).toMatchObject({ kind: 'self_answer', source: 'instructions', hint: SELF_ANSWER_HINTS.instructions });
    // The hint names where, never what.
    expect(SELF_ANSWER_HINTS.inputs).not.toContain('Sales Q3');
  });

  it('yes with source = none → parks (unchanged)', async () => {
    mockAsk.mockResolvedValue(reply({ answerable: ['yes', 0.95], source: 'none' }));
    expect(await checkAsk(question())).toEqual({ kind: 'unchanged' });
  });

  it('yes below SELF_ANSWER_T, no, unclear, and null → unchanged', async () => {
    for (const a of [
      reply({ answerable: ['yes', 0.79], source: 'inputs' }),
      reply({ answerable: ['no', 0.9], source: 'inputs' }),
      reply({ answerable: ['unclear', 0.6], source: 'inputs' }),
      null,
    ]) {
      mockAsk.mockResolvedValue(a);
      expect(await checkAsk(question())).toEqual({ kind: 'unchanged' });
    }
  });

  it('a second ask on the same fingerprint parks as today: no call', async () => {
    mockAsk.mockResolvedValue(reply({ answerable: ['yes', 0.95], source: 'inputs' }));
    expect(await checkAsk(question())).toMatchObject({ kind: 'self_answer' });
    markContinued('inv-1', 'ask_user:s2:tool_error');
    expect(wasContinued('inv-1', 'ask_user:s2:tool_error')).toBe(true);
    expect(await checkAsk(question())).toEqual({ kind: 'unchanged' });
    expect(mockAsk).toHaveBeenCalledTimes(1);
    // Another invocation is its own record.
    expect(await checkAsk(question({ invocationId: 'inv-2' }))).toMatchObject({ kind: 'self_answer' });
  });

  it('a question never reads person_can_act', async () => {
    mockAsk.mockResolvedValue(reply({ answerable: ['no', 0.9], canAct: ['no', 0.99] }));
    expect(await checkAsk(question())).toEqual({ kind: 'unchanged' });
  });
});

describe('an escalation nobody in the workspace can act on', () => {
  it('person_can_act = no above NOT_ACTIONABLE_T → not actionable, with the probability', async () => {
    mockAsk.mockResolvedValue(reply({ canAct: ['no', 0.91] }));
    expect(await checkAsk(escalation())).toEqual({ kind: 'not_actionable', p: 0.91 });
  });

  it('no below threshold, yes, unclear, and null → unchanged', async () => {
    for (const a of [reply({ canAct: ['no', 0.79] }), reply({ canAct: ['yes', 0.95] }), reply({ canAct: ['unclear', 0.7] }), null]) {
      mockAsk.mockResolvedValue(a);
      expect(await checkAsk(escalation())).toEqual({ kind: 'unchanged' });
    }
  });

  it('an escalation never reads answerable_from_context', async () => {
    mockAsk.mockResolvedValue(reply({ answerable: ['yes', 0.99], source: 'inputs', canAct: ['yes', 0.9] }));
    expect(await checkAsk(escalation())).toEqual({ kind: 'unchanged' });
  });
});

describe('the state', () => {
  it('carries the ask, the contract, the known context and the setting; bounded and sanitised', async () => {
    const input = question({
      ask: { kind: 'question', text: 'x'.repeat(3_000) },
      known: {
        inputs: { api_key: 'plain-secret', note: 'n'.repeat(3_000) },
        recentToolResults: [{ result: 'r'.repeat(5_000) }],
        stepOutputs: { header: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789', v: 's'.repeat(3_000) },
      },
      setting: 'exceptions',
    });
    const state = askCheckState(input) as { ask: { text: string }; known: Record<string, string>; setting: string; contract: unknown };
    expect(state.ask.text).toHaveLength(ASK_INPUTS_MAX_CHARS);
    expect(state.known.inputs.length).toBeLessThanOrEqual(ASK_INPUTS_MAX_CHARS);
    expect(state.known.recentToolResults.length).toBeLessThanOrEqual(ASK_RECENT_RESULTS_MAX_CHARS);
    expect(state.known.stepOutputs.length).toBeLessThanOrEqual(ASK_STEP_OUTPUTS_MAX_CHARS);
    expect(state.known.inputs).not.toContain('plain-secret');
    expect(state.known.stepOutputs).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(state.setting).toBe('exceptions');
    expect(state.contract).toEqual(input.contract);
    await checkAsk(input);
    const [set, sent, opts] = mockAsk.mock.calls[0] as [{ id: string; thresholds: Record<string, number> }, unknown, Record<string, unknown>];
    expect(set.id).toBe('ask_check');
    expect(set.thresholds).toEqual({ SELF_ANSWER_T: 0.8, NOT_ACTIONABLE_T: 0.8 });
    expect(sent).toEqual(state);
    expect(opts).toEqual({ deadlineMs: 30_000, tenantId: 't1', runtimeAgentId: 'ra-1', invocationId: 'inv-1' });
  });
});
