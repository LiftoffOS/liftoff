// Minimal connector-table operations needed by the OAuth / API-key /
// keypair routers. Mirrors the subset of platform-backend's
// ConnectorService that the routers call (findByTenantAndType, create,
// updateStatus, updateApiKeyHint, createOAuthState, verifyOAuthState,
// getById).
//
// All queries go through withTenantScope so RLS (app.tenant_id) enforces
// isolation. The full-surface ConnectorService in platform-backend owns
// listing, disconnect, dashboard aggregates etc. — those are NOT needed
// by the OAuth web flow and stay in platform-backend until Fix 6.

import crypto from 'node:crypto';
import { withTenantScope } from '../db/pool.js';
import { logger } from '../infra/logging.js';
import { getConnectorScopes, type ConnectorType } from '../types.js';

export type ConnectorStatus = 'pending' | 'active' | 'error' | 'disabled' | 'disconnected';

export interface ConnectorRow {
  id: string;
  tenantId: string;
  type: string;
  name: string;
  status: ConnectorStatus;
  config: Record<string, unknown>;
  apiKeyHint: string | null;
}

export interface CreateConnectorInput {
  tenantId: string;
  type: ConnectorType;
  name: string;
  config?: Record<string, unknown>;
}

export interface OAuthStateRow {
  id: string;
  state: string;
  tenantId: string;
  accountId: string;
  connectorType: ConnectorType;
  scopes: string[] | null;
  redirectUri: string | null;
  codeVerifier: string | null;
  expiresAt: Date;
  createdAt: Date;
  /**
   * Branch-specific payload. Composio path persists
   * `{ composioConnectedAccountId, composioAuthConfigId }`; static-oauth /
   * dcr paths leave this null. Optional so existing test fixtures and
   * pre-extra-column rows continue to satisfy the type.
   */
  extra?: Record<string, unknown> | null;
}

function mapConnector(row: Record<string, unknown>): ConnectorRow {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    type: row.type as string,
    name: row.name as string,
    status: row.status as ConnectorStatus,
    config: (row.config as Record<string, unknown>) ?? {},
    apiKeyHint: (row.api_key_hint as string | null) ?? null,
  };
}

function mapOAuthState(row: Record<string, unknown>): OAuthStateRow {
  const rawScopes = row.scopes;
  let scopes: string[] | null = null;
  if (Array.isArray(rawScopes)) {
    scopes = rawScopes as string[];
  } else if (typeof rawScopes === 'string') {
    try {
      const parsed = JSON.parse(rawScopes);
      scopes = Array.isArray(parsed) ? (parsed as string[]) : null;
    } catch {
      scopes = null;
    }
  }
  const rawExtra = row.extra;
  let extra: Record<string, unknown> | null = null;
  if (rawExtra && typeof rawExtra === 'object') {
    extra = rawExtra as Record<string, unknown>;
  } else if (typeof rawExtra === 'string') {
    try {
      const parsed = JSON.parse(rawExtra);
      extra = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      extra = null;
    }
  }
  return {
    id: row.id as string,
    state: row.state as string,
    tenantId: row.tenant_id as string,
    accountId: row.account_id as string,
    connectorType: row.connector_type as ConnectorType,
    scopes,
    redirectUri: (row.redirect_uri as string | null) ?? null,
    codeVerifier: (row.code_verifier as string | null) ?? null,
    expiresAt: new Date(row.expires_at as string),
    createdAt: new Date(row.created_at as string),
    extra,
  };
}

/**
 * The connector of this type a tenant can actually USE right now.
 *
 * `findConnectorByTenantAndType` below answers a different question — "is there
 * a row of this type at all" — and answers it with `ORDER BY created_at DESC`
 * and no status filter. That is right for the OAuth reconnect path, which wants
 * to find a dead row precisely so it can reuse it. It is wrong for anything that
 * intends to make a call with the credential.
 *
 * For example, an import placeholder with no credential, created after the
 * tenant's real GitHub connector, shadows it because it is newer. The
 * authorize leg writes a token to the live row and `/install-targets` reads
 * the placeholder moments later, so the org picker fails with "No credentials
 * found" and re-connecting can never fix it — the write and the read are
 * aimed at different rows.
 *
 * `disconnected` is excluded outright, and an `active` row wins over any other
 * surviving status regardless of age.
 */
