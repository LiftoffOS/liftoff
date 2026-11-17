// "Does this paused thread need something from me?"
//
// The chat banner is a call to action, so it must only appear for people who
// can actually act. Everyone else learns the thread is blocked from the status
// message the team posts into the conversation.
//
// This is a query over outstanding state rather than a live event on purpose.
// The banner used to be driven solely by the `hitl_required` SSE event, which
// reaches exactly one client: whoever's turn tripped the gate. An assignee who
// simply opened the thread saw nothing, and a reload wiped it even for the
// person who did trigger it.

import { api } from './api'

export interface PendingApproval {
  approvalId: string
  /** 1 requires an owner or admin; anything else a member and above. */
  hitlLevel: number
  /** The reader is one of the people the request was routed to. */
  isForYou: boolean
  /** The reader's role can approve at this level. */
  canApprove: boolean
  /** Names of everyone asked, so the banner can say who else is on it. */
  routedTo: string[]
  /** No eligible assignee, so it escalated to the workspace admins. */
  routedToAdmins: boolean
  /** Nobody is assigned, so it is open to the workspace. */
  unassigned: boolean
}

/** Null when nothing is outstanding, or when the request is not this reader's
 *  to clear. The backend makes that judgement so the client cannot get it
 *  wrong by, say, showing a viewer a Review button that would throw. */
export async function getPendingApproval(
  tenantId: string,
  agentId: string,
  threadId: string,
): Promise<PendingApproval | null> {
  const res = await api.get<{ approval: PendingApproval | null }>(
    `/api/agent-chat/${agentId}/threads/${threadId}/pending-approval?tenantId=${encodeURIComponent(tenantId)}`,
  )
  return res.approval ?? null
}
