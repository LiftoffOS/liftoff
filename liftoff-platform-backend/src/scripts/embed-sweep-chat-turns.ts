// Embed sweep for semantic conversation recall — the DURABLE delivery path for
// turn-content embeddings (the inline chat-service embed is best-effort only
// under Cloud Run request-based CPU throttling).
//
// EVERY SURFACE THAT HAS TURNS, in one job: agent chat (agent_chat_turns) and,
// since migration 547, Liftoff and the Insights Manager. One job rather than
// three because the two passes, the failure taxonomy, the keyset cursor and the
// exit-code contract are the same for all of them, and a second copy is how one
// surface quietly stops being swept.
//
// Duties:
//   Pass 1 — embed attributed turns that have no vector yet. The first
//     manual execution of this job IS the historical backfill; hourly
//     scheduled runs keep the corpus current.
//   Pass 2 — drift repair: re-embed turns whose stored
//     (content_embedding_provider, content_embedding_model) differ from the
//     client's current default embedding space, so retrieval (which is
//     space-gated) never strands old vectors after a provider/model change.
//
// Failure taxonomy: a 'failed' OUTCOME from embedTurn (provider error,
// lost UPDATE race) is row-level — counted, sweep continues, cursor
// advances past it (keyset pagination; no infinite loop, no false
// success). A REJECTION (embedTurn's tenant-scoped DB work threw) may be a
// transient row-scoped fault — counted — but a RUN of rejections means the
// DB itself is unhealthy: 3 consecutive rejections escalate as systemic
// and abort. A throw from the batch-enumeration query itself is systemic
// by definition and aborts immediately. Systemic aborts and any
// report.failed > 0 exit NON-ZERO so the Cloud Run job surfaces failure;
// the scheduler retries next tick.
//
// Ops: docs/runbooks/embed-sweep-chat-turns.md (activation order,
// report fields, pause/resume).

import { initSecrets } from '../infrastructure/secrets';
import { closePools, initDatabase, withAdminScope } from '../infrastructure/database';
import { initEmbeddingClient } from '../embedding/init';
import { log } from '../infrastructure/logging';
import { embedTurn, type EmbedTurnOutcome } from '../agent-chat/turn-embedding-service';
import { embedPlatformTurn } from '../chat-recall/turn-embedding';
import { embeddingClient } from '@liftoffos/embedding';

const BATCH_SIZE = 100;
const MAX_CONSECUTIVE_REJECTIONS = 3;

/** One turns table and the embedder that knows how to read its messages and
 *  attribute its cost. Table names are literals here and never come from input.
 *
 *  Team chat keeps its own embedder because its attribution names the responding
 *  agent; the two platform assistants have no such row and are attributed by
 *  purpose. Everything else about a sweep is identical, which is why they share
 *  this job. */
interface SweepTarget {
  label: string;
  table: string;
  embed: (tenantId: string, turnId: string) => Promise<EmbedTurnOutcome>;
}

const TARGETS: readonly SweepTarget[] = [
  { label: 'team', table: 'agent_chat_turns', embed: embedTurn },
  { label: 'liftoff', table: 'liftoff_chat_turns', embed: (t, id) => embedPlatformTurn('liftoff', t, id) },
  { label: 'insights', table: 'insights_chat_turns', embed: (t, id) => embedPlatformTurn('insights', t, id) },
];

interface SweepReport {
  embedded: number;
  reembedded: number;   // drift repairs
  skippedGuest: number; // defensive; WHERE already excludes them
  skippedEmpty: number;
  failed: number;       // includes 'missing'
}

interface SweepRow {
  id: string;
  tenant_id: string;
  created_at: string;
}

type Cursor = { at: string; id: string } | null;

/** Runs embedTurn over one batch with the row-level/systemic failure
 *  taxonomy. `onEmbedded` lets the caller count into the right bucket
 *  (embedded vs reembedded). */
async function processBatch(
  target: SweepTarget,
  rows: SweepRow[],
  report: SweepReport,
  onEmbedded: () => void,
  state: { consecutiveRejections: number },
): Promise<void> {
  for (const row of rows) {
    try {
      const outcome = await target.embed(row.tenant_id, row.id);
      state.consecutiveRejections = 0;
      if (outcome === 'embedded') onEmbedded();
      else if (outcome === 'skipped_guest') report.skippedGuest++;
      else if (outcome === 'skipped_empty') report.skippedEmpty++;
      else report.failed++; // 'failed' | 'missing'
    } catch (err) {
      // Row-level accounting, systemic detection: one rejection may be a
      // transient row-scoped fault (count it, keep sweeping); a RUN of
      // rejections means the DB itself is unhealthy — continuing would
      // burn the whole batch against a down pool.
      report.failed++;
      state.consecutiveRejections++;
      log.error({ surface: target.label, turnId: row.id, err: (err as Error).message }, 'embed-sweep: embedTurn rejected');
      if (state.consecutiveRejections >= MAX_CONSECUTIVE_REJECTIONS) {
        throw new Error(`systemic: ${state.consecutiveRejections} consecutive embedTurn rejections — aborting sweep`);
      }
    }
  }
}

