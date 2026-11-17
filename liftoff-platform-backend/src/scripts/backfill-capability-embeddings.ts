// Backfill internal_agents.capability_embedding_v2.
//
// Why this exists:
//   The embedding writer selected a `capabilities` column that has never
//   existed on `internal_agents`, so the SELECT threw on every call and no
//   embedding was ever stored. The caller is deliberately fire-and-forget, so
//   the failure logged once per call and degraded a search nobody could tell was
//   degraded: `find_teammates` fell back to ILIKE every time, for every tenant,
//   for the whole life of the feature.
//
//   Fixing the reader only helps an agent the next time something happens to
//   re-embed it — create, update, or a skill-feedback write. Existing agents
//   would keep their NULL embedding until somebody edited them, which for a
//   stable team is never. So the fix ships with this sweep.
//
// Run as a Cloud Run Job using the platform-backend image at a SHA that
// contains this script:
//   --command=node --args="dist/scripts/backfill-capability-embeddings.js"
//
// Idempotent: only agents with a NULL embedding are touched. Set FORCE=true to
// re-embed every agent (use after a change to the embedding text itself, which
// is the one case where existing vectors are stale rather than missing).
// Pass DRY_RUN=true to report what would be embedded without spending on it.
//
// Cost note: one embedding call per agent. This is metered through
// embeddingClient like any other embed, so the spend lands on the normal
// attribution path rather than appearing from nowhere.

import { closePools, initDatabase, withAdminScope } from '../infrastructure/database';
import { initEmbeddingClient } from '../embedding/init';
import { log } from '../infrastructure/logging';
import { generateAndStoreEmbedding } from '../internal-agents/embedding-service';

const DRY_RUN = process.env.DRY_RUN === 'true';
const FORCE = process.env.FORCE === 'true';

interface AgentRow {
  id: string;
  tenant_id: string;
  role: string;
}

/** How many agents currently hold a vector. The only honest measure of what
 *  this script did: `generateAndStoreEmbedding` swallows provider errors by
 *  design, so counting calls that did not throw counts attempts, not stored
 *  embeddings, so a run that stored none could still report most agents
 *  embedded. */
async function countEmbedded(): Promise<number> {
  return withAdminScope(
    { caller: 'backfill-capability-embeddings', reason: 'count stored capability embeddings' },
    async (client) => {
      const r = await client.query<{ n: string }>(
        `SELECT count(capability_embedding_v2) AS n FROM internal_agents WHERE deleted_at IS NULL`,
      );
      return Number(r.rows[0].n);
    },
  );
}

async function main(): Promise<void> {
  // Required before any withTenantScope call. withAdminScope lazily builds its
  // own admin pool, so the enumeration below would work without this and every
  // per-agent write would then fail with "Database not initialized" — a sweep
  // that reports the right work set and does none of it.
  await initDatabase();
  // Same story one layer up: without this the embed call itself throws
  // "EmbeddingClient not initialized", which generateAndStoreEmbedding catches
  // and logs, leaving a sweep that looks like it worked. index.ts does this at
  // boot; a job process has no boot.
  await initEmbeddingClient();

  // Read-only cross-tenant enumeration; every write below runs under
  // withTenantScope inside generateAndStoreEmbedding.
  //
  // Tenant-less rows are excluded. The two platform system agents carry an
  // empty tenant_id, which is not a uuid, so every scoped write for them fails
  // on cast. They are also not reachable through find_teammates, which is
  // tenant-scoped, so an embedding for them would have no reader.
  const rows = await withAdminScope(
    { caller: 'backfill-capability-embeddings', reason: 'cross-tenant sweep of un-embedded agents' },
    async (client) => {
      const result = await client.query<AgentRow>(
        `SELECT id, tenant_id, role
           FROM internal_agents
          WHERE deleted_at IS NULL
            AND tenant_id IS NOT NULL
            AND tenant_id::text <> ''
            ${FORCE ? '' : 'AND capability_embedding_v2 IS NULL'}
          ORDER BY tenant_id, created_at`,
      );
      return result.rows;
    },
  );

  log.info({ agents: rows.length, dryRun: DRY_RUN, force: FORCE }, 'capability embedding backfill: starting');

  if (DRY_RUN) {
    for (const row of rows) {
      log.info({ agentId: row.id, tenantId: row.tenant_id, role: row.role }, 'capability embedding backfill: would embed');
    }
    log.info({ agents: rows.length }, 'capability embedding backfill: dry run complete');
    return;
  }

  const before = await countEmbedded();
  let threw = 0;

  // Sequential on purpose. This is a one-shot operator sweep with no deadline,
  // and the embedding provider is a shared, rate-limited dependency that live
  // traffic is also using.
  for (const row of rows) {
    try {
      await generateAndStoreEmbedding(row.id, row.tenant_id);
    } catch (err) {
      // generateAndStoreEmbedding swallows provider errors itself, so reaching
      // here means something structural. Counted, not fatal: one bad agent must
      // not end the sweep.
      threw += 1;
      log.error(
        { agentId: row.id, tenantId: row.tenant_id, err: (err as Error).message },
        'capability embedding backfill: agent failed',
      );
    }
  }

  // Measured, not tallied. The tally cannot see a swallowed provider error and
  // will happily report five embedded on a run that stored nothing.
  const after = await countEmbedded();
  const stored = after - before;

  log.info(
    { attempted: rows.length, stored, before, after, threw },
    'capability embedding backfill: complete',
  );

  // A sweep with work to do that stored nothing is a failure, whatever the
  // per-agent calls reported. Exiting 0 on that is how the original bug stayed
  // invisible for the life of the feature.
  if (rows.length > 0 && stored === 0) {
    throw new Error(
      `capability embedding backfill stored nothing: attempted ${rows.length}, embedded count still ${after}`,
    );
  }
  if (stored < rows.length) {
    // Partial success is a result too, and worth saying out loud rather than
    // leaving to whoever compares two numbers in the log.
    log.warn(
      { attempted: rows.length, stored, shortfall: rows.length - stored },
      'capability embedding backfill: some agents were not embedded',
    );
  }
}

main()
  .then(async () => {
    await closePools();
    process.exit(0);
  })
  .catch((err) => {
    log.error({ err: (err as Error).message }, 'capability embedding backfill: fatal');
    process.exit(1);
  });
