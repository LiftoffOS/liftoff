// Admission and kind at the agent's own save (memory-admit.ts, wired in
// standard-tool-handler.ts): refuse only on a confident task_state /
// already_in_instructions with the model-visible reason; every other admit
// saves; kind, facet and classification set only above threshold and never
// when unclear; a confident facet overrides the supplied one; supersedes
// retires the neighbour under the new row; contradicts keeps both with the
// tag; a declared-step save never asks; null and the kill are today's save.

const mockAsk = jest.fn();
jest.mock('../../typesafe/client', () => ({ ask: (...a: unknown[]) => mockAsk(...a) }));
const mockSaveMemory = jest.fn();
const mockSupersede = jest.fn();
const mockScored = jest.fn();
jest.mock('../service', () => ({
  memoryService: {
    saveMemory: (...a: unknown[]) => mockSaveMemory(...a),
    supersedeMemory: (...a: unknown[]) => mockSupersede(...a),
    findRecentSimilarMemoriesWithNeighbours: (...a: unknown[]) => mockScored(...a),
    retrieveMemories: jest.fn().mockResolvedValue([]),
    resolveRoleScopeKey: jest.fn().mockResolvedValue('role-1'),
  },
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../usage-ledger/service', () => ({ usageLedgerService: { recordUsage: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../../infrastructure/database', () => ({ getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }), getPoolForService: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }) }));

import { admitMemory, REFUSAL_MESSAGES } from '../memory-admit';
import { executeStandardTool, type StandardToolContext } from '../../tools/standard-tool-handler';

type Head = { choice: string; confidence: number; probabilities: Record<string, number> };
const head = (choice: string, p: number): Head => ({ choice, confidence: 0.9, probabilities: { [choice]: p } });
function reply(a: { admit?: [string, number]; kind?: [string, number]; facet?: [string, number]; classification?: [string, number]; relations?: Array<[string, number]> }) {
  const answers: Record<string, Head> = {
    admit: head(a.admit?.[0] ?? 'durable_knowledge', a.admit?.[1] ?? 0.9),
    kind: head(a.kind?.[0] ?? 'unclear', a.kind?.[1] ?? 0.5),
    facet: head(a.facet?.[0] ?? 'none', a.facet?.[1] ?? 0.5),
    classification: head(a.classification?.[0] ?? 'unclear', a.classification?.[1] ?? 0.5),
  };
  (a.relations ?? []).forEach(([c, p], i) => { answers[`relation_${i}`] = head(c, p); });
  return { answers, model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 0 }, callId: 'k', attempts: 1, latencyMs: 1 };
}

const ctx: StandardToolContext = {
  tenantId: 't1', agentId: 'ra-1', traceId: 'tr', invocationId: 'inv-1',
  memoryScope: { writableLayers: ['individual', 'conversation'], readableLayers: ['individual'], scopeKeys: ['sk'] },
  contract: { kind: 'instructions', instructions: 'Reconcile invoices weekly.', role: 'You are Sales Ops.' },
};
const save = (payload: Record<string, unknown>, c: StandardToolContext = ctx) => executeStandardTool('memory_save', payload, c);

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TR_MEMORY_ADMIT_ENABLED;
  mockAsk.mockResolvedValue(reply({}));
  mockSaveMemory.mockResolvedValue({ memoryId: 'mem-new', deduplicated: false });
  mockSupersede.mockResolvedValue('mem-new');
  mockScored.mockResolvedValue({ similar: [], neighbours: [{ id: 'n1', cosine: 0.8, content: 'Prefers short answers.' }, { id: 'n2', cosine: 0.6, content: 'Works 9 to 5 CET.' }] });
});

