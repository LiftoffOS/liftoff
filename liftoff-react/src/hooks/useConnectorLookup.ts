import { useMemo } from 'react'
import { useConnectors } from './useConnectors'
import { useConnectorCatalog } from './useConnectorCatalog'

interface ResolvedConnector {
  integrationId: string
  name: string
}

/**
 * Provides a lookup function that resolves either:
 *   - a live connector UUID (from /api/connectors), or
 *   - a canonical connector type id (from /api/connectors/catalog)
 * to `{ integrationId, name }` used by icon + display callsites.
 *
 * Phase 4 cutover: both sides of the lookup now come from the backend —
 * no more src/data/integrations.json / INTEGRATION_TO_CONNECTOR_TYPE /
 * CONNECTOR_TYPE_TO_INTEGRATION static tables.
 */
export function useConnectorLookup() {
  const { data: connectors = [] } = useConnectors()
  const { byType } = useConnectorCatalog()

  return useMemo(() => {
    const byUuid = new Map<string, ResolvedConnector>()
    for (const connector of connectors) {
      const def = byType.get(connector.type)
      if (def) {
        byUuid.set(connector.id, {
          integrationId: def.type,
          name: def.displayName ?? connector.name,
        })
      }
    }
    return (uuid: string): ResolvedConnector | undefined => {
      const fromConnector = byUuid.get(uuid)
      if (fromConnector) return fromConnector
      // Accept a catalog type directly (useful when callsites store a
      // type alongside the UUID).
      const catalogEntry = byType.get(uuid)
      if (catalogEntry) {
        return { integrationId: catalogEntry.type, name: catalogEntry.displayName }
      }
      return undefined
    }
  }, [connectors, byType])
}
