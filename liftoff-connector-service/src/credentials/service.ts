// Connector credential service.
//
// Ported from tenant-runtime/src/connectors/credential-service.ts, adapted
// to this service's DB + Secret Manager shims. The provider-specific OAuth
// refresh dispatch from the source file (~1200 LoC covering 15+ providers'
// token endpoints) is NOT yet ported; this module exposes a pluggable
// `OAuthRefreshHandler` that callers register per-provider. Until a handler
// is registered, refresh calls throw `OAuthRefreshError('reconnect_required')`
// with a clear message, which the RPC handlers surface as a 409 to callers.
//
// Phase 1c scope: credential lookup, secret fetch, flow-kind detection,
// in-memory warm cache. Full OAuth refresh dispatch is a follow-up Phase.

import { CONNECTORS } from '../catalog/connectors.js';
import { withTenantScope } from '../db/pool.js';
import { resolveGithubInstallationId } from '../oauth/github-installation-lookup.js';
import { makeConnectorTransport, type ConnectorTransport } from '../clients/connector-transport.js';
import { logger } from '../infra/logging.js';
import {
  ComposioAccountNotActiveError,
  assertComposioAccountActive,
  deleteComposioConnectedAccount,
} from '../oauth/composio-client.js';
import {
  getConnectorCredential,
  storeConnectorCredential,
  type ConnectorSecretData,
} from '../secrets/client.js';

export type OAuthRefreshFailureReason =
  | 'reconnect_required'
  | 'vendor_unavailable'
  | 'writeback_failed'
  | 'no_refresh_token'
  | 'unknown';

export class OAuthRefreshError extends Error {
  public readonly reason: OAuthRefreshFailureReason;
  public readonly connectorId: string;
  public readonly tenantId: string;
  public readonly vendor: string | undefined;

  constructor(
    reason: OAuthRefreshFailureReason,
    message: string,
    ctx: { connectorId: string; tenantId: string; vendor?: string },
  ) {
    super(message);
    this.name = 'OAuthRefreshError';
    this.reason = reason;
    this.connectorId = ctx.connectorId;
    this.tenantId = ctx.tenantId;
    this.vendor = ctx.vendor;
  }
}

const RECONNECT_REQUIRED_OAUTH_ERRORS = new Set([
  'invalid_grant',
  'invalid_token',
  'unauthorized_client',
  'access_denied',
  'token_revoked',
]);

export function isReconnectRequiredOAuthError(err: unknown): boolean {
  if (err instanceof OAuthRefreshError) {
    return err.reason === 'reconnect_required' || err.reason === 'no_refresh_token';
  }
  return false;
}

export function isReconnectOAuthErrorCode(code: string): boolean {
  return RECONNECT_REQUIRED_OAUTH_ERRORS.has(code);
}

export type FlowKind =
  | 'static_oauth'
  | 'dynamic_client_registration'
  | 'api_key'
  | 'keypair'
  | 'composio_managed'
  | 'none';

