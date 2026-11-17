// Action Allowlists Service
//
// Per-tenant declarative rules that short-circuit HITL approval when a
// tool call's (connector, entity_type, action_type) tuple matches an
// allowlist row. Read by:
//   - Preflight: returned to the caller so tenant-runtime's local
//     short-circuit path can skip the Authorize RPC entirely for obvious
//     matches.
//   - Authorize: consulted as a fast-path that bypasses HITL even for
//     level-1/2/3 tenants.
//
// Schema (migration 001): action_allowlists (id, tenant_id, connector_type,
// entity_type, action_type, pattern JSONB, created_at). `pattern` is
// reserved for future scope-narrowing (e.g. channel regex, repo prefix) —
// matching today is a strict tuple match. Values of `*` in any column
// match any input for that column so tenants can express connector-wide
// or action-type-wide whitelisting.

import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

export interface ActionAllowlist {
  id: string;
  tenantId: string;
  connectorType: string;
  entityType: string;
  actionType: string;
  pattern: Record<string, unknown>;
  createdAt: Date;
}

export class AllowlistsService {
  // Returns every allowlist row for the tenant. Used by Preflight so
  // the caller can cache the whole set for its 30s preflight window.
  async getAllowlists(tenantId: string): Promise<ActionAllowlist[]> {
    return withTenantScope(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, tenant_id, connector_type, entity_type, action_type,
                pattern, created_at
           FROM action_allowlists
          WHERE tenant_id = $1
          ORDER BY created_at ASC`,
        [tenantId],
      );
      return result.rows.map(this.mapRow);
    });
  }

  // True iff the (connector, entity_type, action_type) tuple matches at
  // least one allowlist row for the tenant. `*` wildcards match anything.
  async matches(
    tenantId: string,
    connector: string,
    entityType: string,
    actionType: string,
  ): Promise<boolean> {
    try {
      const rows = await this.getAllowlists(tenantId);
      return rows.some(
        (r) =>
          (r.connectorType === connector || r.connectorType === '*') &&
          (r.entityType === entityType || r.entityType === '*') &&
          (r.actionType === actionType || r.actionType === '*'),
      );
    } catch (err) {
      logger.warn(
        {
          err: (err as Error).message,
          tenant_id: tenantId,
          connector,
          entity_type: entityType,
          action_type: actionType,
        },
        'allowlists lookup failed — treating as no match',
      );
      return false;
    }
  }

  private mapRow(row: Record<string, unknown>): ActionAllowlist {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      connectorType: row.connector_type as string,
      entityType: row.entity_type as string,
      actionType: row.action_type as string,
      pattern:
        (row.pattern as Record<string, unknown> | null) ?? {},
      createdAt: row.created_at as Date,
    };
  }
}

export const allowlistsService = new AllowlistsService();
