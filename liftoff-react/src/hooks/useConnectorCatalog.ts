// Connector catalog hook.
//
// Fetches the single source of truth for connector metadata from the
// backend:
//
//   GET /api/connectors/catalog
//     → ConnectorCatalogResponse = {
//         connectors: ConnectorDef[],
//         version: string,
//         categoryLabels: Record<ConnectorCategory, string>
//       }
//
// Replaces the hardcoded src/data/integrations.json + the OAUTH_CONNECTORS /
// API_KEY_CONNECTORS / KEYPAIR_CONNECTORS sets that used to live in
// src/services/connections.ts. See docs/CONNECTORS.md in liftoff-connector-service
// for the registry + projections design.

import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api } from '../services/api'
import { useAuth } from '../contexts/AuthContext'

// ── Types (mirror @liftoffos/connector-types, but the frontend doesn't
//    depend on the published package — values arrive over HTTP as plain JSON). ──

export type ConnectorCatalogStatus = 'available' | 'coming_soon' | 'beta' | 'deprecated'

export type ConnectorCategory =
  | 'crm_sales'
  | 'productivity_comms'
  | 'engineering'
  | 'customer_support'
  | 'finance'
  | 'accounting'
  | 'hr'
  | 'storage'
  | 'meetings_scheduling'
  | 'data'
  | 'knowledge'
  | 'observability'
  | 'marketing_comms'
  | 'social_messaging'
  | 'project_management'
  | 'e_commerce'
  | 'error_tracking'
  | 'instant_connect'
  | 'incident_management'
  | 'ats'
  | 'infrastructure'

export type ConnectorAuthKind =
  | 'static_oauth'
  | 'dcr_oauth'
  | 'api_key'
  | 'keypair'
  | 'custom_mcp'
  // An API the workspace described and connected from a conversation. There is
  // no static form behind it — the fields only exist once an assistant has read
  // a particular provider's documentation — so its tile starts a conversation
  // rather than opening one. An unhandled kind falls through to the OAuth
  // branch in ConnectIntegrationModal, so leaving this out does not degrade: it
  // misroutes.
  | 'custom_api'
  | 'iam_grant'
  | 'none'

export interface ConnectorAuth {
  kind: ConnectorAuthKind
  // Other fields (clientIdEnvVar, scopes, etc.) exist on the backend but
  // aren't relevant to the UI. Kept loose intentionally.
  [k: string]: unknown
}

export interface ConnectorMcp {
  kind: 'vendor_hosted' | 'sidecar' | 'customer_hosted' | 'composio_managed'
  [k: string]: unknown
}

export interface ConnectorCapabilityBinding {
  capability: string
  requiredScopes: string[]
}

export interface ConnectorDef {
  type: string
  displayName: string
  description?: string
  category: ConnectorCategory
  objectsCovered?: string[]
  status: ConnectorCatalogStatus
  statusReason?: string
  auth: ConnectorAuth
  mcp?: ConnectorMcp
  capabilities?: ConnectorCapabilityBinding[]
  /**
   * Whether a tenant may hold several independent connections of this type.
   *
   * This comment used to claim the flag "keeps the Add tile persistent and
   * emits one Connected tile per instance". Both halves were wrong:
   *
   *   - the Available tile persists for EVERY type regardless — `integrations`
   *     is built from the catalog and its status never depends on whether an
   *     instance is connected
   *   - one Connected tile per live connector row also happens regardless —
   *     `connected` maps over `liveConnectors`, not over the catalog
   *
   * Its only effect in this app is the card `id` in useIntegrations: namespaced
   * as `<type>:<connectorId>` when true, the bare connector id when false. Both
   * are unique, so this is presentational.
   *
   * Where it IS load-bearing is the backend, and only for Composio-managed
   * connectors: on reconnect, connector-service retires the previously linked
   * Composio account for a single-instance connector and keeps sibling accounts
   * for a multi-instance one (liftoff-connector-service apikey-router.ts). Do
   * not set or clear it to change anything about this UI.
   */
  multiInstance?: boolean
}

export interface ConnectorCatalogResponse {
  connectors: ConnectorDef[]
  version: string
  categoryLabels: Record<ConnectorCategory, string>
}

// ── Hook ────────────────────────────────────────────────────────────

/**
 * Shape returned to callers. `connectors` and `categoryLabels` come
 * straight from the wire; `byType` is a memoised lookup map and the
 * helper functions are closures over it so callers don't have to
 * re-implement gating logic.
 */
