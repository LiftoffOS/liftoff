// Rolling conversation summaries for the CAIO chat.
//
// This file used to be a stub: 28 lines that never called a model and returned
// `Conversation with N messages (summary placeholder)`. That string was written
// to team_plan_threads.rolling_summary and then injected into the CAIO's prompt,
// so a long planning conversation had its early context replaced by a sentence
// counting the messages.
//
// It is now a client, not an implementation. The insights chat and the agent
// team-chat already share platform-backend's summarizer, and that module is pure
// — an LLM call, redaction, and a logger, with no database access — so there is
// no reason for a second one to exist. POST /api/internal/chat-summarization
// runs it and hands back the structured summary plus the prompt text, which is
// why nothing here decides thresholds, builds a prompt, or parses a response.
//
// Redaction happens inside that module, so this path cannot forget it. That is
// deliberate: the title path had redaction only because its caller remembered,
// and this service's caller did not.

import { loadConfig } from '../infrastructure/config.js';
import { getServiceAuthHeaders } from '../infrastructure/service-auth.js';
import { log } from '../infrastructure/logging.js';

/** Mirrors platform-backend's ConversationSummary (src/insights/types.ts). */
export interface ConversationSummary {
  userIntent: string;
  keyFacts: string[];
  openQuestions: string[];
  previousFindings: string[];
  nextSteps: string[];
  summarizedThrough: string;
  messageCount: number;
}

export interface SummarizationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
}

export interface SummarizationResult {
  summarized: boolean;
  summary: ConversationSummary | null;
  promptText: string | null;
}

const NOT_SUMMARIZED: SummarizationResult = {
  summarized: false,
  summary: null,
  promptText: null,
};

/**
 * Ask platform-backend to refresh this thread's rolling summary.
 *
 * Returns `summarized: false` both when the thread is too short to need one and
 * when the call failed — the caller's response to either is the same, which is
 * to leave the summary it already has alone. Never throws: summarization is a
 * fire-and-forget side effect and must not be able to fail a chat turn.
 */
export async function summarizeThread(input: {
  tenantId: string;
  threadId: string;
  /** Oldest first. */
  messages: SummarizationMessage[];
  previousSummary: ConversationSummary | null;
}): Promise<SummarizationResult> {
  try {
    const config = loadConfig();
    const baseUrl = config.PLATFORM_BACKEND_URL.replace(/\/$/, '');
    const headers = await getServiceAuthHeaders(baseUrl, config.WORKFORCE_SERVICE_TOKEN);

    const response = await fetch(`${baseUrl}/api/internal/chat-summarization`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tenantId: input.tenantId,
        threadId: input.threadId,
        messages: input.messages,
        previousSummary: input.previousSummary,
        // Keeps the cost in the Workforce Planning bucket on /insights rather
        // than Platform Analytics.
        purpose: 'caio_workforce_planning_summarization',
      }),
    });

    if (!response.ok) {
      log.warn(
        { threadId: input.threadId, status: response.status },
        'CAIO: summarization request failed - keeping the existing summary',
      );
      return NOT_SUMMARIZED;
    }

    return (await response.json()) as SummarizationResult;
  } catch (err) {
    log.warn(
      { threadId: input.threadId, error: (err as Error).message },
      'CAIO: summarization request threw - keeping the existing summary',
    );
    return NOT_SUMMARIZED;
  }
}

/**
 * Render a stored summary for the prompt.
 *
 * A freshly generated summary arrives pre-formatted from platform-backend; this
 * covers the one already sitting on the thread from an earlier turn. It is a
 * projection of the same fields in the same order, not a second opinion about
 * what a summary should look like.
 */
export function formatSummaryForPrompt(summary: ConversationSummary): string {
  const lines: string[] = [`User intent: ${summary.userIntent}`];
  if (summary.keyFacts.length) {
    lines.push(`Key facts:\n${summary.keyFacts.map(f => `- ${f}`).join('\n')}`);
  }
  if (summary.previousFindings.length) {
    lines.push(`Previous findings:\n${summary.previousFindings.map(f => `- ${f}`).join('\n')}`);
  }
  if (summary.openQuestions.length) {
    lines.push(`Open questions:\n${summary.openQuestions.map(q => `- ${q}`).join('\n')}`);
  }
  if (summary.nextSteps.length) {
    lines.push(`Suggested next steps:\n${summary.nextSteps.map(s => `- ${s}`).join('\n')}`);
  }
  return lines.join('\n\n');
}

/**
 * Is this a real structured summary, or one of the flat placeholder rows the
 * stub left behind (`{summary, messageCount}`)? Every stored row predating this
 * change is a placeholder, so reading them as absent simply regenerates them.
 */
export function isUsableSummary(raw: unknown): raw is ConversationSummary {
  return (
    !!raw &&
    typeof raw === 'object' &&
    typeof (raw as ConversationSummary).userIntent === 'string'
  );
}
