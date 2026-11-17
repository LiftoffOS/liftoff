// Cloud Run Job entrypoint. Sweeps every registered source until done,
// then exits 0. Idempotent: re-running on a no-work DB exits in <1s
// (each source's first pass returns done=true).
//
// Triggered by:
//   1. cloudbuild.yaml — post-migration step on every deploy
//   2. provider-switch endpoint (PR-4) — after ALTER+NULL
//   3. optional Cloud Scheduler safety-net (weekly, no-op on idle)
//
// Each pass processes EMBED_BACKFILL_BATCH rows (default 32). RPS gate
// (EMBED_BACKFILL_MAX_RPS, default 5) bounds vendor pressure. Hard cap
// of MAX_PASSES (10000) protects against an embedding API that returns
// success on a zero-vector or similar degenerate loop.

import { sweepOnePass, DEFAULT_SOURCES } from './sweeper';
import { log } from '../../infrastructure/logging';
import { pool } from '../../infrastructure/database';

const BATCH = parseInt(process.env.EMBED_BACKFILL_BATCH ?? '32', 10);
const MAX_RPS = parseFloat(process.env.EMBED_BACKFILL_MAX_RPS ?? '5');
const MAX_PASSES = parseInt(process.env.EMBED_BACKFILL_MAX_PASSES ?? '10000', 10);
const TENANT_FILTER = process.env.MEM_BACKFILL_TENANT_ID;

interface Totals { attempted: number; succeeded: number; failed: number; }

/** Tenants to sweep for a FORCE-RLS source. Read from `tenants`, which has no
 *  policy of its own. */
async function listTenantIds(): Promise<string[]> {
  const res = await pool.query<{ id: string }>('SELECT id FROM tenants ORDER BY id');
  return res.rows.map(r => r.id);
}

async function main(): Promise<void> {
  const start = Date.now();
  log.info(
    { batch: BATCH, maxRps: MAX_RPS, tenantFilter: TENANT_FILTER ?? '(all)' },
    'embedding-backfill: starting',
  );

  for (const src of DEFAULT_SOURCES) {
    // A FORCE-RLS source is swept one tenant at a time — its policy raises off
    // a scope, so there is no fleet-wide pass. Tenants come from `tenants`,
    // which carries no policy, because enumerating them from the scoped table
    // itself is the circularity RLS exists to prevent.
    const tenantIds: Array<string | undefined> = src.tenantScoped
      ? (TENANT_FILTER ? [TENANT_FILTER] : await listTenantIds())
      : [TENANT_FILTER];

    if (src.tenantScoped && tenantIds.length === 0) {
      log.info({ source: src.name }, 'embedding-backfill: no tenants to sweep');
      continue;
    }

    for (const tenantId of tenantIds) {
    const totals: Totals = { attempted: 0, succeeded: 0, failed: 0 };

    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      const result = await sweepOnePass(src, {
        batchSize: BATCH,
        tenantIdFilter: tenantId,
      });

      totals.attempted += result.attempted;
      totals.succeeded += result.succeeded;
      totals.failed    += result.failed;

      log.info(
        { source: src.name, pass, ...result, totals },
        'embedding-backfill: pass complete',
      );

      // Adapted from src/scripts/backfill-skill-embeddings.ts:48 — if
      // every row in a non-empty pass failed, something is structurally
      // wrong (auth, quota, dim, provider outage). Abort rather than
      // silently mask. The Cloud Run Job will exit non-zero and the
      // operator gets paged.
      if (result.attempted > 0 && result.succeeded === 0) {
        log.error(
          { source: src.name, pass, ...result },
          'embedding-backfill: every row in pass failed; aborting',
        );
        process.exit(1);
      }

      if (result.done) {
        log.info(
          { source: src.name, totals, passes: pass },
          'embedding-backfill: source complete',
        );
        break;
      }

      // RPS gate between passes. MAX_RPS = passes-per-second budget.
      await new Promise(resolve => setTimeout(resolve, 1000 / MAX_RPS));
    }
    }
  }

  log.info({ durationMs: Date.now() - start }, 'embedding-backfill: all sources complete');
  process.exit(0);
}

if (require.main === module) {
  main().catch(err => {
    log.error({ err: (err as Error).message, stack: (err as Error).stack },
              'embedding-backfill: fatal');
    process.exit(1);
  });
}
