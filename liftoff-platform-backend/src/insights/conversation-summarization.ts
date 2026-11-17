// Conversation Summarization Service
//
// Maintains a structured rolling summary of older turns on long insights
// chat threads. The chat service calls this periodically — not on every
// turn — so a 50-message investigation only incurs ~8 summarization
// LLM calls instead of being re-summarized every turn.
//
// Triggering rules (shouldSummarize):
//   - Thread message count >= SUMMARIZATION_THRESHOLD (10), AND
//   - At least SUMMARIZATION_INTERVAL (5) new messages since the last
//     summary was written
//
// The prompt asks the model to produce a strict JSON structure with five
// lists (user_intent, key_facts, open_questions, previous_findings,
// next_steps) via responseSchema so we get deterministic shape back. On
// any failure the previous summary is returned unchanged — never block
// the chat on summarization failure.
//
// The summary ONLY covers messages OLDER than the last 6 turns. The most
// recent 6 go into the context budget as raw history, so summarizing them
// would be redundant and would lose fine-grained detail about what's
// happening right now.

import { llmClient } from '../llm';
import { redactSensitiveText } from '../common/redact';
import type { JSONSchema } from '../llm/types';
import { log } from '../infrastructure/logging';
import type { ConversationSummary } from './types';

export type { ConversationSummary };

const SUMMARIZATION_THRESHOLD = 10;
const SUMMARIZATION_INTERVAL = 5;
const RECENT_TURNS_EXCLUDED_FROM_SUMMARY = 6;
const SUMMARY_MAX_TOKENS = 600;

export interface SummarizationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface SummarizationInput {
  threadId: string;
  tenantId: string;
  /** All messages in the thread, oldest first. */
  allMessages: SummarizationMessage[];
  /** Previous rolling summary for this thread, if any. */
  previousSummary: ConversationSummary | null;
  /**
   * Override the purpose tag written to llm_usage_log for cost attribution.
   * Defaults to 'insights_summarization'. Set to
   * 'caio_workforce_planning_summarization' from the CAIO chat service so
   * its summaries route to Workforce Planning instead of Platform Analytics.
   */
  purpose?: string;
  /**
   * When set, the LLM cost is attributed to this agent in llm_usage_log
   * (and rolls into the per-agent "interactions" bucket on /insights).
   * Pass from agent-chat; leave undefined for insights and CAIO.
   */
  agentId?: string;
}

const SUMMARIZER_SYSTEM_PROMPT = `You are a conversation summarizer for an analytics chat assistant.

Given a conversation history (and optionally a previous summary), produce a structured JSON snapshot that captures what the user was investigating and what was found.

Extract these fields:
- user_intent: ONE sentence describing what the user is currently investigating
- key_facts: array of important data points the assistant returned (with numbers and dates)
- open_questions: array of questions the user asked that haven't been fully answered yet
- previous_findings: array of conclusions or hypotheses the conversation reached
- next_steps: array of suggested follow-up directions

Be CONCISE. Each field should fit in one or two sentences. Drop pleasantries, drop tool error messages, drop visualization JSON. Focus on what a future turn would need to know to continue the investigation.

Respond with ONLY a JSON object matching the schema. No markdown, no preamble.`;

const SUMMARY_JSON_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    user_intent: { type: 'string' },
    key_facts: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
    previous_findings: { type: 'array', items: { type: 'string' } },
    next_steps: { type: 'array', items: { type: 'string' } },
  },
  required: ['user_intent', 'key_facts', 'open_questions', 'previous_findings', 'next_steps'],
};

/**
 * Decide whether the thread needs a fresh summary right now. Short threads
 * don't — the raw history fits in the budget. Long threads that have had
 * enough new activity since the last summary do.
 */
export function shouldSummarize(input: SummarizationInput): boolean {
  if (input.allMessages.length < SUMMARIZATION_THRESHOLD) return false;
  if (!input.previousSummary) return true;
  const newSinceLast = input.allMessages.length - input.previousSummary.messageCount;
  return newSinceLast >= SUMMARIZATION_INTERVAL;
}

