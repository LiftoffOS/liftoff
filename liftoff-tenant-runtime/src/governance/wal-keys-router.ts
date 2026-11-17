// Read-only endpoint queried by governance-engine's reconciliation job
// (governance-reconciliation-${env}). Returns the idempotency keys this
// runtime believes it has already replicated to governance-engine, so the
// engine can compare them against its own `actions` table and surface drift.
//
// Why this exists as HTTP rather than the reconciler reading our database:
// it cannot. YOUR_TENANT_PROJECT is ipv4Enabled=false on
// YOUR_TENANT_PROJECT; the job runs on vpc-${env}; the two networks
// peer only with their own servicenetworking and peering is not transitive.
// The job spent its whole life failing — first on an image tag that was never
// written, then, once that was fixed, on `failed to dial ... SFEClient is
// nil`. A Cloud SQL socket cannot bridge that, with either vpc-egress
// setting. This path reuses the one route that is already proven: the same
// X-Service-Auth token, over the same public-with-auth ingress, that
// platform-backend's outbox reconciler already uses for /event-status.
//
// Auth: X-Service-Auth bearer, TENANT_RUNTIME_SERVICE_TOKEN — the same secret
// event-status uses, and byte-identical to the copy in the control project.
//
// Mounted unconditionally (not gated on SERVICE_TYPE) for the same reason
// event-status is: the caller is a central reconciler that reaches whichever
// service of this runtime is publicly ingressible, and every service in the
// split shares one tenant_runtime database.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireServiceAuth } from '../security/service-auth';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

export const walKeysRouter = Router();

// verifyServiceAuth() with no opts → defaults to TENANT_RUNTIME_SERVICE_TOKEN.
// `requireServiceAuth` from src/security, NOT `verifyServiceAuth` from
// @liftoffos/service-client. The package's verifier resolves the expected
// token with `process.env[tokenEnvVar]` and answers 500 when it finds
// nothing — and this runtime no longer keeps secrets in the environment
// (INV-TR-016). Every request to this router returned 500 until it moved.
// Same default semantics: shared bearer only, TENANT_RUNTIME_SERVICE_TOKEN,
// constant-time compare.
const svcAuth = requireServiceAuth();

// windowHours mirrors the reconciler's own default (25h — one day plus an
// hour of overlap so a run that slips cannot open a gap). Capped: this reads
// unbounded rows and the caller is a batch job, not a user.
const querySchema = z.object({
  windowHours: z.coerce.number().int().positive().max(168).default(25),
  tenantId: z.string().min(1).optional(),
});

interface WalKeyRow {
  tenant_id: string;
  idempotency_key: string;
}

// GET /api/internal/governance/wal-keys?windowHours=25[&tenantId=...]
walKeysRouter.get('/governance/wal-keys', svcAuth, async (req: Request, res: Response): Promise<void> => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query', detail: parsed.error.flatten() });
    return;
  }
  const { windowHours, tenantId } = parsed.data;

  try {
    // replicated = true only. An unreplicated row is one this runtime has not
    // yet handed to governance-engine, so its absence there is the drainer
    // working through its backlog, not drift. This matches the predicate the
    // reconciler used when it read the table directly.
    //
    // No RLS scope is set, deliberately and identically to the WAL drainer a
    // few files over: the tenant-runtime app role holds BYPASSRLS, and this
    // read is inherently cross-tenant within a runtime that hosts one tenant.
    const pool = getPoolForService('default');
    const { rows } = await pool.query<WalKeyRow>(
      `SELECT tenant_id, idempotency_key
         FROM governance_wal
        WHERE replicated = true
          AND created_at > NOW() - ($1 || ' hour')::interval
          AND ($2::text IS NULL OR tenant_id = $2)`,
      [String(windowHours), tenantId ?? null],
    );

    // tenantIds is returned alongside the keys rather than assumed. The
    // reconciler is configured with a tenant identifier of its own, and if the
    // two spaces ever disagree the comparison would otherwise report every key
    // as missing — a loud, total, and completely wrong drift alarm. Returning
    // what we actually hold lets the caller say "these do not match" instead.
    const tenantIds = [...new Set(rows.map((r) => r.tenant_id))];

    res.json({
      windowHours,
      tenantIds,
      keys: rows.map((r) => r.idempotency_key),
      count: rows.length,
    });
  } catch (err) {
    logger.error(
      { err: (err as Error).message, event: 'wal_keys_query_failed' },
      'governance wal-keys query failed',
    );
    // 500 rather than an empty 200: an empty key set is a meaningful value
    // here (it means "this runtime replicated nothing in the window"), so it
    // must never be manufactured out of a failure. The reconciler treats a
    // non-200 as inconclusive and does not report drift.
    res.status(500).json({ error: 'wal_keys_query_failed' });
  }
});
