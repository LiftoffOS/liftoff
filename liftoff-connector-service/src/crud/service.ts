// Connector CRUD Service.
//
// Ported from platform-backend/src/connectors/service.ts, adapted to the
// connector-service schema:
//   - RLS variable is `app.tenant_id` (migrations 001/002). All per-tenant
//     queries run through withTenantScope from db/pool.ts.
//   - connector_credentials rows use the new shape (flow_kind, secret_name,
//     scopes TEXT[], expires_at_epoch_sec, extra JSONB) defined in
//     migration 001 — NOT the legacy platform-backend shape.
//   - OAuth state + credential storage flows live in src/oauth/connector-ops.ts
//     and src/credentials/service.ts; this CRUD service only owns the
//     listing / dashboard / disconnect path (the slice the router calls).
//
// Consumed by src/crud/router.ts.

import { getPool, withTenantScope } from '../db/pool.js';
import { logger } from '../infra/logging.js';
import {
  CONNECTOR_DISPLAY_NAMES,
  type Connector,
  type ConnectorCredential,
  type ConnectorStatus,
  type ConnectorType,
  type ConnectorWithCredential,
  type CreateConnectorInput,
} from '../types.js';

function mapConnector(row: Record<string, unknown>): Connector {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    type: row.type as ConnectorType,
    name: row.name as string,
    status: row.status as ConnectorStatus,
    config: (row.config as Record<string, unknown>) ?? {},
    apiKeyHint: (row.api_key_hint as string | null) ?? null,
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function mapConnectorWithCredential(
  row: Record<string, unknown>,
): ConnectorWithCredential {
  const connector = mapConnector(row);
  if (!row.credential_id) return connector;

  const rawScopes = row.cred_scopes;
  const scopes = Array.isArray(rawScopes) ? (rawScopes as string[]) : null;
  const expiresEpoch = row.cred_expires_at_epoch_sec;
  const expiresAt =
    expiresEpoch == null
      ? null
      : new Date(
          (typeof expiresEpoch === 'string'
            ? parseInt(expiresEpoch, 10)
            : (expiresEpoch as number)) * 1000,
        );

  // New schema has no `status` column on connector_credentials — presence
  // of the row implies 'active'. We keep the field on the response for API
  // compatibility with platform-backend clients.
  const credential: ConnectorCredential = {
    id: row.credential_id as string,
    connectorId: connector.id,
    credentialType: mapFlowKindToCredentialType(row.cred_flow_kind as string),
    secretName: row.cred_secret_name as string,
    scopes,
    expiresAt,
    lastRefreshedAt: row.cred_updated_at
      ? new Date(row.cred_updated_at as string)
      : null,
    status: 'active',
    createdAt: row.cred_created_at
      ? new Date(row.cred_created_at as string)
      : new Date(row.created_at as string),
    updatedAt: row.cred_updated_at
      ? new Date(row.cred_updated_at as string)
      : new Date(row.updated_at as string),
  };
  return { ...connector, credential };
}

function mapFlowKindToCredentialType(
  flowKind: string,
): 'oauth2' | 'api_key' | 'service_account' {
  if (flowKind === 'api_key') return 'api_key';
  if (flowKind === 'keypair') return 'service_account';
  // static_oauth / dynamic_client_registration / unknown → oauth2
  return 'oauth2';
}

/**
 * Per-row shape returned by ConnectorCrudService.listTenantConnectors —
 * matches the proto-generated ConnectorSummary field list (epoch-seconds
 * timestamps, no sensitive data, joined display name).
 */
export interface ConnectorSummaryRow {
  id: string;
  connectorType: string;
  displayName: string;
  name: string;
  status: string;
  flowKind: string; // 'static_oauth' | 'dynamic_client_registration' | 'api_key' | 'keypair' | 'none'
  apiKeyHint: string;
  lastSyncAtEpochSec: number;
  createdAtEpochSec: number;
  updatedAtEpochSec: number;
}

function toEpochSec(value: unknown): number {
  if (value == null) return 0;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
  }
  if (typeof value === 'number') return Math.floor(value);
  return 0;
}

