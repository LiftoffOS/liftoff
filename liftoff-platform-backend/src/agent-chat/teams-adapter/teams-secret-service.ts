// Teams secret/credential service.
//
// Two concerns:
//   1. getBotCredentials() — the "Liftoff" bot's MicrosoftAppId /
//      MicrosoftAppPassword / MicrosoftAppTenantId. The Azure Bot resource is
//      single-tenant (bound to its home tenant), while the backing Entra app
//      registration is multi-tenant so any customer tenant can install the
//      Teams app. Injected as env vars (TEAMS_BOT_APP_ID /
//      TEAMS_BOT_APP_PASSWORD from Secret Manager; TEAMS_BOT_APP_TENANT_ID is
//      the non-secret home tenant id), bound in Terraform alongside
//      AGENT_SLACK_SERVICE_TOKEN.
//   2. getGraphAppToken(aadTenantId) — an application-permission Graph access
//      token (client-credentials grant) for the customer's Azure AD tenant.
//      Used for proactive install (TeamsAppInstallation.*). Cached per tenant
//      until shortly before expiry, mirroring the TTL-cache pattern in
//      bot-token-service.ts.

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { log } from '../../infrastructure/logging';

export interface BotCredentials {
  appId: string;
  appPassword: string;
  appTenantId: string;
}

// ── Admin delegated refresh-token storage (per tenant) ──────────────────────
// The OAuth callback persists the customer admin's delegated refresh token so
// Liftoff can re-publish/upgrade the org-catalog app later. Stored in Secret
// Manager (one secret per tenant), path persisted in
// teams_tenant_installs.graph_admin_refresh_secret_path.

const smClient = new SecretManagerServiceClient();
const SM_PROJECT = process.env.GCP_PROJECT_ID;

function shortId(uuid: string): string {
  return uuid.replace(/-/g, '').slice(0, 12);
}

function secretParent(): string {
  if (!SM_PROJECT) throw new Error('GCP_PROJECT_ID not set');
  return `projects/${SM_PROJECT}`;
}

/** Store a tenant's admin refresh token; returns the /versions/latest path. */
export async function storeAdminRefreshToken(tenantId: string, refreshToken: string): Promise<string> {
  const secretId = `teams-graph-admin-${shortId(tenantId)}`;
  const parent = secretParent();
  try {
    await smClient.createSecret({
      parent,
      secretId,
      secret: { replication: { automatic: {} }, labels: { purpose: 'teams-graph-admin', tenant: shortId(tenantId) } },
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 6) {
      // 6 = ALREADY_EXISTS — fine, add a new version below.
      throw new Error(`Failed to create secret ${secretId}: ${(err as Error).message}`);
    }
  }
  await smClient.addSecretVersion({
    parent: `${parent}/secrets/${secretId}`,
    payload: { data: Buffer.from(refreshToken, 'utf-8') },
  });
  return `${parent}/secrets/${secretId}/versions/latest`;
}

/** Read a tenant's admin refresh token from a stored secret path. */
export async function readAdminRefreshToken(secretPath: string): Promise<string> {
  const [resp] = await smClient.accessSecretVersion({ name: secretPath });
  const token = resp.payload?.data?.toString();
  if (!token) throw new Error(`Secret ${secretPath} has no payload`);
  return token;
}

/** Read the Liftoff bot's app id, password, and home tenant id (env-injected). */
export function getBotCredentials(): BotCredentials {
  const appId = process.env.TEAMS_BOT_APP_ID;
  const appPassword = process.env.TEAMS_BOT_APP_PASSWORD;
  const appTenantId = process.env.TEAMS_BOT_APP_TENANT_ID;
  if (!appId || !appPassword || !appTenantId) {
    throw new Error('TEAMS_BOT_APP_ID / TEAMS_BOT_APP_PASSWORD / TEAMS_BOT_APP_TENANT_ID not set');
  }
  return { appId, appPassword, appTenantId };
}

// ── Graph application-permission token cache ────────────────────────────────
// Keyed by the customer Azure AD tenant id. Client-credentials tokens last
// ~60-90 min; we refresh 5 min before expiry. Mirrors the 5-min horizon used
// by bot-token-service.ts.

interface GraphTokenEntry {
  token: string;
  expiresAt: number; // epoch ms (already minus the 5-min safety margin)
}
const GRAPH_TOKEN_SAFETY_MS = 5 * 60 * 1000;
const graphTokenCache = new Map<string, GraphTokenEntry>();

/**
 * Acquire an application-permission Microsoft Graph access token for the
 * customer's Azure AD tenant via the client-credentials grant. App
 * permissions are scoped per resource tenant, so the token endpoint is the
 * customer tenant, not `common`.
 */
export async function getGraphAppToken(aadTenantId: string): Promise<string> {
  const cached = graphTokenCache.get(aadTenantId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const appId = process.env.TEAMS_BOT_APP_ID;
  // One Entra app backs both the bot and Graph, so the bot password is the same
  // client secret. TEAMS_GRAPH_CLIENT_SECRET is an optional override for rotating
  // the Graph secret independently.
  const clientSecret = process.env.TEAMS_GRAPH_CLIENT_SECRET || process.env.TEAMS_BOT_APP_PASSWORD;
  if (!appId || !clientSecret) {
    throw new Error('TEAMS_BOT_APP_ID / TEAMS_BOT_APP_PASSWORD not set');
  }

  const url = `https://login.microsoftonline.com/${encodeURIComponent(aadTenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: appId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    log.error(
      { aadTenantId, status: res.status, error: data.error, desc: data.error_description },
      'Failed to acquire Graph app token',
    );
    throw new Error(`Graph app token acquisition failed: ${data.error ?? res.status}`);
  }

  const ttlMs = (data.expires_in ?? 3600) * 1000;
  graphTokenCache.set(aadTenantId, {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(0, ttlMs - GRAPH_TOKEN_SAFETY_MS),
  });
  return data.access_token;
}

/** Test-only: clear the in-process Graph token cache. */
export function _clearGraphTokenCache(): void {
  graphTokenCache.clear();
}
