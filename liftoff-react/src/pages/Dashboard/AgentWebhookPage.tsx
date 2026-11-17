// AgentWebhookPage — inbound webhook configuration for a single internal agent.
// Route: /dashboard/agents/update/webhook (teamId passed via location.state)
// Layout follows AgentUpdatePage. Component vocabulary follows
// /dashboard/settings/communication (Toggle) and /dashboard/settings/workspace
// (code+copy pattern for read-only credentials).

import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { track } from '../../lib/analytics'
import { BackButton, Button, ModalOverlay, Toggle, Tooltip } from '../../components'
import { useTenant } from '../../hooks/useTenant'
import { useToast } from '../../contexts/ToastContext'
import { useInternalAgent } from '../../hooks/useInternalAgents'
import { formatRelativeTime } from '../../utils/chat'
import {
  useAgentWebhook,
  useAgentWebhookDeliveries,
  useProvisionAgentWebhook,
  useResetAgentWebhookCredentials,
  useUpdateAgentWebhook,
  type AgentWebhookDelivery,
} from '../../hooks/useInternalAgents'
import CopyIcon from '../../assets/icons/copy.svg?react'
import RefreshCwIcon from '../../assets/icons/refresh-cw.svg?react'
import './AgentUpdatePage.css'
import './AgentWebhookPage.css'

interface LocationState {
  teamId?: string
}

function statusLabel(status: unknown): { text: string; tone: 'accepted' | 'duplicate' | 'rejected' } {
  switch (status) {
    case 'accepted':              return { text: 'Accepted', tone: 'accepted' }
    case 'duplicate':             return { text: 'Duplicate', tone: 'duplicate' }
    case 'rejected_signature':    return { text: 'Rejected (bad signature)', tone: 'rejected' }
    case 'rejected_rate':         return { text: 'Rejected (rate limit)', tone: 'rejected' }
    case 'rejected_size':         return { text: 'Rejected (oversize)', tone: 'rejected' }
    case 'rejected_disabled':     return { text: 'Rejected (disabled)', tone: 'rejected' }
    case 'rejected_no_active_rule': return { text: 'Rejected (no active rule)', tone: 'rejected' }
    case 'rejected_unsafe_content': return { text: 'Rejected (unsafe content)', tone: 'rejected' }
    case 'rejected_tenant_ceiling': return { text: 'Rejected (tenant limit)', tone: 'rejected' }
    case 'rejected_budget_exceeded': return { text: 'Rejected (budget)', tone: 'rejected' }
    // Same guard as formatRelative: coerce any non-string `status` into a
    // primitive before handing it to JSX. Returning a raw unknown value
    // here would trigger React error #31 in the list-row render below.
    default:                      return { text: typeof status === 'string' ? status : 'Unknown', tone: 'rejected' }
  }
}

/**
 * Read-only credential row: monospaced code block + outside copy button.
 * Mirrors the Workspace ID pattern in dashboard/settings/workspace —
 * NOT a disabled input. Avoids the "looks editable" affordance.
 */
function CredentialRow({
  value,
  ariaCopyLabel,
  onCopy,
  hidden = false,
}: {
  value: string
  ariaCopyLabel: string
  onCopy: () => void
  /** When true, render dots in place of the value and disable the copy button. */
  hidden?: boolean
}) {
  return (
    <>
      <code className="settings-section__code webhook-code">
        {hidden ? '••••••••••••••••••••••••••••••••' : value}
      </code>
      <button
        type="button"
        className="settings-section__copy"
        onClick={onCopy}
        aria-label={ariaCopyLabel}
        disabled={hidden}
      >
        <CopyIcon width="16" height="16" />
      </button>
    </>
  )
}

