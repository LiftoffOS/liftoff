// The "acting as somebody else" flag, and why it lives where it lives.
//
// A platform admin can operate a customer's workspace as that customer, to
// reproduce a per-user problem or to finish setting something up on their
// behalf. The mechanism is delegation, not impersonation: the operator's own
// Firebase credential is never swapped. All that changes is that requests from
// THIS TAB carry one extra header, and the backend answers them as the
// customer while still recording who is really acting.
//
// sessionStorage, deliberately, not localStorage:
//
//   - localStorage is shared by every tab, so storing it there would put the
//     whole browser into the customer's account. sessionStorage belongs to one
//     tab, so one tab can be the customer while another stays the operator's
//     own account, both live, with no signing out in between. There is only
//     ever one login; the only difference between the two tabs is this header
//   - it is cleared when the tab closes, so the TICKET cannot outlive the window
//     it was opened in. The GRANT still can: only an explicit revoke ends that,
//     which is why Exit calls the revoke endpoint rather than just clearing here
//
// The one sharp edge: browsers COPY sessionStorage into a tab opened from the
// current one, so a cmd-clicked link inherits the session. That is why the
// banner reads from here rather than from React state handed down at entry: an
// inherited tab must be labelled too.
//
// See docs/support-delegation-plan.md.

const STORAGE_KEY = 'liftoff_support_delegation'

export interface DelegationSession {
  /** Opaque bearer ticket. Only ever travels in a header from here. */
  ticket: string
  targetEmail: string
  /** The grant's id, so Exit can revoke it server-side rather than only
   *  forgetting the ticket locally. Optional because a session stored by an
   *  older build will not have one; Exit still clears locally without it. */
  sessionId?: string
}

/** Header the backend reads to decide whose account to answer as. */
export const DELEGATION_HEADER = 'X-Liftoff-Act-As'

function isSession(value: unknown): value is DelegationSession {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.ticket === 'string' && v.ticket.length > 0 && typeof v.targetEmail === 'string'
}

/**
 * The active session for this tab, or null.
 *
 * Every read is guarded. sessionStorage throws outright in some contexts
 * (Safari private mode, site data blocked), and a storage failure must never be
 * the reason the app fails to render.
 *
 * There is no expiry to check. A session ends only when it is revoked
 * server-side; closing this tab discards the ticket but leaves the grant open.
 */
export function getDelegation(): DelegationSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isSession(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export function setDelegation(session: DelegationSession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch {
    // Nothing useful to do. The caller checks isDelegating() afterwards, and a
    // browser that cannot store this simply cannot hold a support session.
  }
}

export function clearDelegation(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // See setDelegation.
  }
}

export function isDelegating(): boolean {
  return getDelegation() !== null
}

/** The header to merge into a request, or an empty object when this tab is
 *  the operator's own account. Shaped for spreading so call sites stay
 *  one-liners. */
export function delegationHeader(): Record<string, string> {
  const session = getDelegation()
  return session ? { [DELEGATION_HEADER]: session.ticket } : {}
}

/**
 * The workspace-selection key for this tab.
 *
 * AuthContext writes the chosen workspace to localStorage unconditionally, and
 * localStorage is shared across tabs. Without namespacing, switching workspaces
 * while acting as a customer overwrites the operator's own saved selection, so
 * they come back to a workspace they did not choose.
 */
export function selectedTenantKey(): string {
  const session = getDelegation()
  return session ? `liftoff_selected_tenant:${session.targetEmail}` : 'liftoff_selected_tenant'
}
