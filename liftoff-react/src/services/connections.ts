// Connections Service
// Manages connector integrations with the backend

import { api } from './api'

// Connector types matching backend ConnectorType union.
// Whether a connector is "Available" or "Coming Soon" in the UI is determined
// solely by the OAUTH_CONNECTORS and API_KEY_CONNECTORS sets below — NOT by
// comments here or by integrations.json status fields.
export type ConnectorType =
  // Google Workspace
  | 'google_drive' | 'google_docs' | 'google_sheets' | 'google_slides'
  | 'google_calendar' | 'google_mail' | 'google_contacts' | 'google_tasks'
  | 'google_bigquery' | 'google_firestore'
  // Microsoft 365
  | 'microsoft_onedrive' | 'microsoft_outlook_mail' | 'microsoft_outlook_calendar'
  | 'microsoft_teams' | 'microsoft_todo' | 'outlook_contacts'
  | 'microsoft_onenote' | 'microsoft_sharepoint' | 'microsoft_planner'
  | 'microsoft_excel'
  // CRM & Sales
  | 'salesforce' | 'hubspot'
  // GTM / market intelligence (vendor-hosted MCP + DCR)
  | 'outreach' | 'zoominfo' | 'common_room' | 'similarweb' | 'ahrefs' | 'supermetrics'
  // Marketing (vendor-hosted MCP + DCR, api_key, Composio-managed)
  | 'klaviyo' | 'kit' | 'omnisend' | 'amplitude' | 'pendo' | 'webflow' | 'typefully' | 'crustdata'
  | 'tapfiliate' | 'partnerstack' | 'crossbeam' | 'paddle' | 'salesloft' | 'snov' | 'sparktoro'
  | 'livestorm' | 'coupler' | 'keywords_everywhere' | 'tolt' | 'demandbase'
  | 'google_analytics' | 'google_search_console' | 'reddit_ads' | 'plausible' | 'dataforseo'
  // Communication & Collaboration
  | 'slack' | 'atlassian_jira' | 'atlassian_confluence' | 'zendesk' | 'intercom'
  // Dev & Version Control
  | 'github' | 'gitlab' | 'linear' | 'sentry' | 'datadog'
  // Storage
  | 'dropbox' | 'box'
  // Payments & Finance
  | 'stripe' | 'paypal' | 'square' | 'quickbooks' | 'xero' | 'plaid'
  // Scheduling
  | 'calendly' | 'cal_com'
  // Workspace & Productivity
  | 'notion' | 'asana' | 'zoom'
  // API key connectors
  | 'mailchimp' | 'sendgrid' | 'trello' | 'bamboohr' | 'woocommerce'
  // HR & Payroll
  | 'gusto' | 'rippling'
  // Native HRIS (in-house clients, auth.kind 'api_key')
  | 'namely' | 'workday' | 'oracle_hcm' | 'sap_successfactors'
  // Native HRIS batch 2 (customer-credential in-house clients)
  | 'deel' | 'factorial' | 'hibob' | 'personio' | 'ukg_pro' | 'ukg_ready'
  | 'dayforce' | 'adp_run' | 'adp_workforce_now'
  // Composio-managed (net-new)
  | 'discord' | 'airtable' | 'typeform' | 'freshbooks'
  // Other
  | 'pipedrive' | 'docusign' | 'snowflake' | 'databricks'
  | 'twilio' | 'website_forms' | 'linkedin' | 'reddit' | 'mongodb' | 'supabase'
  | 'apollo' | 'lever' | 'workable' | 'instantly'
  | 'clickup' | 'todoist' | 'greenhouse' | 'ashby' | 'freshdesk' | 'coda' | 'missive'
  | 'fireflies' | 'fathom' | 'shopify' | 'gumroad' | 'close' | 'browseai' | 'documint'
  | 'posthog' | 'mixpanel' | 'pandadoc'
  // Tenant-registered MCP server (public URL or tunnel-routed)
  | 'custom_mcp_server'
  // An API the workspace described and connected from a conversation. ONE
  // generic type: the provider is per instance, never in the shared catalog,
  // so this is the only name any of its connections ever has here. The page
  // compares against it to route the tile to a conversation rather than a
  // form, and the card to its own manage modal rather than the generic one.
  | 'custom_api_connector'
  // BYOK browser automation — these gate the per-thread live-view iframe in
  // the chat page's right pane (AgentChatPage). Any vendor that can OWN a
  // thread's browser belongs here; see SESSION_BROWSER_CONNECTORS there.
  | 'anchor_browser'
  | 'browser_use'
  | 'steel'
  // The saved logins the browsers sign in with: a 1Password service-account
  // token, api_key on /connections. Not a pane vendor; the runtime applies
  // the login at the session.
  | 'onepassword'
  // Net-new Composio-managed batch
  | 'activecampaign'
  | 'apify'
  // Capability-absorption data vendors. contactout and crunchbase
  // are user-visible; the rest are internal-tier and never reach the catalog
  // response, but the union carries every type so a visibility flip is a
  // one-word server-side change.
  | 'contactout'
  | 'crunchbase'
  | 'tikhub'
  | 'pdl'
  | 'hunterio'
  | 'saperly'
  | 'strale'
  | 'nasdaq'
  | 'ycombinator'
  | 'gloria'
  | 'minimax'
  | 'bytedance'
  | 'alibaba'
  | 'baserow'
  | 'brevo'
  | 'buildkite'
  | 'codacy'
  | 'dovetail'
  | 'elevenlabs'
  | 'fibery'
  | 'fillout'
  | 'folk'
  | 'follow_up_boss'
  | 'heygen'
  | 'imgbb'
  | 'incident_io'
  | 'jotform'
  | 'lemlist'
  | 'lemon_squeezy'
  | 'loops'
  | 'mailerlite'
  | 'mailersend'
  | 'mem'
  | 'new_relic'
  | 'northflank'
  | 'paperform'
  | 'scrapingbee'
  | 'supabase'
  | 'tally'
  | 'telegram'
  | 'toggl'
  | 'clicksend'
  | 'ticktick'
  | 'monday'
  | 'dialpad'
  | 'harvest'
  | 'google_meet'
  // Zoho suite — Composio-managed. zoho = Zoho CRM; books / desk / inventory /
  // mail ship coming_soon because Composio serves them no callable tools.
  | 'zoho'
  | 'zoho_bigin'
  | 'zoho_invoice'
  | 'zoho_books'
  | 'zoho_desk'
  | 'zoho_inventory'
  | 'zoho_mail'
  // Research — native sidecar (api_key); academic papers, reports, clinical trials, systematic reviews
  | 'elicit'

