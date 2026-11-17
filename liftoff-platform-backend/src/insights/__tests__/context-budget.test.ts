// Context budget allocator tests
//
// Covers token counting, truncation, message fitting, and the full prompt
// assembly with per-section caps.

import {
  DEFAULT_INSIGHTS_BUDGET,
  buildBudgetedPrompt,
  countTokens,
  fitMessagesToBudget,
  truncateToTokenBudget,
} from '../context-budget';
import type { LLMMessage } from '../../llm/types';
import { renderBrowserStateBlock, STATE_BLOCK_MAX_CHARS } from '@liftoffos/browser-record';

describe('countTokens', () => {
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });

  it('returns Math.ceil(chars / 4)', () => {
    expect(countTokens('abcd')).toBe(1); // 4 chars → 1 token
    expect(countTokens('abcde')).toBe(2); // 5 chars → ceil(5/4) = 2
    expect(countTokens('a'.repeat(400))).toBe(100);
  });

  it('handles unicode as chars (not codepoints)', () => {
    // Simple sanity check — the approximation uses .length so multi-byte
    // chars count as their JS length, which is fine for a budget heuristic.
    expect(countTokens('hello world')).toBe(Math.ceil(11 / 4));
  });
});

describe('truncateToTokenBudget', () => {
  it('returns the original string when under budget', () => {
    expect(truncateToTokenBudget('abc', 10)).toBe('abc');
  });

  it('returns empty string for empty input', () => {
    expect(truncateToTokenBudget('', 10)).toBe('');
  });

  it('drops characters from the START to preserve recency', () => {
    // 40 chars → 10 tokens. Request 5-token budget → 20 chars, keep last 20.
    const text = 'A'.repeat(20) + 'B'.repeat(20);
    const result = truncateToTokenBudget(text, 5);
    expect(result.length).toBe(20);
    expect(result).toBe('B'.repeat(20));
  });

  it('handles zero-token budget by returning empty string', () => {
    expect(truncateToTokenBudget('anything', 0)).toBe('');
  });
});

