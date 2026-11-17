// The rolling summary reaches a model, and cannot fail a turn getting there.
//
// The defect these pin: `agent_chat_threads.rolling_summary` was regenerated
// after every qualifying turn (10+ messages, then every 5), billed as platform
// overhead, and read by exactly one caller — its own summarizer, to seed the
// next summary of itself. The thread built a summary that never reached the
// model. Wiring it is what makes that spend buy something.
//
// Two properties matter and neither is about the happy path: the summary must
// be BUDGETED before it goes on the wire (the runtime rejects an over-long one
// at its request schema, so an unbounded value fails the turn rather than
// degrading it), and a summary that cannot be read must not break chat.

import { truncateToTokenBudget } from '../../insights/context-budget';
import { formatSummaryForPrompt } from '../../insights/conversation-summarization';
import type { ConversationSummary } from '../../insights/types';

// Must equal ROLLING_SUMMARY_PROMPT_TOKEN_BUDGET in chat-service.ts and stay
// at or under the runtime's `conversationSummary: z.string().max(8000)` bound.
const BUDGET_TOKENS = 1000;
const RUNTIME_MAX_CHARS = 8000;

function summaryOfSize(itemCount: number, itemChars: number): ConversationSummary {
  const item = 'x'.repeat(itemChars);
  return {
    userIntent: item,
    keyFacts: Array.from({ length: itemCount }, () => item),
    openQuestions: Array.from({ length: itemCount }, () => item),
    previousFindings: Array.from({ length: itemCount }, () => item),
    nextSteps: Array.from({ length: itemCount }, () => item),
    summarizedThrough: new Date().toISOString(),
  };
}

describe('rolling summary on the wire', () => {
  it('fits inside the runtime request bound even when the summary is huge', () => {
    // The generator caps its OUTPUT tokens, which is a different module's
    // constant. Depending on it would let a change there decide whether chat
    // works. This is the property that must hold regardless.
    const enormous = summaryOfSize(50, 500); // ~100k chars before budgeting
    const formatted = formatSummaryForPrompt(enormous);
    expect(formatted.length).toBeGreaterThan(RUNTIME_MAX_CHARS);

    const budgeted = truncateToTokenBudget(formatted, BUDGET_TOKENS);
    expect(budgeted.length).toBeLessThanOrEqual(RUNTIME_MAX_CHARS);
  });

  it('leaves a normal summary untouched', () => {
    // Budgeting must not quietly truncate the ordinary case.
    const normal = summaryOfSize(3, 80);
    const formatted = formatSummaryForPrompt(normal);
    expect(truncateToTokenBudget(formatted, BUDGET_TOKENS)).toBe(formatted);
  });

  it('keeps the most recent end when it does truncate', () => {
    // A rolling summary's tail is its current state; dropping the tail would
    // hand the model the stalest part of the thread.
    const long = summaryOfSize(50, 500);
    const formatted = formatSummaryForPrompt(long);
    const budgeted = truncateToTokenBudget(formatted, BUDGET_TOKENS);
    expect(formatted.endsWith(budgeted)).toBe(true);
  });

  it('formats a summary into prose the model can read as background', () => {
    const s = summaryOfSize(1, 10);
    const formatted = formatSummaryForPrompt(s);
    expect(formatted).toContain('User intent:');
    expect(formatted.length).toBeGreaterThan(0);
  });
});
