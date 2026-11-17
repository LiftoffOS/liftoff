// Connector Manifest Repository
//
// Stores per-tenant metadata about which connectors a tenant has connected
// (alias, display name, enabled toggle). DOES NOT store the function/tool
// schemas — those live in the tool-schema cache seeded by the connector-service
// keyed by connectorType, and are loaded into the runtime image at process
// start. To get the function list for a manifest, the caller does:
//
//   const functions = getConnectorFunctions(manifest.connectorType);
//
// See ConnectorManifest in ./types.ts and the comment block on
// registry-validator.ts for the full rationale.

import { pool } from '../infrastructure/database';
import type {
  ConnectorManifest,
  ConnectorManifestCreate,
  ConnectorType,
} from '@liftoffos/connector-types';

export class ConnectorManifestRepository {
  /**
   * Get all connector manifests for an agent based on allowed connectors.
   * allowedConnectors may contain: connector UUIDs, connector types, or
   * aliases. Connector UUIDs are resolved to types via the connectors
   * table because the manifest id may differ from the current connector id
   * after reconnect.
   */
  async getManifestsForAgent(
    tenantId: string,
    allowedConnectors: string[]
  ): Promise<ConnectorManifest[]> {
    if (allowedConnectors.length === 0) {
      return [];
    }

    const result = await pool.query(
      `SELECT DISTINCT cm.id, cm.tenant_id, cm.connector_type, cm.alias,
              cm.display_name, cm.enabled, cm.external_account_id, cm.created_at, cm.updated_at
       FROM connector_manifests cm
       WHERE cm.tenant_id = $1
         AND cm.enabled = true
         -- A revoked credential withdraws the connector whatever the manifest
         -- says. cm.enabled is a MIRROR of connection state, written by the
         -- connect and disconnect handlers, and it has drifted in BOTH
         -- directions: a disconnect keyed on the wrong column left it true for
         -- three months, and a reconnect that did not restore connectors.status
         -- made a repair migration read seven LIVE connectors as dead. The
         -- credential is the one signal maintained in both directions, on the
         -- id that always matched, so it is what the catalog is judged on.
         --
         -- NOT EXISTS rather than a join on status = 'active': a manifest with
         -- no credential row at all keeps today's behaviour. Some predate the
         -- handler that writes one (see migration 251's backfill), and
         -- inventing a signal where there is none is the mistake that caused
         -- this. Only an EXPLICIT revocation withdraws.
         AND NOT EXISTS (
           SELECT 1 FROM connector_credentials cc
            WHERE cc.connector_id = cm.id
              AND cc.status <> 'active'
         )
         AND (
           cm.connector_type = ANY($2)
           OR cm.alias = ANY($2)
           OR cm.id::text = ANY($2)
           OR cm.connector_type IN (
             SELECT c.type FROM connectors c
             WHERE c.id::text = ANY($2) AND c.tenant_id = $1
           )
         )
       ORDER BY cm.alias`,
      [tenantId, allowedConnectors]
    );

    return result.rows.map(this.mapManifest);
  }

