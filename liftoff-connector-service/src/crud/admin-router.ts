// Cross-tenant connector lookups for other services.
//
// These exist because connector rows live HERE and nowhere else. Since the
// Phase 2a cutover, platform-backend's own `connectors` table has only held
// pre-cutover rows plus the custom_mcp_server ones it writes itself, so any
// query it runs against that table answers for a shrinking historical subset
// and, worse, answers "no rows" rather than erroring for everything created
// since. Two of its features were quietly reading it:
//
//   - harvest's connector-to-tenant resolver, which 404s a live connector
//   - the operator dashboard's connector health panel, which reports zeros
//
// Both need to ask the service that owns the data. That is what this router
// is for. Every route is cross-tenant by nature (the caller does not yet know
// the tenant, or wants an estate-wide roll-up), so they all run under
// withAdminScope on the BYPASSRLS role, and they are mounted behind the same
// verifyServiceAuth gate as the rest of /api/connectors.

import { Router, type Request, type Response } from 'express';
import { withAdminScope } from '../db/pool.js';
import { logger } from '../infra/logging.js';

export const connectorAdminRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /connectors/:connectorId/tenant
 *
 * Which tenant owns this connector. The caller has an id and no tenant
 * context — a webhook, a Pub/Sub message, a harvest callback — so this cannot
 * be a tenant-scoped read.
 */
connectorAdminRouter.get(
  '/connectors/:connectorId/tenant',
  async (req: Request, res: Response) => {
    const { connectorId } = req.params;
    if (!UUID_RE.test(connectorId)) {
      return res.status(400).json({ error: 'connectorId must be a UUID' });
    }

    try {
      const result = await withAdminScope(
        {
          caller: 'admin-router.connectorTenant',
          reason: 'resolve owning tenant from a connector id for a pre-tenant-context caller',
        },
        (client) =>
          client.query<{ tenant_id: string; type: string; status: string }>(
            'SELECT tenant_id, type, status FROM connectors WHERE id = $1',
            [connectorId],
          ),
      );

      const row = result.rows[0];
      if (!row) return res.status(404).json({ error: 'Connector not found', connectorId });

      return res.json({ tenantId: row.tenant_id, connectorType: row.type, status: row.status });
    } catch (err) {
      logger.error(
        { err, connectorId },
        'admin-router: connector tenant lookup failed',
      );
      return res.status(500).json({ error: (err as Error).message });
    }
  },
);

/**
 * GET /health/summary
 *
 * Estate-wide connector health for the operator dashboard: totals by status,
 * a breakdown by connector type, and the most recent sync failures.
 *
 * `connector_sync_stats` holds one row per connector with its last error, so
 * "failures in the last 24h" means connectors whose last sync error landed in
 * that window — not a count of individual failed attempts. The distinction is
 * worth stating because the number is smaller than a naive log count and the
 * dashboard should not imply otherwise.
 */
