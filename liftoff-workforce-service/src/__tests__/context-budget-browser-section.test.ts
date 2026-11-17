// The Browser section in the Chief AI Officer's budgeted prompt: its own
// 900-token section, above the renderer's cap so a block platform-backend
// rendered is never cut twice, placed in the preamble after the user context
// and before the plan state, counted in the usage, and absent at no cost
// when the thread has no browser.

import { renderBrowserStateBlock, STATE_BLOCK_MAX_CHARS } from '@liftoffos/browser-record';
import { buildBudgetedCAIOPrompt, countTokens, DEFAULT_CAIO_BUDGET } from '../workforce-plans/context-budget.js';

const baseInput = {
  systemPrompt: 'You are the Chief AI Officer.',
  userContext: 'Caller: Ada (owner)',
  planStateText: '## Current plan\nA plan.',
  rollingSummary: 'Earlier they asked about a team.',
  recentTurns: [],
  currentMessage: 'What is on the page?',
};
const block = '## Browser\n\nObserved from the browser and its record.\n\nThe browser beside this conversation is open on https://a.example/.';

describe('the Browser section', () => {
  it('has its own section of 900 tokens, above the renderer\'s cap, and the total grew by it', () => {
    expect(DEFAULT_CAIO_BUDGET.sections.browserContext).toBe(900);
    expect(DEFAULT_CAIO_BUDGET.sections.browserContext * 4).toBeGreaterThan(STATE_BLOCK_MAX_CHARS);
    const others = DEFAULT_CAIO_BUDGET.sections.systemPrompt + DEFAULT_CAIO_BUDGET.sections.userContext
      + DEFAULT_CAIO_BUDGET.sections.datasetContext
      + DEFAULT_CAIO_BUDGET.sections.planState + DEFAULT_CAIO_BUDGET.sections.rollingSummary + DEFAULT_CAIO_BUDGET.sections.recentTurns
      + DEFAULT_CAIO_BUDGET.sections.currentMessage;
    expect(DEFAULT_CAIO_BUDGET.totalBudget).toBe(others + DEFAULT_CAIO_BUDGET.sections.browserContext);
  });

  it('rides the preamble after the user context and before the plan state and the summary, and is counted', () => {
    const result = buildBudgetedCAIOPrompt({ ...baseInput, browserContext: block });
    const preamble = result.messages[0].content as string;
    expect(preamble.indexOf('## User context')).toBeLessThan(preamble.indexOf('## Browser'));
    expect(preamble.indexOf('## Browser')).toBeLessThan(preamble.indexOf('## Current plan'));
    expect(preamble.indexOf('## Current plan')).toBeLessThan(preamble.indexOf('## Conversation summary'));
    expect(result.usage.browserContext).toBe(countTokens(block));
    expect(result.usage.total).toBe(
      result.usage.systemPrompt + result.usage.userContext + result.usage.browserContext
      + result.usage.planState + result.usage.rollingSummary + result.usage.recentTurns + result.usage.currentMessage,
    );
  });

  it('is absent and costs nothing when the thread has no browser', () => {
    const result = buildBudgetedCAIOPrompt({ ...baseInput, browserContext: '' });
    expect(result.messages[0].content as string).not.toContain('## Browser');
    expect(result.usage.browserContext).toBe(0);
    expect(buildBudgetedCAIOPrompt(baseInput).usage.browserContext).toBe(0);
  });

  it('a block at the renderer\'s cap survives whole: the budget never cuts twice', () => {
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
    const result = buildBudgetedCAIOPrompt({ ...baseInput, browserContext: rendered });
    expect(result.messages[0].content as string).toContain(rendered);
  });
});

describe('the Datasets section', () => {
  it('has its own 700-token section, rides the preamble after the browser and before the plan state, and is counted', () => {
    expect(DEFAULT_CAIO_BUDGET.sections.datasetContext).toBe(700);
    const inventory = 'Datasets kept for this conversation. Read them with dataset_query.\n- id "posts" — 100 records; fields title (text)';
    const result = buildBudgetedCAIOPrompt({
      systemPrompt: '', userContext: 'Caller: Ada (owner)', browserContext: block, datasetContext: inventory,
      planStateText: '## Plan\nA plan.', rollingSummary: null, recentTurns: [], currentMessage: 'go on',
    });
    const preamble = String(result.messages[0].content);
    expect(preamble).toContain('## Datasets\n' + inventory);
    expect(preamble.indexOf('## Browser')).toBeLessThan(preamble.indexOf('## Datasets'));
    expect(preamble.indexOf('## Datasets')).toBeLessThan(preamble.indexOf('## Plan'));
    expect(result.usage.datasetContext).toBe(countTokens(inventory));
    const without = buildBudgetedCAIOPrompt({
      systemPrompt: '', userContext: 'Caller: Ada (owner)', planStateText: null, rollingSummary: null, recentTurns: [], currentMessage: 'go on',
    });
    expect(without.messages.map((m) => String(m.content)).join('\n')).not.toContain('## Datasets');
    expect(without.usage.datasetContext).toBe(0);
  });
});
