// An assistant's own thread for one chat conversation, remembered per
// (conversation, assistant) so the conversation continues across messages
// whatever the conversation is bound to.
//
// A binding names one colleague per Slack conversation or Teams chat. A person
// whose DM is bound to a team can still address the Chief AI Officer by name,
// and that conversation has to hold together too: the thread lives here, keyed
// by the conversation and the assistant, and the binding is not consulted.
// Written once, on the first message; read on every one after.

import { withTenantScope } from '../infrastructure/database';
import type { AssistantKind } from './assistant-targets';
import { isAssistantKind } from './assistant-targets';

export type AssistantConversation =
  | { surface: 'slack'; slackTeamId: string; channelId: string; threadRootTs: string | null }
  | { surface: 'teams'; conversationId: string };

/** The stored key: Slack conversations carry the workspace, channel and thread
 *  root (empty for the channel or DM itself); Teams the conversation id. */
function keyOf(c: AssistantConversation): string {
  return c.surface === 'slack' ? `${c.slackTeamId}:${c.channelId}:${c.threadRootTs ?? ''}` : c.conversationId;
}

function conversationOf(surface: string, key: string): AssistantConversation | null {
  if (surface === 'teams') return { surface: 'teams', conversationId: key };
  if (surface !== 'slack') return null;
  const first = key.indexOf(':');
  const second = key.indexOf(':', first + 1);
  if (first <= 0 || second <= first + 1) return null;
  const threadRootTs = key.slice(second + 1);
  return { surface: 'slack', slackTeamId: key.slice(0, first), channelId: key.slice(first + 1, second), threadRootTs: threadRootTs || null };
}

/** The assistant's thread for this conversation, or null on the first message. */
export async function rememberedAssistantThread(
  tenantId: string,
  conversation: AssistantConversation,
  kind: AssistantKind,
): Promise<string | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ assistant_thread_id: string }>(
      `SELECT assistant_thread_id FROM assistant_conversation_threads
        WHERE tenant_id = $1 AND surface = $2 AND conversation_key = $3 AND assistant_kind = $4`,
      [tenantId, conversation.surface, keyOf(conversation), kind],
    );
    return res.rows[0]?.assistant_thread_id ?? null;
  });
}

/** Keep the thread the first message created. A row already there wins: two
 *  first messages in flight must not split the conversation in two. */
export async function rememberAssistantThread(
  tenantId: string,
  conversation: AssistantConversation,
  kind: AssistantKind,
  assistantThreadId: string,
): Promise<void> {
  await withTenantScope(tenantId, (client) =>
    client.query(
      `INSERT INTO assistant_conversation_threads
         (tenant_id, surface, conversation_key, assistant_kind, assistant_thread_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, surface, conversation_key, assistant_kind) DO NOTHING`,
      [tenantId, conversation.surface, keyOf(conversation), kind, assistantThreadId],
    ),
  );
}

/** The conversation an assistant thread lives in, or null when the thread was
 *  never held in a chat workspace (the dashboard case). */
export async function conversationForAssistantThread(
  tenantId: string,
  assistantThreadId: string,
): Promise<{ kind: AssistantKind; conversation: AssistantConversation } | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query<{ surface: string; conversation_key: string; assistant_kind: string }>(
      `SELECT surface, conversation_key, assistant_kind FROM assistant_conversation_threads
        WHERE tenant_id = $1 AND assistant_thread_id = $2
        ORDER BY updated_at DESC
        LIMIT 1`,
      [tenantId, assistantThreadId],
    );
    const row = res.rows[0];
    if (!row || !isAssistantKind(row.assistant_kind)) return null;
    const conversation = conversationOf(row.surface, row.conversation_key);
    return conversation ? { kind: row.assistant_kind, conversation } : null;
  });
}
