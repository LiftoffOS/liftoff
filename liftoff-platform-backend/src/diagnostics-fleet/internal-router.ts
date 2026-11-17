// Internal fleet-tenants endpoint for the tenant-runtime diagnostics harvester.
//
// Mounted at /api/internal/diagnostics. Service-auth gated with the default
// TENANT_RUNTIME_SERVICE_TOKEN (the same shared bearer the diagnostics job already
// uses for /api/internal/*). Returns the ACTIVE, execution-allowed tenants that have a
// runtime URL — the exact set the fleet harvest should evaluate — so the harvester
// AUTO-DISCOVERS the fleet at runtime instead of reading a hand-maintained
// DIAGNOSTICS_FLEET_TENANTS CSV. Enrollment is "every active workspace", no manual step.
//
// The query mirrors reconciler.listTenants (the reconcilable-tenant set): status=active,
// entitlement operational + execution-allowed, non-empty runtime_url. Admin-scoped read.

import { Router, type Request, type Response } from 'express';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

export const diagnosticsFleetRouter = Router();

const svcAuth = verifyServiceAuth(); // defaults to TENANT_RUNTIME_SERVICE_TOKEN

// GET /api/internal/diagnostics/fleet-tenants
//   → { tenants: [{ tenantId, runtimeUrl }] }
diagnosticsFleetRouter.get('/fleet-tenants', svcAuth, async (_req: Request, res: Response) => {
  try {
    const rows = await withAdminScope(
      { caller: 'diagnostics.fleetTenants', reason: 'list active execution-allowed tenants for fleet harvest' },
      (c) =>
        c
          .query<{ id: string; runtime_url: string }>(
            `SELECT t.id, t.runtime_url
               FROM tenants t
               JOIN entitlements e ON e.tenant_id = t.id
              WHERE t.status = 'active'
                AND t.runtime_url IS NOT NULL AND t.runtime_url <> ''
                AND e.tenant_operational_status = 'active'
                AND e.agent_execution_allowed = true`,
          )
          .then((r) => r.rows),
    );
    return res.json({ tenants: rows.map((r) => ({ tenantId: r.id, runtimeUrl: r.runtime_url })) });
  } catch (err) {
    log.error({ err: (err as Error).message }, 'diagnostics fleet-tenants query failed');
    return res.status(500).json({ error: 'fleet_tenants_query_failed' });
  }
});