describe('fitMessagesToBudget', () => {
  const makeMsg = (content: string, role: 'user' | 'assistant' = 'user'): LLMMessage => ({
    role,
    content,
  });

  it('returns all messages when under budget', () => {
    const messages = [makeMsg('hi'), makeMsg('there')];
    expect(fitMessagesToBudget(messages, 1000)).toEqual(messages);
  });

  it('drops oldest messages first (preserves recency)', () => {
    // Each message is 40 chars = 10 tokens. Budget 25 → fits exactly 2 messages.
    const messages = [
      makeMsg('A'.repeat(40), 'user'),
      makeMsg('B'.repeat(40), 'assistant'),
      makeMsg('C'.repeat(40), 'user'),
    ];
    const result = fitMessagesToBudget(messages, 25);
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('B'.repeat(40));
    expect(result[1].content).toBe('C'.repeat(40));
  });

  it('returns empty array when even the newest message is too big', () => {
    const messages = [makeMsg('X'.repeat(400))]; // 100 tokens
    expect(fitMessagesToBudget(messages, 10)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(fitMessagesToBudget([], 1000)).toEqual([]);
  });
});

describe('buildBudgetedPrompt', () => {
  const baseInput = {
    systemPrompt: 'You are Liftoff Insights.',
    userContext: 'Caller: alice (owner)',
    rollingSummary: null as string | null,
    recentTurns: [] as LLMMessage[],
    currentMessage: 'What were my costs last week?',
  };

  it('produces a messages array starting with system prompt', () => {
    const result = buildBudgetedPrompt(baseInput);
    expect(result.messages[0]).toEqual({
      role: 'system',
      content: 'You are Liftoff Insights.',
    });
  });

  it('ends with the current user message', () => {
    const result = buildBudgetedPrompt(baseInput);
    const last = result.messages[result.messages.length - 1];
    expect(last).toEqual({
      role: 'user',
      content: 'What were my costs last week?',
    });
  });

  it('includes a preamble system message when userContext is present', () => {
    const result = buildBudgetedPrompt(baseInput);
    const preamble = result.messages.find(
      m => m.role === 'system' && m.content.includes('User context'),
    );
    expect(preamble).toBeDefined();
    expect(preamble?.content).toContain('Caller: alice (owner)');
  });

  it('omits preamble when both userContext and rollingSummary are empty', () => {
    const result = buildBudgetedPrompt({
      ...baseInput,
      userContext: '',
      rollingSummary: null,
    });
    // Only the system prompt and the user message — no preamble
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[1].role).toBe('user');
  });

  it('includes rolling summary in preamble when present', () => {
    const result = buildBudgetedPrompt({
      ...baseInput,
      rollingSummary: 'User was investigating Q1 cost spike on Salesforce Sync',
    });
    const preamble = result.messages.find(
      m => m.role === 'system' && m.content.includes('Conversation summary'),
    );
    expect(preamble).toBeDefined();
    expect(preamble?.content).toContain('Q1 cost spike');
  });

  it('places recent turns between preamble and current message', () => {
    const recentTurns: LLMMessage[] = [
      { role: 'user', content: 'What about last month?' },
      { role: 'assistant', content: 'Last month total was $3,200.' },
    ];
    const result = buildBudgetedPrompt({ ...baseInput, recentTurns });

    // Find positions
    const userTurnIdx = result.messages.findIndex(m => m.content === 'What about last month?');
    const assistantTurnIdx = result.messages.findIndex(
      m => m.content === 'Last month total was $3,200.',
    );
    const currentIdx = result.messages.findIndex(
      m => m.content === 'What were my costs last week?',
    );

    expect(userTurnIdx).toBeGreaterThan(0);
    expect(assistantTurnIdx).toBe(userTurnIdx + 1);
    expect(currentIdx).toBe(assistantTurnIdx + 1);
  });

  it('drops oldest recent turns when they exceed the recentTurns cap', () => {
    // Each turn is 10_000 chars = 2500 tokens. Default cap is 2500.
    // So only ONE turn should fit.
    const recentTurns: LLMMessage[] = [
      { role: 'user', content: 'A'.repeat(10_000) },
      { role: 'assistant', content: 'B'.repeat(10_000) },
      { role: 'user', content: 'C'.repeat(10_000) },
    ];
    const result = buildBudgetedPrompt({ ...baseInput, recentTurns });

    // Count recent-turn messages (not the system prompt, preamble, or current message)
    const keptTurns = result.messages.filter(m =>
      m.content.startsWith('A') ||
      m.content.startsWith('B') ||
      m.content.startsWith('C'),
    );
    expect(keptTurns).toHaveLength(1);
    // Should be the most recent (C) — oldest dropped first
    expect(keptTurns[0].content.startsWith('C')).toBe(true);
  });

  it('truncates rolling summary from the start when over cap', () => {
    const longSummary = 'X'.repeat(100) + 'KEEP-THIS'.repeat(500);
    const result = buildBudgetedPrompt({
      ...baseInput,
      rollingSummary: longSummary,
      config: {
        ...DEFAULT_INSIGHTS_BUDGET,
        sections: { ...DEFAULT_INSIGHTS_BUDGET.sections, rollingSummary: 100 },
      },
    });
    const preamble = result.messages.find(m => m.content.includes('Conversation summary'));
    // The X's at the start should be gone (truncated), KEEP-THIS should survive
    expect(preamble?.content).toContain('KEEP-THIS');
  });

  it('truncates current user message from the start when over cap', () => {
    const hugeMessage = 'OLDER' + 'Y'.repeat(10_000) + 'ENDING';
    const result = buildBudgetedPrompt({
      ...baseInput,
      currentMessage: hugeMessage,
      config: {
        ...DEFAULT_INSIGHTS_BUDGET,
        sections: { ...DEFAULT_INSIGHTS_BUDGET.sections, currentMessage: 10 },
      },
    });
    const current = result.messages[result.messages.length - 1];
    expect(current.content).toContain('ENDING');
    expect(current.content).not.toContain('OLDER');
  });

  it('reports accurate per-section usage totals', () => {
    const result = buildBudgetedPrompt({
      systemPrompt: 'A'.repeat(40), // 10 tokens
      userContext: 'B'.repeat(20), //  5 tokens
      rollingSummary: 'C'.repeat(80), // 20 tokens
      recentTurns: [
        { role: 'user', content: 'D'.repeat(16) }, // 4 tokens
        { role: 'assistant', content: 'E'.repeat(16) }, // 4 tokens
      ],
      currentMessage: 'F'.repeat(12), // 3 tokens
    });

    expect(result.usage.systemPrompt).toBe(10);
    expect(result.usage.userContext).toBe(5);
    expect(result.usage.rollingSummary).toBe(20);
    expect(result.usage.recentTurns).toBe(8);
    expect(result.usage.currentMessage).toBe(3);
    expect(result.usage.total).toBe(10 + 5 + 20 + 8 + 3);
  });

  it('uses DEFAULT_INSIGHTS_BUDGET when config is omitted', () => {
    const result = buildBudgetedPrompt(baseInput);
    // Total budget is 8000 tokens; this small input should be well under.
    expect(result.usage.total).toBeLessThan(DEFAULT_INSIGHTS_BUDGET.totalBudget);
  });

  it('passes the system prompt through unchanged even when over cap', () => {
    // System prompt cap is 3000 tokens = 12_000 chars. Feed 20_000 chars.
    const huge = 'Z'.repeat(20_000);
    const result = buildBudgetedPrompt({ ...baseInput, systemPrompt: huge });
    // System prompt should be passed through unchanged — upstream bug, not ours to hide
    expect(result.systemPrompt).toBe(huge);
    expect(result.messages[0].content).toBe(huge);
  });
});

