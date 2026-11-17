// Which chat surface a pane's thread belongs to, and so which table holds it.
//
// The pane runs on four chat surfaces, and each keeps its threads in its own
// table: agent chat in agent_chat_threads, and the three PLATFORM ASSISTANTS —
// Liftoff and the Insights Manager in liftoff_chat_threads and
// insights_chat_threads, the Chief AI Officer in workforce-service's
// team_plan_threads, which this service cannot read and so asks across the
// service boundary.
//
// All the lookups have the same shape and the same rule: tenant-scoped, no
// per-account gate, because "anyone with thread access shares the session" is
// the collaboration model on every surface. The surface picks WHICH table,
// never whether the caller is checked; membership is proved by the caller
// before this runs.
//
// Explicit rather than "try each table until one matches": a thread id is a
// UUID and nothing stops the same value existing on two surfaces, so a
// fall-through search would let a caller reach a thread on a surface they did
// not name. It also makes a 404 mean what it says — no such thread on THIS
// surface — instead of "not on any of them".
//
// Shared by the REST router and the SSE stream router. The stream router had
// its own lookup, on agent chat alone, so every assistant pane opened its
// event stream and got a 404: the pane still worked off the query refetch
// backstop, and nobody saw the session events it was built to carry.

import { z } from 'zod';
import { getThread as getAgentChatThread } from '../agent-chat/chat-repository';
import { getThread as getLiftoffThread } from '../liftoff/chat-repository';
import { getThread as getInsightsThread } from '../insights/chat-repository';
import { teamPlanThreadExists } from '../workforce-plans/team-plan-thread-client';
import type { CallerContext } from '../auth/resolve-caller';

const THREAD_SURFACES = {
  agent: getAgentChatThread,
  liftoff: getLiftoffThread,
  insights: getInsightsThread,
} as const;

export type ThreadSurface = 'agent' | 'liftoff' | 'insights' | 'team_plan';

/** Optional, defaulting to the agent chat that was the only surface with a
 *  pane. An older frontend that sends nothing keeps working unchanged. */
export const surfaceQuerySchema = z.object({
  surface: z.enum(['agent', 'liftoff', 'insights', 'team_plan']).optional(),
});

/** The thread on the named surface, or null. The CAIO's thread is confirmed
 *  by workforce-service, which owns the table; it answers existence only, so
 *  there is no row to carry forward and the id is all the pane needs. */
export async function findThreadOnSurface(
  surface: ThreadSurface,
  threadId: string,
  tenantId: string,
  caller: CallerContext,
): Promise<{ id: string } | null> {
  if (surface === 'team_plan') {
    const exists = await teamPlanThreadExists({
      threadId, tenantId, accountId: caller.accountId, role: caller.role,
    });
    return exists ? { id: threadId } : null;
  }
  return THREAD_SURFACES[surface](threadId, tenantId);
}