export async function findUsableConnectorByTenantAndType(
  tenantId: string,
  type: string,
): Promise<ConnectorRow | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT id, tenant_id, type, name, status, config, api_key_hint
         FROM connectors
         WHERE tenant_id = $1 AND type = $2 AND status <> 'disconnected'
         ORDER BY (status = 'active') DESC, created_at DESC
         LIMIT 1`,
      [tenantId, type],
    );
    return res.rows[0] ? mapConnector(res.rows[0]) : null;
  });
}

export async function findConnectorByTenantAndType(
  tenantId: string,
  type: string,
): Promise<ConnectorRow | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT id, tenant_id, type, name, status, config, api_key_hint
         FROM connectors
         WHERE tenant_id = $1 AND type = $2
         ORDER BY created_at DESC
         LIMIT 1`,
      [tenantId, type],
    );
    if (res.rows.length === 0) return null;
    return mapConnector(res.rows[0]);
  });
}

/**
 * Find a connector by (tenantId, type, config.externalAccountId).
 *
 * After OAuth completes, the callback calls a per-provider identity fetcher
 * (see identity-fetchers.ts) to obtain a stable per-account id. That id is
 * the disambiguator for multi-instance connectors — connecting a DIFFERENT
 * account on the same type returns null (so the caller creates a new row),
 * while reconnecting the SAME account returns the existing row (so the
 * caller resurrects it instead of creating duplicates).
 *
 * Returns the most-recently-created match. config.externalAccountId is
 * written by createConnector / mergeConnectorConfig as part of the same
 * callback transaction.
 */
export async function findConnectorByTenantTypeAndExternalAccountId(
  tenantId: string,
  type: string,
  externalAccountId: string,
): Promise<ConnectorRow | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT id, tenant_id, type, name, status, config, api_key_hint
         FROM connectors
         WHERE tenant_id = $1 AND type = $2
           AND config->>'externalAccountId' = $3
         ORDER BY created_at DESC
         LIMIT 1`,
      [tenantId, type, externalAccountId],
    );
    if (res.rows.length === 0) return null;
    return mapConnector(res.rows[0]);
  });
}

/**
 * Find the (single) connector row an operator marked for forced reconnect —
 * status 'error' OR 'disconnected', with a non-null config.disconnect_reason
 * stamp ('disconnected' included so a user-initiated disconnect on a marked
 * row is still adoptable). Used by /callback (both the Composio branch and the
 * native identity branch) to UPDATE the marked row in place instead of
 * creating a new row — which preserves the connector id, so tenant-runtime
 * manifests and agent tool-name aliases (`<type>-<id-prefix>__<fn>`) survive
 * the reconnect.
 *
 * Originally written for the Composio migration script (reason
 * 'composio_migration'); generalized for source flips in EITHER
 * direction (the slack composio→native revert marks rows with its own
 * reason). The reason string is informational — any marked row is adoptable.
 *
 * Returns null if no such row exists (fresh-connect path).
 */
export async function findMigrationMarkedConnector(
  tenantId: string,
  type: string,
): Promise<ConnectorRow | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT id, tenant_id, type, name, status, config, api_key_hint
         FROM connectors
         WHERE tenant_id = $1
           AND type = $2
           AND status IN ('error', 'disconnected')
           AND config->>'disconnect_reason' IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT 1`,
      [tenantId, type],
    );
    if (res.rows.length === 0) return null;
    return mapConnector(res.rows[0]);
  });
}

export async function getConnectorById(
  tenantId: string,
  connectorId: string,
): Promise<ConnectorRow | null> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `SELECT id, tenant_id, type, name, status, config, api_key_hint
         FROM connectors
         WHERE id = $1 AND tenant_id = $2`,
      [connectorId, tenantId],
    );
    if (res.rows.length === 0) return null;
    return mapConnector(res.rows[0]);
  });
}

