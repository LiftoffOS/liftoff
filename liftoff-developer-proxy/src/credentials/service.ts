// Developer Proxy Credential Service
// Orchestrates key generation, Secret Manager storage, DB insertion, and PKCE setup-token flow.

import crypto from 'node:crypto';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { loadConfig } from '../infrastructure/config.js';
import { getPool, withByokTenant, withByokUser } from '../infrastructure/database.js';
import { invalidateRevocationCache } from '../proxy/auth.js';
import { invalidateSecretCache } from '../proxy/secret-cache.js';
import * as repository from './repository.js';
import type {
  ByokCredential,
  CreateCredentialParams,
  CreateCredentialResult,
  CredentialResponse,
} from './types.js';

// ---------------------------------------------------------------------------
// Setup token store (Postgres-backed, 30-min TTL)
//
// The setup token is minted on the dashboard, retrieved by the CLI-auth page,
// and exchanged by the CLI — three hops that can each land on a DIFFERENT proxy
// instance (maxScale=20, no session affinity) and are separated by a deploy.
// A process-local Map lost the token in all of those cases, so it lives in the
// `developer_proxy_setup_tokens` table (migration 016) instead. Single-use
// (deleted on exchange), short-lived (expires_at), swept on read.
// ---------------------------------------------------------------------------

const SETUP_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// createCredential
// ---------------------------------------------------------------------------

export async function createCredential(
  params: CreateCredentialParams,
): Promise<CreateCredentialResult> {
  const config = loadConfig();
  const vendor = params.vendor ?? 'anthropic';
  // Vendor-neutral input: generic apiKey preferred; anthropicApiKey
  // preserved for backward compatibility with existing Anthropic callers.
  const rawApiKey = params.apiKey ?? params.anthropicApiKey;
  if (!rawApiKey) {
    throw new Error('apiKey is required');
  }

  // 1. Verify the provider key with a vendor-specific verifier
  if (vendor === 'openai') {
    await verifyOpenAiKey(rawApiKey);
  } else {
    await verifyAnthropicKey(rawApiKey);
  }

  // 2. Generate liftoff_sk_* token
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const fullKey = `liftoff_sk_${rawToken}`;
  const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');
  const keyPrefix = `liftoff_sk_${rawToken.slice(0, 8)}`;
  const keyHint = rawToken.slice(-4);

  // 3. Generate credential ID upfront so we can encode it in the Secret Manager path.
  // Secret Manager naming: devproxy/{tenantId}/{userId}/{vendor}/{credentialId}
  // This encoding enables ref-swap attack prevention: the secret path is bound to
  // the specific credential row, so substituting one tenant's secretName for another
  // is detectable at access time (the path won't match the authenticated principal).
  const credentialId = crypto.randomUUID();
  // Secret path (documented): devproxy/{tenantId}/{userId}/{vendor}/{credentialId}
  const secretClient = new SecretManagerServiceClient();
  const secretParent = `projects/${config.GCP_PROJECT_ID}`;
  // Secret Manager IDs cannot contain '/'; encode the path as a flat ID
  // using '---' as delimiter (safe: UUIDs and vendor names don't contain '--').
  const secretManagerId = `devproxy---${params.tenantId}---${params.userId}---${vendor}---${credentialId}`;
  const secretPath = `${secretParent}/secrets/${secretManagerId}`;

  try {
    await secretClient.createSecret({
      parent: secretParent,
      secretId: secretManagerId,
      secret: { replication: { automatic: {} } },
    });
  } catch (error) {
    if (!(error as Error).message?.includes('ALREADY_EXISTS')) throw error;
  }

  await secretClient.addSecretVersion({
    parent: secretPath,
    payload: {
      data: Buffer.from(
        JSON.stringify({
          // Generic field name; the secret-cache reader also
          // understands the legacy anthropicApiKey field for old versions.
          apiKey: rawApiKey,
          tenantId: params.tenantId,
          userId: params.userId,
          vendor,
          credentialId,
          storedAt: new Date().toISOString(),
        }),
      ),
    },
  });

  // 4. Insert DB row within user RLS context (sets both tenant_id and user_id GUCs)
  const credential = await withByokUser(params.tenantId, params.userId, (client) =>
    repository.insertCredential(client, {
      id: credentialId,
      tenantId: params.tenantId,
      userId: params.userId,
      vendor,
      keyHash,
      keyPrefix,
      keyHint,
      secretName: secretManagerId,
      label: params.label ?? '',
    }),
  );

  // 5. Store one-time setup token (durable, TTL enforced via expires_at)
  const setupToken = crypto.randomBytes(16).toString('hex');
  const pool = await getPool();
  await pool.query(
    `INSERT INTO developer_proxy_setup_tokens
       (setup_token, full_key, proxy_base_url, tenant_id, user_id, code_challenge, expires_at)
     VALUES ($1, $2, $3, $4, $5, NULL, NOW() + ($6::int * INTERVAL '1 millisecond'))`,
    [setupToken, fullKey, config.PROXY_BASE_URL, params.tenantId, params.userId, SETUP_TOKEN_TTL_MS],
  );

  return {
    credential: toResponse(credential),
    fullKey,
    setupToken,
    proxyBaseUrl: config.PROXY_BASE_URL,
  };
}

