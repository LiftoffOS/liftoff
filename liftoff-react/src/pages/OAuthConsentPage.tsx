// MCP OAuth consent page (plan v6.1 Phase 3)
//
// The browser step of the OAuth flow for connecting a coding tool (Claude
// Code, Codex, any MCP client) to a workspace. Same layout family as
// ConnectorSuccess: connector visual -> header -> subtext -> content ->
// actions. Behavior contract (unchanged from the plan):
//   1. Requester identity + redirect host displayed (who is asking).
//   2. ALWAYS explicit Approve/Deny. A sole workspace is auto-SELECTED but
//      never auto-approved (CLIAuthPage's auto-skip must not be copied).
//   3. Redirect ONLY to the backend-supplied redirectTo.
//   4. Request-expired state.
//   5. A workspace the person owns that has not finished onboarding cannot
//      be connected yet. It is still listed (flagged "Finish setup to
//      connect", so the person can reach their own workspace from here),
//      and choosing it turns the primary action into Continue Setup: the
//      request is parked server-side (POST /park), the chosen workspace is
//      made the current one (onboarding runs against the current workspace)
//      and the person goes to /onboarding; completion returns to this same
//      request, where the workspace now approves. A person whose only workspace is unfinished
//      sees the same picker with that one row selected. The server applies
//      the same rule on Approve (409, request parked), so nothing here is
//      the only guard.
// No client-side PKCE — that is fully server-side in this flow.

import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { PENDING_OAUTH_CONSENT_KEY } from './Dashboard/Onboarding/types'
import { Button } from '../components'
import { track } from '../lib/analytics'
import { useAuth } from '../contexts/AuthContext'
import { getOauthConsentRequest, parkOauthConsent, submitOauthConsent, type OauthConsentRequest } from '../services/oauthConsent'
import PeopleIcon from '../assets/icons/people.svg?react'
import { codingToolMark } from '../components/CodingToolMark'
// Base layout MUST be imported here: this page is loaded directly from the
// OAuth redirect, so it can't rely on a connector page's chunk having pulled
// these in first (same rule as ConnectorSuccess).
import './Dashboard/AgentConnector/AgentConnector.css'
import './Dashboard/ClaudeCodeConnector/ClaudeCodeConnector.css'
import './OAuthConsentPage.css'

type PageState = 'loading' | 'invalid' | 'expired' | 'ready' | 'processing' | 'setup_required'

interface WorkspaceOption {
  id: string
  name: string
  role: string
  /** The person owns it and its onboarding is not finished: it is listed,
   *  and choosing it leads to setup rather than to Approve. */
  setupRequired: boolean
}

// The backend says which tool is asking (clientSlug, from the name the client
// registered under); a client it does not know arrives with no slug and is
// shown under the generic mark, with its registered name as the label. A
// platform-backend that predates the slug sends only the name, and the two
// tools it ever branded are still told apart from it.
function clientIcon(clientSlug: string | null | undefined, clientName: string | undefined) {
  let slug: string | null = clientSlug ?? null
  if (clientSlug === undefined) {
    const name = (clientName ?? '').toLowerCase()
    slug = name.includes('claude') ? 'claude-code' : /codex|openai/.test(name) ? 'codex' : null
  }
  const mark = codingToolMark(slug)
  return <mark.Icon className={mark.dark ? 'oauth-consent-page__dark-mark' : undefined} />
}