  /**
   * Get a specific connector manifest by alias
   */
  async getById(tenantId: string, manifestId: string): Promise<ConnectorManifest | null> {
    const result = await pool.query(
      `SELECT id, tenant_id, connector_type, alias, display_name, enabled,
              external_account_id, created_at, updated_at
       FROM connector_manifests
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, manifestId]
    );
    return result.rows[0] ? this.mapManifest(result.rows[0]) : null;
  }

  async getManifestByAlias(tenantId: string, alias: string): Promise<ConnectorManifest | null> {
    const result = await pool.query(
      `SELECT id, tenant_id, connector_type, alias, display_name, enabled,
              external_account_id, created_at, updated_at
       FROM connector_manifests
       WHERE tenant_id = $1 AND alias = $2`,
      [tenantId, alias]
    );

    return result.rows[0] ? this.mapManifest(result.rows[0]) : null;
  }

  /**
   * Get all connector manifests for a tenant
   */
  async listManifests(tenantId: string): Promise<ConnectorManifest[]> {
    const result = await pool.query(
      `SELECT id, tenant_id, connector_type, alias, display_name, enabled,
              external_account_id, created_at, updated_at
       FROM connector_manifests
       WHERE tenant_id = $1
       ORDER BY alias`,
      [tenantId]
    );

    return result.rows.map(this.mapManifest);
  }

  /**
   * Create a new connector manifest
   */
  async createManifest(data: ConnectorManifestCreate): Promise<ConnectorManifest> {
    const result = await pool.query(
      `INSERT INTO connector_manifests (
        tenant_id, connector_type, alias, display_name, enabled, external_account_id
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, tenant_id, connector_type, alias, display_name, enabled,
                external_account_id, created_at, updated_at`,
      [
        data.tenantId,
        data.connectorType,
        data.alias,
        data.displayName,
        data.enabled ?? true,
        data.externalAccountId ?? null,
      ]
    );

    return this.mapManifest(result.rows[0]);
  }

  /**
   * Update an existing connector manifest
   */
  async updateManifest(
    id: string,
    tenantId: string,
    updates: Partial<Pick<ConnectorManifestCreate, 'displayName' | 'enabled' | 'externalAccountId'>>
  ): Promise<ConnectorManifest | null> {
    const setClauses: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [id, tenantId];
    let paramIndex = 3;

    if (updates.displayName !== undefined) {
      setClauses.push(`display_name = $${paramIndex++}`);
      params.push(updates.displayName);
    }

    if (updates.enabled !== undefined) {
      setClauses.push(`enabled = $${paramIndex++}`);
      params.push(updates.enabled);
    }

    if (updates.externalAccountId !== undefined) {
      setClauses.push(`external_account_id = $${paramIndex++}`);
      params.push(updates.externalAccountId);
    }

    const result = await pool.query(
      `UPDATE connector_manifests
       SET ${setClauses.join(', ')}
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, tenant_id, connector_type, alias, display_name, enabled,
                 external_account_id, created_at, updated_at`,
      params
    );

    return result.rows[0] ? this.mapManifest(result.rows[0]) : null;
  }

  /**
   * Delete a connector manifest
   */
  async deleteManifest(id: string, tenantId: string): Promise<boolean> {
    const result = await pool.query(
      `DELETE FROM connector_manifests WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId]
    );

    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Upsert a connector manifest (create or update by alias)
   */
  async upsertManifest(data: ConnectorManifestCreate): Promise<ConnectorManifest> {
    const result = await pool.query(
      `INSERT INTO connector_manifests (
        tenant_id, connector_type, alias, display_name, enabled, external_account_id
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, alias)
      DO UPDATE SET
        connector_type = EXCLUDED.connector_type,
        display_name = EXCLUDED.display_name,
        enabled = EXCLUDED.enabled,
        -- COALESCE preserves an existing external_account_id when the
        -- upsert call doesn't carry one (e.g. a manifest re-sync from a
        -- path that doesn't know the composio identifier). Native
        -- connectors stay NULL; composio connectors keep the value set
        -- at first OAuth completion until the next composio re-OAuth
        -- explicitly overwrites it.
        external_account_id = COALESCE(EXCLUDED.external_account_id, connector_manifests.external_account_id),
        updated_at = NOW()
      RETURNING id, tenant_id, connector_type, alias, display_name, enabled,
                external_account_id, created_at, updated_at`,
      [
        data.tenantId,
        data.connectorType,
        data.alias,
        data.displayName,
        data.enabled ?? true,
        data.externalAccountId ?? null,
      ]
    );

    return this.mapManifest(result.rows[0]);
  }

  /**
   * Map database row to ConnectorManifest
   */
  private mapManifest(row: Record<string, unknown>): ConnectorManifest {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      connectorType: row.connector_type as ConnectorType,
      alias: row.alias as string,
      displayName: row.display_name as string,
      enabled: row.enabled as boolean,
      externalAccountId: (row.external_account_id as string | null) ?? undefined,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}

export const connectorManifestRepository = new ConnectorManifestRepository();
