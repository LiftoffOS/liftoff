// Builds the census of what exists in each connected system.
//
// METADATA ONLY. Enumeration is paginated — listing 10,000 entities costs on
// the order of 100 vendor calls — while hydrating their bodies costs 10,000.
// Two orders of magnitude out of one shared budget, so this fetches names,
// paths and versions and never a body. A helper that "just also grabs the
// content while it is there" turns an affordable job into an unaffordable one.
//
// FOUR PROPERTIES THAT MUST NOT BE WEAKENED:
//
//  1. The checkpoint advances only after its batch is fully reconciled.
//     Advancing first would skip whatever a failed batch contained, and the
//     gap would be invisible: the census would simply report fewer things than
//     exist, which is indistinguishable from a small workspace.
//  2. Only a COMPLETE pass may treat an omitted entity as deleted. An
//     incremental pass returns a window, and everything outside that window is
//     absent from it by construction. Marking those deleted would empty the
//     census one page at a time.
//  3. A vendor rate-limit response PARKS the job (next_run_at = now +
//     Retry-After + jitter) rather than sleeping a worker. A sleeping worker
//     holds a connection and a slot to accomplish nothing.
//  4. Jobs are claimed with FOR UPDATE SKIP LOCKED, so two workers never
//     enumerate the same scope into the same rows.

import type { PoolClient } from 'pg';
import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

/** One entity as the vendor described it. Metadata only — there is no body
 *  field, and that is the point. */
export interface EnumeratedEntity {
  remoteId: string;
  entityType: string;
  title?: string | null;
  projectedPath: string;
  parentRemoteId?: string | null;
  remoteVersion?: string | null;
}

/** One page of enumeration.
 *
 *  `kind` is the honesty flag. 'complete' asserts the series covers the whole
 *  scope, so an entity missing from it is genuinely gone. 'incremental'
 *  asserts nothing of the sort. */
export interface EnumerationBatch {
  entities: EnumeratedEntity[];
  cursor: string | null;
  kind: 'complete' | 'incremental';
}

/** A vendor's "slow down". Thrown by a source to park the job rather than
 *  burn its remaining budget on retries. */
export class EnumerationRateLimited extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`enumeration_rate_limited: retry after ${retryAfterMs}ms`);
    this.name = 'EnumerationRateLimited';
  }
}

/** Fetches one page from a connector. Supplied by the caller so this module
 *  holds no vendor knowledge and stays testable without a network. */
export type EnumerationSource = (args: {
  tenantId: string;
  connectorId: string;
  connectorType: string;
  scope: string;
  cursor: string | null;
}) => Promise<EnumerationBatch>;

export interface EnumerationJob {
  id: string;
  tenantId: string;
  connectorId: string;
  connectorType: string;
  scope: string;
  cursor: string | null;
}

export interface EnumerationOutcome {
  jobId: string;
  entitiesUpserted: number;
  entitiesMarkedDeleted: number;
  batchKind: 'complete' | 'incremental';
  cursorAdvancedTo: string | null;
  /** Set when the job was parked instead of progressing. */
  parkedForMs?: number;
  error?: string;
}

/** Bound on one worker tick. Enumeration is cheap per call but not free, and an
 *  unbounded tick would spend a tenant's whole per-minute allowance in one go. */
const MAX_PAGES_PER_TICK = 20;

/** Spread retries so every parked job in the fleet does not wake together and
 *  reproduce the burst that got them parked. */
function jitterMs(): number {
  return Math.floor(Math.random() * 30_000);
}

/** Claim due enumeration jobs for this tenant.
 *
 *  SKIP LOCKED so concurrent workers take disjoint sets rather than blocking on
 *  each other or, worse, both enumerating one scope into the same rows.
 */
export async function claimDueJobs(tenantId: string, limit = 5): Promise<EnumerationJob[]> {
  return withTenantScope(tenantId, async (client: PoolClient) => {
    const { rows } = await client.query(
      `UPDATE connector_enumeration_state
          SET next_run_at = NOW() + interval '15 minutes', updated_at = NOW()
        WHERE id IN (
          SELECT id FROM connector_enumeration_state
           WHERE tenant_id = $1 AND next_run_at <= NOW()
           ORDER BY next_run_at ASC
           LIMIT $2 FOR UPDATE SKIP LOCKED
        )
        RETURNING id, tenant_id, connector_id, connector_type, scope, cursor`,
      [tenantId, limit],
    );
    return rows.map((r) => ({
      id: r.id as string,
      tenantId: r.tenant_id as string,
      connectorId: r.connector_id as string,
      connectorType: r.connector_type as string,
      scope: r.scope as string,
      cursor: (r.cursor as string | null) ?? null,
    }));
  });
}

/** Write one page of entities. Upsert on (tenant, connector, remote_id) so a
 *  re-run of the same page is idempotent and a re-appearing entity is
 *  un-deleted rather than duplicated. */
async function upsertEntities(
  client: PoolClient,
  job: EnumerationJob,
  entities: EnumeratedEntity[],
): Promise<number> {
  let written = 0;
  for (const e of entities) {
    await client.query(
      `INSERT INTO connector_entities
         (tenant_id, connector_id, connector_type, remote_id, entity_type, title,
          projected_path, parent_remote_id, remote_version, last_touched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (tenant_id, connector_id, remote_id) DO UPDATE SET
         entity_type      = EXCLUDED.entity_type,
         title            = EXCLUDED.title,
         projected_path   = EXCLUDED.projected_path,
         parent_remote_id = EXCLUDED.parent_remote_id,
         remote_version   = EXCLUDED.remote_version,
         last_touched_at  = NOW(),
         updated_at       = NOW(),
         deleted          = FALSE`,
      [
        job.tenantId, job.connectorId, job.connectorType,
        e.remoteId, e.entityType, e.title ?? null,
        e.projectedPath, e.parentRemoteId ?? null, e.remoteVersion ?? null,
      ],
    );
    written++;
  }
  return written;
}