/** Pass 1 for one surface: attributed turns with no vector yet. The keyset
 *  cursor advances PAST a failure, so a permanently-failing row cannot stall the
 *  sweep. */
async function sweepUnembedded(
  target: SweepTarget,
  report: SweepReport,
  state: { consecutiveRejections: number },
): Promise<void> {
  let cursor: Cursor = null;
  for (;;) {
    const batch = await withAdminScope(
      {
        caller: 'embed-sweep-chat-turns',
        reason: `cross-tenant enumeration of un-embedded attributed ${target.label} turns; per-turn writes run under withTenantScope inside the embedder`,
      },
      (client) => client.query<SweepRow>(
        `SELECT id, tenant_id, created_at FROM ${target.table}
          WHERE sender_account_id IS NOT NULL
            AND content_embedding IS NULL
            AND ($1::timestamptz IS NULL OR (created_at, id) > ($1, $2::uuid))
          ORDER BY created_at ASC, id ASC
          LIMIT ${BATCH_SIZE}`,
        [cursor?.at ?? null, cursor?.id ?? null],
      ),
    );
    if (batch.rows.length === 0) return;
    await processBatch(target, batch.rows, report, () => report.embedded++, state);
    const last = batch.rows[batch.rows.length - 1];
    cursor = { at: last.created_at, id: last.id };
  }
}

/** Pass 2 for one surface: vectors written in a space the client no longer
 *  defaults to. Retrieval is space-gated, so without this an old vector is
 *  stranded — present, and unreachable. */
async function sweepDrifted(
  target: SweepTarget,
  space: { provider: string; model: string },
  report: SweepReport,
  state: { consecutiveRejections: number },
): Promise<void> {
  let cursor: Cursor = null;
  for (;;) {
    const batch = await withAdminScope(
      {
        caller: 'embed-sweep-chat-turns',
        reason: `cross-tenant enumeration of provider/model-drifted ${target.label} turn embeddings; per-turn writes run under withTenantScope inside the embedder`,
      },
      (client) => client.query<SweepRow>(
        `SELECT id, tenant_id, created_at FROM ${target.table}
          WHERE content_embedding IS NOT NULL
            AND (content_embedding_provider, content_embedding_model)
                IS DISTINCT FROM ($3, $4)
            AND ($1::timestamptz IS NULL OR (created_at, id) > ($1, $2::uuid))
          ORDER BY created_at ASC, id ASC
          LIMIT ${BATCH_SIZE}`,
        [cursor?.at ?? null, cursor?.id ?? null, space.provider, space.model],
      ),
    );
    if (batch.rows.length === 0) return;
    await processBatch(target, batch.rows, report, () => report.reembedded++, state);
    const last = batch.rows[batch.rows.length - 1];
    cursor = { at: last.created_at, id: last.id };
  }
}

export async function sweep(): Promise<SweepReport> {
  const report: SweepReport = { embedded: 0, reembedded: 0, skippedGuest: 0, skippedEmpty: 0, failed: 0 };
  const state = { consecutiveRejections: 0 };

  // Resolved once: the current space is a property of the client, not of a
  // surface. Absent, the drift pass is skipped for every surface — never the
  // whole sweep, because pass 1 does not need it.
  const space = embeddingClient.getDefaultEmbeddingSpace();
  if (!space) {
    log.warn({}, 'embed-sweep: no default embedding space resolved — drift pass skipped for every surface');
  }

  for (const target of TARGETS) {
    await sweepUnembedded(target, report, state);
    if (space) await sweepDrifted(target, space, report, state);
  }

  return report;
}

/** Exported for tests (exit-code + gate contract). */
export async function main(): Promise<void> {
  // GATE FIRST: a disabled run must be a genuine no-op that never touches
  // Secret Manager or the DB.
  if (process.env.RECALL_EMBED_WRITE_ENABLED !== 'true') {
    console.log(JSON.stringify({ embedSweepReport: 'RECALL_EMBED_WRITE_ENABLED != true — no-op' }));
    process.exit(0);
  }
  await initSecrets();
  await initDatabase();
  await initEmbeddingClient();
  let report: SweepReport | null = null;
  try {
    report = await sweep();
  } catch (err) {
    log.error(
      { event: 'embed_sweep_systemic_failure', error: (err as Error).message },
      'embed-sweep: systemic failure — aborting',
    );
  } finally {
    // Success AND failure: never leave pool handles keeping the job alive.
    await closePools().catch(() => undefined);
  }
  if (report === null) {
    process.exit(1);
  }
  console.log(JSON.stringify({ embedSweepReport: report }, null, 2));
  process.exit(report.failed > 0 ? 1 : 0);
}

if (require.main === module) {
  void main();
}
