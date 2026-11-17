// Claude Code Proxy Service
//
// Scope after the liftoff-developer-proxy cutover (migration 132 dropped the
// platform-backend-side `claude_code_proxy_keys` table; the active proxy lives
// as a separate Cloud Run service):
//   - MCP token management (`createMcpToken`, `listMcpTokens`, `revokeMcpToken`)
//     for liftoff_mcp_* tokens, which keep using the local DB (`mcp_tokens`).
//   - PKCE setup-token bind + exchange (`bindCodeChallenge`, `exchangeSetupToken`)
//     against the local `setup_tokens` table, MCP path only.
//
// Removed in this PR (dead code paths against the dropped proxy-keys table):
//   - createKey / listKeys / getKey / updateKey / revokeKey / getKeyUsage
//   - resolveProxyKey / selfRevoke / getAnthropicApiKey / refreshAnthropicKeyCache
//   - In-memory setupTokenStore + Anthropic key verification helpers
//   - Companion `repository.ts` (deleted) and `proxy-router.ts` (deleted)
// All proxy-key flows are served by liftoff-developer-proxy now.

import crypto from 'crypto';
import { hashToken } from '../tenant-members/tokens';
import { withAdminScope, withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { getProxyBaseUrl } from '../infrastructure/control-plane-url';
import * as devProxyClient from './developer-proxy-client';

// PROXY_BASE_URL is used in setup_tokens.base_url (shown to users when they
// configure Claude Code). Must be env-specific so a dev user gets an
// api-dev.example.com/proxy URL, not the prod alias. See control-plane-url.ts
// for the cross-env trust rationale.

// --- PKCE: Bind code_challenge to setup token ---

export async function bindCodeChallenge(setupToken: string, codeChallenge: string): Promise<boolean> {
  // The setup token identifies the tenant post-exchange, but tenant context
  // isn't established yet at bind time — admin scope is required for the
  // lookup + update on setup_tokens (RLS-on). Only the MCP path remains;
  // the proxy-key in-memory fallback was removed with the developer-proxy cutover.
  const result = await withAdminScope(
    {
      caller: 'claude-code-proxy.bindCodeChallenge',
      reason: 'PKCE code_challenge bind pre-tenant-context',
    },
    (client) => client.query(
      `UPDATE setup_tokens
       SET code_challenge = $2
       WHERE token = $1 AND token_type = 'mcp' AND used_at IS NULL AND expires_at > NOW()
       RETURNING token`,
      [setupToken, codeChallenge],
    ),
  );
  return result.rows.length > 0;
}

// --- Setup Token Exchange (with PKCE verification) ---

export async function exchangeSetupToken(
  setupToken: string,
  accountId: string,
  codeVerifier: string,
): Promise<{ fullKey: string; baseUrl: string; tokenId?: string } | null> {
  // DB path for MCP tokens.
  // Setup-token exchange runs before tenant context is established (the token
  // itself identifies which tenant the resulting MCP key belongs to). Use
  // withAdminScope to bypass RLS for the lookup + mark-used update.
  //
  // H3 (TOCTOU fix): collapse the SELECT + UPDATE into a single atomic
  // statement using `UPDATE ... WHERE used_at IS NULL ... RETURNING`. Two
  // concurrent callers race to claim the row; PostgreSQL guarantees exactly
  // one will get a rowCount of 1, the other 0 — eliminating the prior
  // window where both saw `used_at IS NULL` and both proceeded.
  //
  // PKCE is verified AFTER the UPDATE. On PKCE failure the token is left
  // marked used (intentional — counts as a single-use attempt for replay
  // protection); the caller still gets `null`.
  const dbRow = await withAdminScope(
    {
      caller: 'exchangeSetupToken',
      reason: 'atomic token claim pre-tenant-context',
      actor: `account:${accountId}`,
    },
    async (client) => {
      const r = await client.query(
        `UPDATE setup_tokens
         SET used_at = NOW()
         WHERE token = $1
           AND token_type = 'mcp'
           AND used_at IS NULL
           AND expires_at > NOW()
         RETURNING full_key, base_url, token_id, account_id, code_challenge`,
        [setupToken],
      );
      return r.rows[0] ?? null;
    },
  );
  if (dbRow) {
    const row = dbRow;
    if (row.account_id !== accountId) {
      // H5: account mismatch on a claimed single-use token is a strong replay
      // signal — caller is presenting a token that was issued to a different
      // account. Log at error level with audit-grade context so security
      // tooling can alert.
      log.error(
        {
          event: 'mcp_setup_token_account_mismatch_after_claim',
          setupTokenPrefix: setupToken.substring(0, 8),
          claimedByAccountId: accountId,
          issuedToAccountId: row.account_id,
          tokenId: row.token_id ?? null,
        },
        'setup-token claimed by an account different from the one it was issued to — possible replay/CSRF',
      );
      return null;
    }
    if (row.code_challenge) {
      const expectedChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
      if (expectedChallenge !== row.code_challenge) {
        // H5: PKCE failure AFTER claiming a single-use token is the strongest
        // signal of attempted replay/CSRF — the token was already consumed by
        // the time we noticed the mismatch. Log at error with audit-grade
        // context (event id, tokenId, accountId, token prefix) so security
        // monitoring can alert on it.
        log.error(
          {
            event: 'mcp_setup_token_pkce_after_claim_fail',
            setupTokenPrefix: setupToken.substring(0, 8),
            accountId,
            tokenId: row.token_id ?? null,
          },
          'PKCE verification failed after setup-token claim — possible replay/CSRF',
        );
        return null;
      }
    }
    return { fullKey: row.full_key, baseUrl: row.base_url, tokenId: row.token_id ?? undefined };
  }
  return null;
}

// ── MCP Token Management ─────────────────────────────────────────────
// liftoff_mcp_* tokens: valid on /mcp only.
// Setup token is stored in setup_tokens (RLS-on, MCP-only path).

export async function createMcpToken(params: {
  tenantId: string;
  accountId: string;
  name?: string;
}): Promise<{ id: string; setupToken: string; proxyBaseUrl: string }> {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const fullKey = `liftoff_mcp_${rawToken}`;
  const keyHash = hashToken(fullKey);
  const keyPrefix = `liftoff_mcp_${rawToken.substring(0, 8)}`;

  const setupToken = crypto.randomBytes(16).toString('hex');

  const tokenId = await withTenantScope(params.tenantId, async (client) => {
    const result = await client.query(
      `INSERT INTO mcp_tokens (tenant_id, account_id, token_hash, token_prefix, name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [params.tenantId, params.accountId, keyHash, keyPrefix, params.name ?? 'Default'],
    );

    const id = result.rows[0].id;

    // Store setup token in DB for PKCE exchange (security req #14)
    await client.query(
      `INSERT INTO setup_tokens (token, token_type, full_key, base_url, tenant_id, account_id, token_id)
       VALUES ($1, 'mcp', $2, $3, $4, $5, $6)`,
      [setupToken, fullKey, getProxyBaseUrl(), params.tenantId, params.accountId, id],
    );

    return id as string;
  });

  // Auto-register collab connection in person_agent_assignments so it appears
  // on the Teams page and is eligible for can_delegate grants (same as proxy key setup)
  withTenantScope(params.tenantId, (client) =>
    client.query(
      `INSERT INTO person_agent_assignments (tenant_id, account_id, agent_id, agent_origin, created_by)
       VALUES ($1, $2, $3, 'external', $4)
       ON CONFLICT DO NOTHING`,
      [params.tenantId, params.accountId, tokenId, params.accountId],
    ),
  ).catch(err => {
    log.error({ error: (err as Error).message, tokenId }, 'Failed to auto-assign MCP token to member');
  });

  return { id: tokenId, setupToken, proxyBaseUrl: getProxyBaseUrl() };
}

/** Whether `connectionId` is a live coding-tool connection of this workspace:
 *  an mcp_tokens anchor (static or OAuth) under the tenant, else a
 *  developer-proxy credential the proxy answers for under the tenant. The
 *  check that a profile row is written under an id the workspace owns. */
export async function connectionBelongsToTenant(connectionId: string, tenantId: string, accountId: string): Promise<boolean> {
  const anchor = await withTenantScope(tenantId, (client) =>
    client.query(
      `SELECT 1 FROM mcp_tokens
       WHERE id = $1 AND tenant_id = $2 AND status = 'active' AND deleted_at IS NULL`,
      [connectionId, tenantId],
    ),
  );
  if (anchor.rows.length > 0) return true;
  if (!devProxyClient.isDevProxyEnabled()) return false;
  const credential = await devProxyClient.getCredential({ id: connectionId, tenantId, userId: accountId });
  return credential !== null;
}

export async function listMcpTokens(tenantId: string): Promise<Array<{
  id: string;
  tenantId: string;
  accountId: string;
  name: string;
  status: string;
  tokenPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string;
  createdAt: string;
}>> {
  const result = await withTenantScope(tenantId, (client) =>
    client.query(
      // Credential-management surface: static tokens only (plan v6.1 audit).
      // OAuth anchors (auth_kind='oauth', NULL prefix) are managed via grants.
      `SELECT id, tenant_id, account_id, name, status, token_prefix, last_used_at, expires_at, created_at
       FROM mcp_tokens
       WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'active' AND auth_kind = 'static'
       ORDER BY created_at DESC`,
      [tenantId],
    ),
  );
  return result.rows.map(r => ({
    id: r.id,
    tenantId: r.tenant_id,
    accountId: r.account_id,
    name: r.name,
    status: r.status,
    tokenPrefix: r.token_prefix,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }));
}

export async function revokeMcpToken(tokenId: string, accountId: string): Promise<void> {
  // Revocation is called from two paths: (1) self-revoke from the CLI with no
  // tenant context yet, (2) dashboard JWT path that doesn't thread tenantId
  // down. Admin scope is the correct primitive — the (tokenId, accountId)
  // pair is the authorization check on the row itself.
  //
  // The row is either a static liftoff_mcp_* token or an OAuth anchor. An
  // anchor's grant is what a connected tool actually presents, so it is
  // retired first, with its access and refresh tokens, and the anchor row
  // last; a static token has no grant and the first statement matches
  // nothing. Every statement is bound to this one anchor and person: this
  // is the person disconnecting their own tool (INV-PB-014).
  await withAdminScope(
    {
      caller: 'claude-code-proxy.revokeMcpToken',
      reason: 'revoke MCP token or OAuth grant family + clear person assignment',
      actor: `account:${accountId}`,
    },
    async (client) => {
      const grants = await client.query(
        `UPDATE oauth_grants SET status = 'revoked', revoked_at = NOW()
         WHERE mcp_token_id = $1 AND account_id = $2 AND status = 'active'
         RETURNING id`,
        [tokenId, accountId],
      );
      const grantIds = grants.rows.map((r: { id: string }) => r.id);
      if (grantIds.length > 0) {
        await client.query(
          `UPDATE oauth_access_tokens SET revoked_at = NOW()
           WHERE grant_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
          [grantIds],
        );
        await client.query(
          `UPDATE oauth_refresh_tokens SET revoked_at = NOW()
           WHERE grant_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
          [grantIds],
        );
      }
      await client.query(
        `UPDATE mcp_tokens SET status = 'revoked', deleted_at = NOW()
         WHERE id = $1 AND account_id = $2`,
        [tokenId, accountId],
      );
      // Remove the connection from the Teams page (mirrors proxy key revocation)
      await client.query(
        `UPDATE person_agent_assignments SET deleted_at = NOW()
         WHERE agent_id = $1 AND deleted_at IS NULL`,
        [tokenId],
      );
    },
  );
}