describe('the Browser section', () => {
  const baseInput = {
    systemPrompt: 'You are Liftoff.',
    userContext: 'Caller: alice (owner)',
    rollingSummary: 'Earlier they asked about costs.',
    recentTurns: [] as LLMMessage[],
    currentMessage: 'What is on the page?',
  };
  const block = '## Browser\n\nObserved from the browser and its record.\n\nThe browser beside this conversation is open on https://a.example/.';

  it('has its own section of 900 tokens, above the renderer\'s cap, and the totals grew by it', () => {
    expect(DEFAULT_INSIGHTS_BUDGET.sections.browserContext).toBe(900);
    // 8900 with the browser section; 9600 with the datasets section beside it.
    expect(DEFAULT_INSIGHTS_BUDGET.totalBudget).toBe(9600);
    expect(DEFAULT_INSIGHTS_BUDGET.sections.browserContext * 4).toBeGreaterThan(STATE_BLOCK_MAX_CHARS);
  });

  it('rides the preamble after the user context and before the summary, and is counted', () => {
    const result = buildBudgetedPrompt({ ...baseInput, browserContext: block });
    const preamble = result.messages[1].content;
    expect(preamble.indexOf('## User context')).toBe(0);
    expect(preamble.indexOf('## Browser')).toBeGreaterThan(preamble.indexOf('## User context'));
    expect(preamble.indexOf('## Conversation summary')).toBeGreaterThan(preamble.indexOf('## Browser'));
    expect(result.usage.browserContext).toBe(countTokens(block));
    expect(result.usage.total).toBe(
      result.usage.systemPrompt + result.usage.userContext + result.usage.browserContext
      + result.usage.rollingSummary + result.usage.recentTurns + result.usage.currentMessage,
    );
  });

  it('is absent from the preamble and costs nothing when the thread has no browser', () => {
    const result = buildBudgetedPrompt({ ...baseInput, browserContext: '' });
    expect(result.messages[1].content).not.toContain('## Browser');
    expect(result.usage.browserContext).toBe(0);
    expect(buildBudgetedPrompt(baseInput).usage.browserContext).toBe(0);
  });

  it('a block at the renderer\'s cap survives whole: the budget never cuts twice', () => {
    // Enough items that the renderer trims to its cap itself.
    const rendered = renderBrowserStateBlock({
      session: { open: true, url: 'https://a.example/', urlProtectedDataOmitted: false, title: '', wheel: 'assistant', driverName: '' },
      recent: Array.from({ length: 30 }, (_, i) => ({
        at: new Date(Date.UTC(2026, 8, 1, 10, i)).toISOString(),
        call: {
          tool: 'navigate_browser_session', instruction: `https://a.example/page-${i}-${'x'.repeat(60)}`, outcome: `opened https://a.example/page-${i}-${'x'.repeat(60)}`,
          personTookOver: false, steps: null, createdAt: new Date(Date.UTC(2026, 8, 1, 10, i)).toISOString(),
          instructionTruncated: false, outcomeTruncated: false, instructionProtectedDataOmitted: false, outcomeProtectedDataOmitted: false,
          captureGap: false, gapReason: '',
        },
      })),
      sinceLastReply: null,
      intervention: null,
    });
    expect(rendered.length).toBeLessThanOrEqual(STATE_BLOCK_MAX_CHARS);
    expect(rendered.length).toBeGreaterThan(STATE_BLOCK_MAX_CHARS - 600);
    const result = buildBudgetedPrompt({ ...baseInput, browserContext: rendered });
    expect(result.messages[1].content).toContain(rendered);
  });
});

describe('the datasets section', () => {
  it('rides the preamble after the browser section, under its own heading, and counts toward the total', () => {
    const inventory = 'Datasets kept for this conversation. Read them with dataset_query.\n- id "posts" — 100 records; fields title (text)';
    const result = buildBudgetedPrompt({
      systemPrompt: 'SYSTEM', userContext: 'Caller: Ada (owner)', browserContext: '## Browser\n\nOpen on https://a.example/.',
      datasetContext: inventory, rollingSummary: null, recentTurns: [], currentMessage: 'go on',
    });
    const preamble = result.messages[1].content;
    expect(preamble).toContain('## Datasets\n' + inventory);
    expect(preamble.indexOf('## Browser')).toBeLessThan(preamble.indexOf('## Datasets'));
    expect(result.usage.datasetContext).toBe(countTokens(inventory));
    expect(result.usage.total).toBe(
      result.usage.systemPrompt + result.usage.userContext + result.usage.browserContext + result.usage.datasetContext
      + result.usage.rollingSummary + result.usage.recentTurns + result.usage.currentMessage,
    );
    expect(DEFAULT_INSIGHTS_BUDGET.sections.datasetContext).toBe(700);
  });

  it('is absent from the preamble when the conversation holds none', () => {
    const result = buildBudgetedPrompt({
      systemPrompt: 'SYSTEM', userContext: 'Caller: Ada (owner)', rollingSummary: null, recentTurns: [], currentMessage: 'go on',
    });
    expect(result.messages.map((m) => m.content).join('\n')).not.toContain('## Datasets');
    expect(result.usage.datasetContext).toBe(0);
  });
});