export interface UseConnectorCatalog {
  /** Undefined while loading; empty array if the endpoint errored. */
  connectors: ConnectorDef[]
  /** Undefined while loading. */
  categoryLabels: Record<ConnectorCategory, string> | undefined
  /** Opaque version string from the backend. */
  version: string | undefined
  /** Fast lookup by connector type. */
  byType: Map<string, ConnectorDef>

  // ── Helpers (replace the old supportsConnection / usesApiKey / etc.
  //    sets in connections.ts — all derived from the catalog). ──

  /** True if the connector is live (status === 'available'). */
  supportsConnection: (connectorType: string) => boolean
  /** True if the connector uses OAuth (static or DCR). */
  supportsOAuth: (connectorType: string) => boolean
  /** True if the connector is authenticated by user-provided API key. */
  usesApiKey: (connectorType: string) => boolean
  /** True if the connector uses RSA keypair auth (e.g. Snowflake). */
  usesKeypair: (connectorType: string) => boolean
  /** True if the connector uses the inline Custom MCP Server flow. */
  usesCustomMcp: (connectorType: string) => boolean
  /** True for the one generic custom-API type. Its tile hands the person to
   *  Liftoff with the question framed, because the connection's fields are not
   *  knowable until an assistant has read the provider's documentation. */
  usesCustomApi: (connectorType: string) => boolean
  /** True if the connector uses keyless IAM-grant + verify onboarding (e.g. BigQuery). */
  usesIamGrant: (connectorType: string) => boolean
  /** True if the connector has an MCP server (vendor-hosted, sidecar, or customer-hosted). */
  usesMCP: (connectorType: string) => boolean
  /** Human label for the category enum — falls back to the raw key. */
  labelForCategory: (category: ConnectorCategory | string) => string

  // Lifecycle state for the UI.
  isLoading: boolean
  isError: boolean
  error: unknown
}

export const CONNECTOR_CATALOG_QUERY_KEY = ['connector-catalog'] as const

async function fetchCatalog(): Promise<ConnectorCatalogResponse> {
  return api.get<ConnectorCatalogResponse>('/api/connectors/catalog')
}

export function useConnectorCatalog(): UseConnectorCatalog {
  const { user } = useAuth()
  const query = useQuery({
    queryKey: CONNECTOR_CATALOG_QUERY_KEY,
    queryFn: fetchCatalog,
    // Only fire once Firebase has confirmed an auth session. Without this
    // guard the query fires on mount before auth.currentUser is set, the
    // request reaches the backend without an Authorization header, and the
    // server returns 401 — leaving the page blank for the rest of the session.
    // Same pattern as the enabled: !!tenant?.id guard in useConnectors.
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  })

  // Memoized because `?? []` mints a new array every render, which would make
  // every memo keyed on it recompute every render.
  const connectors = useMemo(() => query.data?.connectors ?? [], [query.data?.connectors])
  const categoryLabels = query.data?.categoryLabels

  const byType = useMemo(() => {
    const m = new Map<string, ConnectorDef>()
    for (const c of connectors) m.set(c.type, c)
    return m
  }, [connectors])

  return useMemo<UseConnectorCatalog>(() => {
    const supportsConnection = (t: string) => byType.get(t)?.status === 'available'
    const supportsOAuth = (t: string) => {
      const k = byType.get(t)?.auth.kind
      return k === 'static_oauth' || k === 'dcr_oauth'
    }
    const usesApiKey = (t: string) => byType.get(t)?.auth.kind === 'api_key'
    const usesKeypair = (t: string) => byType.get(t)?.auth.kind === 'keypair'
    const usesCustomMcp = (t: string) => byType.get(t)?.auth.kind === 'custom_mcp'
    const usesCustomApi = (t: string) => byType.get(t)?.auth.kind === 'custom_api'
    const usesIamGrant = (t: string) => byType.get(t)?.auth.kind === 'iam_grant'
    const usesMCP = (t: string) => byType.get(t)?.mcp !== undefined
    const labelForCategory = (c: ConnectorCategory | string) =>
      (categoryLabels?.[c as ConnectorCategory]) ?? String(c)

    return {
      connectors,
      categoryLabels,
      version: query.data?.version,
      byType,
      supportsConnection,
      supportsOAuth,
      usesApiKey,
      usesKeypair,
      usesCustomMcp,
      usesCustomApi,
      usesIamGrant,
      usesMCP,
      labelForCategory,
      isLoading: query.isLoading,
      isError: query.isError,
      error: query.error,
    }
  }, [connectors, categoryLabels, byType, query.data?.version, query.isLoading, query.isError, query.error])
}
