// HTTP client for platform-backend's /api/internal/agent-slack/* RPC.
//
// Resolves per-agent Slack installs (with bot tokens) and channel bindings.
// The bot tokens are returned by the server already resolved from Secret
// Manager — this client only forwards them to the slack-tool-handler.
//
// Caching: install lists are stable across invocations for a given (tenant,
// agent) but bot tokens can rotate. A short TTL (60s) gives ~zero cost
// across a typical agent burst while remaining responsive to install /
// uninstall / token-rotation events.

import { logger } from '../infrastructure/logging';
import { resolveInternalAgentId } from '../agent-lifecycle/resolve-runtime-agent-id';
import { getManagedSecret } from '../infrastructure/secret-store';

const PLATFORM_BACKEND_URL = process.env.PLATFORM_BACKEND_URL;
const SERVICE_TOKEN = getManagedSecret('AGENT_SLACK_SERVICE_TOKEN');

export interface AgentSlackInstall {
  installId: string;
  slackAppId: string;
  slackTeamId: string;
  slackTeamName: string | null;
  slackBotUserId: string | null;
  installedAt: string;
  botToken: string | null;
  /** 'workspace' = virtual install backed by the single Liftoff workspace
   *  app (ADR-040); absent for legacy per-agent installs. */
  kind?: 'workspace';
  /** Present on workspace installs: the agent's display name for
   *  chat:write.customize posting (per-message identity). */
  postAs?: { username: string } | null;
}

const CACHE_TTL_MS = 60_000;
const installsCache = new Map<
  string,
  { value: AgentSlackInstall[]; cachedAt: number }
>();

function cacheKey(tenantId: string, agentId: string): string {
  return `${tenantId}:${agentId}`;
}

function fresh<T>(entry: { value: T; cachedAt: number } | undefined): T | null {
  if (!entry) return null;
  return Date.now() - entry.cachedAt < CACHE_TTL_MS ? entry.value : null;
}

function assertConfigured(): void {
  if (!PLATFORM_BACKEND_URL) {
    throw new Error('PLATFORM_BACKEND_URL is required for agent-slack-client');
  }
  if (!SERVICE_TOKEN) {
    throw new Error('AGENT_SLACK_SERVICE_TOKEN is required for agent-slack-client');
  }
}

