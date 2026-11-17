// Claude Code Proxy Management Router
// Dashboard CRUD for proxy key management (Firebase auth)
//
// Proxy-key management (create/list/get/update/revoke/refresh) is
// served entirely by liftoff-developer-proxy via devProxyClient. The local
// platform-backend table was dropped in migration 132. Each proxy-key
// handler short-circuits with 503 if devProxy isn't configured.
//
// MCP-only token management (createMcpToken/listMcpTokens/revokeMcpToken)
// and the PKCE setup-token endpoints (setup-bind-challenge / setup-exchange)
// remain in the platform-backend because they back `liftoff_mcp_*` tokens
// stored in the local mcp_tokens / setup_tokens tables.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { AccountService } from '../accounts/service';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import { ROLE_PERMISSIONS } from '../tenant-members/types';
import type { TenantMemberRole } from '../tenant-members/types';
import { logAudit, log } from '../infrastructure/logging';
import { withAdminScope } from '../infrastructure/database';
import { hashToken } from '../tenant-members/tokens';
import * as service from './service';
import * as devProxyClient from './developer-proxy-client';
import { upsertConnectionProfile } from '../workforce/connection-profiles';
import { verifyTenantOwnership } from '../infrastructure/tenant-role-auth';
import {
  createProxyKeySchema,
  listProxyKeysSchema,
  revokeProxyKeySchema,
  updateProxyKeySchema,
} from './types';

export const claudeCodeProxyRouter = Router();
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const accountService = new AccountService();

// Resolve Firebase UID to account (same pattern as corrections/router.ts)
async function getAccount(req: Request) {
  const firebaseUid = (req as unknown as { user?: { uid?: string } }).user?.uid;
  if (!firebaseUid) return null;
  return accountService.getByFirebaseUid(firebaseUid);
}

// Get membership from tenantAuthMiddleware (attached to req)
function getMembership(req: Request): { role: TenantMemberRole; accountId: string } | null {
  const membership = (req as any).membership;
  const actorAccountId = (req as any).actorAccountId;
  if (!membership || !actorAccountId) return null;
  return { role: membership.role, accountId: actorAccountId };
}

function hasPermission(role: TenantMemberRole, permission: string): boolean {
  return ROLE_PERMISSIONS[role]?.[permission as keyof typeof ROLE_PERMISSIONS[typeof role]] ?? false;
}

// Helper: translate a developer-proxy client error to an HTTP error response.
function handleDevProxyClientError(error: unknown, res: Response, context: string): void {
  const err = error as { statusCode?: number; message?: string; devProxyBody?: Record<string, unknown> };
  const statusCode = err.statusCode ?? 502;
  const message = err.devProxyBody?.error ?? err.message ?? 'developer-proxy error';
  log.error({ error: err.message, context }, 'developer-proxy request failed');
  res.status(statusCode).json({ error: message });
}

// --- Create Proxy Key ---
// Any tenant member can create their own key

claudeCodeProxyRouter.post(
  '/keys',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response) => {
    const parseResult = createProxyKeySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }

    const account = await getAccount(req);
    if (!account) return res.status(401).json({ error: 'Authentication required' });

    const { tenantId, vendor, apiKey, anthropicApiKey, label } = parseResult.data;

    if (!devProxyClient.isDevProxyEnabled()) {
      return res.status(503).json({ error: 'developer_proxy_not_configured' });
    }
    try {
      const result = await devProxyClient.createCredential({
        tenantId,
        userId: account.id,
        vendor: vendor ?? 'anthropic',
        apiKey: apiKey ?? anthropicApiKey,
        label,
      });

      logAudit('claude_code_proxy.key_created', req.ctx || { requestId: '', operation: '' }, {
        keyId: result.id,
        tenantId,
        accountId: account.id,
      });

      return res.status(201).json(result);
    } catch (error) {
      return handleDevProxyClientError(error, res, 'create_credential');
    }
  },
);

// --- List Proxy Keys ---
// All members can list (own keys). manageClaudeCodeProxy sees all.

claudeCodeProxyRouter.get(
  '/keys',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response) => {
    const parseResult = listProxyKeysSchema.safeParse(req.query);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }

    const auth = getMembership(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });

    const { tenantId } = parseResult.data;

    if (!devProxyClient.isDevProxyEnabled()) {
      return res.status(503).json({ error: 'developer_proxy_not_configured' });
    }
    try {
      const isAdmin = hasPermission(auth.role, 'manageClaudeCodeProxy');
      const credentials = await devProxyClient.listCredentials({ tenantId, userId: auth.accountId, all: isAdmin });
      return res.json({ keys: credentials });
    } catch (error) {
      return handleDevProxyClientError(error, res, 'list_credentials');
    }
  },
);

// --- Get Single Proxy Key ---

