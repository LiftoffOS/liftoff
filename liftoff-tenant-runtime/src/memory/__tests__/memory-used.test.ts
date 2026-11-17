// Usefulness per injected memory (memory-used.ts): the ids above USED_T,
// bounded state, one request per run; null on the kill or no answer, which
// the caller treats as today's path (H1-H3 on success, every injected
// memory on failure). The caller's mapping is pinned from the source.

const mockAsk = jest.fn();
jest.mock('../../typesafe/client', () => ({ ask: (...a: unknown[]) => mockAsk(...a) }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { usedMemories } from '../memory-used';
import { MEMORY_USED_CONTENT_MAX_CHARS, MEMORY_USED_OUTCOME_MAX_CHARS, MEMORY_USED_TRAIL_MAX_CHARS } from '../../typesafe/questions';

const memories = [
  { id: 'm1', content: 'The HubSpot export drops rows with an empty region; filter on region first.' },
  { id: 'm2', content: 'Priya prefers bullet points.' },
  { id: 'm3', content: 'The weekly brief goes to #sales-ops.' },
];
const run = { objective: 'Reconcile last week\'s invoices', toolTrail: [{ name: 'hubspot__list_deals', success: true }], outcomeSummary: 'Reconciled 12 invoices.' };
const reply = (values: number[]) => ({
  answers: Object.fromEntries(values.map((v, i) => [`used_${i}`, { noul: v }])),
  model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 0 }, callId: 'k', attempts: 1, latencyMs: 1,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.TR_MEMORY_USED_ENABLED;
});

describe('usedMemories', () => {
  it('returns the ids at or above USED_T, one Noul per memory', async () => {
    mockAsk.mockResolvedValue(reply([0.9, 0.2, 0.7]));
    expect(await usedMemories({ memories, run, tenantId: 't1', agentId: 'ra-1', invocationId: 'inv-1' })).toEqual(['m1', 'm3']);
    const [set, state, opts] = mockAsk.mock.calls[0] as [{ id: string; questions: Record<string, unknown>; thresholds: Record<string, number> }, Record<string, unknown>, Record<string, unknown>];
    expect(set.id).toBe('memory_used');
    expect(Object.keys(set.questions)).toEqual(['used_0', 'used_1', 'used_2']);
    expect(set.thresholds).toEqual({ USED_T: 0.7 });
    expect(state).toEqual({
      memories: memories.map((m, i) => ({ memory: i, id: m.id, content: m.content })),
      run: { objective: run.objective, toolTrail: JSON.stringify(run.toolTrail), outcomeSummary: run.outcomeSummary },
    });
    expect(opts).toEqual({ deadlineMs: 30_000, tenantId: 't1', runtimeAgentId: 'ra-1', invocationId: 'inv-1' });
  });

  it('a missing answer reads as not used', async () => {
    mockAsk.mockResolvedValue(reply([0.9]));
    expect(await usedMemories({ memories, run, tenantId: 't1' })).toEqual(['m1']);
  });

  it('null and the kill → null (today\'s path); no memories → nothing asked', async () => {
    mockAsk.mockResolvedValue(null);
    expect(await usedMemories({ memories, run, tenantId: 't1' })).toBeNull();
    process.env.TR_MEMORY_USED_ENABLED = '0';
    expect(await usedMemories({ memories, run, tenantId: 't1' })).toBeNull();
    expect(mockAsk).toHaveBeenCalledTimes(1);
    delete process.env.TR_MEMORY_USED_ENABLED;
    expect(await usedMemories({ memories: [], run, tenantId: 't1' })).toEqual([]);
    expect(mockAsk).toHaveBeenCalledTimes(1);
  });

  it('bounds: content 300, trail 4,000, objective and outcome 800', async () => {
    mockAsk.mockResolvedValue(reply([0.9]));
    await usedMemories({
      memories: [{ id: 'm', content: 'c'.repeat(1_000) }],
      run: { objective: 'o'.repeat(2_000), toolTrail: 't'.repeat(10_000), outcomeSummary: 's'.repeat(2_000) },
      tenantId: 't1',
    });
    const state = mockAsk.mock.calls[0][1] as { memories: Array<{ content: string }>; run: { objective: string; toolTrail: string; outcomeSummary: string } };
    expect(state.memories[0].content).toHaveLength(MEMORY_USED_CONTENT_MAX_CHARS);
    expect(state.run.toolTrail).toHaveLength(MEMORY_USED_TRAIL_MAX_CHARS);
    expect(state.run.objective).toHaveLength(MEMORY_USED_OUTCOME_MAX_CHARS);
    expect(state.run.outcomeSummary).toHaveLength(MEMORY_USED_OUTCOME_MAX_CHARS);
  });
});

describe('the caller (agent-execution/service.ts) applies the verdict and keeps today\'s path on null', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'agent-execution', 'service.ts'), 'utf8') as string;
  const site = src.slice(src.indexOf('const jevUsed ='), src.indexOf("'Non-fatal: usefulness tracking failed'"));

  it('success: +1 for the verdict, else H1-H3', () => {
    expect(site).toContain('const usedIds = jevUsed ?? detectUsedMemories(');
    expect(site).toContain('await updateUsefulnessScores(usedIds, 1, 90)');
  });

  it('failure: −1 for the verdict, else every injected memory; cold-start forgiveness unchanged', () => {
    expect(site).toContain("memorySignal === 'negative' && isPastColdStart");
    expect(site).toContain('const punished = jevUsed ?? injectedMemoryIds;');
    expect(site).toContain('updateUsefulnessScores(punished, -1, 90)');
  });

  it('one request per completed run with injected memories, input only', () => {
    expect(site.split('await usedMemories(').length - 1).toBe(1);
    expect(src).toContain('if (injectedMemoryIds.length > 0 && !willContinue)');
  });
});

describe('the chat turn (interactive-chat/chat-turn-handler.ts) asks the same question and keeps today\'s path on null', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'interactive-chat', 'chat-turn-handler.ts'), 'utf8') as string;
  const site = src.slice(src.indexOf("if (chatInjectedMemories.length > 0 && turnOutcome === 'success')"), src.indexOf("'Non-fatal: chat memory usefulness tracking failed'"));

  it('one request per successful turn with injected memories: the person\'s message, the tool trail, the reply', () => {
    expect(site.split('await usedMemories(').length - 1).toBe(1);
    expect(site).toContain('objective: userMessage,');
    expect(site).toContain('outcomeSummary: outputText,');
    expect(site).toContain("toolTrail: completedToolCalls.map((c) => ({ ...(c.name ? { name: c.name } : {}), success: c.success }))");
  });

  it('credits the verdict, else H1-H3; a chat turn never punishes', () => {
    expect(site).toContain('const usedIds = jevUsed ?? detectUsedMemories(');
    expect(site).toContain('await updateUsefulnessScores(usedIds, 1, 90)');
    expect(site).not.toContain('updateUsefulnessScores(punished');
  });
});
