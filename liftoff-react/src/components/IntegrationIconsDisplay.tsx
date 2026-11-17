import { getIntegrationIcon } from './icons/integrationIconRegistry'
import PlugIcon from '../assets/icons/plug.svg?react'
import Tooltip from './Tooltip'
import { useConnectorLookup } from '../hooks/useConnectorLookup'
import type { IntegrationPermission } from '../services/internalAgents'

interface IntegrationIconsDisplayProps {
  /** Integration permissions (with optional integrationId for stable icon resolution) */
  appIntegrations: IntegrationPermission[]
  /** Number of external agents */
  externalAgentCount: number
  /** Total slots available (default 8 = 2 rows of 4) */
  maxSlots?: number
  /** CSS class prefix for styling (e.g., 'agent-card' or 'completion-step') */
  classPrefix: string
}

/**
 * Displays integration icons with consistent formatting.
 * Uses integrationId (canonical) when available for stable icon resolution,
 * falling back to connector UUID lookup via live connector data.
 */
export default function IntegrationIconsDisplay({
  appIntegrations,
  externalAgentCount,
  maxSlots = 8,
  classPrefix,
}: IntegrationIconsDisplayProps) {
  const resolveConnector = useConnectorLookup()

  // Resolve each permission to an icon-ready entry.
  // Uses integrationId when stored (stable across connector lifecycle),
  // falls back to connector UUID lookup for legacy data.
  const resolvedIntegrations = appIntegrations.reduce<{ integrationId: string; name: string }[]>(
    (acc, perm) => {
      let integrationId: string | undefined
      let name: string | undefined

      if (perm.integrationId) {
        // Stable path: integrationId was persisted alongside the connector UUID
        integrationId = perm.integrationId
        const resolved = resolveConnector(perm.integrationId)
        name = resolved?.name || perm.integrationId
      } else {
        // Legacy path: try resolving the connector UUID via live connectors
        const resolved = resolveConnector(perm.id)
        if (resolved) {
          integrationId = resolved.integrationId
          name = resolved.name
        }
      }

      if (!integrationId) return acc
      if (acc.some(r => r.integrationId === integrationId)) return acc
      acc.push({ integrationId, name: name! })
      return acc
    },
    []
  )

  // Calculate how many slots external agents need
  const externalSlots = externalAgentCount > 1 ? 2 : (externalAgentCount > 0 ? 1 : 0)
  const availableForApp = maxSlots - externalSlots
  const needsOverflow = resolvedIntegrations.length > availableForApp
  const appIconsToShow = needsOverflow ? availableForApp - 1 : resolvedIntegrations.length
  const overflowCount = resolvedIntegrations.length - appIconsToShow

  return (
    <>
      {/* App integrations */}
      {resolvedIntegrations.slice(0, appIconsToShow).map((resolved) => (
        <Tooltip key={resolved.integrationId} text={resolved.name} position="top">
          <span className={`${classPrefix}__integration`}>
            {getIntegrationIcon(resolved.integrationId)}
          </span>
        </Tooltip>
      ))}
      {/* External agents - single icon with count (shown before overflow) */}
      {externalAgentCount > 0 && (
        <>
          <Tooltip text="External Agents" position="top">
            <span className={`${classPrefix}__integration ${classPrefix}__integration--external`}>
              <PlugIcon />
            </span>
          </Tooltip>
          {externalAgentCount > 1 && (
            <span className={`${classPrefix}__integration-count`}>
              ×{externalAgentCount}
            </span>
          )}
        </>
      )}
      {/* Overflow indicator (always last) */}
      {needsOverflow && (
        <span className={`${classPrefix}__integration-more`}>
          +{overflowCount}
        </span>
      )}
    </>
  )
}
