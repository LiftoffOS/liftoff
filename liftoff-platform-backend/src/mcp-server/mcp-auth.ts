// MCP Auth Middleware
// Strict prefix-routed token lookup — no cross-table fallthrough.
//   liftoff_mcp_* → mcp_tokens (static credentials, auth_kind='static')
//   liftoff_oat_* → oauth_access_tokens → grant → mcp_tokens anchor (plan v6.1)
// Any other prefix or missing token → 401.
//
// 401 challenge (Phase 2, gated by MCP_OAUTH_ENABLED): the WWW-Authenticate
// header distinguishes missing-token (no `error` attribute) from
// invalid/expired token (`error="invalid_token"`) so spec clients know
// whether to start the OAuth flow or refresh. The JSON-RPC error body is
// kept for legacy clients.

import type { Request, Response, NextFunction } from 'express';
import { withAdminScope } from '../infrastructure/database';
import { hashToken } from '../tenant-members/tokens';
import { log } from '../infrastructure/logging';
import { getBackendUrl } from '../infrastructure/control-plane-url';
import { isMcpOauthEnabled } from '../oauth/metadata-router';
import { verifyOAuthAccessToken } from '../oauth/verifier';
import type { McpAuthContext } from './types';

declare global {
  namespace Express {
    interface Request {
      mcpAuth?: McpAuthContext;
    }
  }
}

function jsonRpcError(id: unknown, code: number, message: string): object {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// RFC 9728 §5.1 challenge. `invalidToken: false` = no credentials were
// presented (no error attribute); true = a token was presented and rejected.
function setChallenge(res: Response, invalidToken: boolean): void {
  if (!isMcpOauthEnabled()) return;
  const parts = [
    `resource_metadata="${getBackendUrl()}/.well-known/oauth-protected-resource/mcp"`,
    'scope="mcp"',
  ];
  if (invalidToken) parts.push('error="invalid_token"');
  res.setHeader('WWW-Authenticate', `Bearer ${parts.join(', ')}`);
}

// Block browser-originated CSRF (mirrors proxy originGuard)
export function mcpOriginGuard(req: Request, res: Response, next: NextFunction): void {
  if (req.headers.origin) {
    res.status(403).json(jsonRpcError(null, -32001, 'Browser requests are not allowed'));
    return;
  }
  next();
}

export async function mcpAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    setChallenge(res, false);
    res.status(401).json(jsonRpcError(req.body?.id, -32001, 'Unauthorized'));
    return;
  }

  const rawKey = authHeader.slice(7);

  try {
    let ctx: McpAuthContext | null = null;

    if (rawKey.startsWith('liftoff_mcp_')) {
      const keyHash = hashToken(rawKey);
      // Auth runs before any tenant context is established (we're identifying
      // which tenant the token belongs to). Use withAdminScope to bypass RLS.
      // Use the token-hash prefix as the audit-log `actor` (no account id yet).
      ctx = await withAdminScope(
        {
          caller: 'mcpAuthMiddleware',
          reason: 'token lookup pre-tenant-context',
          actor: `mcp-token:${keyHash.slice(0, 8)}`,
        },
        async (client) => {
          // The account join is not decoration: without it this resolved a
          // token whose OWNER had been deleted, so a deleted person's coding
          // tool kept full access while the dashboard refused them. Read per
          // call, like the token's own status, so the credential follows the
          // account's current state (INV-PB-014) rather than being revoked by
          // anything.
          const result = await client.query(
            `SELECT t.id, t.tenant_id, t.account_id
             FROM mcp_tokens t
             JOIN accounts a ON a.id = t.account_id
             WHERE t.token_hash = $1 AND t.status = 'active' AND t.auth_kind = 'static'
               AND t.expires_at > NOW() AND t.deleted_at IS NULL
               AND a.deleted_at IS NULL`,
            [keyHash],
          );
          if (result.rows.length === 0) return null;
          const row = result.rows[0];
          // Await the last_used_at update so any failure surfaces through
          // withAdminScope's normal error path (was previously
          // fire-and-forget with a swallowed .catch).
          await client.query(
            `UPDATE mcp_tokens SET last_used_at = NOW() WHERE id = $1`,
            [row.id],
          );
          return { tenantId: row.tenant_id, accountId: row.account_id, keyId: row.id, keyType: 'collab' as const };
        },
      );
    } else if (rawKey.startsWith('liftoff_oat_')) {
      ctx = await verifyOAuthAccessToken(rawKey);
    }

    if (!ctx) {
      setChallenge(res, true);
      res.status(401).json(jsonRpcError(req.body?.id, -32001, 'Unauthorized'));
      return;
    }

    req.mcpAuth = ctx;
    next();
  } catch (error) {
    log.error({ error: (error as Error).message }, 'mcp-auth: database error');
    res.status(500).json(jsonRpcError(req.body?.id, -32603, 'Internal error'));
  }
}
