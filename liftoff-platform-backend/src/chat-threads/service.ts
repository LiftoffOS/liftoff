// One Chat History over every chat surface: Liftoff, the Insights Manager, the
// Chief AI Officer (whose threads live in workforce-service), and every AI
// team's own chat. It backs the "All" view of the web app's Chat History, where
// picking a thread routes the person to the surface it lives on.
//
// Each surface keeps its own listing rule; this only merges them. All four
// sort by updated_at DESC and page on `updated_at < cursor`, so one timestamp
// cursor pages the merge: every source is asked for the page after the same
// cursor, the union is cut at `limit`, and the last row kept becomes the next
// cursor. A row a source returned but the cut left out is older than that
// cursor, so the next page asks for it again.

import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { listThreads as listAgentChatThreads } from '../agent-chat/chat-repository';
import { listThreads as listLiftoffThreads } from '../liftoff/chat-repository';
import { listThreads as listInsightsThreads } from '../insights/chat-repository';
import { listTeamPlanThreadPage, type WorkforceCaller } from '../workforce-plans/team-plan-thread-client';
import type { ChatThreadKind } from '../chat-shares/repository';

export interface CrossSurfaceThread {
  id: string;
  kind: ChatThreadKind;
  title: string | null;
  updatedAt: string;
  unread: boolean;
  /** The team a thread of kind 'agent' belongs to. Null on the three
   *  platform assistants, which have no team behind them. */
  agent: { id: string; name: string } | null;
}

export interface CrossSurfaceThreadPage {
  threads: CrossSurfaceThread[];
  nextCursor: string | null;
  hasMore: boolean;
}

interface SourcePage {
  rows: Array<Omit<CrossSurfaceThread, 'agent'>>;
  hasMore: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function listAllChatThreads(
  caller: WorkforceCaller,
  options: { cursor?: string; limit?: number } = {},
): Promise<CrossSurfaceThreadPage> {
  const { tenantId, accountId } = caller;
  const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const page = { cursor: options.cursor, limit };

  const tag = (kind: ChatThreadKind) =>
    (result: { threads: Array<{ id: string; title: string | null; updatedAt: string; unread: boolean }>; hasMore: boolean }): SourcePage => ({
      rows: result.threads.map((t) => ({ id: t.id, kind, title: t.title, updatedAt: t.updatedAt, unread: t.unread })),
      hasMore: result.hasMore,
    });

  const [agentPage, liftoffPage, insightsPage, teamPlanPage] = await Promise.all([
    listAgentChatThreads(tenantId, accountId, page).then(tag('agent')),
    listLiftoffThreads(tenantId, accountId, page).then(tag('liftoff')),
    listInsightsThreads(tenantId, accountId, page).then(tag('insights')),
    // The only source across a network hop. A history that cannot see the
    // Chief AI Officer is still a history, so its failure leaves that surface
    // out of this page rather than failing the other three.
    listTeamPlanThreadPage(caller, page).then(tag('team_plan')).catch((err: Error): SourcePage => {
      log.warn({ tenantId, error: err.message }, 'chat-threads: Chief AI Officer threads unavailable; listing the other surfaces');
      return { rows: [], hasMore: false };
    }),
  ]);

  const sources = [agentPage, liftoffPage, insightsPage, teamPlanPage];
  const merged = sources
    .flatMap((s) => s.rows)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const kept = merged.slice(0, limit);
  const hasMore = merged.length > limit || sources.some((s) => s.hasMore);
  const nextCursor = hasMore && kept.length > 0 ? kept[kept.length - 1].updatedAt : null;

  const teams = await teamsForThreads(
    tenantId,
    kept.filter((t) => t.kind === 'agent').map((t) => t.id),
  );

  const threads: CrossSurfaceThread[] = [];
  for (const row of kept) {
    if (row.kind !== 'agent') {
      threads.push({ ...row, agent: null });
      continue;
    }
    // A team thread with no live team behind it has nowhere to open, so it is
    // left out. The cursor still moves past it.
    const team = teams.get(row.id);
    if (team) threads.push({ ...row, agent: team });
  }

  return { threads, nextCursor, hasMore };
}

/**
 * The team each agent-chat thread belongs to: its first participant, the same
 * rule the MCP conversation listing uses. Named by role, which is the name the
 * team's chat page shows in its header. A deleted team is no owner.
 */
async function teamsForThreads(
  tenantId: string,
  threadIds: string[],
): Promise<Map<string, { id: string; name: string }>> {
  const teams = new Map<string, { id: string; name: string }>();
  if (threadIds.length === 0) return teams;
  const result = await withTenantScope(tenantId, (client) => client.query(
    `SELECT DISTINCT ON (p.thread_id) p.thread_id, a.id, a.role, a.deleted_at
     FROM agent_chat_thread_participants p
     JOIN internal_agents a ON a.id = p.agent_id
     WHERE p.thread_id = ANY($1::uuid[])
     ORDER BY p.thread_id, p.added_at ASC`,
    [threadIds],
  ));
  for (const row of result.rows as Array<{ thread_id: string; id: string; role: string; deleted_at: Date | null }>) {
    if (row.deleted_at === null) teams.set(row.thread_id, { id: row.id, name: row.role });
  }
  return teams;
}
