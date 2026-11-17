// The bind rung: the deterministic exact/alias rebind (no `ask`, no
// distill_runs row, one log line), the fuzzy candidates that go to Jev
// (prefix, distance, argument fit, one-to-five), what makes the rung skip,
// and the umbrella kill. The loop half — bind before patch, fields updated as
// by patch, patch on what remains — is distill-bind-loop.test.ts.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../typesafe/client', () => ({ ask: jest.fn() }));

import type { WorkflowStep } from '@liftoffos/shared-types';
import {
  bindCandidatesFor,
  bindWorkflowSteps,
  damerauLevenshtein,
  normaliseToolName,
  argumentsFit,
} from '../distill-bind';
import type { ToolCatalog, ValidationError } from '../distill-service';
import { ask } from '../../typesafe/client';
import { log } from '../../infrastructure/logging';

const mockAsk = ask as jest.Mock;
const mockLog = log as unknown as { info: jest.Mock };

const schema = (props: string[], required: string[] = []) => ({
  type: 'object',
  properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])),
  required,
});

const catalog: ToolCatalog = new Map([
  ['gmail-1a2b__send_email', { name: 'gmail-1a2b__send_email', description: 'Send an email', input_schema: schema(['to', 'body'], ['to']) }],
  ['gmail-1a2b__send_emails', { name: 'gmail-1a2b__send_emails', description: 'Send several emails', input_schema: schema(['to', 'body'], ['to']) }],
  ['gmail-1a2b__list_threads', { name: 'gmail-1a2b__list_threads', description: 'List threads', input_schema: schema(['q']) }],
  ['gmail-1a2b__reply_to_thread', { name: 'gmail-1a2b__reply_to_thread', description: 'Reply', input_schema: schema(['thread_id', 'body'], ['thread_id']), vendorToolName: 'GMAIL_REPLY_TO_THREAD' }],
  ['slack-9f9f__send_email', { name: 'slack-9f9f__send_email', description: 'Other connector', input_schema: schema(['to']) }],
  ['find_teammates', { name: 'find_teammates', description: 'builtin', input_schema: schema([]) }],
]);

const step = (o: Partial<WorkflowStep> & { stepId: string }): WorkflowStep =>
  ({ description: 'd', type: 'tool_call', ...o }) as WorkflowStep;
const unknownTool = (stepId: string): ValidationError => ({ type: 'unknown_tool', stepId, detail: 'x', field: 'toolName' });

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DISTILL_BIND_ENABLED;
});

describe('normalisation and distance', () => {
  it('folds case and separators', () => {
    expect(normaliseToolName('Gmail-1a2b__Send.Email')).toBe('gmail_1a2b_send_email');
  });
  it('is restricted Damerau-Levenshtein, bounded', () => {
    expect(damerauLevenshtein('send_email', 'send_emial')).toBe(1);
    expect(damerauLevenshtein('send_email', 'send_emails')).toBe(1);
    // The names differ everywhere: a distance far over the bound.
    expect(damerauLevenshtein('send_email', 'list_threads')).toBeGreaterThan(2);
    // Three characters longer than the bound admits: the bound plus one,
    // without a full computation.
    expect(damerauLevenshtein('send_email', 'send_email_now')).toBe(3);
    expect(damerauLevenshtein('send_email', 'send_mial')).toBe(2);
    expect(damerauLevenshtein('abcd', 'abdc')).toBe(1);
  });
});

describe('argumentsFit', () => {
  it('a template and an object through tokenize / coerce / restore', () => {
    expect(argumentsFit(step({ stepId: 's', toolInputTemplate: '{"to":"{{input.to}}"}' }), schema(['to'], ['to']))).toBe(true);
    expect(argumentsFit(step({ stepId: 's', toolInput: { to: 'a' } }), schema(['to'], ['to']))).toBe(true);
    expect(argumentsFit(step({ stepId: 's', toolInput: { subject: 'a' } }), schema(['to'], ['to']))).toBe(false);
    expect(argumentsFit(step({ stepId: 's' }), schema(['to'], ['to']))).toBe(false);
    expect(argumentsFit(step({ stepId: 's' }), schema(['to']))).toBe(true);
  });

  it('a placeholder in a field the schema types as a number is a fit, as the distiller\'s own gate treats it', () => {
    // The shape of most steps that read an earlier one. Judged on the
    // tokenised form the sentinel reads as a string in a number field, and
    // the rung would never offer such a step a candidate.
    const numbered = {
      type: 'object',
      properties: { owner: { type: 'string' }, issue_number: { type: 'number' }, labels: { type: 'array', items: { type: 'string' } } },
      required: ['owner', 'issue_number'],
    };
    expect(argumentsFit(step({ stepId: 's', toolInputTemplate: '{"owner":"octo-org","issue_number":"{{steps.s1.number}}","labels":["needs-triage"]}' }), numbered)).toBe(true);
    // A bare placeholder too.
    expect(argumentsFit(step({ stepId: 's', toolInputTemplate: '{"owner":"octo-org","issue_number":{{steps.s1.number}}}' }), numbered)).toBe(true);
    // A genuine mismatch beside a placeholder is still not a fit: a key the
    // schema does not define. (A lone string where an array is expected is a
    // coercion the distiller performs itself, so it fits.)
    expect(argumentsFit(step({ stepId: 's', toolInputTemplate: '{"owner":"octo-org","issue_number":"{{steps.s1.number}}","colour":"red"}' }), numbered)).toBe(false);
    // And a literal that cannot be a number is not a fit.
    expect(argumentsFit(step({ stepId: 's', toolInputTemplate: '{"owner":"octo-org","issue_number":"soon"}' }), numbered)).toBe(false);
  });
});

