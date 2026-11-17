// Per-tenant MCP URL allowlist (internal endpoint).
//
// Returns the snapshot tenant-runtime caches in its TenantAllowlistProvider.
// Sources:
//   - custom_mcp_servers.endpoint_url (any delivery mode)
//   - external_agents.endpoint_url
//   - derived public_url of registered tunnel routes
//
// Authenticated with the same internal-service token pattern as the LLM
// relay (CONNECTOR_SERVICE_TOKEN is the conventional caller; any of the
// registered service tokens passes). Mounted before authMiddleware in
// src/index.ts.

import crypto from 'crypto';
import { isPublicUrl } from '../common/url-guard';
import { Router, Request, Response } from 'express';
import { pool, withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

export const mcpAllowlistRouter = Router();

const INTERNAL_SERVICE_TOKEN_VARS = [
  // Every caller authenticates with its OWN service identity token.
  // tenant-runtime is the heaviest caller of this endpoint; its identity
  // env var is TENANT_RUNTIME_SERVICE_TOKEN (same one every other TR -> PB
  // internal endpoint already accepts). Including it here means TR can use
  // a single, consistent token across every TR -> PB call.
  'TENANT_RUNTIME_SERVICE_TOKEN',
  'CONNECTOR_SERVICE_TOKEN',
  'WORKFORCE_SERVICE_TOKEN',
  'GOVERNANCE_EVAL_SERVICE_TOKEN',
  'HARVEST_SERVICE_TOKEN',
] as const;

function serviceAuth(req: Request, res: Response, next: () => void): void {
  const token = req.headers['x-service-auth'] as string | undefined;
  if (!token) {
    res.status(401).json({ error: 'Missing service authentication' });
    return;
  }
  const candidates = INTERNAL_SERVICE_TOKEN_VARS
    .map((v) => process.env[v])
    .filter((t): t is string => Boolean(t));
  if (candidates.length === 0) {
    res.status(503).json({ error: 'MCP allowlist endpoint not configured' });
    return;
  }
  const matched = candidates.some((expected) => {
    try {
      return (
        Buffer.byteLength(token) === Buffer.byteLength(expected) &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
      );
    } catch {
      return false;
    }
  });
  if (!matched) {
    res.status(401).json({ error: 'Invalid service authentication' });
    return;
  }
  next();
}

interface AllowlistSnapshot {
  tenantId: string;
  /** Exact-match URLs the per-tenant allowlist accepts. */
  urls: string[];
  /** Monotonic ETag-style version tag. Bumped on any row change. */
  version: string;
  generatedAt: string;
}

mcpAllowlistRouter.get('/tenants/:tenantId/mcp-allowlist', serviceAuth, async (req: Request, res: Response) => {
  const { tenantId } = req.params;
  try {
    const [customMcp, externalAgents, tunnelRoutes] = await Promise.all([
      pool.query(`SELECT endpoint_url, updated_at FROM custom_mcp_servers WHERE tenant_id = $1`, [tenantId]),
      withTenantScope(tenantId, (client) => client.query(`SELECT endpoint_url, updated_at FROM external_agents WHERE tenant_id = $1`, [tenantId])),
      pool.query(
        `SELECT r.public_url, r.updated_at
         FROM mcp_tunnel_routes r
         INNER JOIN mcp_tunnel_deployments d ON r.deployment_id = d.id
         WHERE d.tenant_id = $1`,
        [tenantId],
      ),
    ]);

    const candidates = new Set<string>();
    for (const row of customMcp.rows) if (row.endpoint_url) candidates.add(row.endpoint_url);
    for (const row of externalAgents.rows) if (row.endpoint_url) candidates.add(row.endpoint_url);
    for (const row of tunnelRoutes.rows) if (row.public_url) candidates.add(row.public_url);

    // E1, defence in depth: this endpoint is what the runtime's URL guard
    // TRUSTS — anything listed here is allowed to be dialled from inside the
    // tenant runtime. Registration is now validated (custom MCP servers,
    // external agents), but rows written before that guard existed are still in
    // the table, and DNS can change under a row that was fine when it was
    // created. Filtering on the way out means a bad entry stops being trusted
    // without waiting for a runtime deploy or a data migration.
    //
    // Filtered rather than fatal: one bad row must not blank the whole
    // allowlist and take every good server offline with it.
    const checked = await Promise.all(
      Array.from(candidates).map(async (url) => ({ url, ok: await isPublicUrl(url) })),
    );
    const blocked = checked.filter((c) => !c.ok);
    if (blocked.length > 0) {
      log.warn(
        { event: 'ssrf_block', context: 'mcp-allowlist.emit', tenantId, count: blocked.length },
        'Excluded non-public URLs from the tenant allowlist snapshot',
      );
    }
    const urls = new Set(checked.filter((c) => c.ok).map((c) => c.url));

    const latest = [...customMcp.rows, ...externalAgents.rows, ...tunnelRoutes.rows]
      .map((r) => (r.updated_at ? new Date(r.updated_at).getTime() : 0))
      .reduce((a, b) => Math.max(a, b), 0);

    const snapshot: AllowlistSnapshot = {
      tenantId,
      urls: Array.from(urls).sort(),
      version: latest ? `v-${latest}` : 'v-empty',
      generatedAt: new Date().toISOString(),
    };

    res.json(snapshot);
  } catch (error) {
    log.error({ error, tenantId }, 'Failed to compute MCP allowlist snapshot');
    res.status(500).json({ error: 'Failed to compute allowlist' });
  }
});
