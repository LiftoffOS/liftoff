// Which conversation a Chief AI Officer thread was brought in from.
//
// A Chief AI Officer thread can be the delegate of three hosts, each with its
// own pairing store: a Liftoff conversation (liftoff_thread_delegations,
// migration 349), an Insights Manager conversation
// (assistant_thread_delegations, migration 495) or a team's chat
// (agent_chat_colleague_threads, migration 490). The source-conversation read
// asks the three in that order and answers the first pairing found, so the
// caller — workforce-service, which can only know a delegate thread id
// because it owns that thread — never names a host thread itself.
//
// The two RLS tables are read under the caller's tenant (the source route
// has the tenant in its body); the Liftoff store is not tenant-scoped, and
// the route then reads the resolved thread under the tenant, so a stale or
// cross-tenant pairing is a miss rather than a leak.

import { getDelegationByDelegateThread } from '../liftoff/chat-repository';
import { getAssistantDelegationByDelegateThread } from '../agent-chat/assistant-delegations';
import { getTeamThreadByColleagueThread } from '../agent-chat/colleague-request';

export type SourceHost = 'liftoff' | 'insights' | 'agent';

export interface SourceHostThread {
  host: SourceHost;
  threadId: string;
}

export async function findHostByDelegateThread(
  tenantId: string,
  delegateThreadId: string,
): Promise<SourceHostThread | null> {
  const liftoff = await getDelegationByDelegateThread(delegateThreadId, 'caio');
  if (liftoff) return { host: 'liftoff', threadId: liftoff.liftoffThreadId };
  const insights = await getAssistantDelegationByDelegateThread(tenantId, 'insights', 'caio', delegateThreadId);
  if (insights) return { host: 'insights', threadId: insights.threadId };
  const team = await getTeamThreadByColleagueThread(tenantId, 'caio', delegateThreadId);
  if (team) return { host: 'agent', threadId: team.threadId };
  return null;
}