connectorAdminRouter.get('/health/summary', async (_req: Request, res: Response) => {
  try {
    const summary = await withAdminScope(
      {
        caller: 'admin-router.healthSummary',
        reason: 'cross-tenant operator aggregation of connector health',
      },
      async (client) => {
        const totals = await client.query<{
          total: string;
          active: string;
          error: string;
          disconnected: string;
          pending: string;
        }>(`
          SELECT
            COUNT(*)::text                                          AS total,
            COUNT(*) FILTER (WHERE status = 'active')::text         AS active,
            COUNT(*) FILTER (WHERE status = 'error')::text          AS error,
            COUNT(*) FILTER (WHERE status = 'disconnected')::text   AS disconnected,
            COUNT(*) FILTER (WHERE status = 'pending')::text        AS pending
          FROM connectors
        `);

        const byType = await client.query<{ type: string; count: string }>(`
          SELECT type, COUNT(*)::text AS count
          FROM connectors
          GROUP BY type
          ORDER BY COUNT(*) DESC
        `);

        const failures = await client.query<{
          connector_id: string;
          tenant_id: string;
          type: string;
          last_error: string | null;
          last_error_at: Date | null;
        }>(`
          SELECT s.connector_id, s.tenant_id, c.type, s.last_error, s.last_error_at
            FROM connector_sync_stats s
            JOIN connectors c ON c.id = s.connector_id
           WHERE s.last_error IS NOT NULL
             AND s.last_error_at IS NOT NULL
           ORDER BY s.last_error_at DESC
           LIMIT 10
        `);

        const recentErrorCount = await client.query<{ count: string }>(`
          SELECT COUNT(*)::text AS count
            FROM connector_sync_stats
           WHERE last_error_at > NOW() - INTERVAL '24 hours'
        `);

        return {
          totalConnectors: Number(totals.rows[0]?.total ?? 0),
          activeCount: Number(totals.rows[0]?.active ?? 0),
          errorCount: Number(totals.rows[0]?.error ?? 0),
          disconnectedCount: Number(totals.rows[0]?.disconnected ?? 0),
          pendingCount: Number(totals.rows[0]?.pending ?? 0),
          connectorsWithSyncErrorsLast24h: Number(recentErrorCount.rows[0]?.count ?? 0),
          connectorsByType: Object.fromEntries(
            byType.rows.map((r) => [r.type, Number(r.count)]),
          ) as Record<string, number>,
          recentSyncFailures: failures.rows.map((r) => ({
            connectorId: r.connector_id,
            tenantId: r.tenant_id,
            connectorType: r.type,
            errorMessage: r.last_error,
            failedAt: r.last_error_at,
          })),
        };
      },
    );

    return res.json(summary);
  } catch (err) {
    // No zero-filled fallback. A health panel that cannot read health has to
    // say so — reporting 0 failing connectors because the query died is the
    // exact failure this endpoint was written to end.
    logger.error({ err }, 'admin-router: connector health summary failed');
    return res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /connectors/reconnect-required
 *
 * Report a binding as unusable so the product can say so. Body is one of:
 *
 *   { connectorId }            a connector this caller already resolved
 *   { composioConnectedAccountId }  a Composio account, resolved here
 *
 * Flips the row to `status='error'`, which is the one signal the whole
 * product already reads: the Connections page renders it as a Reconnect
 * card and the Teams page badges every agent bound to it. A successful
 * reconnect flips it back to `active` (oauth/router.ts), so recovery stays
 * automatic and nothing here needs an undo.
 *
 * Two classes of binding had no way to reach that signal and so failed in
 * silence. Composio-managed connectors dispatch in-process inside tenant
 * runtime and never touch this service at tool-call time; customer-hosted
 * MCP servers are not reached by any probe at all. Both now report here —
 * Composio through platform-backend's webhook receiver when the vendor
 * tells us an account expired, and both through tenant runtime's daily
 * binding probe when a real call fails repeatedly.
 *
 * Cross-tenant by nature: a webhook knows a vendor account id, not a
 * tenant, which is why this lives on the admin router.
 *
 * Idempotent. Reporting an already-errored connector is a no-op that still
 * returns ok, so a caller retrying after a timeout cannot double-report.
 */
connectorAdminRouter.post(
  '/connectors/reconnect-required',
  async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      connectorId?: unknown;
      composioConnectedAccountId?: unknown;
      reason?: unknown;
    };
    const connectorId = typeof body.connectorId === 'string' ? body.connectorId : null;
    const composioAccountId =
      typeof body.composioConnectedAccountId === 'string'
        ? body.composioConnectedAccountId
        : null;
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : 'unspecified';

    if (!connectorId && !composioAccountId) {
      return res
        .status(400)
        .json({ error: 'connectorId or composioConnectedAccountId is required' });
    }
    if (connectorId && !UUID_RE.test(connectorId)) {
      return res.status(400).json({ error: 'connectorId must be a UUID' });
    }

    try {
      // Only `active` rows are flipped. A row already in `error` is the
      // desired end state, and one the user has since `disconnected` must not
      // be resurrected into a Reconnect card they did not ask for.
      const result = await withAdminScope(
        {
          caller: 'admin-router.reconnectRequired',
          reason: 'flag a binding as unusable for a caller that has no tenant context',
        },
        (client) =>
          connectorId
            ? client.query<{ id: string; tenant_id: string; type: string }>(
                `UPDATE connectors SET status = 'error', updated_at = NOW()
                  WHERE id = $1 AND status = 'active'
                  RETURNING id, tenant_id, type`,
                [connectorId],
              )
            : client.query<{ id: string; tenant_id: string; type: string }>(
                `UPDATE connectors SET status = 'error', updated_at = NOW()
                  WHERE config->>'composioConnectedAccountId' = $1 AND status = 'active'
                  RETURNING id, tenant_id, type`,
                [composioAccountId],
              ),
      );

      if (result.rowCount === 0) {
        // Either it is already errored/disconnected, or the account id matches
        // nothing we hold. Both are fine outcomes for a best-effort reporter,
        // but they are worth telling apart in the logs.
        logger.info(
          { connectorId, composioAccountId, reason },
          'admin-router: reconnect-required matched no active connector',
        );
        return res.json({ ok: true, updated: 0 });
      }

      for (const row of result.rows) {
        logger.warn(
          {
            connectorId: row.id,
            tenantId: row.tenant_id,
            connectorType: row.type,
            reason,
          },
          'admin-router: connector marked error, reconnect required',
        );
      }

      return res.json({
        ok: true,
        updated: result.rowCount ?? 0,
        connectors: result.rows.map((r) => ({
          connectorId: r.id,
          tenantId: r.tenant_id,
          connectorType: r.type,
        })),
      });
    } catch (err) {
      logger.error(
        { err, connectorId, composioAccountId },
        'admin-router: reconnect-required failed',
      );
      return res.status(500).json({ error: (err as Error).message });
    }
  },
);