describe('the verdict', () => {
  const base = { content: 'The CRM export drops rows with an empty region.', layer: 'individual', requestedTags: [], neighbours: [{ id: 'n1', content: 'x' }], tenantId: 't1', agentId: 'ra-1' };

  it('refuses only on a confident task_state or already_in_instructions', async () => {
    mockAsk.mockResolvedValue(reply({ admit: ['task_state', 0.85] }));
    expect((await admitMemory(base))?.refuse).toEqual({ reason: 'task_state', message: REFUSAL_MESSAGES.task_state, p: 0.85 });
    mockAsk.mockResolvedValue(reply({ admit: ['already_in_instructions', 0.8] }));
    expect((await admitMemory(base))?.refuse).toMatchObject({ reason: 'already_in_instructions' });
    for (const a of [['task_state', 0.79], ['durable_knowledge', 0.99], ['about_a_person', 0.9], ['unclear', 0.9]] as Array<[string, number]>) {
      mockAsk.mockResolvedValue(reply({ admit: a }));
      expect((await admitMemory(base))?.refuse).toBeUndefined();
    }
  });

  it('kind, facet and classification are set only above threshold and never when unclear', async () => {
    mockAsk.mockResolvedValue(reply({ kind: ['fact', 0.7], classification: ['pii', 0.7] }));
    expect(await admitMemory(base)).toMatchObject({ kind: 'fact', classification: 'pii' });
    mockAsk.mockResolvedValue(reply({ kind: ['fact', 0.69], classification: ['pii', 0.69] }));
    let v = await admitMemory(base);
    expect(v?.kind).toBeUndefined();
    expect(v?.classification).toBeUndefined();
    mockAsk.mockResolvedValue(reply({ kind: ['unclear', 0.99], classification: ['unclear', 0.99] }));
    v = await admitMemory(base);
    expect(v?.kind).toBeUndefined();
    expect(v?.classification).toBeUndefined();
    // The facet is read only for a user_model kind or a named person.
    mockAsk.mockResolvedValue(reply({ kind: ['fact', 0.9], facet: ['working_hours', 0.9] }));
    expect((await admitMemory(base))?.facet).toBeUndefined();
    mockAsk.mockResolvedValue(reply({ kind: ['user_model', 0.9], facet: ['working_hours', 0.9] }));
    expect((await admitMemory(base))?.facet).toBe('working_hours');
    mockAsk.mockResolvedValue(reply({ kind: ['user_model', 0.9], facet: ['none', 0.9] }));
    expect((await admitMemory(base))?.facet).toBe('none');
    mockAsk.mockResolvedValue(reply({ facet: ['tooling', 0.9] }));
    expect((await admitMemory({ ...base, aboutPerson: { accountId: 'acc-1', facet: 'role' } }))?.facet).toBe('tooling');
  });

  it('supersedes above SUPERSEDE_T and contradicts at any confidence, per neighbour', async () => {
    const neighbours = [{ id: 'n1', content: 'a' }, { id: 'n2', content: 'b' }, { id: 'n3', content: 'c' }];
    mockAsk.mockResolvedValue(reply({ relations: [['supersedes', 0.85], ['contradicts', 0.6], ['supersedes', 0.79]] }));
    const v = await admitMemory({ ...base, neighbours });
    expect(v?.supersedes).toEqual(['n1']);
    expect(v?.contradicts).toEqual(['n2']);
    const [set, state] = mockAsk.mock.calls[0] as [{ id: string; questions: Record<string, unknown>; thresholds: Record<string, number> }, Record<string, unknown>];
    expect(set.id).toBe('memory_save');
    expect(Object.keys(set.questions)).toEqual(['admit', 'kind', 'facet', 'classification', 'relation_0', 'relation_1', 'relation_2']);
    expect(set.thresholds).toEqual({ ADMIT_REFUSE_T: 0.8, KIND_T: 0.7, CLASS_T: 0.7, SUPERSEDE_T: 0.8 });
    expect(state).toMatchObject({ content: base.content, layer: 'individual', neighbours: [{ neighbour: 0, id: 'n1', content: 'a' }, { neighbour: 1, id: 'n2', content: 'b' }, { neighbour: 2, id: 'n3', content: 'c' }] });
  });

  it('null and the kill are today\'s save', async () => {
    mockAsk.mockResolvedValue(null);
    expect(await admitMemory(base)).toBeNull();
    process.env.TR_MEMORY_ADMIT_ENABLED = '0';
    mockAsk.mockResolvedValue(reply({ admit: ['task_state', 0.99] }));
    expect(await admitMemory(base)).toBeNull();
    expect(mockAsk).toHaveBeenCalledTimes(1);
  });
});

