// Context Budget Allocator for the CAIO workforce planning chat.
//
// Cloned from platform-backend src/workforce-plans/context-budget.ts.
// Manages a 10000-token budget across sections so the LLM context stays
// predictable. Each section is independently capped; overages are truncated
// or dropped oldest-first. System prompt overages are passed through as-is
// — silently truncating critical instructions is worse than overshooting.
//
//   ┌───────────────────────────────────────────┬──────┐
//   │ Section                                   │ Cap  │
//   ├───────────────────────────────────────────┼──────┤
//   │ system prompt + tool definitions          │ 3000 │
//   │ user/tenant context                       │  500 │
//   │ the browser's state (## Browser)          │  900 │
//   │ current workforce plan state (if any)     │ 2000 │
//   │ conversation rolling summary              │ 1000 │
//   │ recent raw turns                          │ 2500 │
//   │ current user message                      │ 8000 │
//   └───────────────────────────────────────────┴──────┘
//
// The browser section's cap is above the renderer's own (2,500 characters,
// browser-record's STATE_BLOCK_MAX_CHARS), so the block is never cut twice:
// platform-backend's renderer drops whole items to fit, and the cap here is
// the net.
//
// Token counting uses a 4-chars-per-token approximation.
//
// `currentMessage` is deliberately the largest section: /teams/plan is the one
// surface whose job is to receive a whole role brief, and the section has to be
// at least MAX_CHAT_MESSAGE_CHARS or a message the router accepted would be
// truncated after the fact.
//
// Note `totalBudget` is advisory — nothing reads it. Sections are enforced
// individually. It is kept consistent with their sum so it does not read as a
// ceiling somebody could believe in.

import {
  ATTACHMENT_ALLOWANCE_TOKENS,
  IMAGE_ALLOWANCE_TOKENS,
  MEDIA_NOTICE_ALLOWANCE_TOKENS,
} from '@liftoffos/chat-attachments';
import type { LLMMessage } from '../llm/types.js';

export interface CAIOBudgetConfig {
  totalBudget: number;
  sections: {
    systemPrompt: number;
    userContext: number;
    browserContext: number;
    datasetContext: number;
    planState: number;
    rollingSummary: number;
    recentTurns: number;
    currentMessage: number;
  };
}

/**
 * Hard cap on a single chat message, in characters, enforced by both team-plan
 * chat routers.
 *
 * Deliberately far above the generic chat default: this is the front door of
 * distillation, and a brief describing a workflow, its fields and its failure
 * handling routinely runs to several thousand characters.
 *
 * Must stay <= sections.currentMessage * 4, so anything the router accepts also
 * survives the budget intact.
 */
export const MAX_CHAT_MESSAGE_CHARS = 32_000;

/**
 * Room for the message itself PLUS everything the router will accept alongside
 * it in attachments.
 *
 * The two are additive, not alternatives: the turn builder puts the attachment
 * blocks in front of the message, and `truncateToTokenBudget` keeps the TAIL, so
 * a section sized for the message alone pays for the overflow out of the head
 * of the first document — silently, because a budget reports no error. Eight
 * attachments at the cap is roughly 34,000 characters, which on its own already
 * exceeds what the message section was sized for.
 *
 * The allowance comes from @liftoffos/chat-attachments, the same constant
 * Liftoff and the Insights Manager add to their own budgets, so the three
 * cannot drift apart about what the caps mean.
 */
const CURRENT_MESSAGE_TOKENS =
  MAX_CHAT_MESSAGE_CHARS / 4
  + ATTACHMENT_ALLOWANCE_TOKENS
  // Media rides the same section, so its whole cost lands here: the images
  // when the model can see them, and the sentences explaining them when it
  // cannot. An image has no characters at all — its cost is pixels — so a
  // budget that counts only the attachment allowance is exactly right about
  // text and silently wrong by a few thousand tokens per picture.
  + IMAGE_ALLOWANCE_TOKENS
  + MEDIA_NOTICE_ALLOWANCE_TOKENS;

export const DEFAULT_CAIO_BUDGET: CAIOBudgetConfig = {
  totalBudget:
    18_600 + ATTACHMENT_ALLOWANCE_TOKENS + IMAGE_ALLOWANCE_TOKENS + MEDIA_NOTICE_ALLOWANCE_TOKENS,
  sections: {
    systemPrompt: 3000,
    userContext: 500,
    browserContext: 900,
    // The datasets kept for this conversation, rendered by platform-backend
    // under its own bound (newest first, the same 700-token budget); the cap
    // here is a net, as the browser section's is.
    datasetContext: 700,
    planState: 2000,
    rollingSummary: 1000,
    recentTurns: 2500,
    currentMessage: CURRENT_MESSAGE_TOKENS,
  },
};

export interface BudgetedCAIOPrompt {
  systemPrompt: string;
  messages: LLMMessage[];
  usage: {
    systemPrompt: number;
    userContext: number;
    browserContext: number;
    datasetContext: number;
    planState: number;
    rollingSummary: number;
    recentTurns: number;
    currentMessage: number;
    total: number;
  };
}

