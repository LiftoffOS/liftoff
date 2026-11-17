// Embed sweep for the Chief AI Officer's conversation search — the DURABLE
// delivery path for turn embeddings.
//
// The chat service also fires an embed inline after it persists a reply, but that
// is best-effort ONLY: this service runs on Cloud Run with request-based CPU, so
// work started after the response has streamed is not guaranteed to finish. The
// first run of this job IS the backfill for turns written before it existed;
// scheduled runs keep the corpus current.
//
// TWO PASSES, mirroring platform-backend's embed-sweep-chat-turns:
//   1. attributed turns with no vector yet;
//   2. drift repair — turns whose stored (provider, model) is no longer the space
//      platform-backend's client defaults to. Retrieval is space-gated, so a
//      vector from an old space is present and unreachable, which is worse than
//      absent because nothing reports it.
//
// FAILURE TAXONOMY. A named 'failed' outcome is row-level: counted, the sweep
// continues, and the keyset cursor advances PAST it so a permanently-failing row
// cannot stall the pass. A REJECTION may be a transient row-scoped fault, but a
// RUN of rejections means the database is unhealthy — three consecutive ones
// abort. Any failure exits non-zero so the Cloud Run job surfaces it.
//
// THE DRIFT PASS NEEDS THE CURRENT SPACE, and that is platform-backend's answer,
// not this service's: the embed itself runs there. It is read by embedding one
// short probe string, which is a real charged call and the reason the pass is
// skipped entirely when pass 1 found nothing to do.
//
// Run as a Cloud Run Job against the workforce-service image:
//   node dist/scripts/embed-sweep-team-plan-turns.js
// Env: CAIO_RECALL_EMBED_ENABLED=true to do anything at all (gate first),
//      EMBED_SWEEP_LIMIT to cap a run (default 500).

import { getPool, initPool } from '../infrastructure/database.js';
import { log } from '../infrastructure/logging.js';
import { embedTeamPlanTurn, requestEmbedding } from '../workforce-plans/turn-embedding.js';

const BATCH_SIZE = 100;
const MAX_CONSECUTIVE_REJECTIONS = 3;
const DEFAULT_LIMIT = 500;

interface SweepReport {
  embedded: number;
  reembedded: number;
  skippedGuest: number;
  skippedEmpty: number;
  failed: number;
}

interface SweepRow {
  id: string;
  tenant_id: string;
  created_at: string;
}

type Cursor = { at: string; id: string } | null;

function sweepLimit(): number {
  const raw = Number.parseInt(process.env.EMBED_SWEEP_LIMIT ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LIMIT;
}

async function processBatch(
  rows: SweepRow[],
  report: SweepReport,
  onEmbedded: () => void,
  state: { consecutiveRejections: number },
): Promise<void> {
  for (const row of rows) {
    try {
      const outcome = await embedTeamPlanTurn(row.tenant_id, row.id);
      state.consecutiveRejections = 0;
      if (outcome === 'embedded') onEmbedded();
      else if (outcome === 'skipped_guest') report.skippedGuest++;
      else if (outcome === 'skipped_empty') report.skippedEmpty++;
      else report.failed++; // 'failed' | 'missing'
    } catch (err) {
      report.failed++;
      state.consecutiveRejections++;
      log.error({ turnId: row.id, error: (err as Error).message }, 'embed-sweep: embed rejected');
      if (state.consecutiveRejections >= MAX_CONSECUTIVE_REJECTIONS) {
        throw new Error(
          `systemic: ${state.consecutiveRejections} consecutive embed rejections — aborting sweep`,
        );
      }
    }
  }
}

/** The cross-tenant enumeration. The owner (workforce_migrate) is exempt from the
 *  un-FORCEd policy on team_plan_turns, which is what lets one job serve every
 *  tenant; every per-turn read and write inside embedTeamPlanTurn still runs under
 *  withTenantContext. Migration 031 states the dependency on that exemption. */
async function claimBatch(sql: string, params: unknown[]): Promise<SweepRow[]> {
  const result = await getPool().query(sql, params);
  return result.rows as SweepRow[];
}

export async function sweep(): Promise<SweepReport> {
  const report: SweepReport = { embedded: 0, reembedded: 0, skippedGuest: 0, skippedEmpty: 0, failed: 0 };
  const state = { consecutiveRejections: 0 };
  const limit = sweepLimit();
  let seen = 0;

  // Pass 1: never-embedded attributed turns.
  let cursor: Cursor = null;
  while (seen < limit) {
    const rows = await claimBatch(
      `SELECT id, tenant_id, created_at FROM team_plan_turns
        WHERE account_id IS NOT NULL
          AND content_embedding IS NULL
          AND ($1::timestamptz IS NULL OR (created_at, id) > ($1, $2::uuid))
        ORDER BY created_at ASC, id ASC
        LIMIT ${BATCH_SIZE}`,
      [cursor?.at ?? null, cursor?.id ?? null],
    );
    if (rows.length === 0) break;
    await processBatch(rows, report, () => report.embedded++, state);
    seen += rows.length;
    const last = rows[rows.length - 1];
    cursor = { at: last.created_at, id: last.id };
  }

  // Pass 2: drift. The space is platform-backend's, read with one probe embed —
  // so the pass is skipped when there is nothing stored that could have drifted.
  const anyStored = await getPool().query(
    `SELECT 1 FROM team_plan_turns WHERE content_embedding IS NOT NULL LIMIT 1`,
  );
  if (anyStored.rows.length === 0) return report;

  const space = await requestEmbedding('00000000-0000-0000-0000-000000000000', 'space probe', 'retrieval_query', 'caio_recall_query');
  if (!space) {
    log.warn({}, 'embed-sweep: the current embedding space could not be read — drift pass skipped');
    return report;
  }

  cursor = null;
  while (seen < limit) {
    const rows = await claimBatch(
      `SELECT id, tenant_id, created_at FROM team_plan_turns
        WHERE content_embedding IS NOT NULL
          AND (content_embedding_provider, content_embedding_model)
              IS DISTINCT FROM ($3, $4)
          AND ($1::timestamptz IS NULL OR (created_at, id) > ($1, $2::uuid))
        ORDER BY created_at ASC, id ASC
        LIMIT ${BATCH_SIZE}`,
      [cursor?.at ?? null, cursor?.id ?? null, space.provider, space.model],
    );
    if (rows.length === 0) break;
    await processBatch(rows, report, () => report.reembedded++, state);
    seen += rows.length;
    const last = rows[rows.length - 1];
    cursor = { at: last.created_at, id: last.id };
  }

  return report;
}

/** Exported for tests (the gate and the exit-code contract). */
export async function main(): Promise<void> {
  // GATE FIRST: a disabled run is a genuine no-op that never touches the database.
  if (process.env.CAIO_RECALL_EMBED_ENABLED !== 'true') {
    console.log(JSON.stringify({ embedSweepReport: 'CAIO_RECALL_EMBED_ENABLED != true — no-op' }));
    process.exit(0);
  }
  await initPool();
  let report: SweepReport | null = null;
  try {
    report = await sweep();
  } catch (err) {
    log.error(
      { event: 'caio_embed_sweep_systemic_failure', error: (err as Error).message },
      'embed-sweep: systemic failure — aborting',
    );
  }
  if (report === null) {
    process.exit(1);
  }
  console.log(JSON.stringify({ embedSweepReport: report }, null, 2));
  process.exit(report.failed > 0 ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('embed-sweep-team-plan-turns.js')) {
  void main();
}
