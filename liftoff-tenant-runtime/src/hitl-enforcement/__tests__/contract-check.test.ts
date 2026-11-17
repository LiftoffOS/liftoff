// The contract check (contract-check.ts): the entry conditions, the one
// direction it can change a decision, the state it builds for each contract
// kind, and the bounds and sanitisation on what it sends.

const mockAsk = jest.fn();
jest.mock('../../typesafe/client', () => ({ ask: (...a: unknown[]) => mockAsk(...a) }));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { log } from '../../infrastructure/logging';
import {
  allow,
  boundedArguments,
  boundedContract,
  instructionsContractOf,
  isEligibleCall,
  roleOf,
  stepContractOf,
  _resetNoContractLogForTesting,
  type ContractCheckContext,
  type HitlContract,
} from '../contract-check';
import { CONTRACT_ARGS_MAX_CHARS, CONTRACT_INSTRUCTIONS_MAX_CHARS, CONTRACT_ROLE_MAX_CHARS } from '../../typesafe/questions';
import type { ModelTool, ToolCallRequest } from '../types';

const TOOLS: ModelTool[] = [
  { name: 'github-1__create_pull_request_review_comment', description: '', categories: ['dataChanges'], effect: 'write' },
  { name: 'github-1__pull_request_read', description: '', categories: ['read'], effect: 'read' },
  { name: 'slack-1__send_message', description: '', categories: ['communication'] },
];
const write = (input: Record<string, unknown> = { owner: 'acme', repo: 'webapp', pullNumber: 42, body: 'nit' }): ToolCallRequest =>
  ({ id: 'c1', name: 'github-1__create_pull_request_review_comment', input });
const read = (): ToolCallRequest => ({ id: 'c2', name: 'github-1__pull_request_read', input: { pullNumber: 42 } });
const stepContract: HitlContract = { kind: 'step', stepId: 's7', description: 'Post the review on the pull request that woke the run', toolName: 'github-1__create_pull_request_review_comment' };
const instructionsContract: HitlContract = { kind: 'instructions', instructions: 'Review pull requests on acme/webapp and post findings as review comments.', role: 'You are the Code Reviewer.' };

function ctx(over: Partial<ContractCheckContext> = {}): ContractCheckContext {
  return { toolCalls: [write()], tools: TOOLS, tenantId: 't1', agentId: 'ra-1', invocationId: 'inv-1', contract: stepContract, ...over };
}

function answer(relations: Array<{ choice: 'within' | 'outside' | 'unclear'; outside: number }>) {
  const answers: Record<string, unknown> = {};
  relations.forEach((r, i) => {
    answers[`relation_${i}`] = {
      choice: r.choice, confidence: 0.9,
      probabilities: { within: r.choice === 'within' ? 1 - r.outside : 0, outside: r.outside, unclear: r.choice === 'unclear' ? 1 - r.outside : 0 },
    };
  });
  return { answers, model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 0 }, callId: 'call-1', attempts: 1, latencyMs: 5 };
}

const ALLOW = { shouldGate: false } as const;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TR_CONTRACT_CHECK_ENABLED;
  _resetNoContractLogForTesting();
  mockAsk.mockResolvedValue(answer([{ choice: 'within', outside: 0.05 }]));
});

