// The capture page for a custom API connection.
//
// An assistant has read the provider's documentation, described the connection
// and minted a link. This is the page behind it: what the connection is, one
// field for the key, and the result of the verification call the description
// declared. The value is posted to platform-backend, which hands it to
// connector-service, which writes Secret Manager. It never enters the
// conversation and it is never stored here.
//
// Behind ProtectedRoute, and every request carries the workspace: the token is
// scoped to the TENANT and to a hash of the description, not to the account
// that asked, so the person who asked can hand the link to the colleague who
// actually holds the key. The permission is re-checked server-side at submit,
// because a role can change inside the hour the link lives.
//
// The page discloses nothing. A capture token stores no value, so what is read
// back is the declared description and whether the link has been spent.

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'
import { Button } from '../components'
import ConnectionCredentialField from '../components/ConnectionCredentialField'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { ApiError } from '../services/api'
import {
  readCustomApiCapture,
  submitCustomApiCapture,
  type CustomApiCaptureResult,
  type CustomApiCaptureView,
} from '../services/customApiCapture'
import './Dashboard/AgentConnector/AgentConnector.css'
import './OAuthConsentPage.css'
// The field rendering above is the Connect modal's, so its stylesheet comes
// with it — the shared component only works where its classes are defined.
import '../components/connectionModals.css'
import './CustomApiCapturePage.css'

/**
 * Every state on this page is the same centred connector screen, the one the
 * OAuth consent page uses.
 *
 * `.agent-connector` is a full-height centring flex ROW that expects a single
 * `__content` child. Putting a heading, a paragraph and a field straight into
 * it lays them out side by side across the viewport, which is what this page
 * did: the states are wrapped here once so none of them can drift again.
 */
function CaptureScreen({ children }: { children: ReactNode }) {
  return (
    <div className="agent-connector">
      <div className="agent-connector__content">
        <div className="agent-connector-step">{children}</div>
      </div>
    </div>
  )
}

export default function CustomApiCapturePage() {
  const { token = '' } = useParams<{ token: string }>()
  const { currentTenant } = useAuth()
  const navigate = useNavigate()
  const { showToast } = useToast()
  const tenantId = currentTenant?.id

  const [view, setView] = useState<CustomApiCaptureView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [credential, setCredential] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<CustomApiCaptureResult | null>(null)

  useEffect(() => {
    if (!token || !tenantId) return
    let cancelled = false
    readCustomApiCapture(token, tenantId)
      .then(v => { if (!cancelled) setView(v) })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(
          err instanceof ApiError && err.status === 404
            ? 'That link is not one this workspace issued. Ask for a new one in the conversation it came from.'
            : 'That link could not be opened just now. Try again in a moment.',
        )
      })
    return () => { cancelled = true }
  }, [token, tenantId])

  const handleSubmit = useCallback(async () => {
    if (!tenantId || credential.trim() === '') return
    setSubmitting(true)
    try {
      const outcome = await submitCustomApiCapture({ token, tenantId, credential })
      // Cleared the moment it has been handed over. The page holds a
      // credential for exactly as long as the request takes.
      setCredential('')
      setResult(outcome)
    } catch (err: unknown) {
      setCredential('')
      // A failed submit is an outcome, not something wrong with what was
      // typed, so it is raised the way every other connection action raises
      // one. The field's own error slot stays for a value a form can judge.
      showToast(
        err instanceof ApiError
          ? (err.message || 'The connection could not be set up.')
          : 'The connection could not be set up just now. Try again in a moment.',
        'error',
      )
    } finally {
      setSubmitting(false)
    }
  }, [credential, showToast, tenantId, token])

  if (!tenantId) {
    return (
      <CaptureScreen>
        <div className="agent-connector-step__text">
          <h1 className="agent-connector-step__header">Choose a workspace first</h1>
          <p className="agent-connector-step__subtext">
            This link belongs to one workspace. Open the workspace it was sent for, then open the link again.
          </p>
        </div>
      </CaptureScreen>
    )
  }

  if (loadError) {
    return (
      <CaptureScreen>
        <div className="agent-connector-step__text">
          <h1 className="agent-connector-step__header">This link cannot be opened</h1>
          <p className="agent-connector-step__subtext">{loadError}</p>
        </div>
        <div className="agent-connector-step__actions">
          <Button variant="primary" onClick={() => navigate('/dashboard/connections')}>
            Go to Connections
          </Button>
        </div>
      </CaptureScreen>
    )
  }

  if (!view) {
    return (
      <CaptureScreen>
        <div className="loading-spinner" role="status" aria-label="Opening the connection link" />
      </CaptureScreen>
    )
  }

  if (result) {
    const active = result.status === 'active'
    return (
      <CaptureScreen>
        <div className="agent-connector-step__text">
          <h1 className="agent-connector-step__header">
            {active ? `${view.provider} is connected` : `${view.provider} could not be verified`}
          </h1>
          <p className="agent-connector-step__subtext">
            {active
              ? `The key was checked against the provider and ${result.operationCount} operations are now available to this workspace.`
              : (result.verification?.message
                ?? 'The key was stored and the check against the provider did not pass. The connection is on the Connections page, where it can be reconnected.')}
          </p>
          {active && result.externalAccountLabel && (
            <p className="agent-connector-step__subtext">
              The provider identifies this key as {result.externalAccountLabel}.
            </p>
          )}
        </div>
        <div className="agent-connector-step__actions">
          <Button variant="primary" onClick={() => navigate('/dashboard/connections')}>
            Go to Connections
          </Button>
        </div>
      </CaptureScreen>
    )
  }

  if (view.spent) {
    return (
      <CaptureScreen>
        <div className="agent-connector-step__text">
          <h1 className="agent-connector-step__header">This link has been used</h1>
          <p className="agent-connector-step__subtext">
            A connection link works once. If the key still needs to be entered, ask for a new link
            in the conversation this one came from.
          </p>
        </div>
        <div className="agent-connector-step__actions">
          <Button variant="primary" onClick={() => navigate('/dashboard/connections')}>
            Go to Connections
          </Button>
        </div>
      </CaptureScreen>
    )
  }

  return (
    <CaptureScreen>
      <div className="agent-connector-step__text">
        <h1 className="agent-connector-step__header">
          {view.reconnect ? `Replace the ${view.provider} key` : `Connect ${view.provider}`}
        </h1>
        <p className="agent-connector-step__subtext">{view.purpose}</p>
      </div>

      {/* The SAME field rendering the Connect modal uses. There are two places
          a person types a credential into Liftoff and they must look and
          behave identically — the label, the error slot, the disabled state
          and the no-autocomplete, no-spellcheck box a secret goes into. */}
      <div className="connection-modal__fields custom-api-capture__field">
        <ConnectionCredentialField
          field={{
            name: 'credential',
            label: view.credentialLabel,
            type: 'password',
            required: true,
            placeholder: 'Paste the key',
          }}
          value={credential}
          onChange={setCredential}
          disabled={submitting}
          idPrefix="custom-api"
        />
      </div>

      <div className="agent-connector-step__actions custom-api-capture__actions">
        <Button variant="outline" onClick={() => navigate('/dashboard/connections')} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={submitting || credential.trim() === ''}
          loading={submitting}
        >
          {submitting ? 'Checking the key' : 'Connect'}
        </Button>
      </div>
    </CaptureScreen>
  )
}