claudeCodeProxyRouter.get(
  '/keys/:keyId',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response) => {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

    const auth = getMembership(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });

    if (!devProxyClient.isDevProxyEnabled()) {
      return res.status(503).json({ error: 'developer_proxy_not_configured' });
    }
    try {
      const credential = await devProxyClient.getCredential({ id: req.params.keyId, tenantId, userId: auth.accountId });
      if (!credential) return res.status(404).json({ error: 'Key not found' });
      return res.json(credential);
    } catch (error) {
      return handleDevProxyClientError(error, res, 'get_credential');
    }
  },
);

// --- Pending Setup Token ---
// The CLI-auth page calls this after the user authenticates to retrieve the
// setup token the dashboard just minted — no browser localStorage handoff, so
// `setup` works from any browser or machine.

claudeCodeProxyRouter.get(
  '/pending-setup-token',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response) => {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

    const auth = getMembership(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });

    if (!devProxyClient.isDevProxyEnabled()) {
      return res.status(503).json({ error: 'developer_proxy_not_configured' });
    }
    try {
      const token = await devProxyClient.getPendingSetupToken({ tenantId, userId: auth.accountId });
      if (!token) return res.status(404).json({ error: 'No pending setup token' });
      return res.json({ setupToken: token });
    } catch (error) {
      return handleDevProxyClientError(error, res, 'pending_setup_token');
    }
  },
);

// --- Update Proxy Key ---

// --- Update a coding-tool connection's name and description ---
// The connection is a developer-proxy credential or an mcp_tokens anchor; the
// person's edits live in coding_tool_connection_profiles (migration 478) and
// the workforce read applies them over the derived values. Gated the way the
// teams page gates its Update action (editTeams), and the connection must be
// one of this workspace's before a profile is written under its id.
claudeCodeProxyRouter.put(
  '/keys/:keyId',
  tenantAuthMiddleware('editTeams'),
  async (req: Request, res: Response) => {
    const parseResult = updateProxyKeySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }

    const auth = getMembership(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });

    const { tenantId, name, description } = parseResult.data;
    const { keyId } = req.params;
    // Both connection families key on a UUID; anything else is not a
    // connection and must not reach the uuid columns as a cast error.
    if (!UUID_SHAPE.test(keyId)) return res.status(404).json({ error: 'Key not found' });

    try {
      if (!(await service.connectionBelongsToTenant(keyId, tenantId, auth.accountId))) {
        return res.status(404).json({ error: 'Key not found' });
      }
      const profile = await upsertConnectionProfile({
        tenantId,
        connectionId: keyId,
        updatedBy: auth.accountId,
        name,
        description,
      });

      logAudit('claude_code_proxy.connection_profile_updated', req.ctx || { requestId: '', operation: '' }, {
        keyId,
        tenantId,
        updatedBy: auth.accountId,
      });

      return res.json({ id: keyId, tenantId, name: profile.name, description: profile.description });
    } catch (error) {
      return handleDevProxyClientError(error, res, 'update_connection_profile');
    }
  },
);

// --- Revoke Proxy Key ---
// Members can revoke their own keys. manageClaudeCodeProxy can revoke any.

claudeCodeProxyRouter.delete(
  '/keys/:keyId',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response) => {
    const parseResult = revokeProxyKeySchema.safeParse(req.query);
    if (!parseResult.success) {
      return res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
    }

    const auth = getMembership(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });

    const { tenantId } = parseResult.data;
    const { keyId } = req.params;

    if (!devProxyClient.isDevProxyEnabled()) {
      return res.status(503).json({ error: 'developer_proxy_not_configured' });
    }
    try {
      const revoked = await devProxyClient.revokeCredential({ id: keyId, tenantId, userId: auth.accountId });
      if (!revoked) return res.status(404).json({ error: 'Key not found' });

      logAudit('claude_code_proxy.key_revoked', req.ctx || { requestId: '', operation: '' }, {
        keyId,
        tenantId,
        revokedBy: auth.accountId,
      });

      return res.json({ revoked: true });
    } catch (error) {
      return handleDevProxyClientError(error, res, 'revoke_credential');
    }
  },
);

// --- Bind PKCE code_challenge to setup token (called by /cli-auth page) ---
// No tenantAuthMiddleware — these endpoints use user-level auth only.
// The setup token already contains tenant context from key creation.

claudeCodeProxyRouter.post(
  '/setup-bind-challenge',
  async (req: Request, res: Response) => {
    const { setupToken, codeChallenge } = req.body as { setupToken?: string; codeChallenge?: string };
    if (!setupToken || !codeChallenge) {
      return res.status(400).json({ error: 'setupToken and codeChallenge required' });
    }

    // Setup token may be an MCP token (local DB) or a proxy-key token
    // (developer-proxy). Try local MCP path first; if not found, delegate
    // to developer-proxy for proxy-key tokens.
    const bound = await service.bindCodeChallenge(setupToken, codeChallenge);
    if (bound) return res.json({ bound: true });

    if (!devProxyClient.isDevProxyEnabled()) {
      return res.status(404).json({ error: 'Setup token expired or invalid' });
    }
    try {
      const remoteBound = await devProxyClient.bindCodeChallenge({
        setupToken,
        codeChallenge,
        tenantId: 'pkce-bind',
        userId: 'pkce-bind',
      });
      if (!remoteBound) return res.status(404).json({ error: 'Setup token expired or invalid' });
      return res.json({ bound: true });
    } catch (error) {
      return handleDevProxyClientError(error, res, 'pkce_bind');
    }
  },
);

