import type { Integration } from '../hooks/useIntegrations'
import type { SelectedIntegration } from '../components/IntegrationsSelector'

interface PermissionInput {
  id: string
  /** Backend's pending-integration-service writes the canonical connector
   *  type into `type` (not `integrationId`) when auto-granting bindings
   *  after OAuth. Accepting both here lets the stale-id heal below find a
   *  canonical type regardless of which writer created the record. */
  type?: string
  integrationId?: string
  selectedObjects: string[]
  config?: Record<string, unknown>
}

/**
 * Convert the server-side IntegrationPermission[] (stored on
 * InternalAgent.integrations) into the SelectedIntegration[] shape the
 * IntegrationsSelector renders.
 *
 * Carries `config` through so per-binding options (Gmail gmailQuery /
 * sendAs) survive the edit round-trip. Looks up display name / category
 * label from the integration catalog by id, connector UUID, or
 * integrationId fallback. Normalises legacy records that stored a
 * composite "${type}:${connectorUuid}" or missing integrationId back to
 * the canonical catalog type.
 *
 * Also heals stale connector UUIDs: when a connector is reconnected,
 * connector-service soft-deletes the old row (status='disconnected',
 * filtered out of /api/connectors) and inserts a new row with a fresh
 * UUID. Any binding written before the reconnect points at the old UUID,
 * which no longer appears in useConnectors. The heal below resolves such
 * bindings to the current live connector by canonical type when
 * unambiguous (exactly one live connector of that type), so the chip
 * renders as bound and sorts to the top. The healed id is what gets
 * written back on the next save, self-healing the stored record.
 */
export function permissionsToSelected(
  permissions: PermissionInput[] | undefined | null,
  allIntegrations: Integration[],
): SelectedIntegration[] {
  if (!permissions || permissions.length === 0) return []
  return permissions
    .filter((p) => p?.id != null)
    .map((perm) => {
      // Fast path: stored id still matches a live connector or catalog entry.
      let integration = allIntegrations.find(
        (i) =>
          i.id === perm.id ||
          i.connector?.id === perm.id ||
          (perm.integrationId && i.id === perm.integrationId),
      )

      // Stale-id heal. Only triggers when the fast path didn't reach a live
      // connector. Single-instance types (Gmail, Slack, etc.) always have at
      // most one live instance per tenant so the lookup is unambiguous.
      // Multi-instance types only heal when the tenant has exactly one live
      // instance — beyond that we cannot safely pick without more metadata,
      // so the binding stays dangling rather than mis-bind to the wrong
      // instance.
      const canonicalType = perm.integrationId ?? perm.type
      if (!integration?.connector && canonicalType) {
        const liveOfType = allIntegrations.filter(
          (i) => i.connector && i.connectorType === canonicalType,
        )
        if (liveOfType.length === 1) {
          integration = liveOfType[0]
        }
      }

      // Prefer the live connector UUID when we matched (or healed) to a
      // live connector — this is what IntegrationsSelector's isSelected
      // compares against (`connector?.id || integration.id`). Falls back
      // to perm.id when no live match (binding to a fully-disconnected
      // app, or a multi-instance type with >1 live instance and a stale
      // UUID we can't disambiguate).
      const healedId = integration?.connector?.id ?? perm.id

      return {
        id: healedId,
        integrationId: integration?.connectorType ?? perm.integrationId ?? perm.type,
        name: integration?.name || perm.id,
        type: integration?.type || 'Unknown',
        selectedObjects: perm.selectedObjects,
        ...(perm.config ? { config: perm.config } : {}),
      }
    })
}