describe('entry conditions', () => {
  it('a read-only batch makes no request', async () => {
    const out = await allow(ALLOW, ctx({ toolCalls: [read()] }));
    expect(out).toEqual(ALLOW);
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('a decision already going to a person makes no request and is returned as it is', async () => {
    const gated = { shouldGate: true, reason: 'sensitive_work' as const, matchedCategory: 'dataChanges' };
    expect(await allow(gated, ctx())).toBe(gated);
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('the kill makes no request', async () => {
    process.env.TR_CONTRACT_CHECK_ENABLED = '0';
    expect(await allow(ALLOW, ctx())).toEqual(ALLOW);
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('no contract → no request, today\'s decision, and the no_contract line once per invocation', async () => {
    expect(await allow(ALLOW, ctx({ contract: undefined }))).toEqual(ALLOW);
    expect(await allow(ALLOW, ctx({ contract: undefined }))).toEqual(ALLOW);
    expect(mockAsk).not.toHaveBeenCalled();
    const lines = (log.warn as jest.Mock).mock.calls.filter((c) => (c[0] as { event?: string }).event === 'contract_check.no_contract');
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toMatchObject({ invocation_id: 'inv-1', tool_names: ['github-1__create_pull_request_review_comment'] });
    // Another invocation logs again.
    await allow(ALLOW, ctx({ contract: undefined, invocationId: 'inv-2' }));
    expect((log.warn as jest.Mock).mock.calls.filter((c) => (c[0] as { event?: string }).event === 'contract_check.no_contract')).toHaveLength(2);
  });

  it('eligibility: a write, an outbound and an unresolved tool enter; a read, bookkeeping and a self-wake do not', () => {
    expect(isEligibleCall(write(), TOOLS)).toBe(true);
    expect(isEligibleCall({ id: 'x', name: 'slack-1__send_message', input: {} }, TOOLS)).toBe(true);
    expect(isEligibleCall({ id: 'x', name: 'vendor-9__do_thing', input: {} }, TOOLS)).toBe(true);
    expect(isEligibleCall(read(), TOOLS)).toBe(false);
    expect(isEligibleCall({ id: 'x', name: 'record_step_output', input: {} }, TOOLS)).toBe(false);
    expect(isEligibleCall({ id: 'x', name: 'sleep_until', input: {} }, TOOLS)).toBe(false);
  });
});

describe('the one direction', () => {
  it('outside at or above OUTSIDE_T → gated with contract_deviation, the detail and the context set', async () => {
    mockAsk.mockResolvedValue(answer([{ choice: 'outside', outside: 0.91 }]));
    const out = await allow(ALLOW, ctx());
    expect(out).toEqual({
      shouldGate: true,
      reason: 'contract_deviation',
      detail: 'github-1__create_pull_request_review_comment is outside the step s7 (p=0.91)',
      context: { contract_check: { kind: 'step', stepId: 's7', p: 0.91 } },
    });
  });

  it('the instructions contract names "instructions" in the detail and carries no step id', async () => {
    mockAsk.mockResolvedValue(answer([{ choice: 'outside', outside: 0.8 }]));
    const out = await allow(ALLOW, ctx({ contract: instructionsContract }));
    expect(out.detail).toBe('github-1__create_pull_request_review_comment is outside the instructions (p=0.80)');
    expect(out.context).toEqual({ contract_check: { kind: 'instructions', p: 0.8 } });
  });

  it('within, unclear, a sub-threshold outside and null leave the decision exactly as it was', async () => {
    for (const a of [
      answer([{ choice: 'within', outside: 0.1 }]),
      answer([{ choice: 'unclear', outside: 0.3 }]),
      answer([{ choice: 'outside', outside: 0.69 }]),
      null,
    ]) {
      mockAsk.mockResolvedValue(a);
      expect(await allow(ALLOW, ctx())).toEqual(ALLOW);
    }
    expect(mockAsk).toHaveBeenCalledTimes(4);
  });

  it('a mixed batch: one relation head per eligible call, the confident outside names its call, a read is not asked about', async () => {
    const other: ToolCallRequest = { id: 'c3', name: 'slack-1__send_message', input: { channel: 'C1', text: 'hi' } };
    mockAsk.mockResolvedValue(answer([{ choice: 'within', outside: 0.02 }, { choice: 'outside', outside: 0.88 }]));
    const out = await allow(ALLOW, ctx({ toolCalls: [write(), read(), other] }));
    const [set, state] = mockAsk.mock.calls[0] as [{ questions: Record<string, unknown> }, { calls: Array<{ call: number; tool: string }> }];
    expect(Object.keys(set.questions)).toEqual(['relation_0', 'relation_1']);
    expect(state.calls.map((c) => c.tool)).toEqual(['github-1__create_pull_request_review_comment', 'slack-1__send_message']);
    expect(out.reason).toBe('contract_deviation');
    expect(out.detail).toContain('slack-1__send_message');
  });
});

describe('the state', () => {
  it('is built from the step for the workflow path: description, toolName, template, the trigger by identity, the call, the recent names', async () => {
    await allow(ALLOW, ctx({
      contract: { ...stepContract, template: '{"owner":"acme"}' },
      triggerTarget: { source: 'github', repository: 'acme/webapp', number: 42, title: 'never sent', body: 'never sent' } as never,
      recentToolNames: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    }));
    const [set, state, opts] = mockAsk.mock.calls[0] as [{ id: string; thresholds: Record<string, number> }, Record<string, unknown>, Record<string, unknown>];
    expect(set.id).toBe('contract_check');
    expect(set.thresholds.OUTSIDE_T).toBe(0.7);
    expect(state.contract).toEqual({ kind: 'step', stepId: 's7', description: stepContract.kind === 'step' ? stepContract.description : '', toolName: 'github-1__create_pull_request_review_comment', template: '{"owner":"acme"}' });
    expect(state.trigger).toEqual({ source: 'github', entity: { repository: 'acme/webapp', number: '42' } });
    expect(JSON.stringify(state)).not.toContain('never sent');
    expect(state.calls).toEqual([{ call: 0, tool: 'github-1__create_pull_request_review_comment', arguments: JSON.stringify({ owner: 'acme', repo: 'webapp', pullNumber: 42, body: 'nit' }) }]);
    expect(state.recent).toEqual(['c', 'd', 'e', 'f', 'g']);
    expect(opts).toEqual({ deadlineMs: 30_000, tenantId: 't1', runtimeAgentId: 'ra-1', invocationId: 'inv-1' });
  });

  it('is built from the instructions for the adapter path', async () => {
    await allow(ALLOW, ctx({ contract: instructionsContract, invocationId: undefined, agentId: undefined }));
    const [, state, opts] = mockAsk.mock.calls[0] as [unknown, Record<string, unknown>, Record<string, unknown>];
    expect(state.contract).toEqual(instructionsContract);
    expect(state.trigger).toBeNull();
    expect(opts).toEqual({ deadlineMs: 30_000, tenantId: 't1' });
  });
});

describe('bounds and sanitisation', () => {
  it('instructions cut at 6,000 and role at 2,000; a step description at 6,000 and a template at 4,000', () => {
    const long = 'x'.repeat(10_000);
    const i = boundedContract({ kind: 'instructions', instructions: long, role: long });
    expect(i.kind === 'instructions' && i.instructions.length).toBe(CONTRACT_INSTRUCTIONS_MAX_CHARS);
    expect(i.kind === 'instructions' && i.role.length).toBe(CONTRACT_ROLE_MAX_CHARS);
    const s = boundedContract({ kind: 'step', stepId: 's1', description: long, toolName: 't', template: long });
    expect(s.kind === 'step' && s.description.length).toBe(CONTRACT_INSTRUCTIONS_MAX_CHARS);
    expect(s.kind === 'step' && s.template?.length).toBe(CONTRACT_ARGS_MAX_CHARS);
  });

  it('arguments: secrets redacted by key name and by value pattern, long values elided, the whole bounded at 4,000', () => {
    const args = boundedArguments({
      api_key: 'plain-secret-value',
      header: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789',
      body: 'y'.repeat(2_000),
      nested: { key: 'sk-abcdefghijklmnopqrstuvwxyz0123456789' },
    });
    expect(args).not.toContain('plain-secret-value');
    expect(args).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(args).toContain('[1500 more]');
    expect(args.length).toBeLessThanOrEqual(CONTRACT_ARGS_MAX_CHARS);
    expect(boundedArguments(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 'z'.repeat(400)]))).length).toBe(CONTRACT_ARGS_MAX_CHARS);
  });

  it('roleOf takes the role and responsibilities sections when the prompt has headings, else the identity text before the first heading, else the whole prompt', () => {
    expect(roleOf('# Role\nYou are the Reviewer.\n\n## Tools\nUse github.\n\n## Responsibilities\n- review PRs\n')).toBe('# Role\nYou are the Reviewer.\n\n## Responsibilities\n- review PRs');
    expect(roleOf('You are the Reviewer for Acme.\n\n## Tools\nUse github.')).toBe('You are the Reviewer for Acme.');
    expect(roleOf('You are the Reviewer for Acme.')).toBe('You are the Reviewer for Acme.');
  });

  it("roleOf takes instructionsMd's fixed `## Role` section first, then the prompt's role", () => {
    // The distiller writes instructionsMd under fixed H2 headings, `## Role`
    // among them; the system prompt has no fixed headings.
    const md = '## Role\nYou are running as the Reviewer for Acme.\n\n## Tool-use guidance\nCall github first.\n\n## Pitfalls and gotchas\n- none';
    expect(roleOf('You review pull requests.\n\n## Tone\nTerse.', md))
      .toBe('## Role\nYou are running as the Reviewer for Acme.\n\nYou review pull requests.');
    // No `## Role` in the document → the prompt alone, as before.
    expect(roleOf('You review pull requests.', '## Tool-use guidance\nCall github first.')).toBe('You review pull requests.');
    // An empty prompt → the document's role alone.
    expect(roleOf('', md)).toBe('## Role\nYou are running as the Reviewer for Acme.');
    expect(instructionsContractOf({ systemPrompt: '', userInstructions: '', instructionsMd: md }))
      .toEqual({ kind: 'instructions', instructions: '', role: '## Role\nYou are running as the Reviewer for Acme.' });
  });

  it('instructionsContractOf reads the agent record and is undefined when it carries nothing', () => {
    expect(instructionsContractOf({ systemPrompt: 'You are X.\n## Tools\nno', userInstructions: 'Do Y.' })).toEqual({ kind: 'instructions', instructions: 'Do Y.', role: 'You are X.' });
    expect(instructionsContractOf({ systemPrompt: '', userInstructions: null })).toBeUndefined();
    expect(instructionsContractOf(undefined)).toBeUndefined();
  });

  it('stepContractOf carries the declared step, the template only when present', () => {
    expect(stepContractOf({ stepId: 's1', toolName: 't', description: 'd' })).toEqual({ kind: 'step', stepId: 's1', description: 'd', toolName: 't' });
    expect(stepContractOf({ stepId: 's1', toolName: 't', template: '{}' })).toEqual({ kind: 'step', stepId: 's1', description: '', toolName: 't', template: '{}' });
  });
});