export class ConnectorCrudService {
  async listByTenant(tenantId: string): Promise<ConnectorWithCredential[]> {
    return withTenantScope(tenantId, async (client) => {
      const res = await client.query(
        `SELECT
           c.*,
           cc.connector_id AS credential_id,
           cc.flow_kind AS cred_flow_kind,
           cc.secret_name AS cred_secret_name,
           cc.scopes AS cred_scopes,
           cc.expires_at_epoch_sec AS cred_expires_at_epoch_sec,
           cc.created_at AS cred_created_at,
           cc.updated_at AS cred_updated_at
         FROM connectors c
         LEFT JOIN connector_credentials cc ON c.id = cc.connector_id
         WHERE c.tenant_id = $1 AND c.status != 'disconnected'
         ORDER BY c.created_at DESC`,
        [tenantId],
      );
      return res.rows.map((r) => mapConnectorWithCredential(r));
    });
  }

  /**
   * Resolve connector ids to their `type` for a tenant. Unlike `listByTenant`,
   * this includes disconnected (soft-deleted) rows — callers like
   * platform-backend's integration-enrichment resolver need to map even
   * stored historical ids back to a canonical type so the tenant runtime can
   * route to the CURRENT live connector of the same type after a reconnect.
   *
   * Returns rows in arbitrary order; missing ids are absent from the result
   * (callers detect orphans by diffing the returned ids against their input).
   */
  async resolveTypesByIds(
    tenantId: string,
    ids: string[],
  ): Promise<Array<{
    id: string;
    type: string;
    status: string;
    scopes: string[];
    botLogin: string | null;
    authorizedRepos: string[] | null;
  }>> {
    if (ids.length === 0) return [];
    return withTenantScope(tenantId, async (client) => {
      // Also returns the team-provisioning "binding contract" config — scopes (required-scope
      // validation), bot_login (self-event exclusion), authorized_repos (repoScope subset check).
      // All non-secret; the endpoint is service-to-service. Lets platform-backend resolve a bound
      // connector from the source of truth (this DB) instead of its own connectors table, which does
      // not hold OAuth connections.
      const res = await client.query<{
        id: string;
        type: string;
        status: string;
        scopes: unknown;
        bot_login: string | null;
        authorized_repos: unknown;
      }>(
        `SELECT id::text AS id, type, status,
                config->'scopes' AS scopes,
                config->>'bot_login' AS bot_login,
                config->'authorized_repos' AS authorized_repos
           FROM connectors
          WHERE tenant_id = $1 AND id::text = ANY($2)`,
        [tenantId, ids],
      );
      return res.rows.map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
        botLogin: r.bot_login ?? null,
        authorizedRepos: Array.isArray(r.authorized_repos) ? (r.authorized_repos as string[]) : null,
      }));
    });
  }

  /**
   * Proto-shaped tenant connector listing used by the ListTenantConnectors
   * RPC. Joins connector_credentials for flow_kind, applies optional type
   * and status filters, and returns a lean summary (no raw config, no
   * credential secret pointer). Display name is resolved from the in-
   * process CONNECTOR_DISPLAY_NAMES catalogue — falls back to the type
   * string when the connector type is unknown (future-proof).
   */
  async listTenantConnectors(
    tenantId: string,
    filter: { connectorTypes?: string[]; statuses?: string[] } = {},
  ): Promise<ConnectorSummaryRow[]> {
    return withTenantScope(tenantId, async (client) => {
      const params: unknown[] = [tenantId];
      const conditions: string[] = ['c.tenant_id = $1'];
      const types = filter.connectorTypes?.filter((t) => t.length > 0) ?? [];
      if (types.length > 0) {
        params.push(types);
        conditions.push(`c.type = ANY($${params.length}::text[])`);
      }
      const statuses = filter.statuses?.filter((s) => s.length > 0) ?? [];
      if (statuses.length > 0) {
        params.push(statuses);
        conditions.push(`c.status = ANY($${params.length}::text[])`);
      }
      const res = await client.query(
        `SELECT
           c.id,
           c.type,
           c.name,
           c.status,
           c.api_key_hint,
           c.last_sync_at,
           c.created_at,
           c.updated_at,
           cc.flow_kind AS flow_kind
         FROM connectors c
         LEFT JOIN connector_credentials cc ON c.id = cc.connector_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY c.created_at DESC`,
        params,
      );
      return res.rows.map((row: Record<string, unknown>) => {
        const type = row.type as string;
        return {
          id: row.id as string,
          connectorType: type,
          displayName:
            (CONNECTOR_DISPLAY_NAMES as Record<string, string>)[type] ?? type,
          name: (row.name as string) ?? '',
          status: (row.status as string) ?? '',
          flowKind: (row.flow_kind as string) ?? 'none',
          apiKeyHint: (row.api_key_hint as string | null) ?? '',
          lastSyncAtEpochSec: toEpochSec(row.last_sync_at),
          createdAtEpochSec: toEpochSec(row.created_at),
          updatedAtEpochSec: toEpochSec(row.updated_at),
        };
      });
    });
  }

  async getById(
    connectorId: string,
    tenantId: string,
  ): Promise<ConnectorWithCredential | null> {
    return withTenantScope(tenantId, async (client) => {
      const res = await client.query(
        `SELECT
           c.*,
           cc.connector_id AS credential_id,
           cc.flow_kind AS cred_flow_kind,
           cc.secret_name AS cred_secret_name,
           cc.scopes AS cred_scopes,
           cc.expires_at_epoch_sec AS cred_expires_at_epoch_sec,
           cc.created_at AS cred_created_at,
           cc.updated_at AS cred_updated_at
         FROM connectors c
         LEFT JOIN connector_credentials cc ON c.id = cc.connector_id
         WHERE c.id = $1 AND c.tenant_id = $2`,
        [connectorId, tenantId],
      );
      if (res.rows.length === 0) return null;
      return mapConnectorWithCredential(res.rows[0]);
    });
  }

  async findByTenantAndType(
    tenantId: string,
    type: string,
  ): Promise<Connector | null> {
    return withTenantScope(tenantId, async (client) => {
      const res = await client.query(
        `SELECT * FROM connectors
         WHERE tenant_id = $1 AND type = $2
         ORDER BY created_at DESC LIMIT 1`,
        [tenantId, type],
      );
      if (res.rows.length === 0) return null;
      return mapConnector(res.rows[0]);
    });
  }

  async create(input: CreateConnectorInput): Promise<Connector> {
    // Default to 'pending' for OAuth connectors — status flips to 'active'
    // after the OAuth callback completes. Non-OAuth callers (e.g.
    // custom_mcp_server) must pass status: 'active' explicitly, or the row
    // is hidden from the Connections UI which only surfaces 'active' | 'error'.
    const status = input.status ?? 'pending';
    return withTenantScope(input.tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO connectors (tenant_id, type, name, status, config)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          input.tenantId,
          input.type,
          input.name,
          status,
          JSON.stringify(input.config ?? {}),
        ],
      );
      logger.info(
        { connectorId: res.rows[0].id, type: input.type, status },
        'connector created',
      );
      return mapConnector(res.rows[0]);
    });
  }

  async updateStatus(
    connectorId: string,
    tenantId: string,
    status: ConnectorStatus,
  ): Promise<Connector> {
    return withTenantScope(tenantId, async (client) => {
      const res = await client.query(
        `UPDATE connectors
         SET status = $3, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [connectorId, tenantId, status],
      );
      if (res.rows.length === 0) throw new Error('connector not found');
      return mapConnector(res.rows[0]);
    });
  }

  /**
   * Fetch a connector by ID without RLS tenant scoping.
   * Used only from service-internal routes where verifyServiceAuth has
   * already validated the caller (e.g. POST /:connectorId/sync/force).
   */
  async getByIdInternal(connectorId: string): Promise<Connector | null> {
    const pool = await getPool();
    const res = await pool.query(
      `SELECT * FROM connectors WHERE id = $1`,
      [connectorId],
    );
    if (res.rows.length === 0) return null;
    return mapConnector(res.rows[0]);
  }

  async disconnect(connectorId: string, tenantId: string): Promise<boolean> {
    return withTenantScope(tenantId, async (client) => {
      const res = await client.query(
        `UPDATE connectors
         SET status = 'disconnected', updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2`,
        [connectorId, tenantId],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  getDisplayName(type: ConnectorType): string {
    return CONNECTOR_DISPLAY_NAMES[type] ?? type;
  }
}

export const connectorCrudService = new ConnectorCrudService();
