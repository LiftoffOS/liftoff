// Teams chat task worker — processes a single inbound Teams message end-to-end
// through the SAME engine the web UI + Slack use (runAgentChatTurn), streaming
// the response back via TeamsStreamer. Mirrors slack-chat-worker.ts.
//
// Called fire-and-forget from the bot handler after the inbound ack.

import type { ConversationReference } from 'botbuilder';
import {
  markDelivered,
  markFailed,
  recordObligation,
  RECOVERED_REPLY_MARKER,
} from '../delivery-obligations';
import { stallNoticeText, withStallStatus } from '../stall-status';
import { runAgentChatTurn } from '../chat-service';
import * as chatRepo from '../chat-repository';
import type { Citation } from '../chat-repository';
import { withTenantScope } from '../../infrastructure/database';
import { log } from '../../infrastructure/logging';
import { liftoffifyString } from '../../branding/registry';
import type { ResolvedTeamsUser } from './identity-resolver';
import { makeTeamsStreamer } from './teams-streamer';
import { collectTurnFileCards } from '../file-cards';
import { assistantByKind, isAssistantKind } from '../assistant-targets';
import { AssistantUnreachableError, createAssistantThread, runAssistantTurn } from '../assistant-turn';
import { resolveActor } from '../../workspace-actions/actor';
import { rememberAssistantThread, rememberedAssistantThread } from '../assistant-conversation-threads';

export interface TeamsChatTask {
  /** Turn identity, minted at ENQUEUE time (C1). See SlackChatTask.turnId. */
  turnId?: string;
  tenantId: string;
  agentId: string;
  conversationId: string;
  conversationReference: Record<string, unknown>;
  scope: 'personal' | 'channel' | 'groupChat';
  // Resolved in the handler from the live turn's roster (identity lookup needs
  // the TurnContext, which no longer exists in this fire-and-forget worker).
  resolvedUser: ResolvedTeamsUser;
  text: string;
}

async function getAgentName(tenantId: string, agentId: string): Promise<string> {
  const row = await withTenantScope(tenantId, async (c) => {
    const res = await c.query<{ messaging_nickname: string | null; role: string }>(
      'SELECT messaging_nickname, role FROM internal_agents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
      [agentId, tenantId],
    );
    return res.rows[0];
  });
  return (row?.messaging_nickname || row?.role || 'Your agent').trim();
}

