import { useState, useCallback, useRef } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useToast } from '../contexts/ToastContext'
import { useConnectors } from './useConnectors'
import {
  startOAuthFlow,
  type ConnectorType,
  type OAuthResult,
  type GitHubAppInstallResult,
} from '../services/connections'
import GitHubInstallTargetModal from '../components/GitHubInstallTargetModal'
import { useConnectorCatalog } from './useConnectorCatalog'
import { track } from '../lib/analytics'

interface UseIntegrationConnectOptions {
  onSuccess?: () => void
  onError?: (error: string) => void
  /**
   * Suppress the built-in "Successfully connected …" toast. Callers that run a
   * follow-up step (e.g. the HR-system picker, which binds + syncs and shows its
   * own single toast when done) opt in so the user does not see two toasts.
   */
  suppressSuccessToast?: boolean
}

export function useIntegrationConnect(options: UseIntegrationConnectOptions = {}) {
  const { currentTenant: tenant, tenantLoading, getIdToken } = useAuth()
  const { showToast } = useToast()
  const { data: connectorsData, refetch: refetchConnectors } = useConnectors()
  const { supportsConnection } = useConnectorCatalog()
  const [connecting, setConnecting] = useState(false)
  const cancelRef = useRef<(() => void) | null>(null)
  // The GitHub App install leg runs INSIDE connect(), between the authorize
  // popup and the outcome, so connect() still resolves with what actually
  // happened. The picker is a modal, so the promise it settles is parked here
  // and resolved by the modal's callbacks.
  const [installPrompt, setInstallPrompt] = useState<{ tenantId: string } | null>(null)
  const installResolveRef = useRef<((result: GitHubAppInstallResult | null) => void) | null>(null)

  const tenantId = tenant?.id

  function getErrorMessage(error?: string): string {
    switch (error) {
      case 'oauth_denied':
        return 'Connection was canceled or denied.'
      case 'invalid_state':
        return 'Session expired. Please try again.'
      case 'token_exchange_failed':
        return 'Failed to complete authentication. Please try again.'
      case 'credential_store_failed':
        return 'Connection succeeded but credentials could not be saved. Please try again.'
      case 'callback_failed':
        return 'Something went wrong. Please try again.'
      case 'popup_closed':
      case 'canceled':
        return 'Connection was canceled.'
      case 'popup_blocked':
        return 'Popup was blocked. Please allow popups and try again.'
      default:
        return 'Failed to connect. Please try again.'
    }
  }

  /**
   * A connect attempt that ran this long before the popup closed was almost
   * certainly a real authorisation, not a change of mind — nobody reaches a
   * vendor consent screen, reads it and approves in under this. Used ONLY to
   * decide whether to speak up when we cannot confirm the outcome, so an
   * instant "actually, no" stays silent while a genuine attempt that vanished
   * does not.
   */
  const REAL_ATTEMPT_MS = 15_000

  /** id → updatedAt for this connector type, read from cache so taking it
   *  costs no network round-trip before `window.open` (an extra await there
   *  risks the popup being blocked). */
  const snapshotConnectors = useCallback((connectorType?: ConnectorType): Map<string, string> => {
    return new Map(
      (connectorsData ?? [])
        .filter((c) => c.type === connectorType)
        .map((c) => [c.id, c.updatedAt]),
    )
  }, [connectorsData])

  /**
   * Did this attempt actually reach us? Asks the backend rather than inferring
   * an outcome from the popup, which knows nothing.
   *
   * Compares against a snapshot taken before the popup opened instead of just
   * asking "is there a row?" — on a RECONNECT there is always already a row,
   * so mere presence would report success for an attempt the user abandoned.
   * A new id, or a touched `updatedAt`, is what proves /callback ran.
   */
  const connectorLanded = useCallback(async (
    connectorType: ConnectorType | undefined,
    before: Map<string, string>,
  ): Promise<boolean> => {
    if (!connectorType) return false
    try {
      const { data } = await refetchConnectors()
      return (data ?? [])
        .filter((c) => c.type === connectorType)
        .some((c) => !before.has(c.id) || before.get(c.id) !== c.updatedAt)
    } catch {
      // A failed refetch is not evidence of anything; fall through to the
      // unconfirmed path rather than claiming the connect failed.
      return false
    }
  }, [refetchConnectors])

  /**
   * What the backend says the install leg did, read off the connector row.
   *
   * Consulted when the popup goes away without telling us anything: a
   * COOP-protected popup reads as closed while it is still alive, and a popup
   * that really did close proves nothing either way. Same discipline as
   * `connectorLanded` — the popup is not evidence.
   */
  const readGitHubInstallState = useCallback(async (connectorId?: string): Promise<{
    installState?: string
    awaitingOrgLogin?: string
    installationId?: number
  }> => {
    try {
      const { data } = await refetchConnectors()
      const rows = (data ?? []).filter((c) => c.type === 'github')
      const row = rows.find((c) => c.id === connectorId) ?? rows[0]
      return (row?.config ?? {}) as {
        installState?: string
        awaitingOrgLogin?: string
        installationId?: number
      }
    } catch {
      return {}
    }
  }, [refetchConnectors])

  /** Open the account picker and wait for the whole install leg. Resolves null
   *  when the user dismisses the picker without going to GitHub. */
  function promptGitHubInstall(forTenantId: string): Promise<GitHubAppInstallResult | null> {
    return new Promise((resolve) => {
      installResolveRef.current = resolve
      setInstallPrompt({ tenantId: forTenantId })
    })
  }

  function closeInstallPrompt(result: GitHubAppInstallResult | null) {
    setInstallPrompt(null)
    const resolve = installResolveRef.current
    installResolveRef.current = null
    resolve?.(result)
  }

  /**
   * Outcome of the GitHub App install leg.
   *
   * The authorize leg has already landed by the time this runs, so GitHub IS
   * connected in every branch below. Only the bot identity is in question.
   *
   * `pending` is a real outcome, not a failure. The generic unconfirmed line
   * ("it will appear here in a few minutes") is simply false for it: a
   * requested install appears when an organisation owner approves, which may
   * be weeks away and may never happen. That toast exists because a genuinely
   * broken integration once looked like silence for two weeks, so it must not
   * now be used to tell a different untruth.
   */
  const handleGitHubInstallResult = useCallback(async (
    result: GitHubAppInstallResult | null,
    integrationName?: string,
    connectorId?: string,
  ) => {
    const label = integrationName ?? 'GitHub'
    const finish = () => {
      refetchConnectors()
      options.onSuccess?.()
    }
    const connectedToast = () => {
      if (!options.suppressSuccessToast) {
        showToast(`Successfully connected ${label}!`, 'success')
      }
    }

    // Dismissed the picker. The connection itself is live and usable; it just
    // writes as the person until someone installs the app.
    if (!result) {
      track('github_app_install_dismissed', { connector: 'github' })
      connectedToast()
      finish()
      return
    }

    let status = result.status
    let org = result.org
    if (status === 'closed') {
      const config = await readGitHubInstallState(connectorId)
      if (config.installState === 'awaiting_org_approval') {
        status = 'pending'
        org = config.awaitingOrgLogin
      } else if (config.installState === 'installed' || config.installationId !== undefined) {
        status = 'installed'
      }
    }

    if (status === 'installed') {
      track('github_app_installed', { connector: 'github' })
      connectedToast()
      finish()
      return
    }

    if (status === 'pending') {
      track('github_app_install_pending', { connector: 'github', org: org ?? '' })
      showToast(
        org
          ? `Request sent. An owner of ${org} needs to approve the Liftoff installation.`
          : 'Request sent. An organization owner needs to approve the Liftoff installation.',
        'success',
      )
      finish()
      return
    }

    track('github_app_install_failed', { connector: 'github', reason: result.error ?? status })
    showToast(
      result.error === 'popup_blocked'
        ? 'Popup was blocked. Please allow popups and try again.'
        : `${label} is connected, but the Liftoff app was not installed. Connect ${label} again to retry the installation.`,
      'error',
    )
    finish()
  }, [options, readGitHubInstallState, refetchConnectors, showToast])

  /**
   * `elapsedMs` is how long the whole attempt took. Only consulted on the
   * unconfirmed path.
   *
   * Treating the popup closing WITHOUT a result as a user cancel (tracked, no
   * toast, nothing shown) makes a totally broken integration look like
   * silence: if the OAuth provider stops redirecting back to us, every user
   * sees exactly what a cancel looks like. The popup tells us nothing; the
   * backend does.
   */
  const handleOAuthResult = useCallback(async (
    result: OAuthResult,
    integrationName?: string,
    connectorType?: ConnectorType,
    elapsedMs = 0,
    before: Map<string, string> = new Map(),
  ) => {
    const connectorLabel = connectorType ?? integrationName ?? 'unknown'
    const succeed = () => {
      track('connection_oauth_completed', { connector: connectorLabel })
      if (!options.suppressSuccessToast) {
        showToast(`Successfully connected ${integrationName ?? 'integration'}!`, 'success')
      }
      refetchConnectors()
      options.onSuccess?.()
    }

    if (result.success) {
      succeed()
    } else if (result.error === 'popup_closed' || result.error === 'canceled') {
      // The connector may well be there: the callback page can broadcast and
      // close faster than we read the message, and a COOP-protected popup
      // reads as closed while it is still alive. Check before concluding.
      if (await connectorLanded(connectorType, before)) {
        succeed()
        return
      }

      // Genuinely nothing landed. An explicit cancel, or a quick popup close,
      // stays silent — that is a user deciding not to connect.
      if (result.error === 'canceled' || elapsedMs < REAL_ATTEMPT_MS) {
        track('connection_oauth_canceled', { connector: connectorLabel })
        return
      }

      // Long attempt, no connector, no callback. Either the redirect back to
      // us failed or the user abandoned a half-finished flow. Say so plainly
      // instead of pretending it was a cancel. The connector-service
      // reconciler adopts stranded connections within minutes, so "it will
      // appear" is a promise the backend actually keeps.
      track('connection_oauth_unconfirmed', {
        connector: connectorLabel,
        elapsedMs,
      })
      const message =
        `We could not confirm the ${integrationName ?? 'integration'} connection. ` +
        `If you finished authorising, it will appear here in a few minutes.`
      showToast(message, 'error')
      options.onError?.('unconfirmed')
    } else {
      track('connection_oauth_failed', {
        connector: connectorLabel,
        reason: result.error ?? 'unknown',
      })
      const errorMessage = getErrorMessage(result.error)
      showToast(errorMessage, 'error')
      options.onError?.(errorMessage)
    }
  }, [connectorLanded, options, refetchConnectors, showToast])

  const cancelConnect = useCallback(() => {
    if (cancelRef.current) {
      cancelRef.current()
      cancelRef.current = null
    }
  }, [])

  const connect = useCallback(async (connectorType: ConnectorType | undefined, integrationName?: string, dynamicUrlParams?: Record<string, string>, reconnectConnectorId?: string) => {
    if (!connectorType) {
      showToast('This integration is not yet available.', 'error')
      return false
    }

    if (!tenantId) {
      if (tenantLoading) {
        showToast('Loading workspace... Please wait a moment and try again.', 'error')
      } else {
        showToast('Workspace not ready. Please refresh the page.', 'error')
      }
      return false
    }

    if (!supportsConnection(connectorType)) {
      showToast('This integration requires manual configuration.', 'error')
      return false
    }

    try {
      setConnecting(true)
      const idToken = await getIdToken()
      if (!idToken) {
        showToast('Authentication required. Please sign in again.', 'error')
        setConnecting(false)
        return false
      }

      track('connection_oauth_started', { connector: connectorType })
      // Snapshot before the popup so we can tell "this attempt wrote a row"
      // from "a row for this type already existed" on reconnects.
      const before = snapshotConnectors(connectorType)
      // Start OAuth flow in popup - returns handle with promise and cancel function
      const startedAt = Date.now()
      const handle = startOAuthFlow(connectorType, tenantId, idToken, dynamicUrlParams, reconnectConnectorId)
      cancelRef.current = handle.cancel

      const result = await handle.promise
      cancelRef.current = null

      // GitHub gets a second leg: installing the App is what gives its writes
      // an identity of their own instead of authoring them as the person who
      // authorised. Only reachable once the authorize leg has landed, because
      // the picker needs the user token it just stored.
      if (result.success && connectorType === 'github') {
        const installResult = await promptGitHubInstall(tenantId)
        await handleGitHubInstallResult(installResult, integrationName, result.connectorId)
        // The connection landed regardless of what the install did.
        return true
      }

      // Awaited: on the unconfirmed path this asks the backend what actually
      // happened before deciding what to tell the user.
      await handleOAuthResult(result, integrationName, connectorType, Date.now() - startedAt, before)
      return result.success
    } catch (error) {
      console.error('OAuth flow failed:', error)
      track('connection_oauth_failed', {
        connector: connectorType,
        reason: error instanceof Error ? error.message : 'unknown',
      })
      showToast('Failed to start connection. Please try again.', 'error')
      return false
    } finally {
      setConnecting(false)
      cancelRef.current = null
    }
  }, [tenantId, tenantLoading, getIdToken, showToast, supportsConnection, snapshotConnectors, handleGitHubInstallResult, handleOAuthResult])

  const canConnect = useCallback((connectorType: ConnectorType | undefined): boolean => {
    if (!connectorType) return false
    if (!tenantId && !tenantLoading) return false
    if (!supportsConnection(connectorType)) return false
    return true
  }, [tenantId, tenantLoading, supportsConnection])

  // Rendered by the caller. Owned here so the picker cannot be half-wired:
  // every surface that can start a GitHub connect gets the install leg by
  // rendering one node, and connect() still resolves with the real outcome.
  const installTargetModal = installPrompt ? (
    <GitHubInstallTargetModal
      tenantId={installPrompt.tenantId}
      onCancel={() => closeInstallPrompt(null)}
      onComplete={(result) => closeInstallPrompt(result)}
    />
  ) : null

  return {
    connect,
    connecting,
    cancelConnect,
    canConnect,
    installTargetModal,
    tenantReady: !tenantLoading && !!tenantId,
  }
}