export interface ConnectorCredentials {
  flowKind: FlowKind;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  privateKey?: string;
  instanceUrl?: string;
  expiresAt?: Date;
  scopes?: string[];
  connectorConfig?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface ConnectorCredentialRecord {
  connectorId: string;
  tenantId: string;
  flowKind: FlowKind;
  secretName: string;
  scopes: string[];
  expiresAtEpochSec: number | null;
  updatedAtEpochSec: number | null;
  extra: Record<string, unknown>;
}

export interface OAuthRefreshHandlerArgs {
  connectorId: string;
  tenantId: string;
  connectorType: string;
  refreshToken: string;
  scopes: string[];
}

export type OAuthRefreshHandler = (
  args: OAuthRefreshHandlerArgs,
) => Promise<ConnectorSecretData>;

const oauthRefreshHandlers = new Map<string, OAuthRefreshHandler>();

export function registerOAuthRefreshHandler(
  connectorType: string,
  handler: OAuthRefreshHandler,
): void {
  oauthRefreshHandlers.set(connectorType, handler);
}

export function unregisterAllOAuthRefreshHandlers(): void {
  oauthRefreshHandlers.clear();
}

export interface OAuthRevocationHandlerArgs {
  connectorId: string;
  tenantId: string;
  connectorType: string;
  accessToken: string;
}

export type OAuthRevocationHandler = (args: OAuthRevocationHandlerArgs) => Promise<void>;

const oauthRevocationHandlers = new Map<string, OAuthRevocationHandler>();

export function registerOAuthRevocationHandler(
  connectorType: string,
  handler: OAuthRevocationHandler,
): void {
  oauthRevocationHandlers.set(connectorType, handler);
}

export function unregisterAllOAuthRevocationHandlers(): void {
  oauthRevocationHandlers.clear();
}

export class ConnectorCredentialService {
  async getCredentialRecord(
    tenantId: string,
    connectorId: string,
  ): Promise<ConnectorCredentialRecord | null> {
    return withTenantScope(tenantId, async (client) => {
      const res = await client.query(
        `SELECT connector_id, tenant_id, flow_kind, secret_name, scopes,
                expires_at_epoch_sec, extra,
                EXTRACT(EPOCH FROM updated_at)::BIGINT AS updated_at_epoch_sec
         FROM connector_credentials
         WHERE connector_id = $1`,
        [connectorId],
      );
      if (res.rows.length === 0) return null;
      const row = res.rows[0] as {
        connector_id: string;
        tenant_id: string;
        flow_kind: FlowKind;
        secret_name: string;
        scopes: string[] | null;
        expires_at_epoch_sec: string | number | null;
        updated_at_epoch_sec: string | number | null;
        extra: Record<string, unknown> | null;
      };
      const toEpochSec = (v: string | number | null): number | null => {
        if (v == null) return null;
        return typeof v === 'string' ? parseInt(v, 10) : v;
      };
      return {
        connectorId: row.connector_id,
        tenantId: row.tenant_id,
        flowKind: row.flow_kind,
        secretName: row.secret_name,
        scopes: row.scopes ?? [],
        expiresAtEpochSec: toEpochSec(row.expires_at_epoch_sec),
        updatedAtEpochSec: toEpochSec(row.updated_at_epoch_sec),
        extra: row.extra ?? {},
      };
    });
  }

  async getConnectorConfig(
    tenantId: string,
    connectorId: string,
  ): Promise<{ connectorType: string; config: Record<string, unknown> } | null> {
    return withTenantScope(tenantId, async (client) => {
      const res = await client.query(
        `SELECT type, config FROM connectors WHERE id = $1`,
        [connectorId],
      );
      if (res.rows.length === 0) return null;
      return {
        connectorType: res.rows[0].type as string,
        config: (res.rows[0].config as Record<string, unknown>) ?? {},
      };
    });
  }

  /**
   * An authorized way to call this connector's vendor — the transport, not the
   * secrets.
   *
   * This is what a connector client should be given. Handing a client
   * `accessToken` makes it responsible for a decision it has no business
   * making: composio_managed connectors have no usable bearer (Composio holds
   * the grant and `getComposioCredentials` returns `accessToken: ''`), so a
   * client that interpolates it sends `Authorization: Bearer ` and the vendor
   * answers 401 — a code defect wearing a credential error's clothes. Gmail's
   * poller did that for over an hour while its account was healthy.
   *
   * Deciding here, once per connector, is what makes that unrepresentable: a
   * client with no token cannot send an empty one. See
   * clients/connector-transport.ts for the migration state — clients are being
   * moved onto this incrementally and the remaining direct-`fetch` ones are
   * frozen by a ratchet.
   *
   * Credentials are resolved through the same `getCredentials` path as before,
   * so refresh, keyless connectors and the composio active-account assertion
   * all behave identically.
   */
  async getTransport(
    tenantId: string,
    connectorId: string,
    options?: { forceRefresh?: boolean; connectorType?: string },
  ): Promise<ConnectorTransport> {
    const credentials = await this.getCredentials(tenantId, connectorId, options);
    // The type is used only to label errors, and `getCredentials` has already
    // read the connectors row to resolve the credential. A caller that knows
    // the type passes it rather than paying for a second read of the same row
    // on every vendor call — this sits in the hot path for polling, execute and
    // warm alike.
    const connectorType = options?.connectorType
      ?? (await this.getConnectorConfig(tenantId, connectorId))?.connectorType
      ?? 'unknown';
    return makeConnectorTransport(credentials, connectorType);
  }