function DeliveriesList({ agentId, disabled }: { agentId: string; disabled: boolean }) {
  const { data, isLoading, refetch, isFetching } = useAgentWebhookDeliveries(agentId, 5)
  const handleRefresh = () => {
    track('team_webhook_deliveries_refreshed', { team_id: agentId })
    refetch()
  }
  const deliveries: AgentWebhookDelivery[] = data?.deliveries ?? []

  return (
    <section className="agent-update__section">
      <div className="webhook-deliveries-head">
        <h2 className="agent-update__section-title">Recent deliveries</h2>
        <Tooltip text="Refresh">
          <button
            type="button"
            className={`webhook-sync-btn${isFetching ? ' webhook-sync-btn--syncing' : ''}`}
            onClick={handleRefresh}
            disabled={disabled || isFetching}
            aria-label="Refresh deliveries"
          >
            <RefreshCwIcon width="16" height="16" />
          </button>
        </Tooltip>
      </div>
      {isLoading ? (
        <div className="webhook-loading">
          <div className="loading-spinner" role="status" aria-label="Loading deliveries" />
        </div>
      ) : deliveries.length === 0 ? (
        <p className="webhook-muted">No deliveries yet.</p>
      ) : (
        <ul className="webhook-deliveries__list">
          {deliveries.map(d => {
            const s = statusLabel(d.status)
            return (
              <li key={d.deliveryId} className="webhook-deliveries__row">
                <span className="webhook-deliveries__time">{formatRelativeTime(d.receivedAt)}</span>
                <span className={`webhook-deliveries__status webhook-deliveries__status--${s.tone}`}>{s.text}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

export default function AgentWebhookPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { currentTenant: tenant } = useTenant()
  const { showToast } = useToast()

  const state = location.state as LocationState | null
  const teamId = state?.teamId

  useEffect(() => {
    if (!teamId) navigate('/dashboard/agents', { replace: true })
  }, [teamId, navigate])

  const { data: agent } = useInternalAgent(teamId)
  const { data: webhook, isLoading: webhookLoading } = useAgentWebhook(teamId)

  const provisionMutation = useProvisionAgentWebhook()
  const resetMutation = useResetAgentWebhookCredentials()
  const updateMutation = useUpdateAgentWebhook()

  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
  const [resetConfirming, setResetConfirming] = useState(false)
  const viewedRef = useRef(false)
  useEffect(() => {
    if (!teamId || viewedRef.current || !webhook && webhook !== null) return
    if (webhookLoading) return
    viewedRef.current = true
    track('team_webhook_viewed', {
      team_id: teamId,
      provisioned: !!webhook,
      enabled: !!webhook?.enabled,
    })
  }, [teamId, webhook, webhookLoading])
  // When set, the HMAC confirm modal is open. The value carries the
  // direction the user is asking for so the copy and the confirm handler
  // can branch on enable vs disable.
  const [hmacConfirming, setHmacConfirming] = useState<{ enable: boolean } | null>(null)

  if (!teamId) return null

  // Three-state model:
  //   - webhook === undefined  → still loading the GET
  //   - webhook === null        → never provisioned (Status toggle is off, no
  //                               source row yet; flipping the toggle ON
  //                               provisions lazily)
  //   - webhook                 → provisioned; `.enabled` drives the toggle
  const isProvisioned = !!webhook
  const isOn = !!webhook?.enabled
  // Everything below the Status toggle is disabled when the webhook is off
  // OR while a mutation is mid-flight.
  const controlsDisabled = !isOn || updateMutation.isPending
  const isMutating = provisionMutation.isPending || updateMutation.isPending

  const copyText = (label: string, value: string) => {
    if (!value) return
    navigator.clipboard.writeText(value)
    if (label === 'Webhook URL') track('team_webhook_url_copied', { team_id: teamId })
    if (label === 'Signing secret') track('team_webhook_secret_copied', { team_id: teamId })
    showToast(`${label} copied`, 'success')
  }

  // Display name for toasts. Respect the casing the user typed in — no
  // title-case transform; their "Marketing Lead" stays "Marketing Lead"
  // and their "qa bot" stays "qa bot".
  const agentName = agent?.role ?? ''

  // The Status toggle is the page's single entry point. Provisioning is
  // deferred until the user enables — so by default an agent has no
  // event_sources row, no signing secret, no URL leaked.
  //
  // Lifecycle-event semantics: every off→on transition reapplies safe
  // defaults (HMAC signing required). Disabling preserves credentials so
  // the user can pick the same URL back up later, but bringing the
  // endpoint live again is treated as a "turning it on" moment — same
  // posture as the first provision — rather than a transparent unpause
  // that could expose an unauthenticated URL if HMAC was previously off.
  // The HMAC row sits above the fold, so the user sees the state without
  // needing a separate toast.
  const handleToggleStatus = async () => {
    if (!tenant?.id) return
    try {
      const suffix = agentName ? ` for ${agentName}` : ''
      const willBeEnabled = !isOn
      track('team_webhook_status_toggled', {
        team_id: teamId,
        enabled: willBeEnabled,
        first_provision: !isProvisioned,
      })
      if (!isProvisioned) {
        const result = await provisionMutation.mutateAsync(teamId)
        if (result.secret) setRevealedSecret(result.secret)
        await updateMutation.mutateAsync({
          internalAgentId: teamId,
          data: { enabled: true, hmacRequired: true },
        })
        showToast(`Webhook enabled${suffix}`, 'success')
      } else if (!isOn) {
        // off → on: reapply safe defaults alongside the enable flip.
        await updateMutation.mutateAsync({
          internalAgentId: teamId,
          data: { enabled: true, hmacRequired: true },
        })
        showToast(`Webhook enabled${suffix}`, 'success')
      } else {
        // on → off: pure pause, settings untouched.
        await updateMutation.mutateAsync({
          internalAgentId: teamId,
          data: { enabled: false },
        })
        showToast(`Webhook disabled${suffix}`, 'success')
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update webhook', 'error')
    }
  }

  // The toggle's onChange only opens the confirm modal — it never directly
  // mutates. The toggle stays in its current visual position until the user
  // confirms, which keeps the UI consistent if they cancel.
  const handleToggleHmac = () => {
    if (!webhook) return
    track('team_webhook_hmac_toggle_confirm_opened', {
      team_id: teamId,
      enable: !webhook.hmacRequired,
    })
    setHmacConfirming({ enable: !webhook.hmacRequired })
  }

  const handleConfirmHmac = async () => {
    if (!hmacConfirming) return
    try {
      await updateMutation.mutateAsync({
        internalAgentId: teamId,
        data: { hmacRequired: hmacConfirming.enable },
      })
      track('team_webhook_hmac_toggle_confirmed', {
        team_id: teamId,
        enabled: hmacConfirming.enable,
      })
      setHmacConfirming(null)
      showToast(
        hmacConfirming.enable ? 'HMAC signing required' : 'HMAC signing disabled',
        'success',
      )
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to update HMAC setting', 'error')
    }
  }

  const handleReset = async () => {
    try {
      const result = await resetMutation.mutateAsync(teamId)
      track('team_webhook_reset_confirmed', { team_id: teamId })
      setRevealedSecret(result.secret)
      setResetConfirming(false)
      showToast('Webhook credentials reset', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to reset credentials', 'error')
    }
  }

  return (
    <div className="agent-update">
      <BackButton onClick={() => navigate('/dashboard/agents/update', { state: { teamId } })} />

      <div className="agent-update__content">
        {/* Webhook on/off — primary control. Disabled state cascades to
            everything below. The toggle IS the state indicator; no
            description text needed. */}
        <section className="agent-update__section">
          <div className="webhook-row">
            <h2 className="agent-update__section-title">Webhook</h2>
            <Toggle
              label="Webhook"
              checked={isOn}
              disabled={isMutating || webhookLoading}
              onChange={handleToggleStatus}
            />
          </div>
        </section>

        {/* Everything below the toggle dims when the webhook is off — the
            controls are already disabled via the `controlsDisabled` prop,
            but the opacity makes the inactive state read at a glance. */}
        <div className={`webhook-controls${controlsDisabled ? ' webhook-controls--inactive' : ''}`}>

        {/* Webhook URL — code + outside copy. Empty until provisioned. */}
        <section className="agent-update__section">
          <h2 className="agent-update__section-title">Webhook URL</h2>
          <div className="webhook-credential-row">
            <CredentialRow
              value={webhook?.url ?? ''}
              ariaCopyLabel="Copy webhook URL"
              onCopy={() => webhook && copyText('Webhook URL', webhook.url)}
              hidden={controlsDisabled || !webhook}
            />
          </div>
        </section>

        {/* Signing secret — code + outside copy. Plaintext rendered ONLY
            immediately after provision/reset; otherwise dotted out. */}
        <section className="agent-update__section">
          <h2 className="agent-update__section-title">Signing secret</h2>
          <div className="webhook-credential-row">
            <CredentialRow
              value={revealedSecret ?? `••••••••••••••••${webhook?.secretHint ?? ''}`}
              ariaCopyLabel="Copy signing secret"
              onCopy={() => revealedSecret && copyText('Signing secret', revealedSecret)}
              hidden={controlsDisabled || !revealedSecret}
            />
          </div>
          {revealedSecret && !controlsDisabled && (
            <p className="webhook-warning">
              ⚠ Save this now — you won't see it again after you leave this page.
            </p>
          )}
          <div className="webhook-reset-row">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                track('team_webhook_reset_confirm_opened', { team_id: teamId })
                setResetConfirming(true)
              }}
              disabled={controlsDisabled}
            >
              Reset Webhook Credentials
            </Button>
          </div>
        </section>

        {/* HMAC signing — Toggle opens a confirmation modal rather than
            applying immediately, so the implications (esp. disabling auth)
            are explicit before any external-system contract changes. */}
        <section className="agent-update__section">
          <div className="webhook-row">
            <h2 className="agent-update__section-title">HMAC signing</h2>
            <Toggle
              label="HMAC signing"
              checked={!!webhook?.hmacRequired}
              disabled={controlsDisabled}
              onChange={handleToggleHmac}
            />
          </div>
        </section>

        {/* Recent deliveries */}
        <DeliveriesList agentId={teamId} disabled={controlsDisabled} />

        </div>
      </div>

      {hmacConfirming && (
        <ModalOverlay
          onClose={() => !updateMutation.isPending && setHmacConfirming(null)}
          disableClose={updateMutation.isPending}
          ariaLabelledBy="webhook-hmac-title"
        >
          <h2 id="webhook-hmac-title" className="webhook-dialog__title">
            {hmacConfirming.enable ? 'Require HMAC Signing' : 'Disable HMAC Signing'}
          </h2>
          <p className="webhook-dialog__description">
            {hmacConfirming.enable
              ? 'Requests must include a valid X-Liftoff-Signature header. Unsigned requests will be rejected.'
              : 'Anyone with the webhook URL can deliver events without authentication. We recommend keeping HMAC signing enabled.'}
          </p>
          <div className="webhook-dialog__actions">
            <Button
              variant="outline"
              onClick={() => setHmacConfirming(null)}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleConfirmHmac}
              loading={updateMutation.isPending}
            >
              {hmacConfirming.enable ? 'Require Signing' : 'Disable Signing'}
            </Button>
          </div>
        </ModalOverlay>
      )}

      {resetConfirming && (
        <ModalOverlay
          onClose={() => !resetMutation.isPending && setResetConfirming(false)}
          disableClose={resetMutation.isPending}
          ariaLabelledBy="webhook-reset-title"
        >
          <h2 id="webhook-reset-title" className="webhook-dialog__title">
            Reset Webhook Credentials
          </h2>
          <p className="webhook-dialog__description">
            This will replace the webhook URL and signing secret. Your external
            system will need both new values before it can deliver events again.
          </p>
          <div className="webhook-dialog__actions">
            <Button
              variant="outline"
              onClick={() => setResetConfirming(false)}
              disabled={resetMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleReset}
              loading={resetMutation.isPending}
            >
              Reset
            </Button>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}
