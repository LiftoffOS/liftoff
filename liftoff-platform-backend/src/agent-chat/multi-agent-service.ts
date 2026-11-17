// Multi-Agent Chat Turn Execution
//
// Runs multiple agents sequentially in a single thread. For 1-on-1 threads
// (single participant) this is a thin wrapper around runAgentChatTurn with
// no routing overhead. For multi-participant threads it routes the message,
// runs each responding agent sequentially, and fires context absorption for
// observers.
//
// Sequential execution ensures:
//   - No race conditions on thread history
//   - Each agent sees the previous agent's response
//   - The user sees a coherent conversation flow
//
// Used by the SSE stream-router (web) and the Slack adapter.

import {
  runAgentChatTurn,
  type AgentChatEvent,
  type AgentChatTurnInput,
} from './chat-service';
import {
  routeMessage,
  extractMentionedAgentIds,
  type RoutingDecision,
} from './routing-service';
import { absorbConversationContext } from './context-absorption';
import * as chatRepo from './chat-repository';
import { log } from '../infrastructure/logging';
import { fireAndForget } from '../shared/fire-and-forget';

// ── Event shape ─────────────────────────────────────────────────────────

/**
 * Extended event that includes which agent is responding.
 * Used by the SSE stream and Slack adapter to attribute responses.
 */
export type MultiAgentChatEvent =
  | { type: 'agent_start'; agentId: string; agentName?: string }
  | (AgentChatEvent & { agentId?: string });

// ── Main entry point ────────────────────────────────────────────────────

/**
 * Run a multi-agent chat turn. Routes the message to the right agent(s),
 * executes their turns sequentially, and absorbs context for observers.
 *
 * For 1-on-1 threads (single participant), this is a thin wrapper around
 * runAgentChatTurn with no routing overhead.
 */
export async function* runMultiAgentChatTurn(
  input: AgentChatTurnInput & { mentionedAgentIds?: string[] },
): AsyncGenerator<MultiAgentChatEvent> {
  const participants = await chatRepo.getParticipants(input.threadId);

  // ── Single participant fast path ──────────────────────────────────────
  //
  // When the thread has 0 or 1 participant, skip routing entirely and
  // delegate directly to the single-agent chat turn.
  if (participants.length <= 1) {
    for await (const event of runAgentChatTurn(input)) {
      yield { ...event, agentId: input.agentId };
    }
    return;
  }

  // ── Multi-participant path ────────────────────────────────────────────

  let routing: RoutingDecision;
  try {
    routing = await routeMessage(
      input.threadId,
      input.tenantId,
      input.content,
      participants.map((p) => ({
        agentId: p.agentId,
        role: p.role as 'participant' | 'lead',
      })),
      input.mentionedAgentIds ?? [],
    );
  } catch (err) {
    log.error(
      {
        threadId: input.threadId,
        tenantId: input.tenantId,
        error: (err as Error).message,
      },
      'Multi-agent routing failed — falling back to first participant',
    );
    // Fallback: route to the first participant only, no observers.
    routing = {
      respondingAgents: [{ agentId: participants[0].agentId, reason: 'relevant' as const }],
      observingAgents: [],
    };
  }

  // Run each responding agent sequentially so they see each other's replies.
  for (const responder of routing.respondingAgents) {
    yield { type: 'agent_start', agentId: responder.agentId };

    for await (const event of runAgentChatTurn({
      ...input,
      agentId: responder.agentId,
    })) {
      yield { ...event, agentId: responder.agentId };
    }
  }

  // Fire-and-forget: context absorption for observers.
  // Load recent messages once and absorb into each observer's memory.
  if (routing.observingAgents.length > 0) {
    fireAndForget(
      absorbForObservers(
        input.tenantId,
        input.threadId,
        routing.observingAgents,
      ),
      'multi-agent context absorption',
    );
  }
}

// ── Async wrapper ─────────────────────────────────────────────────────────

/**
 * Non-streaming wrapper that drains the generator. Used by the Slack
 * adapter and test harnesses where streaming isn't needed.
 */
export async function runMultiAgentChatTurnAsync(
  input: AgentChatTurnInput & { mentionedAgentIds?: string[] },
): Promise<void> {
  for await (const _event of runMultiAgentChatTurn(input)) {
    // Drain the generator — side effects happen inside.
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Load recent thread messages and absorb context into each observer's
 * memory. Each observer gets a concise summary of what was said so they
 * stay contextually aware without responding.
 */
async function absorbForObservers(
  tenantId: string,
  threadId: string,
  observers: Array<{ agentId: string }>,
): Promise<void> {
  const recentHistory = await chatRepo.listMessages(threadId, tenantId, {
    limit: 20,
  });
  // listMessages returns newest-first; reverse to chronological order.
  const recentMessages = [...recentHistory.messages].reverse();

  const results = await Promise.allSettled(
    observers.map((observer) =>
      absorbConversationContext(
        tenantId,
        observer.agentId,
        threadId,
        recentMessages,
      ),
    ),
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      log.warn(
        {
          tenantId,
          threadId,
          agentId: observers[i].agentId,
          error: (result.reason as Error).message,
        },
        'Context absorption failed for observer — non-fatal',
      );
    }
  }
}

// Re-export for convenience — callers that import multi-agent-service
// shouldn't need to also import routing-service directly.
export { extractMentionedAgentIds };
