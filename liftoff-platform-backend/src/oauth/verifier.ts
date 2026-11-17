// OAuth access-token verifier (plan v6.1 Phase 3)
//
// liftoff_oat_* → oauth_access_tokens row (unexpired, not revoked; NO
// clock-skew leeway — opaque tokens checked against the same DB clock)
// → grant active → anchor mcp_tokens row active AND unexpired
// → RFC 8707 audience via isCanonicalMcpResource
// → McpAuthContext with keyId = the anchor mcp_tokens.id, preserving the
//   identity model every existing tool relies on.
//
// Pre-tenant-context lookup (the token identifies the tenant) → admin scope;
// src/oauth/** is on the eslint withAdminScope allow-list.

import { withAdminScope } from '../infrastructure/database';
import { hashToken } from '../tenant-members/tokens';
import { isCanonicalMcpResource } from './metadata-router';
import type { McpAuthContext } from '../mcp-server/types';

export async function verifyOAuthAccessToken(rawToken: string): Promise<McpAuthContext | null> {
  const tokenHash = hashToken(rawToken);

  return withAdminScope(
    {
      caller: 'oauth.verifyOAuthAccessToken',
      reason: 'access-token lookup pre-tenant-context',
      actor: `oat:${tokenHash.slice(0, 8)}`,
    },
    async (client) => {
      const result = await client.query(
        // The accounts join matches the static-token path: this checked the
        // grant and the anchor token and never the person they belong to, so
        // a deleted account's connected tool kept working.
        `SELECT at.resource,
                g.status AS grant_status, g.tenant_id, g.account_id, g.mcp_token_id,
                t.status AS anchor_status, t.expires_at AS anchor_expires_at, t.deleted_at AS anchor_deleted_at
         FROM oauth_access_tokens at
         JOIN oauth_grants g ON g.id = at.grant_id
         JOIN mcp_tokens t ON t.id = g.mcp_token_id
         JOIN accounts a ON a.id = g.account_id
         WHERE at.token_hash = $1
           AND at.revoked_at IS NULL
           AND at.expires_at > NOW()
           AND a.deleted_at IS NULL`,
        [tokenHash],
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];

      if (row.grant_status !== 'active') return null;
      if (row.anchor_status !== 'active' || row.anchor_deleted_at !== null) return null;
      if (new Date(row.anchor_expires_at as string) <= new Date()) return null;
      if (!isCanonicalMcpResource(row.resource as string)) return null;

      // The anchor is the row the teams page reads activity from, for a
      // static token and an OAuth grant alike; the static branch stamps it
      // in mcp-auth.ts and this is the same stamp for the OAuth branch.
      await client.query(
        `UPDATE mcp_tokens SET last_used_at = NOW() WHERE id = $1`,
        [row.mcp_token_id],
      );

      return {
        tenantId: row.tenant_id as string,
        accountId: row.account_id as string,
        keyId: row.mcp_token_id as string,
        keyType: 'collab' as const,
      };
    },
  );
}