describe('bindCandidatesFor — the deterministic branch', () => {
  it('an exact match after normalisation, with fitting arguments, rebinds by exact', () => {
    const steps = [step({ stepId: 's1', toolName: 'Gmail-1a2b__Send-Email', toolInput: { to: 'x' } })];
    expect(bindCandidatesFor([unknownTool('s1')], steps, catalog)).toEqual([
      { stepId: 's1', from: 'Gmail-1a2b__Send-Email', deterministic: { to: 'gmail-1a2b__send_email', by: 'exact' }, fuzzy: [] },
    ]);
  });

  it('the explicit alias the catalog declares rebinds by alias', () => {
    const steps = [step({ stepId: 's1', toolName: 'gmail_reply_to_thread', toolInput: { thread_id: 't' } })];
    expect(bindCandidatesFor([unknownTool('s1')], steps, catalog)?.[0].deterministic).toEqual({ to: 'gmail-1a2b__reply_to_thread', by: 'alias' });
  });

  it('an exact match whose arguments do not fit is not rebound deterministically', () => {
    const steps = [step({ stepId: 's1', toolName: 'GMAIL-1A2B__SEND_EMAIL', toolInput: { subject: 'x' } })];
    const plan = bindCandidatesFor([unknownTool('s1')], steps, catalog);
    // No deterministic binding, and the fuzzy candidates all fail argument fit → the rung skips.
    expect(plan).toBeNull();
  });

  it('a unique fuzzy match is NOT a deterministic rebind: it goes to Jev', () => {
    // send_emial: one edit from send_email; send_emails is two edits (i→a swap + s) → still within 2
    const steps = [step({ stepId: 's1', toolName: 'gmail-1a2b__send_emial', toolInput: { to: 'x' } })];
    const plan = bindCandidatesFor([unknownTool('s1')], steps, catalog)!;
    expect(plan[0].deterministic).toBeUndefined();
    expect(plan[0].fuzzy.map((c) => c.key).sort()).toEqual(['gmail-1a2b__send_email', 'gmail-1a2b__send_emails']);
  });
});

describe('bindCandidatesFor — the fuzzy candidates', () => {
  it('same connector prefix only, within distance 2, arguments fit', () => {
    const steps = [step({ stepId: 's1', toolName: 'gmail-1a2b__send_emal', toolInput: { to: 'x' } })];
    const keys = bindCandidatesFor([unknownTool('s1')], steps, catalog)![0].fuzzy.map((c) => c.key);
    expect(keys).toContain('gmail-1a2b__send_email');
    expect(keys).not.toContain('slack-9f9f__send_email');
    expect(keys).not.toContain('gmail-1a2b__list_threads');
  });

  it('zero candidates, or more than five, skips the rung', () => {
    const steps = [step({ stepId: 's1', toolName: 'gmail-1a2b__zzzzzzzzz', toolInput: { to: 'x' } })];
    expect(bindCandidatesFor([unknownTool('s1')], steps, catalog)).toBeNull();
    const wide: ToolCatalog = new Map(
      Array.from({ length: 6 }, (_, i) => [`c__tool${i}`, { name: `c__tool${i}`, description: 'd', input_schema: schema(['to']) }]),
    );
    expect(bindCandidatesFor([unknownTool('s1')], [step({ stepId: 's1', toolName: 'c__tool', toolInput: { to: 'x' } })], wide)).toBeNull();
  });

  it('any non-bindable error → no pass', () => {
    const steps = [step({ stepId: 's1', toolName: 'Gmail-1a2b__Send_Email', toolInput: { to: 'x' } })];
    expect(bindCandidatesFor([unknownTool('s1'), { type: 'broken_reference', stepId: 's1', detail: 'x', field: 'onSuccess' }], steps, catalog)).toBeNull();
  });

  it('an undispatchable key is never a candidate or an exact target', () => {
    const steps = [step({ stepId: 's1', toolName: 'Find_Teammates' })];
    expect(bindCandidatesFor([unknownTool('s1')], steps, catalog, { isUndispatchable: (k) => k === 'find_teammates' })).toBeNull();
  });
});

