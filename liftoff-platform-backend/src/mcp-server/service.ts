// MCP Server Tool Handlers
//
// The rule that shapes this surface: a connected tool lets a person do what
// the dashboard lets them do, no more and no less. Identity is ALWAYS derived
// from the auth context — never from params.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { oversightService } from '../internal-agent-oversight/service';
import { resolveAgentHitlLevel } from '../internal-agent-oversight/types';
import { getQueryEmbedding } from '../internal-agents/embedding-service';
import { checkChatAdmission } from '../agent-chat/admission';
import { enqueueChatRunTask } from './chat-run-dispatch';
import { cancelThreadContinuations } from '../chat-continuations/store';
import {
  MCP_ASSISTANT_TARGETS,
  assistantByKind,
  type McpAssistantKind,
} from './assistant-targets';
import { checkAndIncrementLiftoffRateLimit } from '../liftoff/rate-limiter';
import { checkAndIncrementInsightsRateLimit } from '../insights/rate-limiter';
import {
  createThread as createLiftoffThread,
  listThreads as listLiftoffThreads,
} from '../liftoff/chat-repository';
import {
  createThread as createInsightsThread,
  listThreads as listInsightsThreads,
} from '../insights/chat-repository';
import { listThreads as listAgentChatThreads } from '../agent-chat/chat-repository';
import { listTeamPlanThreads } from '../workforce-plans/team-plan-thread-client';
import { externalAgentService } from '../external-agents/service';
import { createPairedTeamPlanThread, CAIODelegationError } from '../liftoff/caio-delegation';
import type { McpActor } from './actor';
import {
  ConversationShareError,
  conversationIdForThread,
  conversationLink,
  threadForConversationId,
  threadKindForConversationKind,
} from './conversation-id';
import { MAX_INLINE_MEDIA_BYTES, type ChatInput, type GetChatReplyInput, type DelegateTaskInput, type ListConversationsInput, type ListLearnedContextInput, type RemoveLearnedContextInput } from './types';
import { MAX_MEDIA_ATTACHMENTS, countAttachments, type ChatAttachment } from '../chat-attachments';
import {
  MediaContentMismatchError,
  MediaScreeningRefusedError,
  UnsupportedMediaTypeError,
  storeInboundMedia,
  type InboundSurface,
} from '../media/inbound';
import { canConverseWithAgents } from '../common/agent-conversation-gate';
import { ROLE_HIERARCHY } from '../tenant-members/types';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// Rate limit store for searchConnectorContent: 30 req/min per token
const searchConnectorRateLimitStore = new Map<string, { count: number; windowStart: number }>();
const SEARCH_CONNECTOR_RATE_LIMIT_MAX = 30;

