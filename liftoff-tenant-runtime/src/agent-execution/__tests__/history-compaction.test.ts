// Compaction for the engines whose conversation history the platform holds.
//
// The behaviours that matter are the ones that are silent when they go wrong: a
// compaction that fires when the semantic pass did not happen (and hands the run
// ten fragments as its past), one that orphans a tool result the retained tail
// still answers, one that summarizes away the objective the run was given, and
// one that quietly drops the oldest turns.

import type { PlatformMessage } from '../adapter/types';
import type { ConversationMessage } from '../types';
import { truncateForPrompt } from '../engine/truncate-for-prompt';
import {
  COMPACTION_SUMMARY_HEADER,
  CONTEXT_PRESSURE_RATIOS,
  windowCharsForProvider,
} from '../context-pressure';

jest.mock('../engine/compress-for-prompt', () => ({
  compressForPrompt: jest.fn(),
  semanticCompressionEnabled: jest.fn(() => true),
}));

const { compressForPrompt, semanticCompressionEnabled } = require('../engine/compress-for-prompt') as {
  compressForPrompt: jest.Mock;
  semanticCompressionEnabled: jest.Mock;
};

import {
  compactConversation,
  historyCompactionEnabled,
  retentionBudgetChars,
  summaryBudgetChars,
} from '../history-compaction';

const WINDOW_CHARS = windowCharsForProvider('openai');

function userTurn(text: string): ConversationMessage {
  return { role: 'user', content: text };
}

function assistantTurn(text: string): ConversationMessage {
  return { role: 'assistant', content: text };
}

/** A conversation heavy enough that retention has to leave something behind. */
function longHistory(n: number, filler = 'x'.repeat(4_000)): ConversationMessage[] {
  return Array.from({ length: n }, (_, i) =>
    i % 2 === 0 ? userTurn(`turn ${i} ${filler}`) : assistantTurn(`reply ${i} ${filler}`));
}

const attribution = { tenantId: 't1', agentId: 'a1', invocationId: 'i1' };

/** The semantic pass succeeding: anything that is NOT the deterministic bound. */
function semanticSummary(summary = 'Earlier turns established the plan and ran the build.'): void {
  compressForPrompt.mockResolvedValue(summary);
}