// --- Exchange Setup Token with PKCE (CLI retrieves proxy key after dashboard creation) ---

claudeCodeProxyRouter.post(
  '/setup-exchange',
  async (req: Request, res: Response) => {
    const account = await getAccount(req);
    if (!account) return res.status(401).json({ error: 'Authentication required' });

    const { setupToken, codeVerifier } = req.body as { setupToken?: string; codeVerifier?: string };
    if (!setupToken || !codeVerifier) {
      return res.status(400).json({ error: 'setupToken and codeVerifier required' });
    }

    // MCP tokens (liftoff_mcp_*) live in the local DB (setup_tokens table).
    // devProxyClient has no knowledge of MCP tokens, so always try the local path
    // first. For non-developer-proxy keys the local path also handles in-memory store.
    const localResult = await service.exchangeSetupToken(setupToken, account.id, codeVerifier);
    if (localResult) {
      return res.json({
        proxyKey: localResult.fullKey,
        baseUrl: localResult.baseUrl,
        ...(localResult.tokenId ? { tokenId: localResult.tokenId } : {}),
      });
    }

    // Not found locally — must be a proxy key delegated to the developer proxy
    if (devProxyClient.isDevProxyEnabled()) {
      try {
        const result = await devProxyClient.exchangeSetupToken({
          setupToken,
          userId: account.id,
          codeVerifier,
          tenantId: 'setup-exchange',
        });
        if (!result) return res.status(404).json({ error: 'Setup token expired, invalid, or PKCE mismatch' });
        return res.json({
          proxyKey: result.fullKey,
          baseUrl: result.proxyBaseUrl,
        });
      } catch (error) {
        return handleDevProxyClientError(error, res, 'setup_exchange');
      }
    }

    return res.status(404).json({ error: 'Setup token expired, invalid, or PKCE mismatch' });
  },
);

// --- Refresh Anthropic Key Cache ---

claudeCodeProxyRouter.post(
  '/keys/:keyId/refresh',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response) => {
    const auth = getMembership(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });

    const tenantId = req.query.tenantId as string;
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

    // developer-proxy owns the credential cache; platform-backend has no
    // secret to invalidate here. Audit-log the request and 200.
    logAudit('claude_code_proxy.key_refreshed', req.ctx || { requestId: '', operation: '' }, {
      keyId: req.params.keyId,
      tenantId,
      refreshedBy: auth.accountId,
    });
    res.json({ refreshed: true });
  },
);

// ── MCP-only token management ────────────────────────────────────────
// liftoff_mcp_* tokens: valid on /mcp only (not the Anthropic proxy).
// Used by `liftoff collab` CLI command.

claudeCodeProxyRouter.get(
  '/mcp-tokens',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response) => {
    const auth = getMembership(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    const tenantId = req.query.tenantId as string;
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    const tokens = await service.listMcpTokens(tenantId);
    res.json({ tokens });
  },
);

claudeCodeProxyRouter.post(
  '/mcp-tokens',
  verifyTenantOwnership, async (req: Request, res: Response) => {
    const account = await getAccount(req);
    if (!account) return res.status(401).json({ error: 'Authentication required' });

    const tenantId = (req.body?.tenantId as string) || (req.query.tenantId as string);
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });

    const name = req.body?.name as string | undefined;
    const result = await service.createMcpToken({ tenantId, accountId: account.id, name });
    res.status(201).json(result);
  },
);

claudeCodeProxyRouter.delete(
  '/mcp-tokens/:tokenId',
  async (req: Request, res: Response) => {
    const { tokenId } = req.params;
    const authHeader = req.headers.authorization;
    const rawKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    // Self-revocation: liftoff_mcp_* token may revoke itself without Firebase auth.
    // Token lookup runs before tenant context is established — use withAdminScope.
    if (rawKey?.startsWith('liftoff_mcp_')) {
      const keyHash = hashToken(rawKey);
      const row = await withAdminScope(
        {
          caller: 'mcp-token self-revoke',
          reason: 'lookup token pre-tenant-context',
          actor: `mcp-token:${tokenId}`,
        },
        async (client) => {
          const r = await client.query(
            `SELECT id, account_id FROM mcp_tokens
             WHERE token_hash = $1 AND id = $2 AND status = 'active'
               AND auth_kind = 'static' AND deleted_at IS NULL`,
            [keyHash, tokenId],
          );
          return r.rows[0] ?? null;
        },
      );
      if (!row) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      await service.revokeMcpToken(tokenId, row.account_id);
      return res.json({ revoked: true });
    }

    // Firebase JWT auth (dashboard / admin revocation)
    const account = await getAccount(req);
    if (!account) return res.status(401).json({ error: 'Authentication required' });
    await service.revokeMcpToken(tokenId, account.id);
    res.json({ revoked: true });
  },
);