export interface BuildBudgetedCAIOPromptInput {
  /** The full system prompt (typically empty under platform-agent execution
   *  since the seed-rendered prompt is owned by runPlatformAgent).
   *
   *  It does NOT embed the plan state. The prompt is the provider's cache prefix
   *  and the plan changes mid-conversation, so the two cannot share a block; the
   *  plan comes in through `planStateText` below and is counted there. */
  systemPrompt: string;
  /** Short blurb about the caller (member name, role). May be empty. */
  userContext: string;
  /** The Browser section platform-backend rendered for this thread, with its
   *  own heading; empty or absent when the thread has no browser and no
   *  record. Rides the preamble after the user context. */
  browserContext?: string;
  /** The datasets kept for this conversation, as platform-backend renders the
   *  inventory (dataset_list with `inventory: true`): empty or absent when the
   *  conversation holds none. Per-turn context, after the browser's state,
   *  under its own heading. */
  datasetContext?: string;
  /** Structured plan state formatted for prompt injection, or null when
   *  no workforce plan is linked to the thread yet. */
  planStateText: string | null;
  /** Rolling summary of older turns (null if thread is short). */
  rollingSummary: string | null;
  /** Prior turns in the thread, oldest-first, EXCLUDING the current user message. */
  recentTurns: LLMMessage[];
  /** The current user message being processed. In "greeting" mode the chat
   *  service passes a synthetic (non-persisted) seed here instructing the
   *  CAIO to introduce itself. */
  currentMessage: string;
  /** Override the default 10000-token budget. */
  config?: CAIOBudgetConfig;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Truncate `text` to fit within `maxTokens`.
 *
 * `keep: 'tail'` (the default) drops from the START, which is what running
 * context wants — the most recent content survives.
 *
 * `keep: 'head'` drops from the END. Use it for anything a person wrote as one
 * piece: dropping the start of a user's message amputates the framing that says
 * what the rest of it is, and the model cannot tell that it happened.
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
  keep: 'head' | 'tail' = 'tail',
): string {
  if (!text) return text;
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return keep === 'head'
    ? text.slice(0, maxChars)
    : text.slice(text.length - maxChars);
}

/**
 * Drop oldest messages until the total token count fits the budget.
 */
export function fitMessagesToBudget(
  messages: LLMMessage[],
  budgetTokens: number,
): LLMMessage[] {
  const result: LLMMessage[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const tokens = countTokens(text);
    if (total + tokens > budgetTokens) break;
    result.unshift(messages[i]);
    total += tokens;
  }
  return result;
}

/**
 * Build a budgeted prompt ready for the LLM. Each section is independently
 * capped at its allocated token count; overages are truncated or dropped
 * oldest-first for conversation history. System prompt overages are logged
 * by the caller but passed through as-is — silently truncating critical
 * instructions is worse than overshooting the budget.
 */
export function buildBudgetedCAIOPrompt(
  input: BuildBudgetedCAIOPromptInput,
): BudgetedCAIOPrompt {
  const config = input.config ?? DEFAULT_CAIO_BUDGET;

  const systemPrompt = input.systemPrompt;
  const systemTokens = countTokens(systemPrompt);

  const userContextText = truncateToTokenBudget(
    input.userContext,
    config.sections.userContext,
  );
  const userContextTokens = countTokens(userContextText);

  // The browser's state, rendered under its own cap upstream; the cap here
  // is a net that never closes on a block the renderer produced.
  const browserText = input.browserContext
    ? truncateToTokenBudget(input.browserContext, config.sections.browserContext)
    : '';
  const browserTokens = countTokens(browserText);

  const datasetText = input.datasetContext
    ? truncateToTokenBudget(input.datasetContext, config.sections.datasetContext)
    : '';
  const datasetTokens = countTokens(datasetText);

  const planStateText = input.planStateText
    ? truncateToTokenBudget(input.planStateText, config.sections.planState)
    : '';
  const planStateTokens = countTokens(planStateText);

  const summaryText = input.rollingSummary
    ? truncateToTokenBudget(input.rollingSummary, config.sections.rollingSummary)
    : '';
  const summaryTokens = countTokens(summaryText);

  const recentMessages = fitMessagesToBudget(
    input.recentTurns,
    config.sections.recentTurns,
  );
  const recentTokens = recentMessages.reduce((sum, m) => {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return sum + countTokens(text);
  }, 0);

  const currentText = truncateToTokenBudget(
    input.currentMessage,
    config.sections.currentMessage,
    'head',
  );
  const currentTokens = countTokens(currentText);

  // Assemble the final message array. User context + plan state + rolling
  // summary become a system-role preamble message separate from the main
  // system prompt.
  const preambleParts: string[] = [];
  if (userContextText) preambleParts.push(`## User context\n${userContextText}`);
  if (browserText) preambleParts.push(browserText);
  if (datasetText) preambleParts.push(`## Datasets\n${datasetText}`);
  if (planStateText) preambleParts.push(planStateText);
  if (summaryText) preambleParts.push(`## Conversation summary\n${summaryText}`);
  const preamble = preambleParts.join('\n\n');

  const messages: LLMMessage[] = [
    ...(preamble ? [{ role: 'user' as const, content: `[Context]\n${preamble}` }] : []),
    ...recentMessages,
    { role: 'user' as const, content: currentText },
  ];

  return {
    systemPrompt,
    messages,
    usage: {
      systemPrompt: systemTokens,
      userContext: userContextTokens,
      browserContext: browserTokens,
      datasetContext: datasetTokens,
      planState: planStateTokens,
      rollingSummary: summaryTokens,
      recentTurns: recentTokens,
      currentMessage: currentTokens,
      total:
        systemTokens +
        userContextTokens +
        browserTokens +
        datasetTokens +
        planStateTokens +
        summaryTokens +
        recentTokens +
        currentTokens,
    },
  };
}