/**
 * Every status connector-service actually writes.
 *
 * `disconnected` must be listed: the backend returns it on real rows. Leaving
 * it out would break nothing only because `useIntegrations` admits `active` and
 * `error` alone, so those rows would be invisible by accident rather than by
 * decision — and the next person to widen that filter would trust this type and
 * be wrong.
 *
 *   pending       awaiting completion. A GitHub App install waiting on an
 *                 organization owner sits here, with
 *                 `config.installState === 'awaiting_org_approval'`.
 *   active        usable.
 *   error         broken and needs reconnecting. This is what the Connections
 *                 page renders as "Needs Reconnect".
 *   disconnected  deliberately removed, or an import placeholder that never
 *                 held a credential. NOT the same as `error`: there is nothing
 *                 to reconnect and nothing went wrong.
 *   disabled      turned off administratively.
 */
export type ConnectorStatus =
  | 'pending'
  | 'active'
  | 'error'
  | 'disconnected'
  | 'disabled'
export type CredentialStatus = 'active' | 'expired' | 'revoked' | 'refreshing'

export interface Connector {
  id: string
  tenantId: string
  type: ConnectorType
  name: string
  status: ConnectorStatus
  config: Record<string, unknown>
  apiKeyHint?: string | null
  lastSyncAt: string | null
  createdAt: string
  updatedAt: string
  credential?: {
    id: string
    status: CredentialStatus
    expiresAt: string | null
    lastRefreshedAt: string | null
  }
}

export interface AvailableConnector {
  type: ConnectorType
  name: string
  provider: string
  scopes: string[]
  supportsOAuth: boolean
}

export interface ConnectorHealthStats {
  totalConnectors: number
  healthyConnectors: number
  degradedConnectors: number
  errorConnectors: number
  activeIncidents: number
  avgSyncSuccessRate: number
}

// List all connectors for a tenant
export async function listConnectors(tenantId: string): Promise<Connector[]> {
  const response = await api.get<{ connectors: Connector[] }>(`/api/connectors?tenantId=${tenantId}`)
  return response.connectors
}

// Get a single connector
export async function getConnector(connectorId: string, tenantId: string): Promise<Connector> {
  return await api.get<Connector>(`/api/connectors/${connectorId}?tenantId=${tenantId}`)
}

// List available connector types
export async function listAvailableConnectors(): Promise<AvailableConnector[]> {
  const response = await api.get<{ connectors: AvailableConnector[] }>('/api/connectors/available')
  return response.connectors
}

