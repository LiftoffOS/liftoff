// The reminder that you are not yourself right now.
//
// A support session can do very nearly everything the workspace owner can, and
// everything typed in this tab is saved to the customer's account. So the
// single most important property of this component is that it is impossible to
// miss and impossible to lose.
//
// It reads the session from storage on every render rather than taking it as a
// prop, because browsers COPY sessionStorage into a tab opened from the current
// one. A tab reached by cmd-clicking a link inside a support session inherits
// the session, and a banner that only rendered where it was handed props would
// leave that tab showing somebody else's workspace with nothing to say so.
//
// There is no countdown, because sessions do not expire. They end when they are
// revoked, which is what Exit does. Closing the tab only discards this tab's
// ticket; the grant itself stays open until something revokes it.

import { useEffect, useState } from 'react'
import { getDelegation, clearDelegation } from '../lib/supportDelegation'
import { endDelegationSession } from '../services/supportDelegation'
import './DelegationBanner.css'

export default function DelegationBanner() {
  const [session, setSession] = useState(() => getDelegation())

  // Re-read on focus. Another tab, or an admin ending the session elsewhere,
  // will not have told this one; picking it up when somebody looks at the tab
  // is cheap and catches the case that matters.
  useEffect(() => {
    const refresh = () => setSession(getDelegation())
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  if (!session) return null

  async function handleExit() {
    const ending = session

    // Cleared FIRST, deliberately, for two reasons. The admin route that ends a
    // grant is on the delegation deny list, so a request still carrying the
    // act-as header would be refused with 403. And if the revoke fails, the
    // operator is still out of the customer's account, which matters more than
    // the revoke succeeding.
    clearDelegation()

    // Exit used to stop here. That left the grant open in the database with no
    // expiry, and the actUrl sitting in browser history could resurrect it, so
    // a button everyone reads as "end this" ended nothing server-side.
    if (ending?.sessionId) {
      await endDelegationSession(ending.sessionId)
    }

    // A full load, for the same reason the entry does one: the identity behind
    // every cached query and behind AuthContext's own state has changed back.
    window.location.assign('/dashboard')
  }

  return (
    <div className="delegation-banner" role="status" aria-live="polite">
      <span className="delegation-banner__text">
        You are viewing this workspace as{' '}
        <strong>{session.targetEmail || 'another person'}</strong>. Anything you change will be
        saved to their account.
      </span>
      <button type="button" className="delegation-banner__exit" onClick={() => { void handleExit() }}>
        Exit
      </button>
    </div>
  )
}