  /**
   * Fetch current credential data for a connector, refreshing OAuth tokens
   * if they are expired or near expiry.
   *
   * For `composio_managed` connectors (Gmail, Drive, Calendar, etc.),
   * tokens live at Composio rather than
   * in our local `connector_credentials` + Secret Manager. The composio
   * branch here is the ONE point in the credential service that knows about
   * Composio — callers see a single `getCredentials(tenantId, connectorId)`
   * surface that returns the same `ConnectorCredentials` shape regardless
   * of which backend stores the underlying token.
   */
  async getCredentials(
    tenantId: string,
    connectorId: string,
    options?: { forceRefresh?: boolean },
  ): Promise<ConnectorCredentials> {
    const connectorInfo = await this.getConnectorConfig(tenantId, connectorId);
    const connectorConfig = connectorInfo?.config ?? {};
    const connectorType = connectorInfo?.connectorType ?? 'unknown';

    if (isComposioManagedConnectorType(connectorType)) {
      return this.getComposioCredentials(
        tenantId,
        connectorId,
        connectorType,
        connectorConfig,
        options,
      );
    }

    // ── GitHub App identity ──────────────────────────────────────────────
    // When the connector carries an installation, the platform acts as
    // `Liftoff[bot]` rather than as the person who clicked connect. This is the
    // whole point of the App: an agent that selects "the oldest PR carrying no
    // review FROM THIS AGENT" cannot answer that while its own reviews are
    // authored by a human account.
    //
    // FALLING THROUGH IS A FEATURE. No installation id means the row is a
    // pre-App OAuth connector, and execution continues to the stored user token
    // below exactly as it did before. That is what lets the App ship without a
    // flag and without a cutover — every existing GitHub connector keeps
    // working untouched, and gains the bot identity the moment someone installs.
    if (connectorType === 'github') {
      // THE ROW ASKED FOR IS NOT NECESSARILY THE ROW THAT HOLDS THE INSTALLATION.
      //
      // `internal_agents.integrations` pins an agent to the OAuth row it was
      // bound to, while the installation lives on a separate per-account row. So
      // GetCredentials can be asked for the row without an installation and
      // faithfully return the user token — a review posted as the person rather
      // than the bot, after a healthy install with installation tokens being
      // minted correctly: the exact defect the App exists to fix.
      //
      // The binding cannot be the place this is corrected: every agent bound
      // before the App would need re-pointing, and any future binding to an
      // OAuth row would regress it silently. So the installation is resolved
      // per TENANT here, which fixes every caller at once.
      const installationId = await resolveGithubInstallationId(
        tenantId,
        connectorConfig as Record<string, unknown>,
      );
      if (Number.isInteger(installationId) && installationId > 0) {
        const { getInstallationToken } = await import('../oauth/github-app.js');
        const token = await getInstallationToken(installationId);
        if (token) {
          return this.buildCredentials(
            'static_oauth',
            { accessToken: token, tokenType: 'Bearer' },
            connectorConfig,
            undefined,
          );
        }
        // A configured installation whose token could not be minted falls
        // through rather than failing: the user token, if present, still works
        // and a degraded identity beats a dead connector.
        logger.warn(
          { tenantId, connectorId, installationId },
          'github_app_token_unavailable_falling_back_to_user_token',
        );
      }
    }

    const record = await this.getCredentialRecord(tenantId, connectorId);
    if (!record) {
      // Keyless connectors (catalog auth.kind 'none' / 'iam_grant', e.g.
      // BigQuery per-tenant SA impersonation) legitimately store NO credential
      // record — the client authenticates from connectorConfig, not a vaulted
      // secret. Return an empty credential set instead of throwing so execute /
      // reachability-probe / connect-verify can reach the executor (plan §3C/§5).
      const authKind = (CONNECTORS[connectorType]?.auth as { kind?: string } | undefined)?.kind;
      if (authKind === 'none' || authKind === 'iam_grant') {
        return this.buildCredentials('none', {} as ConnectorSecretData, connectorConfig, undefined);
      }
      throw new Error(
        `No credentials found for connector ${connectorId} (tenant ${tenantId})`,
      );
    }

    const secretData = await getConnectorCredential(tenantId, connectorId);

    // For OAuth flows, refresh if expiring within 5 minutes.
    if (
      record.flowKind === 'static_oauth' ||
      record.flowKind === 'dynamic_client_registration'
    ) {
      const needsRefresh = options?.forceRefresh === true || this.needsRefresh(record, connectorType);
      if (needsRefresh) {
        const refreshed = await this.refreshOAuth(
          tenantId,
          connectorId,
          connectorType,
          record,
          secretData,
        );
        return this.buildCredentials(record.flowKind, refreshed, connectorConfig, record.extra);
      }
      return this.buildCredentials(record.flowKind, secretData, connectorConfig, record.extra);
    }

    return this.buildCredentials(record.flowKind, secretData, connectorConfig, record.extra);
  }