export async function handleTeamsChatTask(task: TeamsChatTask): Promise<void> {
  if (isAssistantKind(task.agentId)) {
    await handleTeamsAssistantTask(task);
    return;
  }
  const { tenantId, agentId, conversationId, scope, resolvedUser: resolved, text, turnId } = task;

  // Find or create the chat thread keyed on the Teams conversation id (natively
  // separates 1:1 vs channel-thread; migration 275 allows 'teams').
  const thread = await chatRepo.findOrCreateThread(
    tenantId,
    resolved.accountId,
    agentId,
    'teams',
    conversationId,
  );

  const agentName = await getAgentName(tenantId, agentId);

  // 3. Stream the turn.
  const streamer = makeTeamsStreamer({
    conversationReference: task.conversationReference as Partial<ConversationReference>,
    scope,
    agentName,
  });
  const turnStart = new Date();
  await streamer.begin();

  let citations: Citation[] | null = null;
  /** Has any of the agent's answer reached the person yet? Decides whether a
   *  transient failure can be retried invisibly or has to be admitted. */
  let streamedAny = false;
  /** Set when the turn died on something worth another delivery attempt and
   *  nothing had been said. Acted on after the streaming block so the throw is
   *  not swallowed by the catch that turns errors into an apology. */
  let retryableFailure: string | null = null;
  try {
    // C1: a retry after a failed post arrives with the same turn id. Deliver the
  // stored reply rather than re-running the turn. See the Slack worker.
  if (turnId) {
    const alreadyRun = await chatRepo.getAssistantMessageByTurnId(tenantId, turnId);
    await recordObligation({
      tenantId, agentId, threadId: thread.id, turnId, channel: 'teams', targetRef: conversationId,
    });
    if (alreadyRun?.content) {
      try {
        streamer.append(RECOVERED_REPLY_MARKER + alreadyRun.content);
        await streamer.finalize(alreadyRun.citations ?? null);
        await markDelivered(tenantId, turnId);
      } catch (err) {
        await markFailed(tenantId, turnId, (err as Error).message);
        throw err;
      }
      return;
    }
  }

  // C4: see the Slack worker — same dead-air problem, same wrapper. Teams
    // shows a typing indicator during silence, so the line is additive there
    // rather than the only signal.
    const turnEvents = withStallStatus(
      runAgentChatTurn({
        tenantId,
        agentId,
        threadId: thread.id,
        userId: resolved.userId,
        senderAccountId: resolved.accountId ?? undefined,
        userDisplayName: resolved.displayName,
        senderLabel: resolved.identityLabel,
        content: text,
        channelHint: 'teams',
        ...(turnId ? { turnId } : {}),
      }),
      { onStall: (lastTool) => streamer.append(stallNoticeText(lastTool)) },
    );

    for await (const event of turnEvents) {
      if (event.type === 'text_delta') {
        // Once ANY text has reached the person, a retry would re-answer a
        // question they can already see part of.
        streamedAny = true;
        streamer.append(event.text);
      } else if (event.type === 'tool_call') {
        streamer.addToolCall(event.tool);
      } else if (event.type === 'complete') {
        // Null when the turn was stopped before it said anything: nothing was
        // persisted, so there are no citations to carry either.
        citations = event.message?.citations ?? null;
      } else if (event.type === 'hitl_required') {
        streamer.append('\n\n_I need approval to proceed. Review pending approvals in Liftoff._');
      } else if (
        event.type === 'interrupt_delivered'
        || event.type === 'clarification_accepted'
      ) {
        // The message was folded into the thread's in-flight run — show a short
        // confirmation instead of streaming a reply that will never come, and
        // skip the file-card follow-up (this turn produced no files).
        streamer.append('_Got it — passing this along to the current run._');
        await streamer.finalize(null);
        return;
      } else if (event.type === 'stop_acknowledged') {
        streamer.append('_Stopping the current run._');
        await streamer.finalize(null);
        return;
      } else if (event.type === 'error') {
        // Same shape as the Slack worker: a transient failure on a turn that has
        // said nothing yet goes back to the queue instead of apologising.
        if (event.retryable === true && !streamedAny) {
          retryableFailure = event.message;
          break;
        }
        streamer.append(`\n\n_Sorry, something went wrong: ${liftoffifyString(event.message)}_`);
      }
    }
  } catch (err) {
    streamer.append('\n\n_Sorry, I encountered an error processing your message._');
    log.error({ tenantId, agentId, error: (err as Error).message }, 'Teams chat turn failed');
  }

  // Nothing was said and the runtime called the failure retryable: fail this
  // request so Cloud Tasks delivers the task again. Outside the catch above,
  // which exists to turn an error into an apology.
  if (retryableFailure) {
    log.warn(
      { tenantId, agentId, turnId, error: retryableFailure },
      'Teams chat turn failed before saying anything; handing back to the queue',
    );
    // Stop the typing indicator. This turn posts nothing, so it never reaches
    // finalize — and the refresh interval begin() armed would otherwise keep
    // sending typing frames into a conversation whose turn has ended, while the
    // redelivery starts its own. The person should see one indicator, from the
    // attempt that is actually running.
    streamer.abandon();
    if (turnId) await markFailed(tenantId, turnId, retryableFailure);
    throw new Error(`retryable chat turn failure: ${retryableFailure}`);
  }

  // C1: settle only after the final flush actually went out.
  try {
    await streamer.finalize(citations);
    if (turnId) await markDelivered(tenantId, turnId);
  } catch (err) {
    if (turnId) await markFailed(tenantId, turnId, (err as Error).message);
    throw err;
  }

  // Surface any files the agent produced this turn as a follow-up card.
  const files = await collectTurnFileCards(tenantId, thread.id, turnStart);
  await streamer.postFiles(files);
}

