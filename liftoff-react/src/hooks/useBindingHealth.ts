// Binding health for an agent's connector integrations.
//
// An agent stores its bindings as connector UUIDs on `integrations`. Those
// UUIDs go stale, and the platform is built to tolerate that: platform-backend
// stamps each binding with its connector `type` precisely because "the stored
// UUID becomes stale on reconnect" (internal-agents/integration-enrichment.ts),
// and the tenant runtime resolves a manifest by id OR by being the sole
// manifest of that type when the team holds a sole integration of that type
// (agent-execution/service.ts).
//
// So a plain "does this UUID still exist" check is wrong in BOTH directions:
// it reports a team as broken after a healthy reconnect handed the connector a
// new id, and it reports a team as healthy when the connector it points at is
// sitting in `error`. This hook mirrors the runtime's resolution instead, then
// reads the resolved connector's status.
//
// Two classes are deliberately NOT detectable here, because nothing writes a
// status for them: composio-managed connectors that carry no poll spec (their
// tool calls dispatch in-process in the runtime and never reach
// connector-service), and customer-hosted MCP servers (the daily binding probe
// skips them by design). They surface only once their connector row is gone.

import { useCallback } from 'react'
import { useConnectors } from './useConnectors'
import { useConnectorCatalog } from './useConnectorCatalog'
import type { Connector } from '../services/connections'
import type { IntegrationPermission } from '../services/internalAgents'

/** Why the binding cannot be used right now. */
export type BindingBreakReason =
  /** The connector row is `error` — a credential died and the user must restore it. */
  | 'needs_reconnect'
  /** Nothing resolves: the row was disconnected, deleted, or disabled. */
  | 'gone'

/** What the user has to DO, derived from the catalog's `auth.kind`. The four
 *  auth classes recover by genuinely different verbs, so one "reconnect"
 *  message would be wrong for three of them. */
export type BindingRecovery =
  /** static_oauth / dcr_oauth — run the OAuth flow again. */
  | 'reconnect'
  /** api_key / keypair — supply a new secret. */
  | 'credentials'
  /** iam_grant (BigQuery) — re-grant access out of band, then Verify. */
  | 'verify'
  /** custom_mcp — the server is the customer's; we have no repair control. */
  | 'byoc'

export interface BrokenBinding {
  /** The stored connector UUID, kept for logging and deep links. */
  connectorId: string
  /** Canonical connector type, e.g. `google_mail`. */
  connectorType: string
  /** What the user calls it, e.g. "Gmail". */
  displayName: string
  reason: BindingBreakReason
  recovery: BindingRecovery
}

export interface BindingHealth {
  isBroken: boolean
  broken: BrokenBinding[]
  /** Tooltip copy. Empty when nothing is broken. */
  message: string
}

const HEALTHY: BindingHealth = { isBroken: false, broken: [], message: '' }

function recoveryForAuthKind(authKind: string | undefined): BindingRecovery {
  switch (authKind) {
    case 'api_key':
    case 'keypair':
      return 'credentials'
    case 'iam_grant':
      return 'verify'
    case 'custom_mcp':
      return 'byoc'
    default:
      // static_oauth, dcr_oauth and anything the catalog adds
      // later all recover by running the connect flow again.
      return 'reconnect'
  }
}

/** "Gmail", "Gmail and Slack", "Gmail, Slack, and Notion" — matches the
 *  phrasing the personnel list already uses on this page. */
function listNames(names: string[]): string {
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

function buildMessage(broken: BrokenBinding[]): string {
  if (broken.length === 0) return ''
  if (broken.length > 1) {
    return `${broken.length} connections need attention: ${listNames(broken.map(b => b.displayName))}.`
  }

  const [only] = broken
  const name = only.displayName

  if (only.reason === 'gone') {
    return only.recovery === 'byoc'
      ? `${name} was removed. Add the MCP server again to restore this agent.`
      : `${name} is no longer connected. Connect it again to restore this agent.`
  }

  switch (only.recovery) {
    case 'credentials':
      return `${name} needs new credentials. Until then this agent cannot use it.`
    case 'verify':
      return `${name} access could not be verified. Re-grant access and verify it to restore this agent.`
    default:
      return `${name} needs to be reconnected. Until then this agent cannot use it.`
  }
}

/**
 * Returns a function that reports whether an agent's bindings are usable.
 *
 * While the connector list or the catalog is still loading everything reports
 * healthy: an in-flight query is not evidence that a connection is broken, and
 * flashing an error badge on every page load would be worse than the silence
 * this replaces.
 */
export function useBindingHealth(): (integrations: IntegrationPermission[] | undefined | null) => BindingHealth {
  const { data: connectors = [], isPending: connectorsPending } = useConnectors()
  const { byType, isLoading: catalogLoading } = useConnectorCatalog()

  return useCallback(
    (integrations: IntegrationPermission[] | undefined | null): BindingHealth => {
      if (connectorsPending || catalogLoading) return HEALTHY
      if (!integrations || integrations.length === 0) return HEALTHY

      const connectorById = new Map<string, Connector>()
      const connectorsByType = new Map<string, Connector[]>()
      for (const connector of connectors) {
        connectorById.set(connector.id, connector)
        const bucket = connectorsByType.get(connector.type)
        if (bucket) bucket.push(connector)
        else connectorsByType.set(connector.type, [connector])
      }

      // Only permissions that name a catalog connector type are judged. That
      // deliberately skips peer-agent bindings (their `integrationId` is absent
      // or names an agent, never a catalog type) and legacy rows that stored a
      // bare UUID: for those we cannot tell a dead connector apart from a peer
      // reference, and a false error badge is worse than a missed one.
      const connectorPerms = (integrations ?? []).filter(
        (perm): perm is IntegrationPermission & { integrationId: string } =>
          !!perm?.id && !!perm.integrationId && byType.has(perm.integrationId),
      )
      if (connectorPerms.length === 0) return HEALTHY

      // The runtime's sole-integration-of-this-type condition is evaluated
      // against the team's OWN bindings, so count them here.
      const permCountByType = new Map<string, number>()
      for (const perm of connectorPerms) {
        permCountByType.set(perm.integrationId, (permCountByType.get(perm.integrationId) ?? 0) + 1)
      }

      const broken: BrokenBinding[] = []
      for (const perm of connectorPerms) {
        const def = byType.get(perm.integrationId)
        const recovery = recoveryForAuthKind(def?.auth?.kind)

        // Resolve exactly the way the runtime does: the stored id first, then
        // the sole-live-connector-of-this-type fallback that lets a reconnect
        // under a new UUID keep working.
        let resolved = connectorById.get(perm.id)
        if (!resolved) {
          const sameType = connectorsByType.get(perm.integrationId) ?? []
          if (sameType.length === 1 && permCountByType.get(perm.integrationId) === 1) {
            resolved = sameType[0]
          }
        }

        // `pending` is a connect still in flight, not a fault.
        if (resolved && (resolved.status === 'active' || resolved.status === 'pending')) continue

        const displayName =
          perm.integrationId === 'custom_mcp_server' && resolved?.name
            ? resolved.name
            : def?.displayName ?? perm.integrationId

        broken.push({
          connectorId: perm.id,
          connectorType: perm.integrationId,
          displayName,
          reason: resolved?.status === 'error' ? 'needs_reconnect' : 'gone',
          recovery,
        })
      }

      if (broken.length === 0) return HEALTHY
      return { isBroken: true, broken, message: buildMessage(broken) }
    },
    [connectors, connectorsPending, byType, catalogLoading],
  )
}