/**
 * Generate a fresh rolling summary for a long thread. Excludes the most
 * recent 6 messages (those go into the budget as raw history) and feeds
 * the rest to the LLM with a structured output schema.
 *
 * Any error returns the previous summary unchanged — summarization is a
 * fire-and-forget side effect and must never block the chat loop.
 */
export async function generateRollingSummary(
  input: SummarizationInput,
): Promise<ConversationSummary | null> {
  // Only summarize messages OLDER than the recent-turns window.
  const toSummarize = input.allMessages.slice(
    0,
    Math.max(0, input.allMessages.length - RECENT_TURNS_EXCLUDED_FROM_SUMMARY),
  );
  if (toSummarize.length === 0) return input.previousSummary;

  // E4: redact before the text leaves for the model AND before it is stored.
  // A rolling summary is durable and long-lived, so a credential someone pasted
  // into chat would otherwise be copied into a second place nobody thinks to
  // look — and stay there after the message itself is gone.
  const conversationText = toSummarize
    .map(m => `${m.role.toUpperCase()}: ${redactSensitiveText(m.content)}`)
    .join('\n\n');

  const previousSummaryText = input.previousSummary
    ? `\n\nPREVIOUS SUMMARY (extend, do not restart):\n${JSON.stringify(input.previousSummary, null, 2)}`
    : '';

  try {
    const response = await llmClient.complete(
      {
        messages: [
          // One literal for every thread on every surface that summarizes —
          // the insights chat, agent chat, and the CAIO through the internal
          // relay, which forwards this request whole.
          { role: 'system', content: SUMMARIZER_SYSTEM_PROMPT, cacheControl: { type: 'ephemeral' } },
          {
            role: 'user',
            content: `CONVERSATION HISTORY:\n${conversationText}${previousSummaryText}`,
          },
        ],
        responseSchema: {
          name: 'conversation_summary',
          schema: SUMMARY_JSON_SCHEMA,
        },
        maxTokens: SUMMARY_MAX_TOKENS,
      },
      undefined,
      {
        tenantId: input.tenantId,
        purpose: input.purpose ?? 'insights_summarization',
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
      },
    );

    const parsed = JSON.parse(response.content) as Record<string, unknown>;
    return {
      userIntent: String(parsed.user_intent ?? ''),
      keyFacts: Array.isArray(parsed.key_facts) ? parsed.key_facts.map(String) : [],
      openQuestions: Array.isArray(parsed.open_questions)
        ? parsed.open_questions.map(String)
        : [],
      previousFindings: Array.isArray(parsed.previous_findings)
        ? parsed.previous_findings.map(String)
        : [],
      nextSteps: Array.isArray(parsed.next_steps) ? parsed.next_steps.map(String) : [],
      summarizedThrough: toSummarize[toSummarize.length - 1].createdAt,
      messageCount: toSummarize.length,
    };
  } catch (err) {
    log.warn(
      { threadId: input.threadId, error: (err as Error).message },
      'Conversation summarization failed — falling back to previous summary',
    );
    return input.previousSummary;
  }
}

/**
 * Format a summary as plain text for injection into the context budget's
 * rollingSummary section. Kept simple and section-based so the LLM can
 * pattern-match against it easily in the next turn.
 */
export function formatSummaryForPrompt(summary: ConversationSummary): string {
  const lines: string[] = [`User intent: ${summary.userIntent}`];

  if (summary.keyFacts.length) {
    lines.push(`Key facts:\n${summary.keyFacts.map(f => `- ${f}`).join('\n')}`);
  }
  if (summary.previousFindings.length) {
    lines.push(
      `Previous findings:\n${summary.previousFindings.map(f => `- ${f}`).join('\n')}`,
    );
  }
  if (summary.openQuestions.length) {
    lines.push(
      `Open questions:\n${summary.openQuestions.map(q => `- ${q}`).join('\n')}`,
    );
  }
  if (summary.nextSteps.length) {
    lines.push(`Suggested next steps:\n${summary.nextSteps.map(s => `- ${s}`).join('\n')}`);
  }

  return lines.join('\n\n');
}