// ---------------------------------------------------------------------------
// PKCE: bind code_challenge to setup token (called before CLI initiates exchange)
// ---------------------------------------------------------------------------

export async function bindCodeChallenge(setupToken: string, codeChallenge: string): Promise<boolean> {
  const pool = await getPool();
  // Only bind a token that still exists and hasn't expired.
  const res = await pool.query(
    `UPDATE developer_proxy_setup_tokens
        SET code_challenge = $2
      WHERE setup_token = $1 AND expires_at > NOW()`,
    [setupToken, codeChallenge],
  );
  return (res.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Setup token exchange (with optional PKCE verification)
// ---------------------------------------------------------------------------

export async function exchangeSetupToken(
  setupToken: string,
  codeVerifier?: string,
): Promise<{ fullKey: string; proxyBaseUrl: string } | null> {
  const pool = await getPool();

  // Atomically consume the token: DELETE ... RETURNING guarantees one-time use
  // even if two exchanges race across instances (only one gets the row).
  const res = await pool.query<{
    full_key: string;
    proxy_base_url: string;
    code_challenge: string | null;
    expired: boolean;
  }>(
    `DELETE FROM developer_proxy_setup_tokens
      WHERE setup_token = $1
      RETURNING full_key, proxy_base_url, code_challenge, (expires_at <= NOW()) AS expired`,
    [setupToken],
  );
  const row = res.rows[0];
  if (!row) return null;

  // TTL check (the row is already consumed; an expired token is rejected).
  if (row.expired) return null;

  // PKCE verification: SHA-256(codeVerifier) base64url must match stored challenge
  if (row.code_challenge) {
    if (!codeVerifier) return null;
    const expectedChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    if (expectedChallenge !== row.code_challenge) return null;
  }

  return { fullKey: row.full_key, proxyBaseUrl: row.proxy_base_url };
}

// Latest unexpired setup token for a (tenant, user). Lets the CLI-auth page
// retrieve the token the dashboard just minted WITHOUT a browser localStorage
// handoff — the user authenticates and we hand back their own pending token,
// so `setup` works from any browser or machine.
export async function getPendingSetupToken(tenantId: string, userId: string): Promise<string | null> {
  const pool = await getPool();
  // Best-effort sweep of expired rows so the table stays small.
  pool.query(`DELETE FROM developer_proxy_setup_tokens WHERE expires_at <= NOW()`).catch(() => undefined);

  const res = await pool.query<{ setup_token: string }>(
    `SELECT setup_token
       FROM developer_proxy_setup_tokens
      WHERE tenant_id = $1 AND user_id = $2 AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId, userId],
  );
  return res.rows[0]?.setup_token ?? null;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listCredentials(
  tenantId: string,
  userId?: string,
): Promise<CredentialResponse[]> {
  // If userId provided, use user-scoped RLS; otherwise tenant-admin scope (list-all)
  const credentials = userId
    ? await withByokUser(tenantId, userId, (client) => repository.listByTenant(client, tenantId, userId))
    : await withByokTenant(tenantId, (client) => repository.listByTenant(client, tenantId));
  return credentials.map(toResponse);
}

export async function getCredential(
  id: string,
  tenantId: string,
  userId?: string,
): Promise<CredentialResponse | null> {
  const credential = userId
    ? await withByokUser(tenantId, userId, (client) => repository.findByIdForTenant(client, id, tenantId))
    : await withByokTenant(tenantId, (client) => repository.findByIdForTenant(client, id, tenantId));
  return credential ? toResponse(credential) : null;
}

export async function revokeCredential(
  id: string,
  tenantId: string,
  userId?: string,
): Promise<{ revoked: boolean; vendor: string | null }> {
  // Fetch secretName first so we can poison the in-process cache on success.
  const existing = userId
    ? await withByokUser(tenantId, userId, (client) => repository.findByIdForTenant(client, id, tenantId))
    : await withByokTenant(tenantId, (client) => repository.findByIdForTenant(client, id, tenantId));
  const secretName = existing?.secretName ?? null;
  const vendor = existing?.vendor ?? null;

  const revoked = userId
    ? await withByokUser(tenantId, userId, (client) => repository.revokeById(client, id, tenantId))
    : await withByokTenant(tenantId, (client) => repository.revokeById(client, id, tenantId));

  if (revoked) {
    invalidateRevocationCache(id);
    if (secretName) invalidateSecretCache(secretName);

    // Write to DB revocation cache for cross-instance invalidation
    const pool = await getPool();
    pool.query(
      `INSERT INTO developer_proxy_revocation_cache (credential_id, revoked_at, expires_at)
       VALUES ($1, NOW(), NOW() + INTERVAL '120 seconds')
       ON CONFLICT (credential_id) DO UPDATE
         SET revoked_at = NOW(), expires_at = NOW() + INTERVAL '120 seconds'`,
      [id],
    ).catch(() => undefined);
  }

  return { revoked, vendor };
}

// ---------------------------------------------------------------------------
// Vendor key verification
// ---------------------------------------------------------------------------

const VERIFY_TIMEOUT_MS = 5_000;
const VERIFY_MAX_ATTEMPTS = 2;

/**
 * Minimal Bearer-authenticated OpenAI verification: GET /v1/models
 * creates no billable model output. Distinguishes invalid credentials (401)
 * from temporary provider/network failures (bounded retries, then stored as
 * unverified). The submitted key is never logged.
 */
async function verifyOpenAiKey(apiKey: string): Promise<void> {
  for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });

      if (res.status === 401) {
        throw new Error('Invalid OpenAI API key');
      }
      if (!res.ok && res.status >= 500 && attempt < VERIFY_MAX_ATTEMPTS) {
        continue; // bounded retry on provider 5xx
      }
      if (!res.ok && res.status >= 500) {
        console.warn(`[developer-proxy] OpenAI API unavailable during key verification (${res.status}) — storing key as unverified`);
      }
      return;
    } catch (error) {
      if ((error as Error).message === 'Invalid OpenAI API key') throw error;
      if (attempt < VERIFY_MAX_ATTEMPTS) continue;
      // Network error after bounded retries — don't block creation
      console.warn('[developer-proxy] Could not verify OpenAI key — storing as unverified', (error as Error).message);
      return;
    }
  }
}

async function verifyAnthropicKey(apiKey: string): Promise<void> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });

    if (res.status === 401) {
      throw new Error('Invalid Anthropic API key');
    }

    // 5xx or network issues — don't block creation on Anthropic downtime
    if (!res.ok && res.status >= 500) {
      console.warn(`[developer-proxy] Anthropic API unavailable during key verification (${res.status}) — storing key as unverified`);
    }
  } catch (error) {
    if ((error as Error).message === 'Invalid Anthropic API key') throw error;
    // Network error — don't block creation
    console.warn('[developer-proxy] Could not verify Anthropic key — storing as unverified', (error as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Helper: strip secretName from outbound responses
// ---------------------------------------------------------------------------

function toResponse(credential: ByokCredential): CredentialResponse {
  const { secretName: _secretName, ...rest } = credential;
  void _secretName; // intentionally omitted
  return rest;
}