describe('the flag', () => {
  afterEach(() => { delete process.env.HISTORY_COMPACTION_ENABLED; });

  it('is off unless set to exactly 1', () => {
    expect(historyCompactionEnabled()).toBe(false);
    process.env.HISTORY_COMPACTION_ENABLED = 'true';
    expect(historyCompactionEnabled()).toBe(false);
    process.env.HISTORY_COMPACTION_ENABLED = '1';
    expect(historyCompactionEnabled()).toBe(true);
  });

  it('does nothing at all while it is off', async () => {
    semanticSummary();
    const result = await compactConversation({
      rebuilt: [], history: longHistory(200), windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).toBeNull();
    expect(compressForPrompt).not.toHaveBeenCalled();
  });
});

describe('the budgets', () => {
  it('aim at the line context-pressure already calibrated, not a fresh fraction', () => {
    expect(retentionBudgetChars(WINDOW_CHARS))
      .toBe(Math.floor(WINDOW_CHARS * CONTEXT_PRESSURE_RATIOS.PRESSURE_RATIO));
  });

  it('reserve a summary that scales with the window and is bounded at both ends', () => {
    expect(summaryBudgetChars(200_000)).toBeGreaterThan(summaryBudgetChars(100_000));
    expect(summaryBudgetChars(1_000)).toBe(4_000);
    expect(summaryBudgetChars(100_000_000)).toBe(20_000);
  });
});

describe('compactConversation', () => {
  beforeEach(() => {
    process.env.HISTORY_COMPACTION_ENABLED = '1';
    compressForPrompt.mockReset();
    semanticCompressionEnabled.mockReturnValue(true);
  });
  afterEach(() => {
    delete process.env.HISTORY_COMPACTION_ENABLED;
    delete process.env.HISTORY_COMPACT_RETAIN;
  });

  it('declines when the summarizer it depends on is switched off, before spending anything', async () => {
    semanticCompressionEnabled.mockReturnValue(false);
    const result = await compactConversation({
      rebuilt: [], history: longHistory(200), windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).toBeNull();
    expect(compressForPrompt).not.toHaveBeenCalled();
  });

  it('leaves a conversation that fits the retention budget alone', async () => {
    semanticSummary();
    const result = await compactConversation({
      rebuilt: [], history: longHistory(6), windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).toBeNull();
    expect(compressForPrompt).not.toHaveBeenCalled();
  });

  it('retains what fits the budget, whatever the message count', async () => {
    semanticSummary();
    // Deliberately NOT a fixed count: these messages are large, so far fewer than
    // twenty fit. A count-based retention would have kept twenty of them and left
    // the conversation over the line it was compacting to get under.
    const history = longHistory(200);
    const result = await compactConversation({
      rebuilt: [], history, windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).not.toBeNull();
    expect(result!.afterChars).toBeLessThanOrEqual(retentionBudgetChars(WINDOW_CHARS));
    expect(result!.afterChars).toBeLessThan(result!.beforeChars);
    // The most recent turns survive untouched.
    expect(result!.history[result!.history.length - 1]).toEqual(history[history.length - 1]);
  });

  it('keeps the run objective verbatim rather than summarizing the task away', async () => {
    semanticSummary();
    const objective = userTurn('Reconcile the July invoices');
    const history = [objective, ...longHistory(200).map((m) => ({ ...m, role: 'assistant' as const }))];
    const result = await compactConversation({
      rebuilt: [], history, windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).not.toBeNull();
    // Summary first, then the objective it did not touch, then the tail.
    expect(result!.history[0].content).toContain(COMPACTION_SUMMARY_HEADER);
    expect(result!.history[1]).toEqual(objective);
    // And it is not counted as summarized, because it was not.
    expect(result!.history.filter((m) => m.content === objective.content)).toHaveLength(1);
  });

  it('says in the summary itself that the run did not restart and the workspace stands', async () => {
    semanticSummary();
    const result = await compactConversation({
      rebuilt: [], history: longHistory(200), windowChars: WINDOW_CHARS, attribution,
    });
    const summary = result!.history[0].content;
    expect(summary).toMatch(/has not restarted/i);
    expect(summary).toMatch(/workspace/i);
    expect(summary).toMatch(/shell or Node sessions/i);
    // Product voice: no contractions in text an agent may echo.
    expect(summary).not.toMatch(/\w'(s|t|re|ll|ve|d)\b/);
  });

  it('declines when the semantic pass did not happen, rather than compacting to the deterministic bound', async () => {
    // compressForPrompt returns exactly truncateForPrompt(value, budget) on every
    // path where the LLM pass did not run. Compacting on that would hand the run
    // ten 200-character fragments as its entire past.
    compressForPrompt.mockImplementation(async (value: unknown, opts: { maxChars: number }) =>
      truncateForPrompt(value, opts.maxChars));
    const result = await compactConversation({
      rebuilt: [], history: longHistory(200), windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).toBeNull();
  });

  it('leaves the run exactly as it was when the summarizer throws', async () => {
    compressForPrompt.mockRejectedValue(new Error('provider down'));
    const result = await compactConversation({
      rebuilt: [], history: longHistory(200), windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).toBeNull();
  });

  it('never returns a conversation larger than the one it was given', async () => {
    semanticSummary('S'.repeat(3_000));
    process.env.HISTORY_COMPACT_RETAIN = '2';
    const result = await compactConversation({
      rebuilt: [], history: [userTurn('a'), assistantTurn('b'), userTurn('c'), assistantTurn('d'), assistantTurn('e')],
      windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).toBeNull();
  });

  it('survives a history message whose content is not the string its type promises', async () => {
    semanticSummary();
    const history = longHistory(200);
    // The caller serializes non-string content before sending it, and
    // estimateHistoryChars carries the same tolerance. Trusting the type here
    // would throw on the slice and silently disable compaction for that run.
    (history[0] as unknown as { content: unknown }).content = { structured: 'payload' };
    const result = await compactConversation({
      rebuilt: [], history, windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).not.toBeNull();
  });

  // ── The chunked fold ──────────────────────────────────────────────────

  it('folds an oversized head in chronological passes rather than cutting it off', async () => {
    let pass = 0;
    compressForPrompt.mockImplementation(async () => `summary after pass ${++pass}`);
    // Each rendered message is capped at 2,000 chars and the input cap is
    // 15x a 20,000-char budget, so ~150 messages fill one pass.
    const result = await compactConversation({
      rebuilt: [], history: longHistory(600), windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).not.toBeNull();
    expect(result!.summaryPasses).toBeGreaterThan(1);
    expect(result!.droppedMessages).toBe(0);
    // Each pass after the first is shown the summary so far, so the oldest turns
    // reach the final summary through it.
    const secondCall = compressForPrompt.mock.calls[1][0] as Array<{ role: string }>;
    expect(secondCall[0].role).toBe('summary-so-far');
  });

  it('names the oldest turns when even the chunked fold cannot reach them', async () => {
    semanticSummary();
    // Far past four passes of the input cap.
    const result = await compactConversation({
      rebuilt: [], history: longHistory(4_000), windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).not.toBeNull();
    expect(result!.droppedMessages).toBeGreaterThan(0);
    expect(result!.summaryPasses).toBe(4);
    expect(result!.history[0].content).toMatch(
      new RegExp(`oldest ${result!.droppedMessages} turns predate this record`));
  });
});

describe('the rebuilt cross-engine half', () => {
  beforeEach(() => {
    process.env.HISTORY_COMPACTION_ENABLED = '1';
    compressForPrompt.mockReset();
    semanticCompressionEnabled.mockReturnValue(true);
    semanticSummary();
  });
  afterEach(() => {
    delete process.env.HISTORY_COMPACTION_ENABLED;
    delete process.env.HISTORY_COMPACT_RETAIN;
  });

  function rebuiltText(text: string, role: PlatformMessage['role'] = 'user'): PlatformMessage {
    return { role, content: [{ type: 'text', text }] };
  }

  it('summarizes the rebuilt history away when this run alone fills the retained tail', async () => {
    const rebuilt = Array.from({ length: 20 }, (_, i) => rebuiltText(`prior ${i} ${'z'.repeat(6_000)}`));
    // This run's own conversation already exceeds the retention budget, so the
    // split falls inside it and nothing rebuilt can be retained.
    const history = longHistory(120);
    const result = await compactConversation({
      rebuilt, history, windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).not.toBeNull();
    // Nothing rebuilt survives, so the summary leads this run's own history and
    // the two arrays still concatenate in conversation order.
    expect(result!.rebuilt).toEqual([]);
    expect(result!.history[0].content).toContain(COMPACTION_SUMMARY_HEADER);
    expect(result!.history[result!.history.length - 1]).toEqual(history[history.length - 1]);
  });

  it('keeps the summary ahead of the rebuilt turns it retained', async () => {
    process.env.HISTORY_COMPACT_RETAIN = '10';
    const rebuilt = Array.from({ length: 60 }, (_, i) => rebuiltText(`prior ${i} ${'z'.repeat(9_000)}`));
    const result = await compactConversation({
      rebuilt, history: [], windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).not.toBeNull();
    expect(result!.rebuilt).toHaveLength(11);
    expect(result!.rebuilt[0].content[0]).toMatchObject({ type: 'text' });
    expect(result!.rebuilt.slice(1)).toEqual(rebuilt.slice(-10));
    expect(result!.history).toEqual([]);
  });

  it('never orphans a tool result the retained tail still answers', async () => {
    process.env.HISTORY_COMPACT_RETAIN = '2';
    const bulk = 'z'.repeat(9_000);
    // The call is opened four messages from the end and answered two from the
    // end, so a naive split would summarize the tool_use and keep its result.
    const rebuilt: PlatformMessage[] = [
      rebuiltText(`older one ${bulk}`),
      rebuiltText(`older two ${bulk}`),
      { role: 'assistant', content: [{ type: 'tool_use', toolName: 'file_read', args: { path: 'a' }, callId: 'call-1' }] },
      rebuiltText('between'),
      { role: 'user', content: [{ type: 'tool_result', callId: 'call-1', result: 'contents' }] },
      rebuiltText('newest'),
    ];
    const result = await compactConversation({
      rebuilt, history: [], windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).not.toBeNull();
    // The split moved back to include the tool_use, so the pair is intact.
    expect(result!.rebuilt.slice(1)).toEqual(rebuilt.slice(2));
    expect(result!.summarizedMessages).toBe(2);
  });

  it('declines rather than compacting when every message is held by a tool pair', async () => {
    process.env.HISTORY_COMPACT_RETAIN = '1';
    const rebuilt: PlatformMessage[] = [
      { role: 'assistant', content: [{ type: 'tool_use', toolName: 'file_read', args: {}, callId: 'c1' }] },
      { role: 'user', content: [{ type: 'tool_result', callId: 'c1', result: 'x' }] },
      { role: 'assistant', content: [{ type: 'tool_use', toolName: 'file_read', args: {}, callId: 'c2' }] },
      { role: 'user', content: [{ type: 'tool_result', callId: 'c2', result: 'y' }] },
      { role: 'assistant', content: [{ type: 'tool_use', toolName: 'file_read', args: {}, callId: 'c3' }] },
      { role: 'user', content: [{ type: 'tool_result', callId: 'c3', result: 'z' }] },
    ];
    // Every result answers a call one message back, so the split walks to zero.
    const chained: PlatformMessage[] = rebuilt.map((m, i) =>
      i % 2 === 1 ? m : { ...m, content: [{ type: 'tool_use', toolName: 't', args: {}, callId: `c${Math.floor(i / 2) + 1}` }] });
    const result = await compactConversation({
      rebuilt: chained, history: [], windowChars: WINDOW_CHARS, attribution,
    });
    expect(result).toBeNull();
  });
});
