import { useMemo } from 'react'
import { useConnectors } from './useConnectors'
import { getIntegrationIcon } from '../components/icons/integrationIconRegistry'
import { useConnectorCatalog, type ConnectorDef } from './useConnectorCatalog'
import { installState } from '../utils/githubInstall'
import type { Connector, ConnectorType } from '../services/connections'

export interface Integration {
  id: string
  name: string
  /** Category display label (backend-supplied, e.g. "CRM & Sales"). */
  type: string
  icon: React.ReactNode
  /**
   *   - 'connected'            — connector row is `active` and healthy
   *   - 'needs_reconnect'      — connector row is `error` (OAuthRefreshError fired
   *                              at runtime; user must reconnect to restore service)
   *   - 'pending_org_approval' — GitHub App install was REQUESTED, not granted:
   *                              the person who asked is not an owner of the
   *                              organisation, so an owner has to approve it
   *                              before anything works
   *   - 'available'            — catalog entry, no live connector for this type
   *   - 'planned'              — catalog entry not yet shipped
   */
  status: 'connected' | 'needs_reconnect' | 'pending_org_approval' | 'available' | 'planned'
  objectsCovered: string[]
  connectorType?: ConnectorType
  connector?: Connector
  /** Reason the connector is `planned`; omitted for available/connected. */
  statusReason?: string
}

/**
 * Hook that provides integrations with live connection status.
 *
 * Two parallel views over the same catalog + live-connectors state:
 *   - `integrations` / `available` / `planned` — one entry per catalog
 *     connector TYPE. Stays in "available" even when one is connected so
 *     the user can always add another instance.
 *   - `connected` — one entry per LIVE (active) connector. Distinct `id`
 *     per instance (the connector UUID). Carries `connector.config.email`
 *     for disambiguating multiple Gmail instances in the UI.
 */
export function useIntegrations() {
  const {
    connectors: catalog,
    isLoading: catalogLoading,
    labelForCategory,
  } = useConnectorCatalog()
  const { data: liveConnectors = [], isPending: connectorsPending } = useConnectors()

  // Catalog-only: one entry per available connector TYPE. Drives the
  // "Available" section. Status stays at 'available' even when one
  // instance is connected — the user can connect another. Multi-instance
  // catalog entries (e.g. Custom MCP Server) stay persistent here too,
  // since users can always add another instance.
  const integrations: Integration[] = useMemo(
    () =>
      catalog.map((entry: ConnectorDef): Integration => ({
        id: entry.type,
        name: entry.displayName,
        type: labelForCategory(entry.category),
        icon: getIntegrationIcon(entry.type),
        status: entry.status === 'available' ? 'available' : 'planned',
        objectsCovered: entry.objectsCovered ?? [],
        connectorType: entry.type as ConnectorType,
        connector: undefined,
        statusReason: entry.status !== 'available' ? entry.statusReason : undefined,
      })),
    [catalog, labelForCategory],
  )

  // Per-instance: one entry per live connector. Used for the "Connected"
  // section. Each entry carries its underlying Connector row (with config.email
  // for Gmail disambiguation; for multi-instance types like custom_mcp_server,
  // the id is suffixed with the connector UUID so tiles render distinctly).
  //
  // `status === 'error'` connectors are surfaced as `needs_reconnect` so the
  // Connections page can render a "Reconnect" affordance. They are NOT filtered
  // out — that would silently hide a broken connector and leave the user with
  // no way to fix it. Successful OAuth reconnect flips the row back to
  // `active` (oauth/router.ts:688), so recovery is automatic.
  const connected: Integration[] = useMemo(() => {
    const byType = new Map(catalog.map((e) => [e.type, e]))
    return liveConnectors
      .filter((c) => c.status === 'active' || c.status === 'error')
      .map((c): Integration | null => {
        const entry = byType.get(c.type)
        if (!entry) return null
        return {
          id: entry.multiInstance ? `${entry.type}:${c.id}` : c.id,
          // Card title is always the catalog display name ("Workday", "Gmail"),
          // NOT the per-instance connector row name — multi-instance rows carry
          // an auto-generated unique suffix (e.g. "Workday (730793)") purely to
          // satisfy the UNIQUE(tenant_id, type, name) constraint, which must
          // never surface in the UI. Instances are disambiguated by the
          // subtitle (connectedAccountLabel), per the connector-card design.
          // The exceptions are custom_mcp_server and custom_api_connector,
          // whose row names ARE the identity: one the person typed, one the
          // provider the connection was described for. Both types are ONE
          // catalog card for every instance, so the catalog name is the same
          // string on every card and identifies nothing.
          name: entry.type === 'custom_mcp_server' || entry.type === 'custom_api_connector'
            ? (c.name ?? entry.displayName)
            : entry.displayName,
          type: labelForCategory(entry.category),
          icon: getIntegrationIcon(entry.type),
          status: c.status === 'error' ? 'needs_reconnect' : 'connected',
          objectsCovered: entry.objectsCovered ?? [],
          connectorType: entry.type as ConnectorType,
          connector: c,
        }
      })
      .filter((x): x is Integration => x !== null)
  }, [catalog, liveConnectors, labelForCategory])

  // Installs waiting on an organisation owner. A `pending` row is otherwise
  // dropped by the filter above, which would leave the user with NOTHING on
  // screen while GitHub holds an outstanding request against their org — the
  // tile sits in "Available" as though nothing had happened.
  //
  // Kept out of `connected` on purpose. Seven surfaces read that array to mean
  // "usable right now" (the team builder's requirement gate, the file-attach
  // picker, the switch wizard), and a requested install is not usable: no
  // installation exists until an owner approves. It renders on the Connections
  // page and nowhere else.
  const pendingApproval: Integration[] = useMemo(() => {
    const byType = new Map(catalog.map((e) => [e.type, e]))
    return liveConnectors
      .filter((c) => c.status === 'pending' && installState(c) === 'awaiting_org_approval')
      .map((c): Integration | null => {
        const entry = byType.get(c.type)
        if (!entry) return null
        return {
          id: `${entry.type}:pending:${c.id}`,
          name: entry.displayName,
          type: labelForCategory(entry.category),
          icon: getIntegrationIcon(entry.type),
          status: 'pending_org_approval',
          objectsCovered: entry.objectsCovered ?? [],
          connectorType: entry.type as ConnectorType,
          connector: c,
        }
      })
      .filter((x): x is Integration => x !== null)
  }, [catalog, liveConnectors, labelForCategory])

  const byName = (a: Integration, b: Integration) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  const connectedSorted = useMemo(() => [...connected].sort(byName), [connected])
  const available = integrations.filter((i) => i.status === 'available').sort(byName)
  const planned = integrations.filter((i) => i.status === 'planned').sort(byName)

  const pendingApprovalSorted = useMemo(
    () => [...pendingApproval].sort(byName),
    [pendingApproval],
  )

  return {
    integrations,
    connected: connectedSorted,
    pendingApproval: pendingApprovalSorted,
    available,
    planned,
    isPending: catalogLoading || connectorsPending,
  }
}