  async storeCredentials(
    tenantId: string,
    connectorId: string,
    flowKind: FlowKind,
    credential: ConnectorSecretData,
    scopes: string[] = [],
  ): Promise<void> {
    // Safety rail: composio_managed connectors never write a local row —
    // Composio is the source of truth and writing here would create a
    // shadow credential that drifts over time. Today no caller invokes
    // this for composio_managed (the OAuth callback's composio branch
    // skips storeCredentials by design), but keep the short-circuit so
    // future regressions don't silently desync the two stores.
    if (flowKind === 'composio_managed') {
      logger.info(
        { tenantId, connectorId },
        'storeCredentials: skipped — composio_managed credentials live at Composio, not locally',
      );
      return;
    }
    const secretName = `connector-${tenantId}-${connectorId}`;
    await storeConnectorCredential(tenantId, connectorId, credential);
    const expiresAtEpochSec = credential.expiresAt
      ? Math.floor(new Date(credential.expiresAt).getTime() / 1000)
      : null;

    await withTenantScope(tenantId, async (client) => {
      await client.query(
        `INSERT INTO connector_credentials (
           connector_id, tenant_id, flow_kind, secret_name, scopes,
           expires_at_epoch_sec, extra
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (connector_id) DO UPDATE SET
           flow_kind = EXCLUDED.flow_kind,
           secret_name = EXCLUDED.secret_name,
           scopes = EXCLUDED.scopes,
           expires_at_epoch_sec = EXCLUDED.expires_at_epoch_sec,
           extra = EXCLUDED.extra,
           updated_at = NOW()`,
        [
          connectorId,
          tenantId,
          flowKind,
          secretName,
          scopes,
          expiresAtEpochSec,
          credential.metadata ?? {},
        ],
      );
    });

    logger.info({ tenantId, connectorId, flowKind }, 'credential stored');
  }

  async revokeCredentials(tenantId: string, connectorId: string): Promise<void> {
    const connectorInfo = await this.getConnectorConfig(tenantId, connectorId);
    const connectorType = connectorInfo?.connectorType;

    if (connectorType && isComposioManagedConnectorType(connectorType)) {
      // composio_managed: delete at Composio so the upstream OAuth grant
      // is released. Failure is non-fatal — we still proceed with the
      // local-row delete below (which is a no-op for composio_managed
      // since no row exists) so the disconnect operation is at least
      // idempotent from the caller's perspective.
      const composioConnectedAccountId = connectorInfo?.config?.composioConnectedAccountId;
      if (typeof composioConnectedAccountId === 'string' && composioConnectedAccountId) {
        try {
          await deleteComposioConnectedAccount(composioConnectedAccountId);
          logger.info(
            { tenantId, connectorId, composioConnectedAccountId },
            'composio connected account deleted on revoke',
          );
        } catch (err) {
          logger.warn(
            { tenantId, connectorId, composioConnectedAccountId, error: (err as Error).message },
            'composio connected account delete failed (non-fatal — local revoke still proceeds)',
          );
        }
      }
    } else if (oauthRevocationHandlers.size > 0) {
      // Dispatch revocation handler BEFORE deleting DB row (token still in SM at this point).
      try {
        if (connectorInfo) {
          const handler = oauthRevocationHandlers.get(connectorInfo.connectorType);
          if (handler) {
            const secretData = await getConnectorCredential(tenantId, connectorId);
            if (secretData?.accessToken) {
              await handler({
                connectorId,
                tenantId,
                connectorType: connectorInfo.connectorType,
                accessToken: secretData.accessToken,
              });
            }
          }
        }
      } catch (err) {
        logger.warn(
          { tenantId, connectorId, error: (err as Error).message },
          'revocation handler failed (non-fatal)',
        );
      }
    }
    await withTenantScope(tenantId, async (client) => {
      await client.query(
        `DELETE FROM connector_credentials WHERE connector_id = $1`,
        [connectorId],
      );
    });
    logger.info({ tenantId, connectorId }, 'credential revoked');
  }

  private needsRefresh(record: ConnectorCredentialRecord, connectorType: string): boolean {
    if (record.expiresAtEpochSec != null) {
      const fiveMinFromNow = Math.floor(Date.now() / 1000) + 5 * 60;
      return record.expiresAtEpochSec < fiveMinFromNow;
    }
    // Backfilled credentials have no expiry. Refresh if a handler is registered
    // and the credential is at least 1 hour old (avoids hammering on every call).
    if (!oauthRefreshHandlers.has(connectorType)) return false;
    if (record.updatedAtEpochSec == null) return true;
    const oneHourAgo = Math.floor(Date.now() / 1000) - 60 * 60;
    return record.updatedAtEpochSec < oneHourAgo;
  }

