// Report which already-registered endpoints the SSRF guard would now reject
// (E1). READ ONLY — this changes nothing.
//
// Registration is validated from now on, but rows written before the guard
// existed are still in the tables, and the allowlist emit filters them
// silently. This script names them, so an operator can tell a tenant "this
// server is no longer reachable and here is why" rather than discovering it
// through a support ticket.
//
// Run before enabling enforcement in an environment, and again afterwards to
// confirm the set is empty:
//   --command=node --args="dist/scripts/audit-registered-url-safety.js"

import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { assertPublicUrl, BlockedUrlError } from '../common/url-guard';

interface UrlRow {
  source: string;
  tenant_id: string;
  id: string;
  name: string | null;
  url: string;
}

async function main(): Promise<void> {
  const rows = await withAdminScope(
    {
      caller: 'scripts/audit-registered-url-safety',
      reason: 'E1 pre-enforcement sweep across every tenant registration',
    },
    async (client) => {
      const result = await client.query<UrlRow>(
        `SELECT 'custom_mcp_server' AS source, tenant_id, connector_id::text AS id, name, endpoint_url AS url
           FROM custom_mcp_servers WHERE endpoint_url IS NOT NULL
         UNION ALL
         SELECT 'external_agent' AS source, tenant_id, id::text AS id, name, endpoint_url AS url
           FROM external_agents WHERE endpoint_url IS NOT NULL`,
      );
      return result.rows;
    },
  );

  log.info({ total: rows.length }, 'url-safety audit: start');

  const blocked: Array<UrlRow & { reason: string }> = [];
  for (const row of rows) {
    try {
      await assertPublicUrl(row.url, { allowHttp: true, context: 'audit' });
    } catch (err) {
      const reason = err instanceof BlockedUrlError ? err.reason : 'unknown';
      blocked.push({ ...row, reason });
      log.warn(
        { source: row.source, tenantId: row.tenant_id, id: row.id, name: row.name, url: row.url, reason },
        'url-safety audit: registration would now be blocked',
      );
    }
  }

  log.info(
    { total: rows.length, blocked: blocked.length, ok: rows.length - blocked.length },
    'url-safety audit: complete',
  );
}

main().catch((err) => {
  log.error({ error: (err as Error).message }, 'url-safety audit: fatal');
  process.exit(1);
});
