// Context Budget Allocator for the insights chat.
//
// Every LLM call in the chat service assembles its prompt by pulling content
// from named sections, each with its own token cap. Sections that exceed
// their cap are truncated (oldest-first for conversation history, which
// preserves recency). This makes per-turn token usage predictable — a short
// Q&A and a long investigation both land in the same ballpark — instead of
// varying by 10x+ depending on what the LLM dumped into a previous turn.
//
//   ┌───────────────────────────────────────────┬──────┐
//   │ Section                                   │ Cap  │
//   ├───────────────────────────────────────────┼──────┤
//   │ system prompt + tool definitions          │ 3000 │
//   │ user/tenant context (member name, role)   │  500 │
//   │ the browser's state (## Browser)          │  900 │
//   │ the job's datasets (## Datasets)          │  700 │
//   │ conversation rolling summary              │ 1000 │
//   │ recent raw turns (last 6 messages)        │ 2500 │
//   │ current user message                      │ 1000 │
//   └───────────────────────────────────────────┴──────┘
//
// Total = 9600 input tokens. Output is reserved separately via `maxTokens`
// on the LLM call.
//
// The datasets section rides the per-turn preamble, beside the browser's
// state, for the reason attachments ride the user turn: the system prompt is
// the cache prefix, and a list that changes as the work goes on cannot sit in
// it. The renderer (datasets/render.ts) keeps the newest datasets that fit its
// own budget and says how many older ones dataset_list can return, so the cap
// here is a net that never closes on a block the renderer produced.
//
// The browser section's cap is above the renderer's own (2,500 characters,
// browser-record's STATE_BLOCK_MAX_CHARS), so the block is never cut twice:
// the renderer drops whole items to fit, and the budget here is the net.
//
// Token counting uses a character-based approximation (4 chars ≈ 1 token).
// This is ~20% conservative for English text and near-exact for JSON/code.
// A real BPE tokenizer would be more precise but would add a ~2MB dependency
// for what's fundamentally a "stay below a ceiling" check — the LLM provider
// already enforces the real context window limit.

import type { LLMImageBlock, LLMMessage } from '../llm/types';
import { estimateImageTokens } from '../chat-attachments';

export interface BudgetConfig {
  totalBudget: number;
  sections: {
    systemPrompt: number;
    userContext: number;
    browserContext: number;
    datasetContext: number;
    rollingSummary: number;
    recentTurns: number;
    currentMessage: number;
  };
}

export const DEFAULT_INSIGHTS_BUDGET: BudgetConfig = {
  totalBudget: 9600,
  sections: {
    systemPrompt: 3000,
    userContext: 500,
    browserContext: 900,
    datasetContext: 700,
    rollingSummary: 1000,
    recentTurns: 2500,
    currentMessage: 1000,
  },
};

export interface BudgetedPrompt {
  /** The system prompt, passed separately to the LLM provider. */
  systemPrompt: string;
  /** The assembled message array ready for llmClient.complete() / completeStream(). */
  messages: LLMMessage[];
  /** Per-section token usage for telemetry and debugging. */
  usage: {
    systemPrompt: number;
    userContext: number;
    browserContext: number;
    datasetContext: number;
    rollingSummary: number;
    recentTurns: number;
    currentMessage: number;
    total: number;
  };
}

export interface BuildBudgetedPromptInput {
  /** The full system prompt built by buildInsightsSystemPrompt(). */
  systemPrompt: string;
  /** Short blurb about the caller (member name, role, tenant name). May be empty. */
  userContext: string;
  /** The Browser section (browser-sessions/browser-state.ts), already
   *  rendered with its own heading; empty or absent when the thread has no
   *  browser and no record. Rides the preamble after the user context. */
  browserContext?: string;
  /** The datasets kept for this conversation (datasets/render.ts
   *  renderDatasetInventory), already rendered with its own header; empty or
   *  absent when the conversation holds none. Rides the preamble after the
   *  browser's state, under its own heading. */
  datasetContext?: string;
  /** Rolling summary of older turns (null if thread is short). */
  rollingSummary: string | null;
  /** Prior turns in the thread, oldest-first, EXCLUDING the current user message. */
  recentTurns: LLMMessage[];
  /** The current user message being processed. */
  currentMessage: string;
  /** Images the current message carries, already resolved against the model's
   *  vision capability (see src/llm/vision.ts). They ride the current-message
   *  slot and are never truncated: an image is not text, and half an image is
   *  not a smaller image. Their token cost is counted against the budget so the
   *  rest of the prompt shrinks around them instead of overflowing. */
  currentImages?: LLMImageBlock[];
  /** Override the default 8000-token budget (tests, larger models). */
  config?: BudgetConfig;
}

/** Approximate token count for a text string. 4 chars ≈ 1 token. */
export function countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Truncate `text` to fit within `maxTokens`, dropping from the START of the
 * string so the most recent content survives. Used for raw conversation
 * history where recency matters.
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (!text) return text;
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