// Presentational view — pure props, so states render without auth wiring.
export function ConsentView({
  pageState,
  clientName,
  clientSlug,
  clientLabel,
  note,
  redirectHost,
  workspaces,
  selectedTenantId,
  error,
  onSelect,
  onDecide,
  onContinueSetup,
}: {
  pageState: PageState
  clientName?: string
  clientSlug?: string | null
  clientLabel?: string
  /** A line under the subtext the caller wants the person to compare with
   *  what their tool shows (the device flow's code, RFC 8628 §3.3.1). */
  note?: string
  redirectHost?: string
  workspaces: WorkspaceOption[]
  selectedTenantId: string | null
  error: string | null
  onSelect: (tenantId: string) => void
  onDecide: (approve: boolean) => void
  onContinueSetup?: () => void
}) {
  const selectedNeedsSetup = workspaces.some((w) => w.id === selectedTenantId && w.setupRequired)
  // The product name when the backend knows the tool, else the name the
  // client registered under: the one thing the person can judge the request by.
  const toolName = clientLabel ?? clientName
  const stateText =
    pageState === 'invalid'
      ? { title: 'Invalid Request', subtext: 'This page should be opened by the tool you are connecting.' }
      : pageState === 'expired'
        ? { title: 'Request Expired', subtext: 'This connection request has expired. Go back to your coding tool and run the sign-in again.' }
        : pageState === 'setup_required'
          ? { title: 'Finish Setting Up Your Workspace', subtext: null }
          : pageState === 'ready' && workspaces.length === 0
            ? { title: 'No Workspaces', subtext: "You don't belong to any workspaces yet. Ask a workspace admin to invite you." }
            : null

  return (
    <div className="agent-connector claude-code-connector oauth-consent-page">
      <div className="agent-connector__content">
        <div className="agent-connector-step">
          <div className="agent-connector__visual">
            <div className="agent-connector__team agent-connector__team--left">
              {clientIcon(clientSlug, clientName)}
            </div>
            <div className="agent-connector__line" />
            <div className="agent-connector__line agent-connector__line--delayed" />
            <div className="agent-connector__line agent-connector__line--delayed-2" />
            <div className="agent-connector__team agent-connector__team--right">
              <PeopleIcon />
            </div>
          </div>

          {pageState === 'loading' ? (
            <div className="loading-spinner" />
          ) : stateText ? (
            <>
              <div className="agent-connector-step__text">
                <h1 className="agent-connector-step__header">{stateText.title}</h1>
                {stateText.subtext && <p className="agent-connector-step__subtext">{stateText.subtext}</p>}
              </div>
              {pageState === 'setup_required' && (
                <div className="agent-connector-step__actions oauth-consent-page__actions">
                  <Button variant="primary" onClick={() => onContinueSetup?.()} disabled={!onContinueSetup}>
                    Continue Setup
                  </Button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="agent-connector-step__text">
                <h1 className="agent-connector-step__header">Connect {toolName ?? 'this tool'}</h1>
                <p className="agent-connector-step__subtext">
                  {toolName ?? 'A tool'} wants to connect to your workspace to interact
                  with your agents using MCP.
                  {/* Phishing signal only where it carries meaning: a web
                      destination. Loopback redirects (every coding tool) are
                      noise the user cannot act on. */}
                  {redirectHost && !/^(localhost|127\.)/.test(redirectHost)
                    ? ` You will return to ${redirectHost}.`
                    : ''}
                </p>
                {note && <p className="agent-connector-step__subtext oauth-consent-page__note">{note}</p>}
              </div>

              <div className="agent-connector__mode-options">
                {workspaces.map((tenant) => (
                  <button
                    key={tenant.id}
                    className={`agent-connector__mode-option ${selectedTenantId === tenant.id ? 'agent-connector__mode-option--selected' : ''}`}
                    onClick={() => onSelect(tenant.id)}
                    disabled={pageState === 'processing'}
                  >
                    <span className="agent-connector__mode-label">{tenant.name}</span>
                    <span className="agent-connector__mode-description">
                      {tenant.role}
                      {tenant.setupRequired && <span className="oauth-consent-page__setup-flag"> · Finish setup to connect</span>}
                    </span>
                  </button>
                ))}
              </div>

              {error && <p className="agent-connector-step__subtext oauth-consent-page__error">{error}</p>}

              {/* Deny pairs with Approve: it answers the connection request.
                  A workspace with its setup to finish has no request to
                  answer yet, so it offers Continue Setup alone. */}
              <div className="agent-connector-step__actions oauth-consent-page__actions">
                {selectedNeedsSetup ? (
                  <Button
                    variant="primary"
                    onClick={() => onContinueSetup?.()}
                    disabled={pageState === 'processing' || !onContinueSetup}
                  >
                    {pageState === 'processing' ? 'One moment...' : 'Continue Setup'}
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => onDecide(false)}
                      disabled={pageState === 'processing'}
                    >
                      Deny
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => onDecide(true)}
                      disabled={pageState === 'processing' || !selectedTenantId}
                    >
                      {pageState === 'processing' ? 'Connecting...' : 'Approve'}
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default function OAuthConsentPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { tenants, tenantLoading, switchTenant } = useAuth()
  const requestId = searchParams.get('request_id')

  // No request id at all is known before the first render, not after it.
  const [pageState, setPageState] = useState<PageState>(requestId ? 'loading' : 'invalid')
  const [request, setRequest] = useState<OauthConsentRequest | null>(null)
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const viewedRef = useRef(false)

  // A workspace the person owns that has not finished onboarding is listed
  // like the rest, marked, and leads to setup rather than to Approve. A
  // member of such a workspace connects as usual: the rule is about the
  // owner who has the setup to finish.
  const workspaces: WorkspaceOption[] = tenants.map((t) => ({
    id: t.id,
    name: t.name,
    role: t.role,
    setupRequired: t.role === 'owner' && !t.onboardingCompletedAt,
  }))

  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    track('oauth_consent_viewed', {})
  }, [])

  // Load the pending request's metadata.
  useEffect(() => {
    if (!requestId) return
    let cancelled = false
    getOauthConsentRequest(requestId)
      .then((data) => {
        if (cancelled) return
        setRequest(data)
        setPageState('ready')
      })
      .catch((err: Error & { status?: number }) => {
        if (cancelled) return
        setPageState(err.status === 410 ? 'expired' : 'invalid')
      })
    return () => { cancelled = true }
  }, [requestId])

  // Auto-SELECT (never auto-approve) when there is exactly one workspace.
  if (!tenantLoading && workspaces.length === 1 && selectedTenantId === null) {
    setSelectedTenantId(workspaces[0].id)
  }

  const decide = async (approve: boolean) => {
    if (!requestId || pageState === 'processing') return
    if (approve && !selectedTenantId) return
    setPageState('processing')
    setError(null)
    track(approve ? 'oauth_consent_approved' : 'oauth_consent_denied', {})
    try {
      const result = await submitOauthConsent({
        requestId,
        ...(approve ? { tenantId: selectedTenantId as string } : {}),
        approve,
      })
      // Redirect ONLY to the backend-supplied target (registration-validated).
      window.location.assign(result.redirectTo)
    } catch (err) {
      const e = err as Error & { status?: number }
      if (e.status === 410) {
        setPageState('expired')
        return
      }
      // The server applies the readiness rule on Approve too and parks the
      // request when it refuses, so the same state is shown.
      if (e.status === 409 && e.message === 'setup_required') {
        track('oauth_consent_setup_required', {})
        setPageState('setup_required')
        return
      }
      setError('Something went wrong. Try again.')
      setPageState('ready')
    }
  }

  // Onboarding runs against the app's CURRENT workspace, which is whichever
  // one the person last used, not necessarily the one they chose here. Make
  // the chosen one current first, then hand the request id to onboarding so
  // completion returns here.
  const goToOnboarding = () => {
    if (!requestId || !selectedTenantId) return
    switchTenant(selectedTenantId)
    try { sessionStorage.setItem(PENDING_OAUTH_CONSENT_KEY, requestId) } catch { /* private-mode fallback */ }
    navigate('/onboarding')
  }

  // The chosen workspace is one of their own with the setup unfinished: park
  // the request first, so it is still live when they are back, then go. The
  // server's 409 path (setup_required state) has already parked it.
  const continueSetup = async () => {
    if (!requestId || pageState === 'processing') return
    if (pageState === 'setup_required') {
      goToOnboarding()
      return
    }
    if (!selectedTenantId) return
    setPageState('processing')
    setError(null)
    track('oauth_consent_setup_required', {})
    try {
      await parkOauthConsent({ requestId, tenantId: selectedTenantId })
      goToOnboarding()
    } catch (err) {
      const e = err as Error & { status?: number }
      if (e.status === 410) {
        setPageState('expired')
        return
      }
      setError('Something went wrong. Try again.')
      setPageState('ready')
    }
  }

  return (
    <ConsentView
      pageState={tenantLoading && pageState !== 'invalid' && pageState !== 'expired' ? 'loading' : pageState}
      clientName={request?.clientName}
      clientSlug={request?.clientSlug}
      clientLabel={request?.clientLabel}
      redirectHost={request?.redirectHost}
      workspaces={workspaces}
      selectedTenantId={selectedTenantId}
      error={error}
      onSelect={setSelectedTenantId}
      onDecide={decide}
      onContinueSetup={continueSetup}
    />
  )
}
