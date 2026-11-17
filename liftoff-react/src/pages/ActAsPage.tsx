// Entry point for a support delegation session.
//
// The operator arrives here from a link produced by
// POST /api/admin/support-delegation, carrying an opaque ticket. This page
// stores it for THIS TAB, confirms with the server that the session is live,
// and then hands over to the dashboard, which from that point renders the
// customer's account because every request carries the ticket.
//
// The handover is a full page load rather than a client-side navigation. The
// identity behind every cached query, and behind AuthContext's own account and
// tenant state, has just changed. Reloading is the only way to guarantee that
// nothing from the operator's own session survives into a view that claims to
// be somebody else.

import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { setDelegation, clearDelegation } from '../lib/supportDelegation'
import { getDelegationSession } from '../services/supportDelegation'
import FullScreenLoader from '../components/FullScreenLoader'
import ErrorState from '../components/ErrorState'

const MISSING_TICKET = 'This link is missing its access ticket. Request a new support session.'
const BAD_TICKET =
  'This support session is not valid. It may have expired, been ended, or been issued to a different account.'

export default function ActAsPage() {
  const [searchParams] = useSearchParams()
  const [failed, setFailed] = useState(false)
  // Strict mode mounts effects twice in development. Without this the second
  // pass would run against a ticket the first pass already consumed.
  const startedRef = useRef(false)

  const ticket = searchParams.get('ticket')

  useEffect(() => {
    // A missing ticket is decided at render, below. Nothing to start here.
    if (!ticket || startedRef.current) return
    startedRef.current = true

    async function begin(sessionTicket: string) {
      // Stored first, because the confirming request below only carries the
      // ticket if it is already in this tab's storage. The target's email
      // arrives with the confirmation and is filled in below.
      setDelegation({ ticket: sessionTicket, targetEmail: '' })

      const session = await getDelegationSession()
      if (!session) {
        clearDelegation()
        setFailed(true)
        return
      }

      setDelegation({
        ticket: sessionTicket,
        targetEmail: session.targetEmail ?? '',
        // Kept so Exit can end the grant, not just forget the ticket.
        sessionId: session.sessionId,
      })

      window.location.assign('/dashboard')
    }

    void begin(ticket)
  }, [ticket])

  if (!ticket || failed) {
    return (
      <ErrorState
        variant="error"
        title="Support session not started"
        subtitle={ticket ? BAD_TICKET : MISSING_TICKET}
      />
    )
  }

  return <FullScreenLoader />
}