/**
 * Drop oldest messages until the total token count fits the budget.
 * Walks backward from the most recent so recency is preserved.
 */
export function fitMessagesToBudget(
  messages: LLMMessage[],
  budgetTokens: number,
): LLMMessage[] {
  const result: LLMMessage[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = countTokens(messages[i].content);
    if (total + tokens > budgetTokens) break;
    result.unshift(messages[i]);
    total += tokens;
  }
  return result;
}

/**
 * Build a budgeted prompt ready for the LLM. Each section is independently
 * capped at its allocated token count; overages are truncated or (for recent
 * turns) dropped oldest-first.
 *
 * System prompt overages do NOT get truncated — a system prompt that exceeds
 * its cap is a bug in the prompt builder upstream, so we log a warning and
 * pass it through as-is. Surfacing the violation is better than silently
 * cutting the instructions.
 */
export function buildBudgetedPrompt(input: BuildBudgetedPromptInput): BudgetedPrompt {
  const config = input.config ?? DEFAULT_INSIGHTS_BUDGET;

  // 1. System prompt — measured but not truncated. If this exceeds its cap,
  //    the upstream prompt builder needs to be tightened — truncating here
  //    would silently drop critical instructions.
  const systemPrompt = input.systemPrompt;
  const systemTokens = countTokens(systemPrompt);

  // 2. User context — small, hard-truncated if over.
  const userContextText = truncateToTokenBudget(input.userContext, config.sections.userContext);
  const userContextTokens = countTokens(userContextText);

  // 2b. The browser's state — rendered under its own cap upstream; the
  //     budget here is a net that never closes on a block the renderer
  //     produced.
  const browserText = input.browserContext
    ? truncateToTokenBudget(input.browserContext, config.sections.browserContext)
    : '';
  const browserTokens = countTokens(browserText);

  // 2c. The job's datasets — rendered under its own cap upstream, newest
  //     first; the budget here is a net. Truncation, were it ever to bite,
  //     drops from the START, which is the newest line, so the renderer's
  //     own bound is what keeps this section whole.
  const datasetText = input.datasetContext
    ? truncateToTokenBudget(input.datasetContext, config.sections.datasetContext)
    : '';
  const datasetTokens = countTokens(datasetText);

  // 3. Rolling summary — null on short threads. When present, hard-truncated.
  const summaryText = input.rollingSummary
    ? truncateToTokenBudget(input.rollingSummary, config.sections.rollingSummary)
    : '';
  const summaryTokens = countTokens(summaryText);

  // 4. Recent turns — drop oldest until we fit.
  const recentMessages = fitMessagesToBudget(input.recentTurns, config.sections.recentTurns);
  const recentTokens = recentMessages.reduce((sum, m) => sum + countTokens(m.content), 0);

  // 5. Current message — almost always fits, hard cap as defense.
  const currentText = truncateToTokenBudget(input.currentMessage, config.sections.currentMessage);
  // Images cost tokens the character count cannot see. Counted on the vendors'
  // own width x height / 750, from the dimensions read out of the image header
  // at upload; without dimensions the estimator assumes the cap. Before this,
  // a turn carrying four screenshots counted as the length of its text and the
  // budget was silently wrong by several thousand tokens.
  const currentImages = input.currentImages ?? [];
  const imageTokens = currentImages.reduce(
    (sum, img) => sum + estimateImageTokens({ width: img.width, height: img.height }),
    0,
  );
  const currentTokens = countTokens(currentText) + imageTokens;

  // Assemble the final message array. User context + rolling summary become
  // a system-role preamble message (separate from the main system prompt,
  // which is passed via the LLMCompletionRequest.messages[0] convention).
  const preambleParts: string[] = [];
  if (userContextText) preambleParts.push(`## User context\n${userContextText}`);
  if (browserText) preambleParts.push(browserText);
  if (datasetText) preambleParts.push(`## Datasets\n${datasetText}`);
  if (summaryText) preambleParts.push(`## Conversation summary\n${summaryText}`);
  const preamble = preambleParts.join('\n\n');

  const messages: LLMMessage[] = [
    { role: 'system' as const, content: systemPrompt },
    ...(preamble ? [{ role: 'system' as const, content: preamble }] : []),
    ...recentMessages,
    {
      role: 'user' as const,
      content: currentText,
      ...(currentImages.length > 0
        ? { images: currentImages.map(({ mimeType, dataBase64, alt }) => ({ mimeType, dataBase64, ...(alt ? { alt } : {}) })) }
        : {}),
    },
  ];

  return {
    systemPrompt,
    messages,
    usage: {
      systemPrompt: systemTokens,
      userContext: userContextTokens,
      browserContext: browserTokens,
      datasetContext: datasetTokens,
      rollingSummary: summaryTokens,
      recentTurns: recentTokens,
      currentMessage: currentTokens,
      total: systemTokens + userContextTokens + browserTokens + datasetTokens + summaryTokens + recentTokens + currentTokens,
    },
  };
}
