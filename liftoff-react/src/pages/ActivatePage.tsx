// Device-flow activation (RFC 8628): the browser step for a coding tool that
// cannot reach a browser on its own machine (a container, a remote host, a
// tool the person drives from a phone).
//
// The tool shows the person a short code and this address. The page reads
// the code (typed, or prefilled from ?code=), looks it up, and then shows the
// SAME consent as /oauth/consent (ConsentView, unchanged): who is asking,
// which workspace, Approve or Deny. The difference is what happens after:
// nothing is redirected anywhere. The tool is polling the token endpoint and
// collects its tokens once the code is approved, so the page ends on a done
// state and the person returns to the tool themselves.
//
// Same layout family as ConsentView (connector visual -> header -> subtext ->
// content -> actions), and the same readiness rule: an owner whose workspace
// has not finished onboarding finishes setup first and comes back to this
// page for the same code, which approves if it is still live.

import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { PENDING_DEVICE_ACTIVATION_KEY } from './Dashboard/Onboarding/types'
import { Button } from '../components'
import { track } from '../lib/analytics'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { codingToolMark } from '../components/CodingToolMark'
import {
  lookupDeviceCode,
  submitDeviceDecision,
  type DeviceCodeLookup,
} from '../services/oauthConsent'
import { ConsentView } from './OAuthConsentPage'
import PeopleIcon from '../assets/icons/people.svg?react'
import './Dashboard/AgentConnector/AgentConnector.css'
import './Dashboard/ClaudeCodeConnector/ClaudeCodeConnector.css'
import './OAuthConsentPage.css'
import './ActivatePage.css'

// The server mints codes from the RFC 8628 §6.1 alphabet (no vowels, no
// look-alikes). The field does not enforce that alphabet: whatever eight
// letters or digits the person types are sent, and the server says whether
// the code is known. A field that silently dropped letters read as one that
// only accepted the right answer.
const USER_CODE_LENGTH = 8
const NOT_CODE_CHARACTER = /[^A-Z0-9]/g

/** Normalize what a person typed or pasted: uppercase, letters and digits
 *  only, printed as XXXX-XXXX. */
function formatUserCode(raw: string): string {
  const chars = raw.toUpperCase().replace(NOT_CODE_CHARACTER, '').slice(0, USER_CODE_LENGTH)
  return chars.length > 4 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars
}

// A workspace name may already end in a period ("Liftoff OS, Inc."); the
// sentence must not add a second one.
function endSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

function isCompleteUserCode(code: string): boolean {
  return code.replace('-', '').length === USER_CODE_LENGTH
}

type PageState =
  | 'code_entry'
  | 'looking_up'
  | 'ready'
  | 'processing'
  | 'setup_required'
  | 'approved'
  | 'denied'

interface WorkspaceOption {
  id: string
  name: string
  role: string
  setupRequired: boolean
}