  private async refreshOAuth(
    tenantId: string,
    connectorId: string,
    connectorType: string,
    record: ConnectorCredentialRecord,
    current: ConnectorSecretData,
  ): Promise<ConnectorSecretData> {
    const handler = oauthRefreshHandlers.get(connectorType);
    if (!handler) {
      throw new OAuthRefreshError(
        'reconnect_required',
        `No OAuth refresh handler registered for ${connectorType}`,
        { connectorId, tenantId, vendor: connectorType },
      );
    }
    if (!current.refreshToken) {
      // No refresh token — this connector issued a long-lived non-expiring token
      // (e.g. GitHub OAuth Apps). Return the existing credential as-is; it's
      // still valid. Throwing here would break vendor MCP resolution for these
      // providers because the caller treats OAuthRefreshError as a hard failure.
      logger.info(
        { tenantId, connectorId, connectorType },
        'no refresh token — returning existing credential unchanged',
      );
      return current;
    }
    try {
      const fresh = await handler({
        connectorId,
        tenantId,
        connectorType,
        refreshToken: current.refreshToken,
        scopes: record.scopes,
      });
      await this.storeCredentials(
        tenantId,
        connectorId,
        record.flowKind,
        fresh,
        record.scopes,
      );
      return fresh;
    } catch (err) {
      if (err instanceof OAuthRefreshError) throw err;
      throw new OAuthRefreshError(
        'unknown',
        `Refresh failed for ${connectorType}: ${(err as Error).message}`,
        { connectorId, tenantId, vendor: connectorType },
      );
    }
  }

  private buildCredentials(
    flowKind: FlowKind,
    secret: ConnectorSecretData,
    connectorConfig: Record<string, unknown>,
    recordExtra?: Record<string, unknown>,
  ): ConnectorCredentials {
    // Flatten `extraFields` (set by store-time callers via metadata.extraFields)
    // up into the response so RPC consumers can read them as a flat string map
    // — the connector vault writes the full metadata blob into the DB `extra`
    // column, but downstream resolvers (e.g. anchor-webhook-secret-resolver in
    // tenant-runtime) expect a flat `{ field: stringValue }` map.
    const extraFields =
      (recordExtra && (recordExtra as { extraFields?: Record<string, unknown> }).extraFields) ?? null;
    return {
      flowKind,
      accessToken: secret.accessToken,
      refreshToken: secret.refreshToken,
      apiKey: secret.apiKey,
      privateKey: secret.privateKey,
      instanceUrl: secret.instanceUrl,
      expiresAt: secret.expiresAt ? new Date(secret.expiresAt) : undefined,
      scopes: secret.scopes,
      connectorConfig,
      extra: extraFields ?? undefined,
    };
  }

