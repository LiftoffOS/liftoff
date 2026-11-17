// Pending Integration Service
//
// Auto-grant logic for the HRBP Agent flow. When a workforce plan is
// provisioned and one of its agents needs a connector that isn't connected
// yet, the HRBP Agent creates the agent anyway with the connector type
// stashed in `pending_integrations` (migration 087). The user can then
// connect the app whenever they're ready on /Connections. This service
// handles that moment: on a successful OAuth callback for connector type
// X, it finds every internal agent in the tenant whose pending_integrations
// array contains X, grants full access (`selectedObjects: []`, matching
// the teambuilder default), removes X from pending, and bumps the version.
//
// Called from src/connectors/oauth-router.ts after the credential store
// succeeds but before returning to the user.

import { withTenantScope } from '../infrastructure/database';
import { log, logAudit } from '../infrastructure/logging';
import { publishEvent } from '../events/publisher';
import { maybeProposeForNewIntegration } from '../agent-chat/suggestion-triggers';
import type { IntegrationPermission } from './types';

export interface ResolvePendingResult {
  agentsUpdated: number;
  agentIds: string[];
}

/**
 * Find every non-deleted internal agent in the given tenant whose
 * `pending_integrations` array contains `connectorType`. Moves the entry
 * into the agent's `integrations` column (full access) and strips it from
 * `pending_integrations`.
 *
 * The scan is a JSONB containment query on the GIN index introduced in
 * migration 087, so it stays cheap even with many agents. Each match is
 * updated in its own transaction so a failure on one agent doesn't block
 * the rest.
 *
 * Fails soft: if the database query throws, the error is logged and the
 * function returns `{ agentsUpdated: 0, agentIds: [] }` so the OAuth
 * callback doesn't fail the user's flow just because auto-grant hiccuped.
 */
export async function resolvePendingIntegrationsForConnector(
  tenantId: string,
  connectorId: string,
  connectorType: string,
): Promise<ResolvePendingResult> {
  try {
    // Normalise incoming type to snake_case (the canonical shape returned
    // by connector-service and used throughout @liftoffos/connector-types)
    // so spec strings like "google-calendar" or "hubspot" both match rows
    // written in either form. Match strings are stored as-is in
    // pending_integrations so we check against both the normalised and the
    // kebab-case variant.
    const normalised = connectorType.replace(/-/g, '_');
    const kebab = connectorType.replace(/_/g, '-');

    // Query uses the @> containment operator twice so either form matches.
    // GIN index idx_internal_agents_pending_integrations supports this.
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT id, integrations, pending_integrations
       FROM internal_agents
       WHERE tenant_id = $1
         AND deleted_at IS NULL
         AND (
           pending_integrations @> to_jsonb($2::text)
           OR pending_integrations @> to_jsonb($3::text)
         )`,
      [tenantId, normalised, kebab],
    ));

    if (result.rows.length === 0) {
      return { agentsUpdated: 0, agentIds: [] };
    }

    const agentIds: string[] = [];
    for (const row of result.rows) {
      const currentIntegrations = (row.integrations as IntegrationPermission[]) ?? [];
      const currentPending = (row.pending_integrations as string[]) ?? [];

      // Skip if the connector is already in the integrations list (defense
      // against race conditions where two concurrent OAuth callbacks fire).
      if (currentIntegrations.some(i => i.id === connectorId)) {
        // Still strip the type from pending so the agent doesn't look like
        // it's still waiting.
        const pendingAfter = currentPending.filter(
          p => p !== normalised && p !== kebab,
        );
        await withTenantScope(tenantId, (client) => client.query(
          `UPDATE internal_agents
             SET pending_integrations = $2::jsonb,
                 updated_at = NOW()
           WHERE id = $1`,
          [row.id, JSON.stringify(pendingAfter)],
        ));
        continue;
      }

      const pendingAfter = currentPending.filter(
        p => p !== normalised && p !== kebab,
      );

      const integrationsAfter: IntegrationPermission[] = [
        ...currentIntegrations,
        {
          id: connectorId,
          type: normalised,
          selectedObjects: [],
        },
      ];

      await withTenantScope(tenantId, (client) => client.query(
        `UPDATE internal_agents
           SET integrations = $2::jsonb,
               pending_integrations = $3::jsonb,
               updated_at = NOW()
         WHERE id = $1`,
        [row.id, JSON.stringify(integrationsAfter), JSON.stringify(pendingAfter)],
      ));

      agentIds.push(row.id as string);

      logAudit(
        'internal_agents.auto_grant',
        { tenantId },
        {
          internalAgentId: row.id,
          connectorId,
          connectorType: normalised,
        },
      );

      // Fire the integrations_updated event so the tenant runtime (and any
      // future subscribers) can hot-reload the agent's integration list
      // without waiting for a background sync. Errors are logged by
      // publishEvent but we swallow them here so one broken event doesn't
      // derail the rest of the auto-grant loop.
      // P1.3: the team member can now see something new. Offer to watch it on
      // a schedule, once, in its own chat. Best-effort and detached — a
      // proposal must never affect the auto-grant it rode in on.
      void maybeProposeForNewIntegration({
        tenantId,
        agentId: row.id as string,
        connectorType: normalised,
      });

      void publishEvent({
        entityType: 'internal_agent',
        entityId: row.id as string,
        eventType: 'internal_agent.integrations_updated',
        // Agent row doesn't carry a monotonic version on disk; use 0 as a
        // placeholder (consumers only care about eventType on this event).
        entityVersion: 0,
        eventVersion: 1,
        tenantId,
        payload: {
          connectorId,
          connectorType: normalised,
          source: 'auto_grant',
        },
      }).catch(err => {
        log.warn(
          {
            tenantId,
            internalAgentId: row.id,
            error: (err as Error).message,
          },
          'Auto-grant integrations_updated event publish failed',
        );
      });
    }

    log.info(
      {
        tenantId,
        connectorId,
        connectorType: normalised,
        agentsUpdated: agentIds.length,
      },
      'Resolved pending integrations for newly-connected connector',
    );

    return { agentsUpdated: agentIds.length, agentIds };
  } catch (err) {
    log.error(
      {
        tenantId,
        connectorId,
        connectorType,
        error: (err as Error).message,
      },
      'Failed to resolve pending integrations - continuing OAuth flow',
    );
    return { agentsUpdated: 0, agentIds: [] };
  }
}