describe('bindWorkflowSteps', () => {
  const base = { tenantId: 't1', runId: 'r1', attempt: 1 };

  it('the deterministic branch rebinds with no ask, no call record, and the log line', async () => {
    const steps = [step({ stepId: 's1', toolName: 'Gmail-1a2b__Send_Email', toolInput: { to: 'x' } })];
    const plan = bindCandidatesFor([unknownTool('s1')], steps, catalog)!;
    const r = await bindWorkflowSteps({ ...base, steps, errors: [unknownTool('s1')], candidates: plan });
    expect(r.applied).toBe(true);
    expect(r.calls).toEqual([]);
    expect(r.steps[0].toolName).toBe('gmail-1a2b__send_email');
    expect(mockAsk).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'distill.rebind', runId: 'r1', attempt: 1, stepId: 's1', from: 'Gmail-1a2b__Send_Email', to: 'gmail-1a2b__send_email', by: 'exact' }),
      expect.any(String),
    );
  });

  it('fuzzy candidates go to ask; a confident choice rebinds and the call is recorded with provider and model', async () => {
    const steps = [step({ stepId: 's1', toolName: 'gmail-1a2b__send_emial', toolInput: { to: 'x' } })];
    const plan = bindCandidatesFor([unknownTool('s1')], steps, catalog)!;
    mockAsk.mockResolvedValueOnce({
      answers: { binding: { type: 'choice', choice: 'gmail-1a2b__send_email', confidence: 1, probabilities: { 'gmail-1a2b__send_email': 0.9, 'gmail-1a2b__send_emails': 0.08, none: 0.02 } } },
      model: 'jev-1.13.0', usage: { inputTokens: 500, outputTokens: 0 }, callId: 'c', attempts: 1, latencyMs: 100,
    });
    const r = await bindWorkflowSteps({ ...base, steps, errors: [unknownTool('s1')], candidates: plan });
    expect(r.applied).toBe(true);
    expect(r.steps[0].toolName).toBe('gmail-1a2b__send_email');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ provider: 'typesafe', model: 'jev-1.13.0', usage: { inputTokens: 500, outputTokens: 0 } });
    expect(mockAsk).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'distill_bind' }),
      expect.objectContaining({ step: expect.objectContaining({ toolName: 'gmail-1a2b__send_emial' }) }),
      expect.objectContaining({ purpose: 'distill_bind', tenantId: 't1', deadlineMs: 3_000, attemptTimeoutMs: 2_000, maxRetries: 1 }),
    );
  });

  it('none or a sub-threshold choice changes nothing; a null ask records an unavailable call', async () => {
    const steps = [step({ stepId: 's1', toolName: 'gmail-1a2b__send_emial', toolInput: { to: 'x' } })];
    const plan = bindCandidatesFor([unknownTool('s1')], steps, catalog)!;
    mockAsk.mockResolvedValueOnce({
      answers: { binding: { type: 'choice', choice: 'none', confidence: 1, probabilities: { 'gmail-1a2b__send_email': 0.1, 'gmail-1a2b__send_emails': 0.1, none: 0.8 } } },
      model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 0 }, callId: 'c', attempts: 1, latencyMs: 1,
    });
    let r = await bindWorkflowSteps({ ...base, steps, errors: [unknownTool('s1')], candidates: plan });
    expect(r.applied).toBe(false);
    expect(r.steps).toBe(steps);

    mockAsk.mockResolvedValueOnce({
      answers: { binding: { type: 'choice', choice: 'gmail-1a2b__send_email', confidence: 0.5, probabilities: { 'gmail-1a2b__send_email': 0.45, 'gmail-1a2b__send_emails': 0.4, none: 0.15 } } },
      model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 0 }, callId: 'c', attempts: 1, latencyMs: 1,
    });
    r = await bindWorkflowSteps({ ...base, steps, errors: [unknownTool('s1')], candidates: plan });
    expect(r.applied).toBe(false);

    mockAsk.mockResolvedValueOnce(null);
    r = await bindWorkflowSteps({ ...base, steps, errors: [unknownTool('s1')], candidates: plan });
    expect(r.applied).toBe(false);
    expect(r.calls[0].error).toBe('unavailable');
  });

  it('the umbrella kill disables both branches', async () => {
    process.env.DISTILL_BIND_ENABLED = '0';
    const steps = [step({ stepId: 's1', toolName: 'Gmail-1a2b__Send_Email', toolInput: { to: 'x' } })];
    const plan = bindCandidatesFor([unknownTool('s1')], steps, catalog)!;
    const r = await bindWorkflowSteps({ ...base, steps, errors: [unknownTool('s1')], candidates: plan });
    expect(r.applied).toBe(false);
    expect(r.rejectedReason).toBe('disabled');
    expect(mockAsk).not.toHaveBeenCalled();
  });
});