  /** composio_managed credential resolution. Lives inside the service so
   *  callers of `getCredentials` see a single uniform surface — they don't
   *  pick between "composio path" and "legacy path".
   *
   *  Composio never exposes the underlying OAuth access token (the v3 API
   *  returns "REDACTED" via both REST and SDK paths).
   *  All vendor calls for composio_managed connectors must route through
   *  `composio.tools.proxyExecute(...)`, which signs requests server-side.
   *  This branch therefore returns an empty `accessToken` and surfaces the
   *  `composioConnectedAccountId` via `connectorConfig`; vendor clients
   *  (e.g. GoogleMailClient) detect that field and switch transports
   *  accordingly. The active-status assertion happens here so callers
   *  don't issue Composio proxy calls against REVOKED/EXPIRED accounts
   *  and have to interpret cryptic vendor errors. */
  private async getComposioCredentials(
    tenantId: string,
    connectorId: string,
    connectorType: string,
    connectorConfig: Record<string, unknown>,
    _options?: { forceRefresh?: boolean },
  ): Promise<ConnectorCredentials> {
    const composioConnectedAccountId = connectorConfig.composioConnectedAccountId;
    if (typeof composioConnectedAccountId !== 'string' || !composioConnectedAccountId) {
      throw new OAuthRefreshError(
        'reconnect_required',
        `Connector ${connectorId} is composio_managed but config.composioConnectedAccountId ` +
          `is unset — re-run the OAuth flow to bind a Composio account`,
        { connectorId, tenantId, vendor: connectorType },
      );
    }
    try {
      await assertComposioAccountActive(composioConnectedAccountId);
      return {
        flowKind: 'composio_managed',
        // No usable bearer token: vendor clients route through
        // composio.tools.proxyExecute via the composioConnectedAccountId
        // surfaced in connectorConfig below.
        accessToken: '',
        connectorConfig,
      };
    } catch (err) {
      if (err instanceof ComposioAccountNotActiveError) {
        throw new OAuthRefreshError('reconnect_required', err.message, {
          connectorId,
          tenantId,
          vendor: connectorType,
        });
      }
      throw err;
    }
  }
}

/** Centralized check so credentialService is the single point in the
 *  service that knows about Composio. Mirrors the same pattern used at
 *  src/oauth/router.ts:153 (OAuth /start branch). */
function isComposioManagedConnectorType(connectorType: string): boolean {
  return CONNECTORS[connectorType]?.mcp?.kind === 'composio_managed';
}

export const credentialService = new ConnectorCredentialService();

// ──────────────────────────────────────────────────────────────────────
// Warm cache — pre-fetched credentials held in memory for the lifetime
// of one request batch. The Warm RPC uses this to amortize Secret Manager
// latency across a burst of follow-on Execute calls.
// ──────────────────────────────────────────────────────────────────────

const warmCache = new Map<string, { expiresAtEpochSec: number; creds: ConnectorCredentials }>();

function warmKey(tenantId: string, connectorId: string): string {
  return `${tenantId}:${connectorId}`;
}

export async function warmCredentials(
  tenantId: string,
  connectorIds: string[],
): Promise<{ warmed: string[]; failures: { connectorId: string; reason: string }[] }> {
  const warmed: string[] = [];
  const failures: { connectorId: string; reason: string }[] = [];
  for (const connectorId of connectorIds) {
    try {
      const creds = await credentialService.getCredentials(tenantId, connectorId);
      const ttl = creds.expiresAt
        ? Math.floor(creds.expiresAt.getTime() / 1000)
        : Math.floor(Date.now() / 1000) + 300; // default 5-min TTL for non-expiring
      warmCache.set(warmKey(tenantId, connectorId), { expiresAtEpochSec: ttl, creds });
      warmed.push(connectorId);
    } catch (err) {
      failures.push({ connectorId, reason: (err as Error).message });
    }
  }
  return { warmed, failures };
}

/**
 * Proto-aligned Warm entry point — takes connector TYPES (e.g. ["slack",
 * "github"]), looks up every connector instance of those types that the
 * tenant owns, and pre-fetches credentials into the warm cache.
 *
 * Returns the set of types that warmed successfully at least once + a list
 * of failures (by type + reason) for partial visibility. A type with zero
 * matching connector rows counts as a failure ("no connectors of type X
 * for tenant Y"). A type with any successful warm counts as warmed.
 */
export async function warmCredentialsByType(
  tenantId: string,
  connectorTypes: string[],
): Promise<{ warmedTypes: string[]; failures: { connectorType: string; reason: string }[] }> {
  const warmedTypes: string[] = [];
  const failures: { connectorType: string; reason: string }[] = [];

  for (const type of connectorTypes) {
    try {
      const ids = await withTenantScope(tenantId, async (client) => {
        const res = await client.query(
          `SELECT id FROM connectors WHERE tenant_id = $1 AND type = $2 AND status = 'active'`,
          [tenantId, type],
        );
        return res.rows.map((r) => r.id as string);
      });

      if (ids.length === 0) {
        failures.push({ connectorType: type, reason: 'no active connector instances for this type' });
        continue;
      }

      const result = await warmCredentials(tenantId, ids);
      if (result.warmed.length > 0) {
        warmedTypes.push(type);
      }
      for (const f of result.failures) {
        failures.push({ connectorType: type, reason: `${f.connectorId}: ${f.reason}` });
      }
    } catch (err) {
      failures.push({ connectorType: type, reason: (err as Error).message });
    }
  }

  return { warmedTypes, failures };
}

export function getWarmCredentials(
  tenantId: string,
  connectorId: string,
): ConnectorCredentials | null {
  const key = warmKey(tenantId, connectorId);
  const entry = warmCache.get(key);
  if (!entry) return null;
  const now = Math.floor(Date.now() / 1000);
  if (entry.expiresAtEpochSec <= now) {
    warmCache.delete(key);
    return null;
  }
  return entry.creds;
}

export function clearWarmCache(): void {
  warmCache.clear();
}