// Delete a connector (disconnect)
export async function deleteConnector(connectorId: string, tenantId: string): Promise<void> {
  await api.delete(`/api/connectors/${connectorId}?tenantId=${tenantId}`)
}

// Update connector status
export async function updateConnectorStatus(
  connectorId: string,
  tenantId: string,
  status: 'active' | 'disabled'
): Promise<Connector> {
  return await api.patch<Connector>(
    `/api/connectors/${connectorId}/status?tenantId=${tenantId}`,
    { status }
  )
}

// Get connector health stats
export async function getConnectorHealthStats(tenantId: string): Promise<ConnectorHealthStats> {
  return await api.get<ConnectorHealthStats>(`/api/connectors/health/stats?tenantId=${tenantId}`)
}

export interface OAuthResult {
  success: boolean
  connectorType?: string
  connectorId?: string
  error?: string
  /**
   * GitHub App install leg only: GitHub recorded a REQUEST rather than an
   * install, because the person who asked is not an owner of the organisation.
   * Not a failure and not a success — an owner has to approve it, which may
   * happen weeks later or never.
   */
  pending?: boolean
  /** Organisation login a `pending` install is waiting on. */
  org?: string
}

export interface OAuthFlowHandle {
  promise: Promise<OAuthResult>
  cancel: () => void
}


// ── GitHub App installation ───────────────────────────────────────────────
//
// The GitHub connector's OAuth leg stores a USER token, so every write it makes
// is authored by a person and is indistinguishable from that person's own work.
// Installing the GitHub App gives those writes an identity of their own
// (`Liftoff[bot]`). The App install is a second leg that runs after the
// authorize leg, on a connector row that already exists.
//
// We ask which account to install on BEFORE handing the user to GitHub. When
// the user is not an owner of the organisation they choose, GitHub records a
// request and tells us nothing about which organisation it was for; the later
// approval webhook carries no reference back to whoever asked. The login the
// user picked here is the only thing that later webhook can be matched against.

export interface GitHubInstallTarget {
  id: number
  login: string
  type: 'User' | 'Organization'
  /**
   * True when the user is an owner of the org and can install directly. False
   * means they may still ASK: requesting is a supported outcome, so this labels
   * the row, it does not disable it.
   */
  canInstall: boolean
}

/** Accounts the connected GitHub user could install the App on. Personal
 *  account first, always installable. */
export async function listGitHubInstallTargets(tenantId: string): Promise<GitHubInstallTarget[]> {
  const response = await api.get<{ targets: GitHubInstallTarget[] }>(
    `/api/connectors/github-app/install-targets?tenantId=${encodeURIComponent(tenantId)}`,
  )
  return response.targets ?? []
}

export interface GitHubInstallStartParams {
  tenantId: string
  /** The login the user picked. Recorded server-side so a later approval can be
   *  attributed back to this tenant. */
  targetLogin: string
  /** Pre-selects the account on GitHub's own screen. Advisory only — the user
   *  can switch accounts there, so never label a card from this value. */
  targetId?: number
  accountId?: string
}

/** Returns the github.com URL that opens GitHub's own install screen.
 *  `redirectUri` is echoed back verbatim by connector-service, which is what
 *  makes this work on localhost against deployed dev with no tunnel. */
export async function startGitHubAppInstall(params: GitHubInstallStartParams): Promise<string> {
  const { tenantId, targetLogin, targetId, accountId } = params
  const response = await api.post<{ installUrl: string }>(
    '/api/connectors/github-app/install-start',
    {
      tenantId,
      redirectUri: `${window.location.origin}/oauth/callback`,
      targetLogin,
      ...(targetId !== undefined ? { targetId } : {}),
      ...(accountId ? { accountId } : {}),
    },
  )
  return response.installUrl
}

export interface GitHubAppInstallResult {
  /**
   *  - 'installed' — the App is on the account
   *  - 'pending'   — GitHub recorded a request; an owner must approve
   *  - 'error'     — the callback came back with a failure
   *  - 'closed'    — the popup went away without telling us anything, which
   *                  proves nothing either way. Ask the backend.
   */
  status: 'installed' | 'pending' | 'error' | 'closed'
  connectorId?: string
  org?: string
  error?: string
}

export interface GitHubAppInstallHandle {
  promise: Promise<GitHubAppInstallResult>
  cancel: () => void
}

/**
 * Watch an already-open install popup for its outcome.
 *
 * The popup must be opened by the caller, synchronously inside the click that
 * started this — opening it after awaiting `startGitHubAppInstall` is what
 * popup blockers exist to stop.
 */
