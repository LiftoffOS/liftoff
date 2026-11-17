// Enrich integration records with `type` from connector-service / external_agents / internal_agents.
//
// Why this exists: integration records on internal_agents store only the connector_id
// (or external_agent_id / internal_agent_id) UUID. After a connector is reconnected, that UUID
// changes — the old row is soft-deleted (status='disconnected') and a new row is inserted with
// a new UUID. The tenant runtime's permission validator and tool gateway need to resolve the
// integration to the CURRENT connector. Resolving by UUID alone is fragile because the stored
// UUID becomes stale on reconnect.
//
// Solution: at event-publish time, enrich each integration with its `type`
// (connector_type, e.g. 'google_sheets', or the literals 'external_agent' / 'internal_agent').
// The tenant runtime then resolves the integration by type, which never changes for the lifetime
// of an integration. UUID resolution remains as a defense-in-depth fallback.
//
// Data sources:
//   - connectors        OWNED by connector-service. Resolved via the
//                       `POST /api/connectors/_resolve` bulk endpoint, which
//                       includes disconnected rows so historical ids still
//                       map. platform-backend's local `connectors` table is a
//                       dead mirror — only custom-MCP rows are written there
//                       — so it is no longer consulted here.
//   - external_agents   OWNED by platform-backend. Local table read.
//   - internal_agents   OWNED by platform-backend. Local table read.

import { withTenantScope } from '../infrastructure/database';
import { resolveConnectorTypes } from '../connectors/connector-service-client';
import type { IntegrationPermission } from './types';

export async function enrichIntegrationsWithType(
  tenantId: string,
  integrations: IntegrationPermission[] | undefined | null
): Promise<IntegrationPermission[]> {
  if (!integrations || integrations.length === 0) return [];

  // Short-circuit: if all entries already have a type, skip lookups entirely.
  // internal_agent entries still need a collaborationMode default applied even when pre-typed,
  // but no lookup is needed for any entry that already carries a type.
  const unenrichedIds = integrations.filter(i => !i.type).map(i => i.id).filter(Boolean);
  if (unenrichedIds.length === 0) {
    return integrations.map(integration => {
      if (integration.type === 'internal_agent') {
        return { ...integration, collaborationMode: integration.collaborationMode ?? 'two_way' };
      }
      return integration;
    });
  }

  // Resolve all three sources in parallel. Connectors call out to connector-
  // service (the authoritative store); the local mirror is intentionally not
  // queried. external_agents and internal_agents are read locally because
  // those tables ARE owned by platform-backend.
  //
  // internal_agents is filtered to live only (`deleted_at IS NULL`): soft-
  // deleted peers should not receive events. Connectors and external_agents
  // include soft-deleted rows because the tenant runtime can re-resolve the
  // type to a CURRENT live row after a reconnect.
  const [connectorRows, externalAgentRows, internalAgentRows] = await Promise.all([
    resolveConnectorTypes(tenantId, unenrichedIds),
    withTenantScope(tenantId, (client) => client.query<{ id: string }>(
      `SELECT id::text AS id FROM external_agents WHERE tenant_id = $1 AND id::text = ANY($2)`,
      [tenantId, unenrichedIds]
    )),
    withTenantScope(tenantId, (client) => client.query<{ id: string }>(
      `SELECT id::text AS id FROM internal_agents WHERE tenant_id = $1 AND id::text = ANY($2) AND deleted_at IS NULL`,
      [tenantId, unenrichedIds]
    )),
  ]);

  const connectorTypeById = new Map<string, string>();
  for (const row of connectorRows) connectorTypeById.set(row.id, row.type);

  const externalAgentIds = new Set<string>();
  for (const row of externalAgentRows.rows) externalAgentIds.add(row.id);

  const internalAgentIds = new Set<string>();
  for (const row of internalAgentRows.rows) internalAgentIds.add(row.id);

  return integrations.map(integration => {
    // Already-typed internal_agent: apply collaborationMode default without re-querying DB.
    if (integration.type === 'internal_agent') {
      return { ...integration, collaborationMode: integration.collaborationMode ?? 'two_way' };
    }
    // Other already-typed entries (connector, external_agent): return as-is.
    if (integration.type) return integration;

    // Unenriched entries: resolve from DB lookup results.
    const connectorType = connectorTypeById.get(integration.id);
    if (connectorType) return { ...integration, type: connectorType };
    if (externalAgentIds.has(integration.id)) return { ...integration, type: 'external_agent' };
    if (internalAgentIds.has(integration.id)) {
      return {
        ...integration,
        type: 'internal_agent',
        collaborationMode: integration.collaborationMode ?? 'two_way',
      };
    }
    // Post-migration: every permission must resolve to a type. An id that
    // matches nothing in connectors / external_agents / internal_agents is
    // data corruption (orphaned binding). The backfill migration drops such
    // rows into migration_orphans; anything reaching this branch at runtime
    // indicates a bug.
    throw new Error(
      `Integration permission has no resolvable type: id=${integration.id} (tenant=${tenantId}). ` +
      `Either the row is orphaned (connector/external_agent/internal_agent missing) or the ` +
      `writer omitted \`type\` and the id does not match any current row.`
    );
  });
}
