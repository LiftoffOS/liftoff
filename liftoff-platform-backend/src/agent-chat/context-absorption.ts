// Context Absorption Service — background memory save for observing agents
//
// When an agent is in a multi-agent thread but doesn't respond to a
// message, it still benefits from having "been in the room". This
// service creates a concise memory summary of the conversation exchange
// so the observing agent can reference it in future interactions.
//
// Runs fire-and-forget — errors are logged but never propagated to the
// chat loop. A failed absorption should never affect the user-visible
// conversation.
//
// Cost: 1 LLM call (fast model, ~200 tokens out) + 1 memory save per
// observer per message. In a 5-agent thread with 1 responder, that's
// 4 absorptions per message — acceptable for typical thread sizes.

import { TenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { isConversationRow } from './transcript-context';
import { llmClient } from '../llm';
import type { AgentChatMessage } from './chat-repository';
import { log } from '../infrastructure/logging';

const tenantRuntimeClient = new TenantRuntimeClient();

// 90-day TTL for observed conversation memories.
// Reserved for when saveAgentMemory supports an expiresAt parameter.
const _ABSORPTION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// Minimum messages required for a meaningful absorption.
const MIN_MESSAGES_FOR_ABSORPTION = 2;

// Max tokens for the summary generation — keep it concise.
const SUMMARY_MAX_TOKENS = 200;

const SUMMARY_SYSTEM_PROMPT =
  'Summarize this conversation in 1-2 sentences from the perspective of an observer agent. ' +
  'Focus on key facts, decisions, and action items that might be relevant later. ' +
  'Be concise and factual — no preamble or filler.';

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Absorb context from a conversation for a non-responding agent.
 * Creates a concise memory summary so the agent benefits from having
 * "been in the room" even though it didn't respond.
 *
 * Runs fire-and-forget — errors are logged but never propagated.
 */
export async function absorbConversationContext(
  tenantId: string,
  agentId: string,
  threadId: string,
  allRecentMessages: AgentChatMessage[],
): Promise<void> {
  try {
    // What an observer absorbs is what was SAID. The status rows in a thread
    // are written about the conversation, so absorbing them would have a team
    // recall a gate stalling, or a run's own tool counts, as something a
    // colleague told it. Filtered ahead of the minimum-length check, because a
    // thread of nothing but narration has no exchange to summarise.
    const recentMessages = allRecentMessages.filter(isConversationRow);

    // Skip if there aren't enough messages for a meaningful summary.
    if (recentMessages.length < MIN_MESSAGES_FOR_ABSORPTION) {
      log.debug(
        { tenantId, agentId, threadId, messageCount: recentMessages.length },
        'context-absorption: skipping — too few messages',
      );
      return;
    }

    // 1. Format messages for the LLM.
    const formattedExchange = recentMessages
      .map((m) => {
        const sender = m.role === 'user' ? 'User' : `Agent(${m.agentId ?? 'unknown'})`;
        return `${sender}: ${m.content}`;
      })
      .join('\n');

    // 2. Generate a concise summary via the LLM (non-streaming).
    const response = await llmClient.complete(
      {
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: formattedExchange },
        ],
        maxTokens: SUMMARY_MAX_TOKENS,
      },
      undefined,
      { tenantId, agentId, purpose: 'context_absorption', threadId },
    );

    const summary = response.content.trim();
    if (!summary) {
      log.warn(
        { tenantId, agentId, threadId },
        'context-absorption: LLM returned empty summary — skipping save',
      );
      return;
    }

    // 3. Save the summary to the agent's memory via tenant runtime.
    await tenantRuntimeClient.saveAgentMemory(
      tenantId,
      agentId,
      'individual',
      summary,
      ['type:convention', 'observed_conversation', `thread:${threadId}`],
    );

    log.info(
      {
        event: 'context_absorption_saved',
        tenantId,
        agentId,
        threadId,
        summaryLength: summary.length,
      },
      'context-absorption: saved observer memory',
    );
  } catch (err) {
    // Fire-and-forget: log and swallow. Never propagate.
    log.error(
      {
        tenantId,
        agentId,
        threadId,
        error: (err as Error).message,
      },
      'context-absorption: failed to absorb conversation context',
    );
  }
}
