// The MCP conversation id IS the chat share id.
//
// A coding tool gets one id per conversation and hands it back to continue.
// That id is the chat_share_links row for the thread: the same id the
// dashboard's share button mints and the one URL the product hands out
// (/share/<id>), so a conversation started from a terminal can be opened in
// Liftoff, and one started on the dashboard can be continued from the terminal
// — the resolver admits any share the caller could open there.
//
// Transition: a bare thread UUID from a client that still holds one from the
// previous release is accepted for ONE release. The share is tried first; the
// fall-through runs the predicates the previous release applied and logs
// `mcp.legacy_conversation_id` so the window can be closed on evidence.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { frontendUrl } from '../infrastructure/frontend-url';
import {
  CAIO_SHARE_AGENT_ID,
  findShareById,
  upsertShare,
  type ChatThreadKind,
} from '../chat-shares/repository';
import { threadVisibleToCaller } from '../chat-shares/visibility';
import { getThread as getLiftoffThread } from '../liftoff/chat-repository';
import { getThread as getInsightsThread } from '../insights/chat-repository';
import type { TenantMemberRole } from '../tenant-members/types';
import type { McpAssistantKind } from './assistant-targets';

// The same origin file-cards.ts links into — resolved per call from
// FRONTEND_URL, which has no default on purpose (see frontend-url.ts): a share
// link minted against a host this deployment does not own is a well-formed URL
// that reaches nothing.

export type McpConversationKind = McpAssistantKind | 'agent';

/** Which surface's thread a conversation kind lives on. */
export function threadKindForConversationKind(kind: McpConversationKind): ChatThreadKind {
  switch (kind) {
    case 'agent': return 'agent';
    case 'liftoff': return 'liftoff';
    case 'insights': return 'insights';
    case 'caio': return 'team_plan';
  }
}

/** A team thread with no team behind it cannot be shared: an agent-kind share
 *  is addressed by its agent (chat-shares/router.ts AGENT_BEARING_KINDS), so
 *  minting one without would hand out a link that opens nothing. */
export class ConversationShareError extends Error {
  constructor(threadId: string) {
    super(`Team thread ${threadId} has no team participant to share it under`);
    this.name = 'ConversationShareError';
  }
}

/** The team an agent-chat thread belongs to: its first participant. */
async function firstParticipantAgentId(tenantId: string, threadId: string): Promise<string | null> {
  const r = await withTenantScope(tenantId, (client) => client.query(
    `SELECT agent_id FROM agent_chat_thread_participants
     WHERE thread_id = $1 ORDER BY added_at ASC LIMIT 1`,
    [threadId],
  ));
  return (r.rows[0]?.agent_id as string | undefined) ?? null;
}

/** Find-or-create the share for a thread and return its id. Idempotent: the
 *  same thread always answers with the same id. A team thread's share carries
 *  the team's id, read from the thread when the caller does not hold it. */
export async function conversationIdForThread(p: {
  tenantId: string;
  accountId: string;
  threadId: string;
  kind: McpConversationKind;
  /** The team's internal_agents id for a team thread. */
  agentId?: string;
}): Promise<string> {
  const threadKind = threadKindForConversationKind(p.kind);
  let agentId: string | null = null;
  if (p.kind === 'agent') {
    agentId = p.agentId ?? await firstParticipantAgentId(p.tenantId, p.threadId);
    if (!agentId) throw new ConversationShareError(p.threadId);
  } else if (p.kind === 'caio') {
    agentId = CAIO_SHARE_AGENT_ID;
  }
  return upsertShare(p.tenantId, agentId, p.threadId, p.accountId, threadKind);
}

/** Resolve a conversation id to the thread it names, or null when the caller
 *  could not open that conversation on the dashboard either: unknown id,
 *  another tenant's share, a thread since deleted. */
export async function threadForConversationId(p: {
  tenantId: string;
  accountId: string;
  role: TenantMemberRole;
  conversationId: string;
  /** Transition only: what the previous release needed to admit a bare thread
   *  id — the anchor token and the requested kind. */
  legacy?: { keyId: string; kind: McpConversationKind };
}): Promise<{ threadId: string; threadKind: ChatThreadKind } | null> {
  const share = await findShareById(p.conversationId);
  if (share) {
    if (share.tenantId !== p.tenantId) return null;
    const visible = await threadVisibleToCaller({
      threadKind: share.threadKind,
      threadId: share.threadId,
      tenantId: p.tenantId,
      accountId: p.accountId,
      role: p.role,
    });
    return visible ? { threadId: share.threadId, threadKind: share.threadKind } : null;
  }
  if (!p.legacy) return null;
  return legacyThreadForConversationId(p.tenantId, p.accountId, p.conversationId, p.legacy);
}

/** The previous release's continuation predicates, applied to a bare thread
 *  UUID. Removed the release after this one ships. */
async function legacyThreadForConversationId(
  tenantId: string,
  accountId: string,
  threadId: string,
  legacy: { keyId: string; kind: McpConversationKind },
): Promise<{ threadId: string; threadKind: ChatThreadKind } | null> {
  const threadKind = threadKindForConversationKind(legacy.kind);
  if (legacy.kind === 'agent') {
    const t = await withTenantScope(tenantId, (client) => client.query(
      `SELECT id FROM agent_chat_threads
       WHERE id = $1 AND tenant_id = $2 AND account_id = $3
         AND channel = 'mcp' AND deleted_at IS NULL`,
      [threadId, tenantId, accountId],
    ));
    if (t.rows.length === 0) return null;
  } else {
    // Continuity was anchored to this connection's own history: a prior run of
    // this kind, on this thread, from this anchor.
    const prior = await withTenantScope(tenantId, (client) => client.query(
      `SELECT 1 FROM mcp_chat_runs
       WHERE thread_id = $1 AND anchor_token_id = $2 AND target_kind = $3
       LIMIT 1`,
      [threadId, legacy.keyId, legacy.kind],
    ));
    if (prior.rows.length === 0) return null;
    if (legacy.kind === 'liftoff' && !(await getLiftoffThread(threadId, tenantId))) return null;
    if (legacy.kind === 'insights' && !(await getInsightsThread(threadId, tenantId))) return null;
  }
  log.info({ tenantId, threadId, kind: legacy.kind }, 'mcp.legacy_conversation_id');
  return { threadId, threadKind };
}

/** The one URL the product hands out for a conversation. */
export function conversationLink(shareId: string): string {
  return `${frontendUrl()}/share/${shareId}`;
}