async function rpcGet<T>(path: string, query: Record<string, string>): Promise<T> {
  assertConfigured();
  const url = new URL(`${PLATFORM_BACKEND_URL}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { 'X-Service-Auth': SERVICE_TOKEN!, accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`agent-slack RPC ${path} returned HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetch all currently-installed Slack workspaces for an agent. Cached for
 * 60s per (tenant, agent). Returns an empty array when no install exists —
 * callers should treat that as "Slack tools not available for this agent".
 */
export async function listAgentSlackInstalls(
  tenantId: string,
  agentId: string,
): Promise<AgentSlackInstall[]> {
  const key = cacheKey(tenantId, agentId);
  const cached = fresh(installsCache.get(key));
  if (cached) return cached;

  try {
    // PB keys agent_slack_installs by the INTERNAL agent id, but every TR
    // caller holds the RUNTIME id (gateway/context agentId). The raw
    // pass-through silently emptied the install lookup for every mapped
    // agent once the id-space split landed (INV-TR-010) — Claude Coder's
    // April install existed the whole time while its chat catalog lost the
    // slack_* bot tools. Translate at this single choke point; when no
    // mapping row exists the id is either already internal or unknown, and
    // PB returns [] for unknown ids anyway.
    const internalAgentId = await resolveInternalAgentId(
      tenantId,
      agentId,
      'agent-slack-client.listAgentSlackInstalls',
    );
    const { installs } = await rpcGet<{ installs: AgentSlackInstall[] }>(
      '/api/internal/agent-slack/installs',
      { tenantId, agentId: internalAgentId ?? agentId },
    );
    installsCache.set(key, { value: installs, cachedAt: Date.now() });
    return installs;
  } catch (err) {
    logger.warn(
      { tenantId, agentId, err: (err as Error).message },
      'listAgentSlackInstalls failed — treating as no installs',
    );
    return [];
  }
}

/** Get a specific install by workspace. Goes through listAgentSlackInstalls' cache. */
export async function findInstall(
  tenantId: string,
  agentId: string,
  slackTeamId: string,
): Promise<AgentSlackInstall | null> {
  const installs = await listAgentSlackInstalls(tenantId, agentId);
  return installs.find((i) => i.slackTeamId === slackTeamId) ?? null;
}

/**
 * Resolve an install for an outbound tool call. If only one install exists,
 * use it. If the caller specified slackTeamId, use that exact one. If
 * multiple exist and no team is specified, throw a structured error that
 * lists the available workspace IDs so the agent can pick.
 */
export async function resolveInstallForCall(
  tenantId: string,
  agentId: string,
  preferredTeamId?: string,
): Promise<AgentSlackInstall> {
  const usable = (await listAgentSlackInstalls(tenantId, agentId)).filter(
    (i) => i.botToken,
  );

  // During the ADR-040 transition an agent can hold BOTH a legacy per-agent
  // install and the workspace-app virtual install for the SAME team — that
  // must not read as "installed in multiple workspaces". Collapse per team
  // id, preferring the workspace install (the target state; the per-agent
  // row is pending revocation).
  const byTeam = new Map<string, AgentSlackInstall>();
  for (const install of usable) {
    const existing = byTeam.get(install.slackTeamId);
    if (!existing || (install.kind === 'workspace' && existing.kind !== 'workspace')) {
      byTeam.set(install.slackTeamId, install);
    }
  }
  const installs = [...byTeam.values()];

  if (installs.length === 0) {
    throw new SlackNotInstalledError(
      `Agent ${agentId} has no installed Slack workspaces. Connect Slack for ` +
        'the workspace on the dashboard Message page before calling slack_* tools.',
    );
  }

  if (preferredTeamId) {
    const match = installs.find((i) => i.slackTeamId === preferredTeamId);
    if (!match) {
      throw new SlackWorkspaceNotFoundError(
        `Agent has no install for workspace ${preferredTeamId}. Available: ${installs
          .map((i) => `${i.slackTeamId} (${i.slackTeamName ?? '?'})`)
          .join(', ')}`,
      );
    }
    return match;
  }

  if (installs.length === 1) return installs[0];

  throw new SlackWorkspaceAmbiguousError(
    `Agent is installed in multiple Slack workspaces — specify "workspace" ` +
      `(team id) on the tool call. Available: ${installs
        .map((i) => `${i.slackTeamId} (${i.slackTeamName ?? '?'})`)
        .join(', ')}`,
  );
}

/** Test-only: clear caches. */
export function _clearAgentSlackClientCache(): void {
  installsCache.clear();
}

// ── Structured errors so the handler can return clean agent-facing messages

export class SlackNotInstalledError extends Error {
  readonly code = 'slack_not_installed';
}
export class SlackWorkspaceAmbiguousError extends Error {
  readonly code = 'slack_workspace_ambiguous';
}
export class SlackWorkspaceNotFoundError extends Error {
  readonly code = 'slack_workspace_not_found';
}

// ── HITL review / draft DM fan-out + assignee lookup (Slack oversight)
//
// Agent display name is resolved server-side in platform-backend by joining
// internal_agents; tenant-runtime doesn't carry it on ExecutionContext.
export interface PostReviewDmInput {
  reviewId: string;
  tenantId: string;
  agentId: string;
  /** Messaging specialization (outbound Slack tool): destination channel + draft. */
  channelId?: string;
  draftText?: string;
  assigneeAccountIds: string[];
  /** Generic gated-tool card content (see agent-execution/hitl-card-content.ts).
   *  Present instead of channelId/draftText for non-messaging gated tools. */
  action?: string;
  why?: string | null;
  detail?: string | null;
}

export async function postReviewDm(input: PostReviewDmInput): Promise<{
  totalAssignees: number; delivered: number; unreachable: string[];
}> {
  assertConfigured();
  const res = await fetch(`${PLATFORM_BACKEND_URL}/api/internal/agent-slack/post-review-dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Auth': SERVICE_TOKEN! },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`postReviewDm HTTP ${res.status}`);
  return res.json() as Promise<{ totalAssignees: number; delivered: number; unreachable: string[] }>;
}

export async function postDraftDm(input: Omit<PostReviewDmInput, 'reviewId'>): Promise<{
  totalAssignees: number; delivered: number; unreachable: string[];
}> {
  assertConfigured();
  const res = await fetch(`${PLATFORM_BACKEND_URL}/api/internal/agent-slack/post-draft-dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Auth': SERVICE_TOKEN! },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`postDraftDm HTTP ${res.status}`);
  return res.json() as Promise<{ totalAssignees: number; delivered: number; unreachable: string[] }>;
}

/** `hitlLevel` matters: authority is per level, so a member assignee who can
 *  take a level 2 gate must be routed past on a level 1. Omitting it defaults
 *  to 2 server-side, which over-routes level 1 gates to people who cannot act.
 *
 *  Only 1 and 2 are sent. Approval authority is defined for those two levels
 *  only, and the endpoint validates the range — so a level outside it does not
 *  select a different audience, it 400s, and the caller's catch records
 *  "reached nobody" for an approval nobody ever tried to announce. That is a
 *  reachable state, not a hypothetical: a gate forced by external content
 *  fires at whatever level the workspace sits at, and 3 is a real value that
 *  reaches this call. Falling back to the server default announces the
 *  approval to the level-2 audience, which is the behaviour every caller had
 *  before the parameter existed. */
export async function listAgentAssignees(
  tenantId: string,
  agentId: string,
  hitlLevel?: number,
): Promise<string[]> {
  assertConfigured();
  const levelParam = hitlLevel === 1 || hitlLevel === 2 ? `&hitlLevel=${hitlLevel}` : '';
  const res = await fetch(
    `${PLATFORM_BACKEND_URL}/api/internal/agent-slack/assignees?tenantId=${tenantId}&agentId=${agentId}${levelParam}`,
    { method: 'GET', headers: { 'X-Service-Auth': SERVICE_TOKEN! }, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) throw new Error(`listAgentAssignees HTTP ${res.status}`);
  const body = await res.json() as { assigneeAccountIds: string[] };
  return body.assigneeAccountIds;
}