export function watchGitHubAppInstall(popup: Window): GitHubAppInstallHandle {
  let cleanup: (() => void) | null = null
  let resolvePromise: ((result: GitHubAppInstallResult) => void) | null = null

  const promise = new Promise<GitHubAppInstallResult>((resolve) => {
    resolvePromise = resolve
    const channel = new BroadcastChannel('oauth_callback')

    // Same COOP guard as startOAuthFlow: a COOP-protected document reads as
    // closed while it is very much alive, and the read itself floods the
    // console. Treat an unreadable popup as open and let the broadcast decide.
    const safeClosed = (): boolean => {
      try {
        return popup.closed
      } catch {
        return false
      }
    }

    cleanup = () => {
      channel.close()
      clearInterval(pollTimer)
      if (!safeClosed()) {
        try { popup.close() } catch { /* COOP-protected */ }
      }
    }

    channel.onmessage = (event) => {
      if (event.data?.type !== 'oauth_callback') return

      cleanup?.()
      cleanup = null
      const { success, connectorId, error, pending, org } = event.data
      if (pending) {
        resolve({ status: 'pending', connectorId, org })
      } else if (success) {
        resolve({ status: 'installed', connectorId })
      } else {
        resolve({ status: 'error', error: error ?? 'github_install_failed' })
      }
    }

    const pollTimer = setInterval(() => {
      if (safeClosed()) {
        cleanup?.()
        cleanup = null
        resolve({ status: 'closed' })
      }
    }, 500)
  })

  const cancel = () => {
    if (cleanup) {
      cleanup()
      cleanup = null
    }
    resolvePromise?.({ status: 'closed' })
  }

  return { promise, cancel }
}


// Start OAuth flow for a connector using a popup window
// Returns a handle with the promise and a cancel function to abort the flow
// Security: Uses POST with credentials in body, not URL (FIX: SE-002)
// A popup reported closed sooner than this did not have time to be closed by a
// person; it is Cross-Origin-Opener-Policy severing the opener. Providers that
// send COOP on their authorize page (Stripe does) make `popup.closed` read true
// while the window is alive, so the signal is discarded rather than believed.
const COOP_SEVERED_MS = 2_000

// How long an authorisation may take before an unsettled flow is called
// abandoned. Stripe's real one took 106 seconds including login and 2FA.
const OAUTH_BACKSTOP_MS = 5 * 60_000