describe('memory_save', () => {
  it('a confident refusal answers the model in the dedup refusal\'s form and saves nothing', async () => {
    mockAsk.mockResolvedValue(reply({ admit: ['task_state', 0.9] }));
    const res = await save({ content: 'The ticket is at step 3 of 5.', layer: 'individual' });
    expect(res).toEqual({ success: false, error: `memory_save rejected: ${REFUSAL_MESSAGES.task_state}` });
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('the kind tag replaces a supplied type: tag that disagrees; the classification is set on the row', async () => {
    mockAsk.mockResolvedValue(reply({ kind: ['fact', 0.9], classification: ['pii', 0.8] }));
    const res = await save({ content: 'Dana Whitfield, dana@acme.test, is the billing contact.', layer: 'individual', tags: ['type:preference', 'billing'] });
    expect(res?.success).toBe(true);
    const opts = mockSaveMemory.mock.calls[0][0] as { tags: string[]; contentClassification?: string };
    expect(opts.tags).toEqual(['agent-initiated', 'billing', 'type:fact']);
    expect(opts.contentClassification).toBe('pii');
  });

  it('unclear keeps the model\'s tag and the default classification', async () => {
    mockAsk.mockResolvedValue(reply({ kind: ['unclear', 0.9], classification: ['unclear', 0.9] }));
    await save({ content: 'x', layer: 'individual', tags: ['type:preference'] });
    const opts = mockSaveMemory.mock.calls[0][0] as { tags: string[]; contentClassification?: string };
    expect(opts.tags).toEqual(['agent-initiated', 'type:preference']);
    expect(opts.contentClassification).toBeUndefined();
  });

  it('a confident facet overrides the supplied one, so supersession keys on it', async () => {
    mockAsk.mockResolvedValue(reply({ kind: ['user_model', 0.9], facet: ['communication_style', 0.9] }));
    await save({ content: 'Priya prefers bullet points.', layer: 'individual', about_person: { account_id: 'acc-1', facet: 'role' } });
    const opts = mockSaveMemory.mock.calls[0][0] as { tags: string[] };
    expect(opts.tags).toContain('facet:communication_style');
    expect(opts.tags).not.toContain('facet:role');
    expect(opts.tags).toContain('subject:acc-1');
    expect(opts.tags).toContain('type:user_model');
  });

  it('supersedes retires the neighbour under the new row; contradicts keeps both with the tag', async () => {
    mockAsk.mockResolvedValue(reply({ relations: [['supersedes', 0.9], ['contradicts', 0.7]] }));
    const res = await save({ content: 'Works 8 to 4 CET now.', layer: 'individual' });
    expect(res?.success).toBe(true);
    expect(mockSupersede).toHaveBeenCalledWith({ memoryId: 'n1', successorId: 'mem-new', reason: expect.any(String) }, 't1');
    const opts = mockSaveMemory.mock.calls[0][0] as { tags: string[] };
    expect(opts.tags).toContain('contradicts:n2');
  });

  it('a declared graph step\'s save never asks', async () => {
    await save({ content: 'Brief sent.', layer: 'individual' }, { ...ctx, declaredStepId: 's4' });
    expect(mockAsk).not.toHaveBeenCalled();
    expect(mockSaveMemory).toHaveBeenCalledTimes(1);
  });

  it('null → today\'s save; the kill → today\'s save', async () => {
    mockAsk.mockResolvedValue(null);
    expect((await save({ content: 'x', layer: 'individual', tags: ['type:alias'] }))?.success).toBe(true);
    expect((mockSaveMemory.mock.calls[0][0] as { tags: string[] }).tags).toEqual(['agent-initiated', 'type:alias']);
    process.env.TR_MEMORY_ADMIT_ENABLED = '0';
    mockAsk.mockResolvedValue(reply({ admit: ['task_state', 0.99] }));
    expect((await save({ content: 'y', layer: 'individual' }))?.success).toBe(true);
  });

  it('the state carries the contract, the requested tags and the neighbours from the same query as the dedup guard', async () => {
    await save({ content: 'x', layer: 'individual', tags: ['t1'] });
    expect(mockScored).toHaveBeenCalledWith(expect.objectContaining({ cosineThreshold: 0.92, neighbours: 3 }));
    const [, state, opts] = mockAsk.mock.calls[0] as [unknown, Record<string, unknown>, Record<string, unknown>];
    expect(state.contract).toEqual(ctx.contract);
    expect(state.requestedTags).toEqual(['agent-initiated', 't1']);
    expect(state.neighbours).toEqual([{ neighbour: 0, id: 'n1', content: 'Prefers short answers.' }, { neighbour: 1, id: 'n2', content: 'Works 9 to 5 CET.' }]);
    expect(opts).toEqual({ deadlineMs: 30_000, tenantId: 't1', runtimeAgentId: 'ra-1', invocationId: 'inv-1' });
  });
});

describe('note_save', () => {
  it('is admitted the same way', async () => {
    mockAsk.mockResolvedValue(reply({ admit: ['already_in_instructions', 0.9] }));
    const res = await executeStandardTool('note_save', { content: 'Reconcile invoices weekly.' }, { ...ctx, threadId: 'th-1' });
    expect(res).toEqual({ success: false, error: `memory_save rejected: ${REFUSAL_MESSAGES.already_in_instructions}` });
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });
});

describe('the writers that are records, not judgments', () => {
  it('correction capture and outcome extraction never import the admission check', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    for (const file of ['../../learning/correction-capture.ts', '../../learning/outcome-extractor.ts']) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(src).not.toContain('memory-admit');
      expect(src).not.toContain('admitMemory');
    }
  });
});