export async function createConnector(input: CreateConnectorInput): Promise<ConnectorRow> {
  return withTenantScope(input.tenantId, async (client) => {
    const res = await client.query(
      `INSERT INTO connectors (tenant_id, type, name, status, config)
         VALUES ($1, $2, $3, 'pending', $4)
         RETURNING id, tenant_id, type, name, status, config, api_key_hint`,
      [input.tenantId, input.type, input.name, JSON.stringify(input.config ?? {})],
    );
    logger.info({ connectorId: res.rows[0].id, type: input.type }, 'connector created');
    return mapConnector(res.rows[0]);
  });
}

/**
 * Create a connector, but if the (tenant, type, externalAccountId) unique index
 * rejects it (23505 — a concurrent connect / heal already created the account
 * row), re-find and reuse that row instead. Idempotent under races.
 */
export async function createConnectorReusingOnAccountConflict(
  input: CreateConnectorInput,
  externalAccountId: string,
): Promise<ConnectorRow> {
  try {
    return await createConnector(input);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      const existing = await findConnectorByTenantTypeAndExternalAccountId(
        input.tenantId,
        input.type,
        externalAccountId,
      );
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Hard-delete a connector row — removes a redundant just-created row when the same company already has a connector.
 */
export async function deleteConnector(tenantId: string, connectorId: string): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(`DELETE FROM connectors WHERE id = $1 AND tenant_id = $2`, [
      connectorId,
      tenantId,
    ]);
  });
}

export async function updateConnectorStatus(
  tenantId: string,
  connectorId: string,
  status: ConnectorStatus,
): Promise<ConnectorRow> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `UPDATE connectors
         SET status = $3, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2
         RETURNING id, tenant_id, type, name, status, config, api_key_hint`,
      [connectorId, tenantId, status],
    );
    if (res.rows.length === 0) throw new Error('connector not found');
    return mapConnector(res.rows[0]);
  });
}

/**
 * Best-effort: flip a connector to `error` status when a runtime call surfaces
 * an OAuthRefreshError (token revoked, insufficient_scope, no_refresh_token,
 * etc). The React Connections page surfaces `error` connectors as
 * "Needs Reconnect" cards with a Reconnect button. A successful OAuth callback
 * flips status back to `active` (oauth/router.ts:688), so recovery is automatic.
 *
 * Failures here are swallowed (best-effort) — we never want a status-write
 * failure to mask the original OAuthRefreshError that the caller is rethrowing.
 */
export async function markConnectorReconnectRequired(
  tenantId: string,
  connectorId: string,
  vendor?: string,
): Promise<void> {
  try {
    await updateConnectorStatus(tenantId, connectorId, 'error');
    logger.info(
      { tenantId, connectorId, vendor },
      'connector marked error: reconnect required',
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId, connectorId },
      'failed to flip connector status to error after OAuthRefreshError',
    );
  }
}

export async function updateApiKeyHint(
  tenantId: string,
  connectorId: string,
  hint: string,
): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `UPDATE connectors SET api_key_hint = $3, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2`,
      [connectorId, tenantId, hint],
    );
  });
}