export function startOAuthFlow(connectorType: ConnectorType, tenantId: string, _idToken: string, dynamicUrlParams?: Record<string, string>, reconnectConnectorId?: string): OAuthFlowHandle {
  let cleanup: (() => void) | null = null
  let resolvePromise: ((result: OAuthResult) => void) | null = null

  // The rule below guards against an async executor throwing before it resolves,
  // which would strand the promise forever because the rejection has nowhere to
  // go. That cannot happen here: the only statements outside the try are the
  // assignment and template literal immediately below, neither of which can
  // throw, and the try's catch resolves. Worth unpicking into a plain async
  // function eventually, but this is the live OAuth popup path and the executor
  // is not the risky part of it.
  // eslint-disable-next-line no-async-promise-executor
  const promise = new Promise<OAuthResult>(async (resolve) => {
    resolvePromise = resolve
    let backstopTimer: ReturnType<typeof setTimeout> | null = null
    const returnUrl = `${window.location.origin}/oauth/callback`

    try {
      // POST request with credentials in body, not URL
      // Authorization header is automatically included by the api service
      const response = await api.post<{ authUrl: string; state: string }>(
        `/api/connectors/oauth/${connectorType}/start?tenantId=${tenantId}`,
        { returnUrl, ...(dynamicUrlParams ? { dynamicUrlParams } : {}), ...(reconnectConnectorId ? { connectorId: reconnectConnectorId } : {}) }
      )

      const { authUrl } = response

      // Open popup window centered on screen
      const width = 600
      const height = 700
      const left = window.screenX + (window.outerWidth - width) / 2
      const top = window.screenY + (window.outerHeight - height) / 2
      const popup = window.open(
        authUrl,
        'oauth_popup',
        `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes`
      )

      // Handle popup blocked by browser
      if (!popup) {
        resolve({ success: false, error: 'popup_blocked' })
        return
      }

      // Use BroadcastChannel to receive result from popup
      // This works even when window.opener is null (cleared by external OAuth navigation)
      const channel = new BroadcastChannel('oauth_callback')

      // safeClosed: reading popup.closed throws a Cross-Origin-Opener-Policy
      // warning in dev tools when the popup is on a different origin (e.g.
      // composio.dev for composio_managed connectors). The returned value
      // is still usable — Chromium hard-blocks the read for actually
      // cross-origin documents but treats COOP-protected documents as
      // "closed = true" — but the noisy console warning floods logs.
      // Wrap in try/catch so we don't propagate either the warning OR a
      // potential throw if a future browser hardens this further.
      const safeClosed = (): boolean => {
        try {
          return popup.closed
        } catch {
          // COOP-protected — treat as still open; BroadcastChannel will
          // resolve the promise when the callback page broadcasts success.
          return false
        }
      }

      cleanup = () => {
        channel.close()
        clearInterval(pollTimer)
        if (backstopTimer) clearTimeout(backstopTimer)
        // Try to close the popup if still open
        if (!safeClosed()) {
          try { popup.close() } catch { /* COOP-protected */ }
        }
      }

      channel.onmessage = (event) => {
        if (event.data?.type !== 'oauth_callback') return

        cleanup?.()
        cleanup = null
        const { success, connectorType: ct, connectorId, error } = event.data
        resolve({ success, connectorType: ct, connectorId, error })
      }

      // Poll to detect if popup was closed without completing.
      // BroadcastChannel is the primary success signal; this polling is
      // only the fallback for "user manually closed the popup mid-flow".
      //
      // `popup.closed` STOPS MEANING "closed" once the popup navigates to a
      // provider that sends Cross-Origin-Opener-Policy: same-origin. Chromium
      // severs the opener and then reports the window as closed while it is
      // very much alive and the user is still typing their password. Stripe's
      // authorize page does exactly this
      // (access.stripe.com/mcp/oauth2/authorize), so this poll fired about half
      // a second in, resolved `popup_closed`, and cleanup() closed the
      // BroadcastChannel — roughly a hundred seconds before the real success
      // broadcast arrived. Nothing was shown to the user, because a sub-15s
      // "close" is deliberately read as someone changing their mind. The
      // connection succeeded on the server every time and the dashboard said
      // nothing at all.
      //
      // A close observed within a second or two of opening is not a human
      // closing a window; it is the opener being severed. Treat the signal as
      // spent and let the channel decide, with a backstop below so the promise
      // can still settle if the broadcast never lands.
      const openedAt = Date.now()
      const pollTimer = setInterval(() => {
        if (!safeClosed()) return
        if (Date.now() - openedAt < COOP_SEVERED_MS) {
          clearInterval(pollTimer)
          return
        }
        cleanup?.()
        cleanup = null
        resolve({ success: false, error: 'popup_closed' })
      }, 500)

      // Backstop: without the poll, an abandoned flow on a COOP provider would
      // never settle and the button would spin forever. Long enough not to cut
      // off a real authorisation (Stripe's took 106 seconds, including a login
      // and a 2FA prompt).
      backstopTimer = setTimeout(() => {
        cleanup?.()
        cleanup = null
        resolve({ success: false, error: 'popup_closed' })
      }, OAUTH_BACKSTOP_MS)
    } catch {
      resolve({ success: false, error: 'oauth_start_failed' })
    }
  })

  const cancel = () => {
    if (cleanup) {
      cleanup()
      cleanup = null
    }
    // Resolve with canceled error so the promise completes
    resolvePromise?.({ success: false, error: 'canceled' })
  }

  return { promise, cancel }
}


// ── REMOVED in Phase 4 of the catalog consolidation cutover ──
//
// The hardcoded OAUTH_CONNECTORS / API_KEY_CONNECTORS / KEYPAIR_CONNECTORS /
// MCP_CONNECTORS sets + supportsConnection / supportsOAuth / usesApiKey /
// usesKeypair / usesMCP helpers used to live in this file (and became
// stale every time the backend registry changed). They are now derived
// from the live backend catalog — use the `useConnectorCatalog()` hook
// (src/hooks/useConnectorCatalog.ts) instead.
//
// INTEGRATION_TO_CONNECTOR_TYPE / CONNECTOR_TYPE_TO_INTEGRATION also
// lived here; since the frontend now uses backend connector-type
// identifiers everywhere, the translation layer is unnecessary. Icon
// lookups accept either form via the alias map in
// src/components/icons/IntegrationIcons.tsx.
//
// Rationale: single source of truth lives in the connector-service
// CONNECTORS registry (liftoff-connector-service/src/catalog/connectors.ts),
// served via GET /api/connectors/catalog and cached for 5 minutes via
// TanStack Query.
