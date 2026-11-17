// Getting an assistant's out-of-turn message to the chat workspace its thread
// lives in.
//
// A team's out-of-turn message goes to the thread's own surface
// (out-of-turn-delivery.ts): a Slack thread hears it in Slack, a Teams chat in
// Teams. The three assistants have no channel column; what they have is the
// binding row that pairs a Slack DM or a Teams personal chat with the
// assistant's own thread. When the Chief AI Officer finishes building a plan
// minutes after the person said yes in Slack, that binding is the only thing
// that knows where the person asked. Without this the notice landed in the
// dashboard thread alone, and a person who had done everything from Slack
// never heard that their teams existed.
//
// Same contract as the team delivery: the caller has already written the
// transcript row, this is only the push, and it never throws.

import { log } from '../infrastructure/logging';
import { assistantByKind, type AssistantKind } from './assistant-targets';

export type AssistantOutOfTurnResult =
  | { channel: 'slack' | 'teams'; pushed: boolean }
  | { channel: null; pushed: null };

/**
 * Post `text` into the Slack DM or Teams chat bound to this assistant thread,
 * under the assistant's name. `{ channel: null }` when the thread is bound to
 * neither, which is the dashboard case and the caller's to handle.
 */
export async function pushAssistantOutOfTurnMessage(params: {
  tenantId: string;
  kind: AssistantKind;
  threadId: string;
  text: string;
}): Promise<AssistantOutOfTurnResult> {
  const { tenantId, kind, threadId, text } = params;
  const speaker = assistantByKind(kind)?.name ?? 'Liftoff';
  try {
    const { conversationForAssistantThread } = await import('./assistant-conversation-threads');
    const held = await conversationForAssistantThread(tenantId, threadId);
    if (!held) return { channel: null, pushed: null };
    if (held.conversation.surface === 'slack') {
      return { channel: 'slack', pushed: await postToSlack(tenantId, held.conversation, `${speaker}: ${text}`) };
    }
    return { channel: 'teams', pushed: await postToTeams(tenantId, held.conversation.conversationId, `${speaker}: ${text}`) };
  } catch (err) {
    log.warn({ tenantId, threadId, kind, error: (err as Error).message }, 'assistant out-of-turn: delivery lookup failed');
    return { channel: null, pushed: null };
  }
}

async function postToSlack(
  tenantId: string,
  binding: { channelId: string; threadRootTs: string | null },
  text: string,
): Promise<boolean> {
  try {
    const { getInstalledWorkspaceInstall } = await import('./slack-adapter/workspace-repository');
    const install = await getInstalledWorkspaceInstall(tenantId);
    if (!install) return false;
    const { resolveWorkspaceBotToken } = await import('./slack-adapter/bot-token-service');
    const token = await resolveWorkspaceBotToken(install);
    if (!token) return false;
    const { slackApiFetch } = await import('./slack-adapter/slack-api');
    const res = await slackApiFetch('chat.postMessage', {
      authToken: token,
      body: { kind: 'json', value: {
        channel: binding.channelId,
        ...(binding.threadRootTs ? { thread_ts: binding.threadRootTs } : {}),
        text,
        unfurl_links: false,
        unfurl_media: false,
      } },
    });
    return Boolean(res.ok);
  } catch (err) {
    log.warn({ tenantId, error: (err as Error).message }, 'assistant out-of-turn: slack push failed');
    return false;
  }
}

async function postToTeams(tenantId: string, conversationId: string, text: string): Promise<boolean> {
  try {
    const { sendToConversation } = await import('./teams-adapter/teams-sender');
    const r = await sendToConversation({ tenantId, conversationId, text, kind: 'message' });
    return Boolean(r.activityId);
  } catch (err) {
    log.warn({ tenantId, error: (err as Error).message }, 'assistant out-of-turn: teams push failed');
    return false;
  }
}