export async function createOAuthState(
  tenantId: string,
  accountId: string,
  connectorType: ConnectorType,
  redirectUri: string,
  codeVerifier?: string,
  reconnectConnectorId?: string,
  subdomain?: string,
): Promise<OAuthStateRow> {
  const state = crypto.randomBytes(32).toString('hex');
  const scopes = getConnectorScopes(connectorType);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  // The `extra` JSONB column carries branch-specific callback metadata:
  //   • reconnectConnectorId — the frontend "Reconnect" target row id, so the
  //     /callback find-or-create can reuse that exact row (see the Precedence block).
  //   • subdomain — for per-company-subdomain OAuth (zendesk, bamboohr), so the
  //     /callback can substitute the SUBDOMAIN placeholder in the token URL and
  //     derive the connection's instanceUrl.
  const extraObj: Record<string, unknown> = {};
  if (reconnectConnectorId) extraObj.reconnectConnectorId = reconnectConnectorId;
  if (subdomain) extraObj.subdomain = subdomain;
  const extra = Object.keys(extraObj).length ? JSON.stringify(extraObj) : null;

  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `INSERT INTO connector_oauth_states
         (state, tenant_id, account_id, connector_type, scopes, redirect_uri, code_verifier, expires_at, extra)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
      [
        state,
        tenantId,
        accountId,
        connectorType,
        JSON.stringify(scopes),
        redirectUri,
        codeVerifier ?? null,
        expiresAt,
        extra,
      ],
    );
    return mapOAuthState(res.rows[0]);
  });
}

/**
 * Create an oauth_state row for the Composio-managed branch. The caller
 * supplies a random `cmp_<hex>` state value (NOT derived from the Composio
 * connected-account id — the state has to be picked up-front so it can be
 * encoded in the Composio callbackUrl, while the connected-account id is
 * only known after `link()` returns). The /callback handler branches on the
 * `cmp_` prefix and looks up `extra.composioConnectedAccountId` to poll
 * Composio for the final account status.
 */
export async function createComposioOAuthState(args: {
  state: string;
  tenantId: string;
  accountId: string;
  connectorType: ConnectorType;
  redirectUri: string;
  extra: {
    composioConnectedAccountId: string;
    composioAuthConfigId: string;
    reconnectConnectorId?: string;
  };
}): Promise<OAuthStateRow> {
  const scopes = getConnectorScopes(args.connectorType);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  return withTenantScope(args.tenantId, async (client) => {
    const res = await client.query(
      `INSERT INTO connector_oauth_states
         (state, tenant_id, account_id, connector_type, scopes, redirect_uri, code_verifier, expires_at, extra)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8)
         RETURNING *`,
      [
        args.state,
        args.tenantId,
        args.accountId,
        args.connectorType,
        JSON.stringify(scopes),
        args.redirectUri,
        expiresAt,
        JSON.stringify(args.extra),
      ],
    );
    return mapOAuthState(res.rows[0]);
  });
}

/**
 * Verify + consume an OAuth state. We cannot scope to a tenantId here
 * because the inbound /callback request carries only the state string
 * (the tenant is what we are about to look up). The route is therefore
 * served from an admin-scoped pool and scrubbed on success.
 */
export async function verifyOAuthState(
  state: string,
): Promise<OAuthStateRow | null> {
  const { withAdminScope } = await import('../db/pool.js');
  return withAdminScope(
    { caller: 'oauth/router.verifyOAuthState', reason: 'OAuth callback state lookup' },
    async (client) => {
      const res = await client.query(
        `DELETE FROM connector_oauth_states
           WHERE state = $1 AND expires_at > NOW()
           RETURNING *`,
        [state],
      );
      if (res.rows.length === 0) return null;
      return mapOAuthState(res.rows[0]);
    },
  );
}

/**
 * Look up an OAuth state row WITHOUT consuming it. Used by the Composio
 * branch of /callback so that a polling timeout doesn't burn the state row
 * — the user can refresh the browser and /callback re-fires, polling
 * again against the (still-INITIATED) Composio account. Without this,
 * every timed-out poll leaves an orphan ACTIVE row in Composio that
 * Liftoff has no record of and no way to associate on retry.
 *
 * The row is deleted via `deleteOAuthState` only after a TERMINAL Composio
 * status (ACTIVE — connector created and committed; or FAILED/EXPIRED/
 * REVOKED — already non-recoverable).
 */
export async function peekOAuthState(
  state: string,
): Promise<OAuthStateRow | null> {
  const { withAdminScope } = await import('../db/pool.js');
  return withAdminScope(
    { caller: 'oauth/router.peekOAuthState', reason: 'OAuth callback state lookup (non-consuming)' },
    async (client) => {
      const res = await client.query(
        `SELECT * FROM connector_oauth_states
           WHERE state = $1 AND expires_at > NOW()`,
        [state],
      );
      if (res.rows.length === 0) return null;
      return mapOAuthState(res.rows[0]);
    },
  );
}

/**
 * Every Composio connect that was started and never completed.
 *
 * Deliberately IGNORES `expires_at`. The 10-minute TTL exists to stop a stale
 * `state` being replayed through /callback; it says nothing about whether the
 * underlying Composio connection is real. Nothing sweeps this table, so an
 * expired `cmp_` row is a durable record that we told Composio to create a
 * connection and never found out how it went — exactly what the reconciler
 * needs to recover connections stranded by a failed browser redirect.
 *
 * `olderThanSeconds` keeps the reconciler off connects a user is still
 * walking through in their browser; /callback should win those races.
 */
export async function listPendingComposioOAuthStates(
  olderThanSeconds: number,
  limit = 100,
): Promise<OAuthStateRow[]> {
  const { withAdminScope } = await import('../db/pool.js');
  return withAdminScope(
    {
      caller: 'oauth/composio-reconciler.listPending',
      reason: 'Recover Composio connects stranded by a failed browser redirect',
    },
    async (client) => {
      const res = await client.query(
        `SELECT * FROM connector_oauth_states
           WHERE state LIKE 'cmp\\_%'
             AND created_at < NOW() - ($1 || ' seconds')::interval
           ORDER BY created_at ASC
           LIMIT $2`,
        [String(olderThanSeconds), limit],
      );
      return res.rows.map(mapOAuthState);
    },
  );
}

/**
 * Explicit delete companion to peekOAuthState. Idempotent — returns false
 * if the row was already gone (treat as a successful no-op since the
 * caller's intent is "make sure this state can't be reused").
 */
export async function deleteOAuthState(state: string): Promise<boolean> {
  const { withAdminScope } = await import('../db/pool.js');
  return withAdminScope(
    { caller: 'oauth/router.deleteOAuthState', reason: 'Consume OAuth state after terminal status' },
    async (client) => {
      const res = await client.query(
        `DELETE FROM connector_oauth_states WHERE state = $1`,
        [state],
      );
      return (res.rowCount ?? 0) > 0;
    },
  );
}

export async function setMetaUserId(
  tenantId: string,
  connectorId: string,
  metaUserId: string,
): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      'UPDATE connector_credentials SET meta_user_id = $1 WHERE connector_id = $2',
      [metaUserId, connectorId],
    );
  });
}

/**
 * Merge fields into the connectors.config JSONB for one connector row.
 * Used by OAuth callbacks to record connection metadata (e.g. Gmail's
 * connected email address) so the frontend can disambiguate multiple
 * instances of the same connector type.
 */
export async function mergeConnectorConfig(
  tenantId: string,
  connectorId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `UPDATE connectors
         SET config = COALESCE(config, '{}'::jsonb) || $3::jsonb,
             updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2`,
      [connectorId, tenantId, JSON.stringify(patch)],
    );
  });
}

/**
 * Convert a Composio-migration-marked row (status='error', api_key auth
 * legacy config) into a freshly-bound Composio row. REPLACES `config`
 * entirely (not merge) — the migrated row carries `disconnect_reason`,
 * legacy `api_key_hint`, etc. that must not bleed into the new state.
 * Used by /callback's Composio branch on the reconnect-from-migration
 * code path; preserves the original connector_id so any integration
 * bindings referencing this connector stay valid.
 */
export async function adoptMigrationMarkedConnector(
  tenantId: string,
  connectorId: string,
  config: Record<string, unknown>,
): Promise<ConnectorRow> {
  return withTenantScope(tenantId, async (client) => {
    const res = await client.query(
      `UPDATE connectors
         SET status = 'active',
             config = $3::jsonb,
             api_key_hint = NULL,
             updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2
         RETURNING id, tenant_id, type, name, status, config, api_key_hint`,
      [connectorId, tenantId, JSON.stringify(config)],
    );
    if (res.rows.length === 0) {
      throw new Error(`adoptMigrationMarkedConnector: connector ${connectorId} not found`);
    }
    return mapConnector(res.rows[0]);
  });
}
