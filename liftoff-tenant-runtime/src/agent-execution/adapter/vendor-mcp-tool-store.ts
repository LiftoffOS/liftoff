// Last known-good `tools/list` per vendor MCP server.
//
// Written on every successful probe, read only when one fails. See
// migrations/377_cached_vendor_mcp_tools.sql for why: graph validation checks a
// workflow step against a list obtained by asking a third party, so a failed
// request otherwise becomes the claim "that tool does not exist" and fails the
// whole run.
//
// Both functions swallow their own errors. A store that cannot be reached must
// not take down the path it exists to protect — on a write failure the live list
// is still correct, and on a read failure the caller degrades exactly as it did
// before this existed.

import { getPool } from '../../infrastructure/database';
import { logger } from '../../infrastructure/logging';
import type { VendorMcpToolListEntry } from './vendor-mcp-enumerate';

/** Record what the server answered. Best-effort; never throws. */
export async function storeVendorToolList(
  tenantId: string,
  serverId: string,
  tools: VendorMcpToolListEntry[],
): Promise<void> {
  // An empty list is not a known-good answer. A server that legitimately
  // exposes nothing is indistinguishable here from one that answered oddly,
  // and overwriting a good list with an empty one would defeat the point.
  if (tools.length === 0) return;
  try {
    await getPool().query(
      `INSERT INTO cached_vendor_mcp_tools (tenant_id, server_id, tools, fetched_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (tenant_id, server_id)
       DO UPDATE SET tools = EXCLUDED.tools, fetched_at = EXCLUDED.fetched_at`,
      [tenantId, serverId, JSON.stringify(tools)],
    );
  } catch (err) {
    logger.warn(
      { serverId, err: (err as Error).message },
      'could not record the vendor tool list; the live list for this run is unaffected',
    );
  }
}

/** What the server said last time it answered, or null if it never has. */
export async function loadVendorToolList(
  tenantId: string,
  serverId: string,
): Promise<{ tools: VendorMcpToolListEntry[]; fetchedAt: Date } | null> {
  try {
    const { rows } = await getPool().query(
      `SELECT tools, fetched_at FROM cached_vendor_mcp_tools
        WHERE tenant_id = $1 AND server_id = $2`,
      [tenantId, serverId],
    );
    if (!rows[0]) return null;
    const raw = rows[0].tools;
    const tools = (typeof raw === 'string' ? JSON.parse(raw) : raw) as VendorMcpToolListEntry[];
    if (!Array.isArray(tools) || tools.length === 0) return null;
    return { tools, fetchedAt: rows[0].fetched_at as Date };
  } catch (err) {
    logger.warn(
      { serverId, err: (err as Error).message },
      'could not read the last known-good vendor tool list',
    );
    return null;
  }
}
