// Read-only endpoint queried by platform-backend's outbox-acknowledgment-
// reconciler (Fix B-2). Returns the processing state of a single event by
// event_id from event_processing_ledger.
//
// Auth: X-Service-Auth bearer. The token env var is TENANT_RUNTIME_SERVICE_TOKEN
// (same secret the existing /internal/agents/sync-state endpoint uses) —
// reusing it avoids a second token-rotation surface.
//
// Response shape (always 200):
//   { status: 'processed', completed_at: ISO, steps_completed: string[] }
//   { status: 'failed',    error: string, attempt_count: number }
//   { status: 'processing', attempt_count: number, first_seen_at: ISO }
//   { status: 'unknown' }    // not in ledger
//
// Why collapse 'not found' into 200 status='unknown' rather than 404: the
// caller (reconciler) reads this as actionable data, not as a presence
// indicator. 404 would force the caller to special-case Node's fetch error
// semantics. Better to make the contract uniform.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireServiceAuth } from '../security/service-auth';
import { subscriberPool } from './subscriber';
import { logger } from '../infrastructure/logging';

export const eventStatusRouter = Router();

// verifyServiceAuth() with no opts → defaults to TENANT_RUNTIME_SERVICE_TOKEN.
// `requireServiceAuth` from src/security, NOT `verifyServiceAuth` from
// @liftoffos/service-client. The package's verifier resolves the expected
// token with `process.env[tokenEnvVar]` and answers 500 when it finds
// nothing — and this runtime no longer keeps secrets in the environment
// (INV-TR-016). Every request to this router returned 500 until it moved.
// Same default semantics: shared bearer only, TENANT_RUNTIME_SERVICE_TOKEN,
// constant-time compare.
const svcAuth = requireServiceAuth();

const paramSchema = z.object({ event_id: z.string().uuid() });
const querySchema = z.object({ tenant_id: z.string().uuid() });

// event_processing_ledger PRIMARY KEY is (tenant_id, event_id) — both required
// to look up a row deterministically. The reconciler always knows the tenant
// for any outbox row it inspects, so we surface tenant_id as a query parameter
// and refuse requests that omit it. This also ensures one tenant can never
// observe another tenant's ledger row even on a UUID collision.
eventStatusRouter.get('/event-status/:event_id', svcAuth, async (req: Request, res: Response): Promise<void> => {
  const paramParsed = paramSchema.safeParse(req.params);
  if (!paramParsed.success) {
    res.status(400).json({ error: 'invalid_event_id' });
    return;
  }
  const queryParsed = querySchema.safeParse(req.query);
  if (!queryParsed.success) {
    res.status(400).json({ error: 'invalid_or_missing_tenant_id' });
    return;
  }

  try {
    const r = await subscriberPool.query<{
      status: string;
      error: string | null;
      attempt_count: number;
      first_seen_at: Date;
      completed_at: Date | null;
      steps_completed: string[] | null;
    }>(
      `SELECT status, error, attempt_count, first_seen_at, completed_at, steps_completed
         FROM event_processing_ledger
        WHERE tenant_id = $1 AND event_id = $2
        LIMIT 1`,
      [queryParsed.data.tenant_id, paramParsed.data.event_id],
    );

    const row = r.rows[0];
    if (!row) {
      res.json({ status: 'unknown' });
      return;
    }
    if (row.status === 'completed') {
      res.json({
        status: 'processed',
        completed_at: row.completed_at?.toISOString() ?? null,
        steps_completed: row.steps_completed ?? [],
      });
      return;
    }
    if (row.status === 'failed') {
      res.json({
        status: 'failed',
        error: row.error ?? 'unknown',
        attempt_count: row.attempt_count,
      });
      return;
    }
    res.json({
      status: 'processing',
      attempt_count: row.attempt_count,
      first_seen_at: row.first_seen_at.toISOString(),
    });
  } catch (err) {
    logger.error(
      { event_id: paramParsed.data.event_id, err: (err as Error).message },
      'event-status query failed',
    );
    res.status(500).json({ error: 'internal_error' });
  }
});