// The states that belong to this page and not to the shared consent view.
function ActivateShell({
  clientSlug,
  title,
  subtext,
  children,
}: {
  clientSlug?: string | null
  title: string
  subtext: string
  children?: React.ReactNode
}) {
  const mark = codingToolMark(clientSlug ?? null)
  return (
    <div className="agent-connector claude-code-connector oauth-consent-page activate-page">
      <div className="agent-connector__content">
        <div className="agent-connector-step">
          <div className="agent-connector__visual">
            <div className="agent-connector__team agent-connector__team--left">
              <mark.Icon className={mark.dark ? 'oauth-consent-page__dark-mark' : undefined} />
            </div>
            <div className="agent-connector__line" />
            <div className="agent-connector__line agent-connector__line--delayed" />
            <div className="agent-connector__line agent-connector__line--delayed-2" />
            <div className="agent-connector__team agent-connector__team--right">
              <PeopleIcon />
            </div>
          </div>
          <div className="agent-connector-step__text">
            <h1 className="agent-connector-step__header">{title}</h1>
            <p className="agent-connector-step__subtext">{subtext}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

export default function ActivatePage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { tenants, tenantLoading, switchTenant } = useAuth()
  const { showToast } = useToast()

  const prefilled = formatUserCode(searchParams.get('code') ?? '')
  const [code, setCode] = useState(prefilled)
  const [pageState, setPageState] = useState<PageState>('code_entry')
  const [lookup, setLookup] = useState<DeviceCodeLookup | null>(null)
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [workspaceName, setWorkspaceName] = useState<string | null>(null)
  const viewedRef = useRef(false)
  const autoLookedUpRef = useRef(false)

  const workspaces: WorkspaceOption[] = tenants.map((t) => ({
    id: t.id,
    name: t.name,
    role: t.role,
    setupRequired: t.role === 'owner' && !t.onboardingCompletedAt,
  }))

  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    track('device_activation_viewed', { prefilled: isCompleteUserCode(prefilled) })
  }, [prefilled])

  // A rejected code is reported the way the connector pages report a bad
  // key: a toast, with the field and its value left in place for the retry.
  // The lookup is rate-limited (a short code can be guessed at), and a 429 is
  // not a wrong code: it asks for a pause, not a different code.
  const rejectCode = (reason: 'invalid' | 'expired' | 'rate_limited') => {
    track('device_activation_code_rejected', { reason })
    showToast(
      reason === 'expired'
        ? 'That code has expired. Ask your coding tool for a new one.'
        : reason === 'rate_limited'
          ? 'Too many attempts. Wait a minute and try again.'
          : 'Code not recognized. Check the code your coding tool shows.',
      'error',
    )
    setPageState('code_entry')
  }

  const lookUp = async (userCode: string) => {
    setPageState('looking_up')
    setError(null)
    try {
      const data = await lookupDeviceCode(userCode)
      setLookup(data)
      setPageState('ready')
    } catch (err) {
      const e = err as Error & { status?: number }
      rejectCode(e.status === 410 ? 'expired' : e.status === 429 ? 'rate_limited' : 'invalid')
    }
  }

  // A complete code in the address is looked up on arrival, once. The
  // lookup closes over toast and state setters that are stable, so the ref
  // is the only guard this needs.
  useEffect(() => {
    if (autoLookedUpRef.current || !isCompleteUserCode(prefilled)) return
    autoLookedUpRef.current = true
    void lookUp(prefilled)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefilled])

  // Auto-SELECT (never auto-approve) when there is exactly one workspace.
  if (!tenantLoading && workspaces.length === 1 && selectedTenantId === null) {
    setSelectedTenantId(workspaces[0].id)
  }

  const decide = async (approve: boolean) => {
    if (pageState === 'processing') return
    if (approve && !selectedTenantId) return
    setPageState('processing')
    setError(null)
    track(approve ? 'device_activation_approved' : 'device_activation_denied', {})
    try {
      const result = await submitDeviceDecision({
        userCode: code,
        ...(approve ? { tenantId: selectedTenantId as string } : {}),
        approve,
      })
      setWorkspaceName(result.workspaceName ?? workspaces.find((w) => w.id === selectedTenantId)?.name ?? null)
      setPageState(approve ? 'approved' : 'denied')
    } catch (err) {
      const e = err as Error & { status?: number }
      if (e.status === 410) {
        rejectCode('expired')
        return
      }
      if (e.status === 429) {
        setError('Too many attempts. Wait a minute and try again.')
        setPageState('ready')
        return
      }
      if (e.status === 409 && e.message === 'setup_required') {
        track('device_activation_setup_required', {})
        setPageState('setup_required')
        return
      }
      setError('Something went wrong. Try again.')
      setPageState('ready')
    }
  }

  // Unlike a consent request, a device code is not parked for onboarding: the
  // tool was told the code lives 10 minutes and stops polling then, so a
  // longer life on our side would approve into the void. The owner finishes
  // setup and comes back to this same code; if it is still live it approves,
  // otherwise the page says so and the tool is asked for a new one.
  const continueSetup = () => {
    if (pageState === 'processing' || !selectedTenantId) return
    if (pageState !== 'setup_required') track('device_activation_setup_required', {})
    switchTenant(selectedTenantId)
    try { sessionStorage.setItem(PENDING_DEVICE_ACTIVATION_KEY, code) } catch { /* private-mode fallback */ }
    navigate('/onboarding')
  }

  const label = lookup?.clientLabel ?? lookup?.clientName

  if (pageState === 'code_entry' || pageState === 'looking_up') {
    const busy = pageState === 'looking_up'
    return (
      <ActivateShell
        title="Enter Your Code"
        subtext="Your coding tool shows a code. Enter it here to connect the tool to your workspace. Codes last 10 minutes."
      >
        <form
          className="agent-connector-step__actions activate-page__form"
          onSubmit={(e) => { e.preventDefault(); if (isCompleteUserCode(code) && !busy) void lookUp(code) }}
        >
          <input
            type="text"
            className="agent-connector__input activate-page__code"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            spellCheck={false}
            placeholder="XXXX-XXXX"
            aria-label="Code"
            value={code}
            onChange={(e) => setCode(formatUserCode(e.target.value))}
            disabled={busy}
          />
          <Button variant="primary" type="submit" disabled={!isCompleteUserCode(code) || busy}>
            {busy ? 'One moment...' : 'Continue'}
          </Button>
        </form>
      </ActivateShell>
    )
  }

  if (pageState === 'approved') {
    return (
      <ActivateShell
        clientSlug={lookup?.clientSlug}
        title="Connected"
        subtext={`${label} is connected to ${endSentence(workspaceName ?? 'your workspace')} You can return to your coding tool.`}
      >
        <div className="agent-connector-step__actions oauth-consent-page__actions">
          <Button variant="outline" onClick={() => navigate('/dashboard/agents')}>
            Go to Dashboard
          </Button>
        </div>
      </ActivateShell>
    )
  }

  if (pageState === 'denied') {
    return (
      <ActivateShell
        clientSlug={lookup?.clientSlug}
        title="Not Connected"
        subtext={`${label} was not connected. You can close this page.`}
      />
    )
  }

  return (
    <ConsentView
      pageState={pageState}
      clientName={lookup?.clientName}
      clientSlug={lookup?.clientSlug}
      clientLabel={lookup?.clientLabel}
      note={`Code ${code}`}
      workspaces={workspaces}
      selectedTenantId={selectedTenantId}
      error={error}
      onSelect={setSelectedTenantId}
      onDecide={decide}
      onContinueSetup={continueSetup}
    />
  )
}
