// Backend contract for the support delegation banner.
//
// The browser holds only an opaque ticket. Everything a person needs to SEE
// about the session comes from the server, which is also the only authority on
// whether the ticket is still live.

import { api } from './api'

export interface DelegationSessionInfo {
  sessionId: string
  targetEmail: string | null
  actorEmail: string | null
}

/** Ends a grant server-side.
 *
 *  MUST be called only after clearDelegation(), for two reasons. The admin
 *  route is on the delegation deny list, so a request still carrying the
 *  act-as header would be refused with 403. And clearing first means a failed
 *  revoke still lets the operator out of the customer's account, which matters
 *  more than the revoke succeeding.
 *
 *  Best effort by design: the caller is on its way out and has nowhere useful
 *  to show an error. */
export async function endDelegationSession(sessionId: string): Promise<void> {
  try {
    await api.delete(`/api/admin/support-delegation/${sessionId}`)
  } catch {
    // Swallowed on purpose. See above.
  }
}

/** Describes the session this tab is running under, or null when the tab is
 *  the operator's own account. A 404 is the ordinary "not delegating" answer,
 *  not a failure, so it resolves to null rather than throwing. */
export async function getDelegationSession(): Promise<DelegationSessionInfo | null> {
  try {
    return await api.get<DelegationSessionInfo>('/api/support-delegation/session')
  } catch {
    return null
  }
}