/**
 * A platform assistant answering in Teams — the twin of the Slack worker's
 * assistant branch, on this surface's streamer. Runs AS the person who wrote,
 * on the assistant's own surface; someone the workspace cannot resolve is
 * told so, and the turn never runs anonymously. The personal chat keeps one
 * thread across messages, remembered on the conversation row after the first
 * turn. The delivery-obligation ledger is not used: it replays from
 * agent_chat_messages, which an assistant's reply never enters.
 */
async function handleTeamsAssistantTask(task: TeamsChatTask): Promise<void> {
  const { tenantId, conversationId, scope, resolvedUser: resolved, text } = task;
  const assistant = assistantByKind(task.agentId);
  if (!assistant) return;
  const streamer = makeTeamsStreamer({
    conversationReference: task.conversationReference as Partial<ConversationReference>,
    scope,
    agentName: assistant.name,
  });

  const actor = resolved.accountId
    ? await resolveActor({
      tenantId,
      accountId: resolved.accountId,
      surface: 'teams',
      via: 'teams',
      client: conversationId,
      displayName: resolved.displayName,
    })
    : null;
  if (!actor) {
    await streamer.begin();
    streamer.append(
      'I can only answer members of this workspace, and I could not match your Teams account to one. '
      + 'Sign in to Liftoff with the email your Teams account uses, then message me again.',
    );
    await streamer.finalize();
    return;
  }

  // This chat's own thread with this assistant, whatever the chat is bound
  // to; created on the first message and remembered.
  const conversation = { surface: 'teams' as const, conversationId };
  let threadId = await rememberedAssistantThread(tenantId, conversation, assistant.kind).catch(() => null);
  try {
    if (!threadId) {
      threadId = await createAssistantThread(assistant.kind, { tenantId, accountId: actor.accountId, role: actor.role });
      await rememberAssistantThread(tenantId, conversation, assistant.kind, threadId).catch((err) =>
        log.warn({ err: (err as Error).message, tenantId }, 'assistant thread could not be remembered for the conversation'));
    }
  } catch (err) {
    if (err instanceof AssistantUnreachableError) {
      await streamer.begin();
      streamer.append('I cannot be reached right now. Please try again in a moment.');
      await streamer.finalize();
      return;
    }
    throw err;
  }

  await streamer.begin();
  try {
    const outcome = await runAssistantTurn(assistant.kind, {
      tenantId,
      threadId,
      userMessage: text,
      accountId: actor.accountId,
      displayName: actor.displayName,
      role: actor.role,
      origin: { via: 'teams', client: conversationId, credentialId: '' },
    });
    if (outcome.terminal === 'completed' && outcome.replyContent) {
      // Liftoff may hand the answer to a colleague; the card carries the
      // assistant's name, so the colleague is named in the text.
      streamer.append(outcome.answeredBy ? `${outcome.answeredBy}: ${outcome.replyContent}` : outcome.replyContent);
    } else if (outcome.errorCode === 'busy') {
      streamer.append("I'm in the middle of answering you somewhere else. Give me a moment and try again.");
    } else {
      streamer.append('Sorry, I could not answer that just now.');
      log.warn({ tenantId, assistant: assistant.kind, errorCode: outcome.errorCode }, 'Teams assistant turn did not complete');
    }
  } catch (err) {
    streamer.append('Sorry, I encountered an error processing your message.');
    log.error({ tenantId, assistant: assistant.kind, error: (err as Error).message }, 'Teams assistant turn failed');
  }
  await streamer.finalize();
}
