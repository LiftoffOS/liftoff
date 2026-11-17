// Seeded tool classifications for one connector type — what tenant-runtime
// consults BEFORE its name heuristics when it enumerates a vendor-hosted MCP.
//
// Composio-managed tools carry categories from the overlay; a vendor-hosted
// server's tools are discovered live per connection and, until now, classified
// only by MCP annotations and verb heuristics at enumeration time. The global
// rows in tool_classification_cache (tenant_id IS NULL) are the a priori seeds
// written from each vendor's public tool inventory, and this endpoint is the one
// place they leave the control plane. Global rows only: a tenant's own manual
// overrides stay behind the tenant-scoped reads in mcp/tool-classifier.ts.
//
// Meta-tool servers expose one tool whose argument names the operation
// (omnisend: `execute` with `tool_name`). The seeds for such a server are keyed
// `<tool>:<operation>`, and the response carries the key so the runtime's gate
// can resolve a call to its operation row.
//
// Auth: TENANT_RUNTIME_SERVICE_TOKEN (the verifyServiceAuth default), the token
// TR's platform-backend-client sends to every /api/internal route it reads.
// Mounted BEFORE authMiddleware (the caller is a service, not a person).

import { Router, type Request, type Response } from 'express';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { pool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

export const toolClassificationsRouter = Router();

const svcAuth = verifyServiceAuth(); // defaults to TENANT_RUNTIME_SERVICE_TOKEN

/** The tool whose argument names the operation, per meta-tool server. A seed
 *  row for such a server is keyed `<tool>:<operation>`. The argument name is
 *  the one the live tool's inputSchema declares (omnisend's `execute` takes
 *  `tool_name`), read at harvest and pinned in connector-service's
 *  scripts/harvest-vendor-mcp-inventory.ts alongside this map. */
const VENDOR_OPERATION_KEYS: Record<string, { tool: string; arg: string }> = {
  omnisend: { tool: 'execute', arg: 'tool_name' },
};

interface ClassificationRow {
  tool_name: string;
  categories: string[] | null;
  is_manual_override: boolean | null;
  reviewed_by: string | null;
}

// GET /api/internal/tool-classifications/:integrationType
// Global rows (tenant_id IS NULL) for one connector type; what tenant-runtime consults
// before its name heuristics when it enumerates a vendor-hosted MCP.
toolClassificationsRouter.get('/:integrationType', svcAuth, async (req: Request, res: Response) => {
  const integrationType = req.params.integrationType;
  try {
    const rows = await pool.query<ClassificationRow>(
      `SELECT tool_name, categories, is_manual_override, reviewed_by
         FROM tool_classification_cache
        WHERE integration_type = $1 AND tenant_id IS NULL`,
      [integrationType],
    );
    res.json({
      integrationType,
      operationKey: VENDOR_OPERATION_KEYS[integrationType] ?? null,
      tools: rows.rows.map((r) => ({
        name: r.tool_name,
        categories: r.categories ?? [],
        manual: r.is_manual_override === true,
        reviewedBy: r.reviewed_by,
      })),
    });
  } catch (err) {
    log.error({ integrationType, error: (err as Error).message }, 'tool_classifications_lookup_failed');
    res.status(500).json({ error: 'tool_classifications_lookup_failed' });
  }
});