/**
 * Run one job to the end of its pages (or the per-tick page bound).
 *
 * Returns rather than throws on a vendor rate limit: parking is a normal
 * outcome, not a failure.
 */
export async function runEnumerationJob(args: {
  job: EnumerationJob;
  source: EnumerationSource;
  maxPages?: number;
}): Promise<EnumerationOutcome> {
  const { job, source } = args;
  const maxPages = args.maxPages ?? MAX_PAGES_PER_TICK;

  let cursor = job.cursor;
  let upserted = 0;
  let pages = 0;
  let lastKind: 'complete' | 'incremental' = 'incremental';
  // Every remote id this pass saw, and the entity types it covered. Only
  // meaningful for a complete pass, which is the only kind allowed to conclude
  // anything from an absence.
  const seen: string[] = [];
  const seenTypes = new Set<string>();

  try {
    while (pages < maxPages) {
      const batch = await source({
        tenantId: job.tenantId,
        connectorId: job.connectorId,
        connectorType: job.connectorType,
        scope: job.scope,
        cursor,
      });
      pages++;
      lastKind = batch.kind;

      // Reconcile the page and advance the cursor in ONE transaction. Split
      // apart, a crash between them either loses the page or skips it, and the
      // skip is silent.
      await withTenantScope(job.tenantId, async (client: PoolClient) => {
        upserted += await upsertEntities(client, job, batch.entities);
        await client.query(
          `UPDATE connector_enumeration_state
              SET cursor = $2, last_batch_kind = $3, consecutive_failures = 0,
                  last_error = NULL, updated_at = NOW()
            WHERE id = $1`,
          [job.id, batch.cursor, batch.kind],
        );
      });

      for (const e of batch.entities) {
        seen.push(e.remoteId);
        seenTypes.add(e.entityType);
      }
      cursor = batch.cursor;
      if (!cursor) break;
    }
  } catch (err) {
    if (err instanceof EnumerationRateLimited) {
      const parkMs = err.retryAfterMs + jitterMs();
      await withTenantScope(job.tenantId, (client) =>
        client.query(
          `UPDATE connector_enumeration_state
              SET next_run_at = NOW() + ($2 || ' milliseconds')::interval, updated_at = NOW()
            WHERE id = $1`,
          [job.id, String(parkMs)],
        ),
      );
      logger.info(
        { tenantId: job.tenantId, connectorType: job.connectorType, scope: job.scope, parkMs },
        'enumeration_job_parked_rate_limited',
      );
      return {
        jobId: job.id,
        entitiesUpserted: upserted,
        entitiesMarkedDeleted: 0,
        batchKind: lastKind,
        cursorAdvancedTo: cursor,
        parkedForMs: parkMs,
      };
    }

    const message = (err as Error).message;
    await withTenantScope(job.tenantId, (client) =>
      client.query(
        `UPDATE connector_enumeration_state
            SET consecutive_failures = consecutive_failures + 1,
                last_error = $2,
                next_run_at = NOW() + (LEAST(POWER(2, consecutive_failures + 1), 240) || ' minutes')::interval,
                updated_at = NOW()
          WHERE id = $1`,
        [job.id, message.slice(0, 500)],
      ),
    );
    logger.warn(
      { tenantId: job.tenantId, connectorType: job.connectorType, scope: job.scope, err: message },
      'enumeration_job_failed',
    );
    return {
      jobId: job.id,
      entitiesUpserted: upserted,
      entitiesMarkedDeleted: 0,
      batchKind: lastKind,
      cursorAdvancedTo: cursor,
      error: message,
    };
  }

  // Deletion detection. ONLY on a complete pass that reached the end of its
  // pages: an incremental pass, or a complete one truncated by the page bound,
  // has seen a window, and everything outside that window is absent by
  // construction rather than by disappearance.
  let markedDeleted = 0;
  const exhaustive = lastKind === 'complete' && cursor === null;
  if (exhaustive && seenTypes.size > 0) {
    // Bounded to the entity types this pass actually enumerated, so a job
    // covering channels can never mark a workspace's files deleted.
    markedDeleted = await withTenantScope(job.tenantId, async (client: PoolClient) => {
      const { rowCount } = await client.query(
        `UPDATE connector_entities
            SET deleted = TRUE, updated_at = NOW()
          WHERE tenant_id = $1 AND connector_id = $2
            AND entity_type = ANY($4)
            AND NOT deleted
            AND NOT (remote_id = ANY($3))`,
        [job.tenantId, job.connectorId, seen, [...seenTypes]],
      );
      return rowCount ?? 0;
    });
  }

  await withTenantScope(job.tenantId, (client) =>
    client.query(
      `UPDATE connector_enumeration_state
          SET last_completed_at = CASE WHEN $2 THEN NOW() ELSE last_completed_at END,
              next_run_at = NOW() + interval '6 hours',
              updated_at = NOW()
        WHERE id = $1`,
      [job.id, exhaustive],
    ),
  );

  return {
    jobId: job.id,
    entitiesUpserted: upserted,
    entitiesMarkedDeleted: markedDeleted,
    batchKind: lastKind,
    cursorAdvancedTo: cursor,
  };
}
