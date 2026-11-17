// Signup approval page — the browser step of the Approve/Waitlist flow.
//
// Reached from the Approve/Waitlist buttons in the internal email sent to
// signups@example.com. Because the route is wrapped in <ProtectedRoute>, an
// unauthenticated click bounces through /login?redirect=... and back, so the
// decision is always made by a signed-in platform admin (the backend also gates
// via adminAuthMiddleware). The signed token in the URL identifies WHICH signup;
// the admin session identifies WHO is deciding. Mirrors OAuthConsentPage's
// load-metadata → decide state machine, minus the workspace selection.

import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { Button } from '../components'
import { ApiError } from '../services/api'
import {
  getSignupApproval,
  submitSignupApproval,
  type SignupApproval,
  type SignupApprovalOutcome,
} from '../services/signupApproval'
// Base layout MUST be imported here: this page is opened directly from an email
// link, so it can't rely on another page's chunk having pulled it in first.
import './Dashboard/AgentConnector/AgentConnector.css'

type PageState = 'loading' | 'invalid' | 'expired' | 'forbidden' | 'ready' | 'processing' | 'done'
type Action = 'approve' | 'waitlist'

export default function SignupApprovalPage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const intentParam = searchParams.get('intent')
  const intent: Action | null =
    intentParam === 'approve' || intentParam === 'waitlist' ? intentParam : null

  // No token at all is known before the first render, not after it.
  const [pageState, setPageState] = useState<PageState>(token ? 'loading' : 'invalid')
  const [signup, setSignup] = useState<SignupApproval | null>(null)
  const [doneAction, setDoneAction] = useState<Action | null>(null)
  const [doneOutcome, setDoneOutcome] = useState<SignupApprovalOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Load the pending signup's metadata for display. No ref guard: under
  // StrictMode the effect runs twice; the `cancelled` flag discards the first
  // (torn-down) run's result and the second run's fetch wins. A ref guard here
  // would let the teardown cancel the only fetch and strand the page on loading.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    getSignupApproval(token)
      .then((data) => {
        if (cancelled) return
        setSignup(data)
        setPageState('ready')
      })
      .catch((err) => {
        if (cancelled) return
        setPageState(pageStateForStatus(err))
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const decide = async (action: Action) => {
    if (!token || pageState === 'processing') return
    setPageState('processing')
    setError(null)
    try {
      const outcome = await submitSignupApproval(token, action)
      setDoneAction(action)
      setDoneOutcome(outcome)
      setPageState('done')
    } catch (err) {
      const status = err instanceof ApiError ? err.status : undefined
      // 410 → expired, 403 → not a platform admin, 400/404 → invalid link or
      // deleted account. Anything else is transient — let the admin retry.
      if (status === 410 || status === 403 || status === 400 || status === 404) {
        setPageState(pageStateForStatus(err))
        return
      }
      setError('Something went wrong. Try again.')
      setPageState('ready')
    }
  }

  const fullName = signup ? `${signup.firstName} ${signup.lastName}`.trim() : ''

  let content: ReactNode
  if (pageState === 'loading') {
    content = <div className="loading-spinner" />
  } else if (pageState === 'expired') {
    content = (
      <div className="agent-connector-step__text">
        <h1 className="agent-connector-step__header">Link expired</h1>
        <p className="agent-connector-step__subtext">
          This approval link has expired. Open the most recent signup email to review this person again.
        </p>
      </div>
    )
  } else if (pageState === 'forbidden') {
    content = (
      <div className="agent-connector-step__text">
        <h1 className="agent-connector-step__header">Not authorized</h1>
        <p className="agent-connector-step__subtext">
          Reviewing signups is limited to platform admins. Ask a platform admin to approve this person.
        </p>
      </div>
    )
  } else if (pageState === 'invalid') {
    content = (
      <div className="agent-connector-step__text">
        <h1 className="agent-connector-step__header">Invalid link</h1>
        <p className="agent-connector-step__subtext">
          This approval link isn't valid. Open the signup email and use the Approve or Waitlist button there.
        </p>
      </div>
    )
  } else if (pageState === 'done') {
    const who = fullName || signup?.email
    let heading: string
    let body: string
    if (doneAction === 'approve') {
      heading = 'Access granted'
      body = `${who} now has access and has been sent a welcome email.`
    } else if (doneOutcome?.alreadyApproved) {
      // Waitlisting an already-approved account is a no-op — the backend never
      // revokes access — so report the truth rather than "on the waitlist".
      heading = 'No change made'
      body = `${who} is already approved, so nothing changed.`
    } else {
      heading = 'Kept on waitlist'
      body = `${who} remains on the waitlist. Nothing has changed for them.`
    }
    content = (
      <div className="agent-connector-step__text">
        <h1 className="agent-connector-step__header">{heading}</h1>
        <p className="agent-connector-step__subtext">{body}</p>
      </div>
    )
  } else {
    // 'ready' or 'processing'
    content = (
      <>
        <div className="agent-connector-step__text">
          <h1 className="agent-connector-step__header">New signup</h1>
          <p className="agent-connector-step__subtext">
            Review this signup and choose whether to grant access.
          </p>
          <p className="agent-connector-step__subtext">
            <strong>{fullName || '(no name provided)'}</strong>
            <br />
            {signup?.email}
          </p>
          {signup?.accessGranted && (
            <p className="agent-connector-step__subtext">This user already has access.</p>
          )}
          {intent && (
            <p className="agent-connector-step__subtext">
              From your email, you chose to {intent === 'approve' ? 'approve' : 'waitlist'} this signup.
            </p>
          )}
          {error && <p className="agent-connector-step__subtext">{error}</p>}
        </div>
        <div className="agent-connector-step__actions">
          <Button
            variant="outline"
            onClick={() => decide('waitlist')}
            disabled={pageState === 'processing'}
          >
            Waitlist
          </Button>
          <Button
            variant="primary"
            onClick={() => decide('approve')}
            loading={pageState === 'processing'}
            disabled={pageState === 'processing'}
          >
            Approve
          </Button>
        </div>
      </>
    )
  }

  return (
    <div className="agent-connector">
      <div className="agent-connector__content">
        <div className="agent-connector-step">{content}</div>
      </div>
    </div>
  )
}

// Map an ApiError status to the matching terminal page state.
function pageStateForStatus(err: unknown): PageState {
  const status = err instanceof ApiError ? err.status : undefined
  if (status === 410) return 'expired'
  if (status === 403) return 'forbidden'
  return 'invalid'
}
