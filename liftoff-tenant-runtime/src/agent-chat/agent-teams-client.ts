// HTTP client for platform-backend's /api/internal/agent-teams/* RPC.
//
// One shared multi-tenant Liftoff Teams bot serves all agents, so (unlike the
// Slack client) there are no per-agent bot tokens. Outbound posting is done by
// platform-backend (which holds the bot adapter + credentials) via /send;
// tenant-runtime resolves conversations + fans out HITL review cards.

import { logger } from '../infrastructure/logging';
import { getManagedSecret } from '../infrastructure/secret-store';

const PLATFORM_BACKEND_URL = process.env.PLATFORM_BACKEND_URL;
const SERVICE_TOKEN = getManagedSecret('AGENT_TEAMS_SERVICE_TOKEN');

export interface AgentTeamsConversation {
  conversationId: string;
  scope: 'personal' | 'channel' | 'groupChat';
  conversationReference: Record<string, unknown>;
}

const CACHE_TTL_MS = 60_000;
const convCache = new Map<string, { value: AgentTeamsConversation[]; cachedAt: number }>();

function cacheKey(tenantId: string, agentId: string): string {
  return `${tenantId}:${agentId}`;
}

function assertConfigured(): void {
  if (!PLATFORM_BACKEND_URL) throw new Error('PLATFORM_BACKEND_URL is required for agent-teams-client');
  if (!SERVICE_TOKEN) throw new Error('AGENT_TEAMS_SERVICE_TOKEN is required for agent-teams-client');
}

/** List the conversations the agent is reachable in (cached 60s). */
export async function listAgentTeamsConversations(
  tenantId: string,
  agentId: string,
): Promise<AgentTeamsConversation[]> {
  const key = cacheKey(tenantId, agentId);
  const cached = convCache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;

  assertConfigured();
  try {
    const url = new URL(`${PLATFORM_BACKEND_URL}/api/internal/agent-teams/conversations`);
    url.searchParams.set('tenantId', tenantId);
    url.searchParams.set('agentId', agentId);
    const res = await fetch(url.toString(), {
      headers: { 'X-Service-Auth': SERVICE_TOKEN!, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { conversations: AgentTeamsConversation[] };
    convCache.set(key, { value: body.conversations, cachedAt: Date.now() });
    return body.conversations;
  } catch (err) {
    logger.warn({ tenantId, agentId, err: (err as Error).message }, 'listAgentTeamsConversations failed');
    return [];
  }
}

export interface SendTeamsActivityInput {
  tenantId: string;
  agentId: string;
  conversationId: string;
  text: string;
  kind: 'message' | 'reply' | 'update';
  messageId?: string;
}

/** Post (or edit) a message via platform-backend's bot adapter. */
export async function sendTeamsActivity(
  input: SendTeamsActivityInput,
): Promise<{ activityId: string | null }> {
  assertConfigured();
  const res = await fetch(`${PLATFORM_BACKEND_URL}/api/internal/agent-teams/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Auth': SERVICE_TOKEN! },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`sendTeamsActivity HTTP ${res.status}`);
  return res.json() as Promise<{ activityId: string | null }>;
}

export async function getTeamsUserInfo(
  tenantId: string,
  aadUserId: string,
): Promise<{ aadUserId: string; displayName: string | null; email: string | null }> {
  assertConfigured();
  const url = new URL(`${PLATFORM_BACKEND_URL}/api/internal/agent-teams/user-info`);
  url.searchParams.set('tenantId', tenantId);
  url.searchParams.set('aadUserId', aadUserId);
  const res = await fetch(url.toString(), {
    headers: { 'X-Service-Auth': SERVICE_TOKEN!, accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`getTeamsUserInfo HTTP ${res.status}`);
  return res.json() as Promise<{ aadUserId: string; displayName: string | null; email: string | null }>;
}

export async function sendTeamsDm(input: {
  tenantId: string;
  agentId: string;
  aadUserId: string;
  text: string;
}): Promise<{ delivered: boolean; activityId?: string | null; installed?: boolean }> {
  assertConfigured();
  const res = await fetch(`${PLATFORM_BACKEND_URL}/api/internal/agent-teams/send-dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Auth': SERVICE_TOKEN! },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`sendTeamsDm HTTP ${res.status}`);
  return res.json() as Promise<{ delivered: boolean; activityId?: string | null; installed?: boolean }>;
}

export async function getTeamsThread(
  tenantId: string,
  conversationId: string,
  messageId: string,
): Promise<{ messages: Array<Record<string, unknown>> }> {
  assertConfigured();
  const url = new URL(`${PLATFORM_BACKEND_URL}/api/internal/agent-teams/thread`);
  url.searchParams.set('tenantId', tenantId);
  url.searchParams.set('conversationId', conversationId);
  url.searchParams.set('messageId', messageId);
  const res = await fetch(url.toString(), {
    headers: { 'X-Service-Auth': SERVICE_TOKEN!, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`getTeamsThread HTTP ${res.status}`);
  return res.json() as Promise<{ messages: Array<Record<string, unknown>> }>;
}

export interface PostReviewCardInput {
  reviewId: string;
  tenantId: string;
  agentId: string;
  /** Messaging specialization (outbound Teams tool): the draft to preview. */
  draftText?: string;
  assigneeAccountIds: string[];
  /** Generic gated-tool card content (see agent-execution/hitl-card-content.ts).
   *  Present instead of draftText for non-messaging gated tools. */
  action?: string;
  why?: string | null;
  detail?: string | null;
}

export async function postReviewCard(input: PostReviewCardInput): Promise<{
  totalAssignees: number;
  delivered: number;
  unreachable: string[];
}> {
  assertConfigured();
  const res = await fetch(`${PLATFORM_BACKEND_URL}/api/internal/agent-teams/post-review-card`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Auth': SERVICE_TOKEN! },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`postReviewCard HTTP ${res.status}`);
  return res.json() as Promise<{ totalAssignees: number; delivered: number; unreachable: string[] }>;
}

/** `hitlLevel` matters: authority is per level, so a member assignee who can
 *  take a level 2 gate must be routed past on a level 1. Omitting it defaults
 *  to 2 server-side, which over-routes level 1 gates to people who cannot act.
 *
 *  Only 1 and 2 are sent — see the note on the Slack client's copy of this
 *  function. A level outside the range 400s the endpoint rather than selecting
 *  a different audience, and the caller records that as "reached nobody". */
export async function listAgentAssignees(
  tenantId: string,
  agentId: string,
  hitlLevel?: number,
): Promise<string[]> {
  assertConfigured();
  const levelParam = hitlLevel === 1 || hitlLevel === 2 ? `&hitlLevel=${hitlLevel}` : '';
  const res = await fetch(
    `${PLATFORM_BACKEND_URL}/api/internal/agent-teams/assignees?tenantId=${tenantId}&agentId=${agentId}${levelParam}`,
    { method: 'GET', headers: { 'X-Service-Auth': SERVICE_TOKEN! }, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`listAgentAssignees HTTP ${res.status}`);
  const body = (await res.json()) as { assigneeAccountIds: string[] };
  return body.assigneeAccountIds;
}

/** Test-only: clear caches. */
export function _clearAgentTeamsClientCache(): void {
  convCache.clear();
}