function checkSearchConnectorRateLimit(keyId: string): boolean {
  const now = Date.now();
  const entry = searchConnectorRateLimitStore.get(keyId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    searchConnectorRateLimitStore.set(keyId, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= SEARCH_CONNECTOR_RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// ── liftoff_find_teammates ─────────────────────────────────────────────

/** The three platform assistants as roster entries. They are not database rows
 *  (see assistant-targets.ts), so roster and search both add them in code:
 *  type 'assistant', addressed by name or reserved id through liftoff_chat. */
function assistantRosterEntries(query?: string): Array<{
  id: string; type: 'assistant'; role: string; name: string; summary: string;
}> {
  const q = query?.toLowerCase().trim();
  return MCP_ASSISTANT_TARGETS
    .filter((a) => !q
      || a.name.toLowerCase().includes(q)
      || a.summary.toLowerCase().includes(q)
      || a.id.includes(q))
    .map((a) => ({
      id: a.id,
      type: 'assistant' as const,
      role: a.name,
      name: a.name,
      summary: a.summary.substring(0, 100),
    }));
}

/** The external agents as roster entries. They are not in the
 *  internal_agents roster SQL (their own table), so roster and search both
 *  add them in code: type 'external_agent', visible on every surface (D8),
 *  and `chat: false` — a collaborator is a system the teams work with, not a
 *  conversation partner, so liftoff_chat refuses it by name. */
async function collaboratorRosterEntries(tenantId: string, query?: string): Promise<Array<{
  id: string; type: 'external_agent'; name: string; summary: string | null; status: string;
  collaborationMode: string; chat: false;
}>> {
  let collaborators;
  try {
    collaborators = await externalAgentService.listAllByTenant(tenantId);
  } catch (err) {
    log.warn({ error: (err as Error).message, tenantId }, 'mcp find_teammates: collaborator listing failed');
    return [];
  }
  const q = query?.toLowerCase().trim();
  return collaborators
    .filter((c) => !q
      || c.name.toLowerCase().includes(q)
      || (c.description ?? '').toLowerCase().includes(q))
    .map((c) => ({
      id: c.id,
      type: 'external_agent' as const,
      name: c.name,
      summary: c.description ? c.description.slice(0, 100) : null,
      status: c.status,
      collaborationMode: c.collaborationMode,
      chat: false as const,
    }));
}

export async function findTeammates(
  params: {
    query?: string;
    limit?: number;
    callerAgentId?: string;
    callerThreadId?: string;
    callerInvocationId?: string;
  },
  actor: McpActor,
): Promise<object> {
  const { tenantId } = actor;

  // Roster mode (plan v2.1): no query = enumerate the full active roster.
  // Enumeration is not search — no embedding call, ordered by role, cap 50.
  if (!params.query) {
    const rosterLimit = Math.min(params.limit ?? 50, 50);
    const roster = await withTenantScope(tenantId, (client) => client.query(
      `SELECT id, role, messaging_nickname, summary, 'internal_agent' AS type
       FROM internal_agents
       WHERE tenant_id = $1 AND status = 'active' AND deleted_at IS NULL
       ORDER BY role
       LIMIT $2`,
      [tenantId, rosterLimit],
    ));
    const teammates = [
      ...assistantRosterEntries(),
      ...roster.rows.map((r: { id: string; role: string; messaging_nickname: string | null; summary: string | null; type: string }) => ({
        id: r.id, type: r.type, role: r.role,
        name: r.messaging_nickname || r.role,
        summary: r.summary ? r.summary.substring(0, 100) : null,
      })),
      ...await collaboratorRosterEntries(tenantId),
    ];
    return { teammates, total: teammates.length };
  }

  // Unified cap (v6.1 audit fix D8): search and roster both honor up to 50,
  // matching the manifest and Zod schema.
  const limit = Math.min(params.limit ?? 10, 50);

  const query = params.query;
  // Escape LIKE wildcards — used for CC/MCP-token name/email search and ILIKE fallback
  const escaped = query.replace(/[%_\\]/g, '\\$&');
  const pattern = `%${escaped}%`;

  // Attempt semantic vector search; fall back to ILIKE if embedding unavailable
  const queryEmbedding = await getQueryEmbedding(query, {
    tenantId,
    agentId: params.callerAgentId,
    threadId: params.callerThreadId,
    invocationId: params.callerInvocationId,
  });

  // Backfill toggle mirrors src/knowledge/repository.ts: until
  // KNOWLEDGE_EMBEDDING_V2_READ=true, read capability_embedding (v1); after,
  // capability_embedding_v2. Migration 239 removes the conditional.
  const readsV2 = process.env.KNOWLEDGE_EMBEDDING_V2_READ === 'true';
  const capCol = readsV2 ? 'capability_embedding_v2' : 'capability_embedding';

  return withTenantScope(tenantId, async (client) => {
    let agentsResult: { rows: Array<{ id: string; role: string; messaging_nickname: string | null; summary: string | null; type: string; similarity?: number }> };

    if (queryEmbedding) {
      // Semantic search: rank by cosine similarity, only over agents with stored embeddings
      const vectorResult = await client.query(
        `SELECT id, role, messaging_nickname, summary, 'internal_agent' AS type,
                1 - (${capCol} <=> $1::vector) AS similarity
         FROM internal_agents
         WHERE tenant_id = $2
           AND status = 'active'
           AND deleted_at IS NULL
           AND ${capCol} IS NOT NULL
         ORDER BY ${capCol} <=> $1::vector
         LIMIT $3`,
        [`[${queryEmbedding.join(',')}]`, tenantId, limit],
      );
      // Also run ILIKE for agents not yet embedded and merge (deduplicated by id)
      const ilikeResult = await client.query(
        `SELECT id, role, messaging_nickname, summary, 'internal_agent' AS type, NULL::float AS similarity
         FROM internal_agents
         WHERE tenant_id = $1
           AND status = 'active'
           AND deleted_at IS NULL
           AND ${capCol} IS NULL
           AND (role ILIKE $2 OR responsibilities ILIKE $2 OR summary ILIKE $2 OR messaging_nickname ILIKE $2)
         ORDER BY role
         LIMIT $3`,
        [tenantId, pattern, limit],
      );
      const seen = new Set(vectorResult.rows.map((r: { id: string }) => r.id as string));
      const merged = [
        ...vectorResult.rows,
        ...ilikeResult.rows.filter((r: { id: string }) => !seen.has(r.id)),
      ];
      agentsResult = { rows: merged };
    } else {
      // Pure ILIKE fallback when embedding generation fails
      agentsResult = await client.query(
        `SELECT id, role, messaging_nickname, summary, 'internal_agent' AS type, NULL::float AS similarity
         FROM internal_agents
         WHERE tenant_id = $1
           AND status = 'active'
           AND deleted_at IS NULL
           AND (role ILIKE $2 OR responsibilities ILIKE $2 OR summary ILIKE $2 OR messaging_nickname ILIKE $2)
         ORDER BY role
         LIMIT $3`,
        [tenantId, `%${escaped}%`, limit],
      );
    }

    // MCP collab tokens (active, not expired, same tenant). Identity
    // surface: deliberately includes BOTH auth kinds — an OAuth-linked
    // person is a real teammate (plan v6.1 static-query audit rule).
    const collabResult = await client.query(
      `SELECT m.id, m.name, a.email, 'collab' AS type
       FROM mcp_tokens m
       JOIN accounts a ON a.id = m.account_id
       WHERE m.tenant_id = $1 AND m.status = 'active'
         AND m.expires_at > NOW() AND m.deleted_at IS NULL
         AND (m.name ILIKE $2 OR a.email ILIKE $2)
       ORDER BY m.created_at DESC
       LIMIT $3`,
      [tenantId, pattern, limit],
    );

    const results = [
      ...assistantRosterEntries(query),
      ...agentsResult.rows.map(r => ({
        id: r.id, type: r.type, role: r.role,
        name: r.messaging_nickname || r.role,
        summary: r.summary ? r.summary.substring(0, 100) : null,
        ...(r.similarity != null && { similarity: Math.round((r.similarity as number) * 1000) / 1000 }),
      })),
      ...collabResult.rows.map(r => ({
        id: r.id, type: r.type, name: r.name, email: r.email,
      })),
      ...await collaboratorRosterEntries(tenantId, query),
    ].slice(0, limit);

    return { teammates: results, total: results.length };
  });
}

// ── liftoff_search_connector_content ──────────────────────────────────

export async function searchConnectorContent(
  params: { query: string; connectorType?: string; limit?: number; agentId?: string },
  actor: McpActor,
): Promise<object> {
  if (!checkSearchConnectorRateLimit(actor.keyId)) {
    return { success: false, error: 'Rate limit exceeded (30/min)' };
  }

  const { tenantId } = actor;
  const { results, coverage } = await tenantRuntimeClient.searchConnectorContent(tenantId, {
    query: params.query,
    connectorType: params.connectorType,
    limit: params.limit ?? 10,
    agentId: params.agentId,
  });
  // Coverage honesty: this index holds only content previously fetched by
  // tool calls, so an empty result never proves absence at the source.
  return {
    results,
    coverage,
    coverageNote:
      'This search covers only content previously fetched from connectors'
      + (coverage?.newestIndexedAt
        ? ` (indexed ${coverage.indexedItems} items, newest ${coverage.newestIndexedAt}).`
        : ' (nothing indexed yet for this scope).')
      + ' No results means "not in what has been fetched so far", not "does not exist" — query the connector directly to be sure.',
  };
}

// ── Team name resolution (plan v6.1 Phase 5, v2.1 contract) ────────────
//
// Auto-accept ONLY on (1) exact case-insensitive nickname/role match or
// (2) normalized (trim/collapse/casefold) match. Anything fuzzier returns
// the semantically-RANKED candidates and the calling model — which has the
// conversation context — picks and retries. Semantic search RANKS, it never
// auto-fires; there is no threshold to calibrate and a misdirected message
// is structurally impossible.

interface ResolvedTeam {
  /** Which surface answers: a tenant agent, or one of the three platform
   *  assistants (Liftoff, the Chief AI Officer, the Insights Manager). */
  kind: 'agent' | McpAssistantKind;
  /** internal_agents.id for a team; the reserved id ('liftoff' / 'caio' /
   *  'insights') for an assistant. Field name kept for wire compatibility:
   *  every chat result echoes it as team.agentId. */
  agentId: string;
  name: string;
  role: string;
}

type TeamResolution =
  | { resolved: ResolvedTeam }
  | { ambiguous: Array<{ agentId: string; name: string; role: string }> }
  /** The name or id names an external agent: visible in the roster,
   *  but not a conversation partner. */
  | { collaborator: { id: string; name: string } };

function normalizeTeamName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

async function resolveTeam(tenantId: string, team: string): Promise<TeamResolution> {
  const roster = await withTenantScope(tenantId, (client) => client.query(
    `SELECT id, role, messaging_nickname FROM internal_agents
     WHERE tenant_id = $1 AND status = 'active' AND deleted_at IS NULL
     ORDER BY role
     LIMIT 200`,
    [tenantId],
  ));
  const rows = roster.rows as Array<{ id: string; role: string; messaging_nickname: string | null }>;

  // One candidate list: the three platform assistants (matched on name and
  // reserved id) alongside the tenant teams (matched on role and nickname).
  // A tenant team named like an assistant is a real collision and comes back
  // ambiguous rather than either one shadowing the other.
  const candidates: Array<ResolvedTeam & { matchNames: string[] }> = [
    ...MCP_ASSISTANT_TARGETS.map((a) => ({
      kind: a.kind, agentId: a.id, name: a.name, role: a.name,
      matchNames: [a.name, a.id],
    })),
    ...rows.map((r) => ({
      kind: 'agent' as const, agentId: r.id,
      name: r.messaging_nickname || r.role, role: r.role,
      matchNames: r.messaging_nickname ? [r.role, r.messaging_nickname] : [r.role],
    })),
  ];
  const toResolved = (c: ResolvedTeam & { matchNames: string[] }): ResolvedTeam =>
    ({ kind: c.kind, agentId: c.agentId, name: c.name, role: c.role });

  // Tier 1: exact case-insensitive match.
  const lower = team.toLowerCase();
  const exact = candidates.filter((c) => c.matchNames.some((n) => n.toLowerCase() === lower));
  if (exact.length === 1) {
    return { resolved: toResolved(exact[0]) };
  }

  // Tier 2: normalized match.
  const norm = normalizeTeamName(team);
  const normalized = candidates.filter(
    (c) => c.matchNames.some((n) => normalizeTeamName(n) === norm),
  );
  if (normalized.length === 1) {
    return { resolved: toResolved(normalized[0]) };
  }
  if (exact.length > 1 || normalized.length > 1) {
    const dupes = (exact.length > 1 ? exact : normalized)
      .map((c) => ({ agentId: c.agentId, name: c.name, role: c.role }));
    return { ambiguous: dupes };
  }

  // A collaborator addressed by name is refused by name rather than ranked
  // as a near miss: it exists, and the answer is that it has no conversation.
  const collaborators = await collaboratorRosterEntries(tenantId);
  const collaboratorHit = collaborators.find((c) => c.name.toLowerCase() === lower || normalizeTeamName(c.name) === norm);
  if (collaboratorHit) {
    return { collaborator: { id: collaboratorHit.id, name: collaboratorHit.name } };
  }

  // No auto-accept: return semantically-ranked candidates. Reuse the
  // findTeammates ranking (embedding when available, ILIKE fallback), which
  // includes the platform assistants.
  const ranked = await findTeammates({ query: team, limit: 5 }, { tenantId } as McpActor) as {
    teammates: Array<{ id: string; type: string; name?: string; role?: string }>;
  };
  const rankedCandidates = ranked.teammates
    .filter((t) => t.type === 'internal_agent' || t.type === 'assistant')
    .map((t) => ({ agentId: t.id, name: t.name ?? t.role ?? '', role: t.role ?? '' }));
  return { ambiguous: rankedCandidates };
}

async function resolveAddress(
  tenantId: string,
  params: { agent?: string; team?: string; agentId?: string },
): Promise<TeamResolution> {
  if (params.agentId) {
    const r = await withTenantScope(tenantId, (client) => client.query(
      `SELECT id, role, messaging_nickname FROM internal_agents
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [params.agentId, tenantId],
    ));
    if (r.rows.length === 0) {
      // A UUID that names no team may name a collaborator.
      const collaborator = await externalAgentService.get(params.agentId, tenantId).catch(() => null);
      if (collaborator) return { collaborator: { id: collaborator.id, name: collaborator.name } };
      return { ambiguous: [] };
    }
    const row = r.rows[0] as { id: string; role: string; messaging_nickname: string | null };
    // A UUID can only name a tenant team; the assistants have reserved
    // non-UUID ids and are addressed by name.
    return { resolved: { kind: 'agent', agentId: row.id, name: row.messaging_nickname || row.role, role: row.role } };
  }
  return resolveTeam(tenantId, (params.agent ?? params.team) as string);
}

// ── liftoff_delegate_task (dual addressing; v6.1 caller contract) ──────

export async function delegateTask(
  params: z.infer<typeof DelegateTaskInput>,
  actor: McpActor,
): Promise<object> {
  if (!canConverseWithAgents(actor.role)) {
    return {
      success: false,
      error: 'Your access to this workspace is view only, so you cannot hand work to an agent. An owner or an admin of the workspace can.',
    };
  }
  const { tenantId, keyId } = actor;

  const resolution = await resolveAddress(tenantId, params);
  if ('ambiguous' in resolution) {
    return {
      success: false,
      error: 'ambiguous',
      candidates: resolution.ambiguous,
    };
  }
  if ('collaborator' in resolution) {
    return {
      success: false,
      error: 'collaborators_have_no_conversation',
      collaborator: resolution.collaborator,
    };
  }
  const team = resolution.resolved;

  // The platform assistants are conversational surfaces with no task queue:
  // there is nothing to enqueue a background objective onto. Resolved first so
  // the refusal can name what the caller reached and where to go instead.
  if (team.kind !== 'agent') {
    return {
      success: false,
      error: `${team.name} answers conversationally and takes no background tasks. Use liftoff_chat to talk to it.`,
    };
  }

  // Delegation keeps status='active' (migration-160 semantics; deliberate
  // divergence from chat's non-deleted web parity — documented in the plan).
  const agentRows = await withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, autonomy_override FROM internal_agents
       WHERE id = $1 AND tenant_id = $2 AND status = 'active' AND deleted_at IS NULL`,
      [team.agentId, tenantId],
    );
    return result.rows;
  });
  if (agentRows.length === 0) {
    return { success: false, error: 'agent not found, or not active' };
  }

  const oversightSettings = await oversightService.getOrCreateOversightSettings(tenantId);
  const hitlLevel = resolveAgentHitlLevel(agentRows[0].autonomy_override, oversightSettings.autonomy);

  try {
    await tenantRuntimeClient.enqueueAgentTask(tenantId, team.agentId, {
      objective: params.objective,
      context: params.context ?? {},
      triggeredBy: 'claude_code',
      // The run-level idempotency key, so one delegation delivered twice runs
      // once. Per DELEGATION, not per key: keyed on the key alone, every later
      // delegation from the same MCP key was a redelivery of the first and
      // replayed its cached result — an agent could be delegated to exactly
      // once per key, ever. The a2a path keys per task for the same reason.
      triggerRef: `mcp-delegate:${keyId}:${randomUUID()}`,
      hitlLevel,
      escalationLevel: oversightSettings.escalation,
      requestedByType: 'mcp_key',
      requestedById: keyId,
    });
  } catch (err) {
    // v6.1 contract: 'queued' ONLY on a successful enqueue.
    log.error({ error: (err as Error).message, tenantId, agentId: team.agentId }, 'mcp delegate enqueue failed');
    return { success: false, error: 'enqueue_failed', team: { agentId: team.agentId, name: team.name } };
  }

  return { success: true, status: 'queued', team: { agentId: team.agentId, name: team.name } };
}

// ── Learned Context (list / remove) ────────────────────────────────────
//
// Dashboard parity, exactly: a connected tool may do with memory what a
// person can do on Update Team, and nothing more. That page lists one AI
// team's own Learned Context and removes one entry, behind
// requireMinRole('member') (src/internal-agents/router.ts); these two tools
// call the same runtime-client functions behind the same role floor, so the
// two surfaces cannot drift. No write, no search, and never the global
// memory layer, which is not exposed to a connected tool in either direction.

type LearnedContextResolution =
  | { team: { agentId: string; name: string } }
  | { refusal: object };

async function resolveLearnedContextTeam(
  params: { agent?: string; team?: string; agentId?: string },
  actor: McpActor,
): Promise<LearnedContextResolution> {
  // Same floor as the dashboard routes' requireMinRole('member').
  if (ROLE_HIERARCHY[actor.role] < ROLE_HIERARCHY.member) {
    return { refusal: { success: false, error: 'Viewers cannot manage Learned Context' } };
  }
  const resolution = await resolveAddress(actor.tenantId, params);
  if ('ambiguous' in resolution) {
    return { refusal: { success: false, error: 'ambiguous', candidates: resolution.ambiguous } };
  }
  if ('collaborator' in resolution) {
    return {
      refusal: {
        success: false,
        error: 'collaborators_have_no_learned_context',
        collaborator: resolution.collaborator,
      },
    };
  }
  if (resolution.resolved.kind !== 'agent') {
    return {
      refusal: {
        success: false,
        error: `${resolution.resolved.name} keeps no Learned Context. Only an agent has it.`,
      },
    };
  }
  return { team: { agentId: resolution.resolved.agentId, name: resolution.resolved.name } };
}

export async function listLearnedContext(
  params: z.infer<typeof ListLearnedContextInput>,
  actor: McpActor,
): Promise<object> {
  const resolution = await resolveLearnedContextTeam(params, actor);
  if ('refusal' in resolution) return resolution.refusal;
  const team = resolution.team;

  const result = await tenantRuntimeClient.listAgentMemories(actor.tenantId, team.agentId, {
    ...(params.limit ? { limit: params.limit } : {}),
    ...(params.cursor ? { cursor: params.cursor } : {}),
  });
  return {
    team,
    // The same fields the dashboard renders, plus the id the remove takes.
    memories: result.memories.map((m) => ({ id: m.id, content: m.content, createdAt: m.createdAt })),
    nextCursor: result.nextCursor,
    total: result.total,
  };
}

export async function removeLearnedContext(
  params: z.infer<typeof RemoveLearnedContextInput>,
  actor: McpActor,
): Promise<object> {
  const resolution = await resolveLearnedContextTeam(params, actor);
  if ('refusal' in resolution) return resolution.refusal;
  const team = resolution.team;

  try {
    await tenantRuntimeClient.deleteAgentMemory(actor.tenantId, team.agentId, params.memoryId);
  } catch (err) {
    // The runtime 404s a memory that does not exist or belongs to another
    // team; the dashboard route maps that the same way.
    if (((err as Error).message ?? '').includes('HTTP 404')) {
      return { success: false, error: 'Memory not found' };
    }
    throw err;
  }
  return { success: true, team };
}

// ── liftoff_chat (plan v6.1 Phase 5b: durable run + long-poll) ─────────

const MAX_CONCURRENT_CHATS_PER_TOKEN = 3;
// Per-token in-flight guard for concurrent liftoff_chat CALLS (nuisance
// guard; per-instance in-memory is fine — plan v6 decision).
const inFlightChats = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The two sentences a coding tool relays when a run is paused on a person.
// A decision can be made in this same session: the person asks Liftoff to
// review it (liftoff_chat to "Liftoff"), and Liftoff shows what the team is
// waiting to do and applies the decision when they say so; or they decide on
// the Liftoff dashboard. Either way the same run resumes.
const WAITING_ON_HUMAN_NOTE = 'This needs a decision from a person before it can finish. The person can ask Liftoff to review it (send "review what is waiting" to "Liftoff" with liftoff_chat, and Liftoff will show what the team is waiting to do and apply their decision), or decide on the Liftoff dashboard. After the decision the SAME run resumes; keep polling liftoff_get_chat_reply with this chatRunId to get the reply. Do not start a new message.';
const WAITING_ON_HUMAN_PAUSED_NOTE = 'This conversation is paused waiting for a decision from a person. The person can ask Liftoff to review it (send "review what is waiting" to "Liftoff" with liftoff_chat), or decide on the Liftoff dashboard; then poll liftoff_get_chat_reply with this chatRunId. The same run resumes and completes.';

interface RunRow {
  status: string;
  target_kind: string;
  assistant_message_id: string | null;
  reply_content: string | null;
  answered_by: string | null;
  approval_id: string | null;
  error_code: string | null;
  action_summary: string | null;
  why_summary: string | null;
  detail: string | null;
}

async function readRunResult(
  tenantId: string,
  chatRunId: string,
  /** The share id (conversation-id.ts), never the raw thread id. */
  conversationId: string,
  team: { agentId: string; name: string },
): Promise<object | null> {
  const r = await withTenantScope(tenantId, (client) => client.query(
    `SELECT status, target_kind, assistant_message_id, reply_content, answered_by, approval_id, error_code, action_summary, why_summary, detail
     FROM mcp_chat_runs WHERE id = $1`,
    [chatRunId],
  ));
  if (r.rows.length === 0) return null;
  const run = r.rows[0] as RunRow;

  if (run.status === 'completed') {
    let reply = '';
    if (run.target_kind !== 'agent') {
      // An assistant run's reply is denormalized onto the run row: the CAIO's
      // message row lives in workforce-service's database, so the run row is
      // the one local record, and the other two assistants use the same column
      // so this read has one branch.
      reply = run.reply_content ?? '';
    } else if (run.assistant_message_id) {
      const m = await withTenantScope(tenantId, (client) => client.query(
        `SELECT content FROM agent_chat_messages WHERE id = $1`,
        [run.assistant_message_id],
      ));
      reply = (m.rows[0]?.content as string) ?? '';
    }
    return {
      status: 'completed',
      reply,
      conversationId,
      link: conversationLink(conversationId),
      chatRunId,
      team,
      // Present only when a Liftoff run handed the reply to a colleague: the
      // words are theirs, and the caller is told to attribute them that way.
      ...(run.answered_by ? { answeredBy: run.answered_by } : {}),
    };
  }
  if (run.status === 'waiting_on_human') {
    return {
      status: 'waiting_on_human',
      conversationId,
      link: conversationLink(conversationId),
      chatRunId,
      team,
      // Generic HITL card summary (hitl-card-content.ts) so the coding tool can relay
      // what needs approving. Omitted when the generic-card flag was off at gate time.
      ...(run.action_summary ? { action: run.action_summary } : {}),
      ...(run.why_summary ? { why: run.why_summary } : {}),
      ...(run.detail ? { detail: run.detail } : {}),
      note: WAITING_ON_HUMAN_NOTE,
    };
  }
  if (run.status === 'failed') {
    return { status: 'failed', error: run.error_code ?? 'failed', conversationId, link: conversationLink(conversationId), chatRunId, team };
  }
  return null; // queued / running — not terminal
}

/** Validate-or-create the conversation and its queued run, or explain why not.
 *  The refusal object is the tool result the caller returns verbatim. */
type RunPreparation =
  | { chatRunId: string; threadId: string; conversationId: string }
  | { refusal: object };

/** Rate-limit admission for an assistant turn: exactly what the dashboard
 *  applies before the same turn. The CAIO's own service enforces its own
 *  admission on the call itself, so nothing is checked here for it. */
async function checkAssistantChatAdmission(
  kind: McpAssistantKind,
  tenantId: string,
  accountId: string,
): Promise<{ allowed: true } | { allowed: false; error: string; retryAfter?: number }> {
  if (kind === 'caio') return { allowed: true };
  const rate = kind === 'liftoff'
    ? await checkAndIncrementLiftoffRateLimit(tenantId, accountId)
    : await checkAndIncrementInsightsRateLimit(tenantId, accountId);
  if (rate.allowed) return { allowed: true };
  return {
    allowed: false,
    error: 'Rate limit exceeded',
    ...(rate.retryAfter != null ? { retryAfter: rate.retryAfter } : {}),
  };
}

/** The team path's validate-or-create, moved verbatim out of chat() so the
 *  assistant path below can sit beside it rather than inside it.
 *
 *  ONE transaction: validate-or-create thread + participant + queued run.
 *  The partial-unique active-per-thread index turns a concurrent second
 *  turn into a clean unique-violation → busy. The conversation id is resolved
 *  before the transaction (it is a share id, admitted by the same visibility
 *  rule the dashboard applies, so a thread born on the dashboard continues
 *  here) and minted after it for a new thread. */
async function prepareTeamRun(
  params: z.infer<typeof ChatInput>,
  actor: McpActor,
  team: { agentId: string; name: string },
  attachments: ChatAttachment[],
): Promise<RunPreparation> {
  const { tenantId, accountId, keyId, role } = actor;

  let existingThreadId: string | null = null;
  if (params.conversationId) {
    const resolved = await threadForConversationId({
      tenantId, accountId, role,
      conversationId: params.conversationId,
      legacy: { keyId, kind: 'agent' },
    });
    if (!resolved || resolved.threadKind !== 'agent') {
      return { refusal: { status: 'failed', error: 'conversation_not_found' } };
    }
    existingThreadId = resolved.threadId;
  }

  let created: { chatRunId: string; threadId: string };
  try {
    created = await withTenantScope(tenantId, async (client) => {
      let threadId = existingThreadId;
      if (threadId) {
        const p = await client.query(
          `SELECT 1 FROM agent_chat_thread_participants WHERE thread_id = $1 AND agent_id = $2`,
          [threadId, team.agentId],
        );
        if (p.rows.length === 0) {
          throw Object.assign(new Error('conversation_not_found'), { code: 'CONVERSATION_NOT_FOUND' });
        }
      } else {
        const t = await client.query(
          `INSERT INTO agent_chat_threads (tenant_id, account_id, channel, title)
           VALUES ($1, $2, 'mcp', $3)
           RETURNING id`,
          [tenantId, accountId, params.message.slice(0, 100)],
        );
        threadId = t.rows[0].id as string;
        await client.query(
          `INSERT INTO agent_chat_thread_participants (thread_id, agent_id, added_by, role)
           VALUES ($1, $2, $3, 'participant')
           ON CONFLICT (thread_id, agent_id) DO NOTHING`,
          [threadId, team.agentId, accountId],
        );
      }

      const run = await client.query(
        `INSERT INTO mcp_chat_runs (tenant_id, anchor_token_id, thread_id, agent_id, user_message, attachments)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [tenantId, keyId, threadId, team.agentId, params.message, attachments.length > 0 ? JSON.stringify(attachments) : null],
      );
      return { chatRunId: run.rows[0].id as string, threadId: threadId as string };
    });
  } catch (err) {
    const e = err as Error & { code?: string };
    if (e.code === 'CONVERSATION_NOT_FOUND') {
      return { refusal: { status: 'failed', error: 'conversation_not_found' } };
    }
    if (e.code === '23505' && existingThreadId) {
      // Active-run unique violation on the one-active-per-thread index. The
      // active set now includes 'waiting_on_human' (migration 296): a run
      // paused for approval keeps the thread occupied so a second turn can't
      // FORK it (the background resume would otherwise re-enter against a
      // conversation that has moved on). Distinguish the two cases so a paused
      // thread returns an actionable waiting status (→ Review) instead of a
      // generic 'busy'.
      const active = await withTenantScope(tenantId, (client) => client.query(
        `SELECT id, status FROM mcp_chat_runs
         WHERE thread_id = $1 AND status IN ('queued', 'running', 'waiting_on_human')
         ORDER BY created_at DESC LIMIT 1`,
        [existingThreadId],
      ));
      const activeRow = active.rows[0] as { id: string; status: string } | undefined;
      const conversationId = await conversationIdForThread({
        tenantId, accountId, threadId: existingThreadId, kind: 'agent', agentId: team.agentId,
      });
      if (activeRow?.status === 'waiting_on_human') {
        return {
          refusal: {
            status: 'waiting_on_human',
            conversationId,
            link: conversationLink(conversationId),
            chatRunId: activeRow.id,
            team,
            note: WAITING_ON_HUMAN_PAUSED_NOTE,
          },
        };
      }
      return {
        refusal: {
          status: 'busy',
          error: 'A turn is already running on this conversation',
          ...(activeRow ? { activeChatRunId: activeRow.id } : {}),
          conversationId,
          link: conversationLink(conversationId),
          team,
        },
      };
    }
    throw err;
  }

  return {
    ...created,
    conversationId: await shareForPreparedRun(tenantId, accountId, created, 'agent', team.agentId),
  };
}

/** Mint (or find) the share for a freshly prepared run. The run row already
 *  exists; if the share cannot be written there is no id to hand back, so the
 *  run is settled as failed rather than left queued behind an error. */
async function shareForPreparedRun(
  tenantId: string,
  accountId: string,
  created: { chatRunId: string; threadId: string },
  kind: McpAssistantKind | 'agent',
  agentId?: string,
): Promise<string> {
  try {
    return await conversationIdForThread({ tenantId, accountId, threadId: created.threadId, kind, agentId });
  } catch (err) {
    await withTenantScope(tenantId, (client) => client.query(
      `UPDATE mcp_chat_runs SET status = 'failed', error_code = 'share_failed', completed_at = NOW()
       WHERE id = $1 AND status = 'queued'`,
      [created.chatRunId],
    )).catch(() => undefined);
    throw err;
  }
}

/** The assistant path's validate-or-create. Unlike the team path this cannot
 *  be one transaction: a Chief AI Officer thread is created by an HTTP call
 *  into workforce-service. The run insert still hits the one-active-per-thread
 *  unique index, so a concurrent second turn comes back busy exactly as it
 *  does for a team. */
async function prepareAssistantRun(
  kind: McpAssistantKind,
  params: z.infer<typeof ChatInput>,
  actor: McpActor,
  team: { agentId: string; name: string },
  attachments: ChatAttachment[],
): Promise<RunPreparation> {
  const { tenantId, accountId, keyId, role } = actor;

  let threadId: string | null = null;
  if (params.conversationId) {
    // The share is admitted by the same visibility rule the dashboard
    // applies, and its kind must be the assistant the caller addressed: a
    // Liftoff share continued as the Insights Manager is not that conversation.
    const resolved = await threadForConversationId({
      tenantId, accountId, role,
      conversationId: params.conversationId,
      legacy: { keyId, kind },
    });
    if (!resolved || resolved.threadKind !== threadKindForConversationKind(kind)) {
      return { refusal: { status: 'failed', error: 'conversation_not_found' } };
    }
    threadId = resolved.threadId;
  } else if (kind === 'liftoff') {
    threadId = (await createLiftoffThread({ tenantId, accountId })).id;
  } else if (kind === 'insights') {
    threadId = (await createInsightsThread({ tenantId, accountId })).id;
  } else {
    // The CAIO's threads live in workforce-service; creating one carries the
    // caller's real tenant role, which that service authorizes against.
    try {
      threadId = await createPairedTeamPlanThread({ caller: { tenantId, accountId, role } });
    } catch (err) {
      if (err instanceof CAIODelegationError) {
        return { refusal: { status: 'failed', error: 'assistant_unreachable', team } };
      }
      throw err;
    }
  }

  // A person's message cancels the work queued to continue an earlier one
  // on this conversation (the stream routers do the same): a queued task
  // simply waits for the thread lock, so the lock alone cancels nothing.
  await cancelThreadContinuations(tenantId, threadId);

  let created: { chatRunId: string; threadId: string };
  try {
    const run = await withTenantScope(tenantId, (client) => client.query(
      `INSERT INTO mcp_chat_runs (tenant_id, anchor_token_id, thread_id, agent_id, user_message, target_kind, attachments)
       VALUES ($1, $2, $3, NULL, $4, $5, $6)
       RETURNING id`,
      [tenantId, keyId, threadId, params.message, kind, attachments.length > 0 ? JSON.stringify(attachments) : null],
    ));
    created = { chatRunId: run.rows[0].id as string, threadId };
  } catch (err) {
    if ((err as Error & { code?: string }).code === '23505') {
      // One-active-per-thread: an assistant turn is already running on this
      // conversation. Assistants never enter waiting_on_human, so this is
      // plain busy.
      const active = await withTenantScope(tenantId, (client) => client.query(
        `SELECT id FROM mcp_chat_runs
         WHERE thread_id = $1 AND status IN ('queued', 'running')
         ORDER BY created_at DESC LIMIT 1`,
        [threadId],
      ));
      const activeId = active.rows[0]?.id as string | undefined;
      const conversationId = await conversationIdForThread({ tenantId, accountId, threadId, kind });
      return {
        refusal: {
          status: 'busy',
          error: 'A turn is already running on this conversation',
          ...(activeId ? { activeChatRunId: activeId } : {}),
          conversationId,
          link: conversationLink(conversationId),
          team,
        },
      };
    }
    throw err;
  }

  return {
    ...created,
    conversationId: await shareForPreparedRun(tenantId, accountId, created, kind),
  };
}

/** The inbound-media surface a conversation kind lives on, so a stored
 *  upload is stamped with the thread and surface that will claim it. */
function inboundSurfaceFor(kind: McpAssistantKind | 'agent'): InboundSurface {
  switch (kind) {
    case 'agent': return 'agent_chat';
    case 'liftoff': return 'liftoff';
    case 'insights': return 'insights';
    case 'caio': return 'team_plan';
  }
}

/** The media cap over attachments and mediaInline together: pure validation,
 *  before anything is written. */
function checkMediaCount(params: z.infer<typeof ChatInput>): { refusal: object } | null {
  const inline = params.mediaInline ?? [];
  if (inline.length === 0) return null;
  const alreadyMedia = countAttachments(params.attachments ?? []).media;
  if (alreadyMedia + inline.length > MAX_MEDIA_ATTACHMENTS) {
    return { refusal: { status: 'rejected', error: 'too_much_media', message: `At most ${MAX_MEDIA_ATTACHMENTS} images or clips per message, counting attachments and mediaInline together` } };
  }
  return null;
}

/** Decode and store the inline media against the prepared run's thread,
 *  through the same inbound path the dashboard's upload route uses (type
 *  allow-list, byte check, screening). The base64 length was bounded by the
 *  schema; the decoded size is checked again here. A refusal names what was
 *  refused. */
async function storeInlineMedia(
  params: z.infer<typeof ChatInput>,
  tenantId: string,
  accountId: string,
  target: { threadId: string; surface: InboundSurface },
): Promise<{ media: ChatAttachment[] } | { refusal: object }> {
  const media: ChatAttachment[] = [];
  for (const item of params.mediaInline ?? []) {
    const bytes = Buffer.from(item.base64, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_INLINE_MEDIA_BYTES) {
      return { refusal: { status: 'rejected', error: 'media_too_large', message: `${item.name}: inline media is at most ${MAX_INLINE_MEDIA_BYTES / (1024 * 1024)} MiB decoded; send larger files from the dashboard` } };
    }
    try {
      const ref = await storeInboundMedia({
        tenantId, accountId, surface: target.surface, threadId: target.threadId,
        bytes, mimeType: item.mimeType, filename: item.name,
      });
      media.push({ kind: 'media', name: ref.filename, media: ref, addedAt: new Date().toISOString() });
    } catch (err) {
      if (err instanceof UnsupportedMediaTypeError || err instanceof MediaContentMismatchError || err instanceof MediaScreeningRefusedError) {
        return { refusal: { status: 'rejected', error: 'media_refused', message: `${item.name}: ${err.message}` } };
      }
      throw err;
    }
  }
  return { media };
}

/** Settle a run that was prepared and then could not be sent, so it is never
 *  left as a phantom 'queued' row. */
async function settlePreparedRun(tenantId: string, chatRunId: string, errorCode: string): Promise<void> {
  await withTenantScope(tenantId, (client) => client.query(
    `UPDATE mcp_chat_runs SET status = 'failed', error_code = $2, completed_at = NOW()
     WHERE id = $1 AND status = 'queued'`,
    [chatRunId, errorCode],
  )).catch(() => undefined);
}

export async function chat(
  params: z.infer<typeof ChatInput>,
  actor: McpActor,
): Promise<object> {
  if (!canConverseWithAgents(actor.role)) {
    return {
      success: false,
      error: 'Your access to this workspace is view only, so you cannot send a message to an agent or an assistant. An owner or an admin of the workspace can.',
    };
  }
  const { tenantId, accountId, keyId } = actor;

  const resolution = await resolveAddress(tenantId, params);
  if ('ambiguous' in resolution) {
    return { status: 'ambiguous', error: 'ambiguous', candidates: resolution.ambiguous };
  }
  if ('collaborator' in resolution) {
    // A collaborator is a system the teams work with, not a conversation
    // partner. The teams that work with it are reachable by name.
    return {
      status: 'rejected',
      error: 'collaborators_have_no_conversation',
      collaborator: resolution.collaborator,
    };
  }
  const resolved = resolution.resolved;
  const team = { agentId: resolved.agentId, name: resolved.name };

  const admission = resolved.kind === 'agent'
    ? await checkChatAdmission({ tenantId, accountId, agentId: team.agentId })
    : await checkAssistantChatAdmission(resolved.kind, tenantId, accountId);
  if (!admission.allowed) {
    return {
      status: 'rejected',
      error: admission.error,
      ...(admission.retryAfter != null ? { retryAfter: admission.retryAfter } : {}),
    };
  }

  const inFlight = inFlightChats.get(keyId) ?? 0;
  if (inFlight >= MAX_CONCURRENT_CHATS_PER_TOKEN) {
    return { status: 'busy', error: `Too many concurrent chats (max ${MAX_CONCURRENT_CHATS_PER_TOKEN})` };
  }
  inFlightChats.set(keyId, inFlight + 1);

  try {
    const overCap = checkMediaCount(params);
    if (overCap) return overCap.refusal;
    const uploads: ChatAttachment[] = [...(params.attachments ?? [])];

    // Validate-or-create the conversation and its queued run on the resolved
    // surface. Both preparers refuse with the exact tool result to return.
    // The run row carries the attachments the call sent; inline media is
    // stored next, against the thread the run now names, so a refusal here
    // stores nothing and a refused upload never sits unclaimed.
    const prepared = resolved.kind === 'agent'
      ? await prepareTeamRun(params, actor, team, uploads)
      : await prepareAssistantRun(resolved.kind, params, actor, team, uploads);
    if ('refusal' in prepared) return prepared.refusal;
    const { chatRunId, threadId, conversationId } = prepared;

    if ((params.mediaInline ?? []).length > 0) {
      const stored = await storeInlineMedia(params, tenantId, accountId, {
        threadId, surface: inboundSurfaceFor(resolved.kind),
      });
      if ('refusal' in stored) {
        await settlePreparedRun(tenantId, chatRunId, 'media_refused');
        return { ...stored.refusal, conversationId, link: conversationLink(conversationId), chatRunId, team };
      }
      const attachments = [...uploads, ...stored.media];
      await withTenantScope(tenantId, (client) => client.query(
        `UPDATE mcp_chat_runs SET attachments = $2 WHERE id = $1`,
        [chatRunId, JSON.stringify(attachments)],
      ));
    }

    // Enqueue the worker task. Failure compensation: the run must never be
    // left as a phantom 'queued' row.
    try {
      await enqueueChatRunTask(chatRunId, tenantId);
    } catch (err) {
      const e = err as Error & { code?: number };
      if (e.code !== 6) { // ALREADY_EXISTS = dedup, fine
        await settlePreparedRun(tenantId, chatRunId, 'enqueue_failed');
        log.error({ error: e.message, chatRunId }, 'mcp chat enqueue failed');
        return { status: 'failed', error: 'enqueue_failed', conversationId, link: conversationLink(conversationId), chatRunId, team };
      }
    }

    // Long-poll the durable run row up to waitSeconds.
    const deadline = Date.now() + (params.waitSeconds ?? 45) * 1000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const result = await readRunResult(tenantId, chatRunId, conversationId, team);
      if (result) return result;
    }
    return {
      status: 'in_progress',
      conversationId,
      link: conversationLink(conversationId),
      chatRunId,
      team,
      note: 'Still working. Fetch the result with liftoff_get_chat_reply.',
    };
  } finally {
    const n = (inFlightChats.get(keyId) ?? 1) - 1;
    if (n <= 0) inFlightChats.delete(keyId); else inFlightChats.set(keyId, n);
  }
}

// ── liftoff_get_chat_reply (side-effect-free read) ─────────────────────

export async function getChatReply(
  params: z.infer<typeof GetChatReplyInput>,
  actor: McpActor,
): Promise<object> {
  const { tenantId, keyId } = actor;

  // LEFT JOIN (audit BUG-7): a since-deleted agent must not make a
  // completed reply unreadable.
  const r = await withTenantScope(tenantId, (client) => client.query(
    `SELECT r.thread_id, r.agent_id, r.target_kind, a.role, a.messaging_nickname
     FROM mcp_chat_runs r
     LEFT JOIN internal_agents a ON a.id = r.agent_id
     WHERE r.id = $1 AND r.anchor_token_id = $2`,
    [params.chatRunId, keyId],
  ));
  if (r.rows.length === 0) {
    return { status: 'not_found', error: 'chatRunId not found for this connection' };
  }
  const row = r.rows[0] as { thread_id: string; agent_id: string | null; target_kind: string; role: string | null; messaging_nickname: string | null };
  // An assistant run has no internal_agents row to join; its identity is the
  // reserved target itself.
  const assistant = assistantByKind(row.target_kind);
  const team = assistant
    ? { agentId: assistant.id, name: assistant.name }
    : { agentId: row.agent_id as string, name: row.messaging_nickname || row.role || 'a former team' };

  // The reply is keyed on chatRunId; the conversation id it carries is the
  // thread's share id, minted here if the thread was never shared.
  const conversationId = await conversationIdForThread({
    tenantId,
    accountId: actor.accountId,
    threadId: row.thread_id,
    kind: assistant ? assistant.kind : 'agent',
    agentId: row.agent_id ?? undefined,
  });
  const result = await readRunResult(tenantId, params.chatRunId, conversationId, team);
  if (result) return result;
  return { status: 'in_progress', conversationId, link: conversationLink(conversationId), chatRunId: params.chatRunId, team };
}

// ── liftoff_list_conversations ─────────────────────────────────────────
//
// One list over the four surfaces a conversation can live on: agent chat (the
// agents), Liftoff, the Insights Manager, and the Chief AI Officer (whose
// threads live in workforce-service). Visibility is each surface's own listing
// rule — tenant-wide on the three local ones since migration 351, workforce's
// rule for the fourth — so a viewer sees what a member sees. Every row carries
// the share id as its conversationId, minted here if the thread was never
// shared, and the one link the product hands out.

interface ConversationRow {
  threadId: string;
  kind: McpAssistantKind | 'agent';
  agentId: string | null;
  title: string | null;
  updatedAt: string;
}

export async function listConversations(
  params: z.infer<typeof ListConversationsInput>,
  actor: McpActor,
): Promise<object> {
  const { tenantId, accountId, role } = actor;
  const limit = Math.min(params.limit ?? 20, 50);
  const titleQuery = params.query?.trim() || undefined;

  // A team filter narrows the fan-out to that team's threads or that
  // assistant's surface; an unresolvable name answers the way liftoff_chat
  // does, with ranked candidates, rather than an empty list.
  let only: ResolvedTeam | null = null;
  if (params.team) {
    const resolution = await resolveTeam(tenantId, params.team);
    if ('ambiguous' in resolution) {
      return { status: 'ambiguous', error: 'ambiguous', candidates: resolution.ambiguous };
    }
    if ('collaborator' in resolution) {
      return { status: 'rejected', error: 'collaborators_have_no_conversation', collaborator: resolution.collaborator };
    }
    only = resolution.resolved;
  }

  const wants = (kind: McpAssistantKind | 'agent'): boolean => !only || only.kind === kind;

  const [agentThreads, liftoffThreads, insightsThreads, teamPlanThreads] = await Promise.all([
    wants('agent')
      ? listAgentChatThreads(tenantId, accountId, { limit, titleQuery, agentId: only?.agentId ?? null })
      : Promise.resolve({ threads: [] as Array<{ id: string; title: string | null; updatedAt: string }> }),
    wants('liftoff')
      ? listLiftoffThreads(tenantId, accountId, { limit, titleQuery })
      : Promise.resolve({ threads: [] as Array<{ id: string; title: string | null; updatedAt: string }> }),
    wants('insights')
      ? listInsightsThreads(tenantId, accountId, { limit, titleQuery })
      : Promise.resolve({ threads: [] as Array<{ id: string; title: string | null; updatedAt: string }> }),
    wants('caio')
      ? listTeamPlanThreads({ tenantId, accountId, role }, { limit, query: titleQuery })
      : Promise.resolve([] as Array<{ id: string; title: string | null; updatedAt: string }>),
  ]);

  const rows: ConversationRow[] = [
    ...agentThreads.threads.map((t) => ({ threadId: t.id, kind: 'agent' as const, agentId: null, title: t.title, updatedAt: t.updatedAt })),
    ...liftoffThreads.threads.map((t) => ({ threadId: t.id, kind: 'liftoff' as const, agentId: null, title: t.title, updatedAt: t.updatedAt })),
    ...insightsThreads.threads.map((t) => ({ threadId: t.id, kind: 'insights' as const, agentId: null, title: t.title, updatedAt: t.updatedAt })),
    ...teamPlanThreads.map((t) => ({ threadId: t.id, kind: 'caio' as const, agentId: null, title: t.title, updatedAt: t.updatedAt })),
  ]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit);

  if (rows.length === 0) return { conversations: [], total: 0 };

  const threadIds = rows.map((r) => r.threadId);
  const teamThreadIds = rows.filter((r) => r.kind === 'agent').map((r) => r.threadId);

  // The team behind each agent-chat thread (its first participant), and which
  // threads are paused on a person: two set queries over the page, not one
  // per row.
  const { participants, waiting } = await withTenantScope(tenantId, async (client) => {
    const participants = new Map<string, { agentId: string; name: string }>();
    if (teamThreadIds.length > 0) {
      const p = await client.query(
        `SELECT DISTINCT ON (p.thread_id) p.thread_id, a.id, a.role, a.messaging_nickname
         FROM agent_chat_thread_participants p
         JOIN internal_agents a ON a.id = p.agent_id
         WHERE p.thread_id = ANY($1::uuid[])
         ORDER BY p.thread_id, p.added_at ASC`,
        [teamThreadIds],
      );
      for (const row of p.rows as Array<{ thread_id: string; id: string; role: string; messaging_nickname: string | null }>) {
        participants.set(row.thread_id, { agentId: row.id, name: row.messaging_nickname || row.role });
      }
    }
    const w = await client.query(
      `SELECT DISTINCT thread_id FROM mcp_chat_runs
       WHERE thread_id = ANY($1::uuid[]) AND status = 'waiting_on_human'`,
      [threadIds],
    );
    const waiting = new Set((w.rows as Array<{ thread_id: string }>).map((r) => r.thread_id));
    return { participants, waiting };
  });

  // A pause is a pause whichever surface started the turn: the runtime's
  // actionable queue names the thread each chat-born approval or
  // clarification paused, so a dashboard-born wait shows here too. A queue
  // that cannot be read leaves the MCP-run signal alone rather than failing
  // the list.
  const pageThreads = new Set(threadIds);
  try {
    const queue = await tenantRuntimeClient.listPendingApprovals(tenantId, { window: 'actionable', limit: 100 });
    for (const item of queue.items) {
      if (item.threadId && pageThreads.has(item.threadId)) waiting.add(item.threadId);
    }
  } catch (err) {
    log.warn({ tenantId, error: (err as Error).message }, 'mcp list_conversations: review queue unavailable; waitingOnHuman reads MCP runs only');
  }

  const conversations = (await Promise.all(rows.map(async (row) => {
    const team = row.kind === 'agent' ? (participants.get(row.threadId) ?? null) : null;
    const assistant = row.kind === 'agent' ? null : assistantByKind(row.kind);
    let conversationId: string;
    try {
      conversationId = await conversationIdForThread({
        tenantId,
        accountId,
        threadId: row.threadId,
        kind: row.kind,
        agentId: team?.agentId,
      });
    } catch (err) {
      if (err instanceof ConversationShareError) {
        // A team thread nothing participates in cannot be opened anywhere;
        // it is left out rather than listed with a link that opens nothing.
        log.warn({ tenantId, threadId: row.threadId }, 'mcp list_conversations: team thread without a participant left out');
        return null;
      }
      throw err;
    }
    return {
      conversationId,
      link: conversationLink(conversationId),
      ...(team ? { team } : {}),
      ...(assistant ? { assistant: { agentId: assistant.id, name: assistant.name } } : {}),
      title: row.title,
      lastActivityAt: row.updatedAt,
      waitingOnHuman: waiting.has(row.threadId),
    };
  }))).filter((c): c is NonNullable<typeof c> => c !== null);

  return { conversations, total: conversations.length };
}
