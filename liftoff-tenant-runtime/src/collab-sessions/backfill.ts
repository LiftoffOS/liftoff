// One-time backfill of collab-session rows for historical invocations.
//
// Runs IN tenant-runtime (the control-project diagnostics job cannot reach the
// tenant DB) and is driven page-by-page by POST /collab-backfill. The window is
// on COMPLETION time and closed in the past (untilIso <= now-24h), so a run that
// completes later cannot slip in or out between page retries — keyset pagination
// over (completed_at, id) is therefore stable and retry-idempotent. The runId is
// derived from the window, so reusing a runId with different bounds is
// impossible. HITL counts come from the local hitl_approval_requests table,
// correlated by invocation_id (migration 312).
//
// This is the SECOND producer of collab-session rows. On OUTCOME it now agrees
// with the live one in `emit.ts`: the row carries what the invocation actually
// recorded, including 'gated', and it never invents one for a run that has not
// settled — such a row is skipped. `terminal_state` is NULL here because this
// producer reads `invocations`, which stores the four-value projection and not
// the state behind it.
//
// The two producers still disagree on POPULATION: this one filters to top-level
// runs (`parent_invocation_id IS NULL`) while the live path emits for delegated
// children too. That is a known, open question — whether a delegated child is a
// session at all — and it is deliberately NOT settled here.

import * as crypto from 'crypto';
import { Storage } from '@google-cloud/storage';
import { getPoolForService } from '../infrastructure/database';
import { invocationsService } from '../invocations/service';
import { logger } from '../infrastructure/logging';
import type { CanonicalTrajectory } from '../trajectories/types';
import {
  messageFeatures,
  sinkKeyGuard,
  COLLAB_SESSION_SCHEMA_VERSION,
  type CollabSessionRow,
} from './emit';
import { sinkCollabSessions } from './sink';

const pool = getPoolForService('default');

const MAX_PAGE_SIZE = 500;
const MIN_UNTIL_LAG_MS = 24 * 60 * 60 * 1000;

export interface BackfillCursor {
  completedAt: string;
  id: string;
}

export interface BackfillPageResult {
  ok: true;
  runId: string;
  emitted: number;
  nextCursor: BackfillCursor | null;
}

function deriveRunId(tenantId: string, sinceIso: string, untilIso: string): string {
  const h = crypto.createHash('sha1').update(`${tenantId}|${sinceIso}|${untilIso}`).digest('hex').slice(0, 8);
  return `bf-${h}`;
}

/** The correlation cutoff (migration 312 rollout timestamp). An invocation that
 *  completed at/before this and has no correlated HITL rows is unattributable
 *  (null counts); after it, zero correlated rows means a real zero. */
function correlationSinceMs(): number {
  const raw = process.env.COLLAB_HITL_CORRELATION_SINCE;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

interface InvRow { id: string; completed_at: string }

async function loadTrajectoryFeatures(gcsPath: string | null): Promise<ReturnType<typeof messageFeatures> | null> {
  if (!gcsPath) return null;
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(gcsPath);
  if (!m) return null;
  try {
    const [buf] = await new Storage().bucket(m[1]).file(m[2]).download();
    const line = buf.toString('utf8').split('\n').find((l) => l.trim().length > 0);
    if (!line) return null;
    const traj = JSON.parse(line) as CanonicalTrajectory;
    if (!Array.isArray(traj.messages)) return null;
    return messageFeatures(traj);
  } catch (err) {
    // 403 for a non-eval tenant (read grant is eval-tenant-only) → null features.
    logger.debug({ gcsPath, err: (err as Error).message }, 'backfill: trajectory read failed; null features');
    return null;
  }
}

interface HitlCounts { requests: number; approved: number; rejected: number }

async function hitlCountsFor(tenantId: string, invocationIds: string[]): Promise<Map<string, HitlCounts>> {
  const out = new Map<string, HitlCounts>();
  if (invocationIds.length === 0) return out;
  const res = await pool.query(
    `SELECT invocation_id,
            COUNT(*)::int AS n_requests,
            COUNT(*) FILTER (WHERE decision = 'approved')::int AS n_approved,
            COUNT(*) FILTER (WHERE decision = 'rejected')::int AS n_rejected
       FROM hitl_approval_requests
      WHERE tenant_id = $1 AND invocation_id = ANY($2::uuid[])
      GROUP BY invocation_id`,
    [tenantId, invocationIds],
  );
  for (const r of res.rows as Array<{ invocation_id: string; n_requests: number; n_approved: number; n_rejected: number }>) {
    out.set(r.invocation_id, { requests: r.n_requests, approved: r.n_approved, rejected: r.n_rejected });
  }
  return out;
}

/** Backfill one page. Deterministic object key per (runId, cursor) so a retry of
 *  the same page overwrites nothing (create-only) and never duplicates. */
export async function backfillPage(args: {
  tenantId: string;
  sinceIso: string;
  untilIso: string;
  cursor?: BackfillCursor;
  pageSize?: number;
}): Promise<BackfillPageResult> {
  const { tenantId, sinceIso, untilIso } = args;
  const since = Date.parse(sinceIso);
  const until = Date.parse(untilIso);
  if (Number.isNaN(since) || Number.isNaN(until)) throw new Error('invalid sinceIso/untilIso');
  if (since >= until) throw new Error('sinceIso must be before untilIso');
  if (until > Date.now() - MIN_UNTIL_LAG_MS) throw new Error('untilIso must be <= now - 24h (closed window)');

  const runId = deriveRunId(tenantId, sinceIso, untilIso);
  const pageSize = Math.min(Math.max(1, args.pageSize ?? MAX_PAGE_SIZE), MAX_PAGE_SIZE);
  const cursorCompleted = args.cursor?.completedAt ?? new Date(since).toISOString();
  const cursorId = args.cursor?.id ?? '00000000-0000-0000-0000-000000000000';

  const page = await pool.query(
    `SELECT i.id, i.completed_at
       FROM invocations i
      WHERE i.tenant_id = $1 AND i.parent_invocation_id IS NULL
        AND i.completed_at >= $2 AND i.completed_at < $3
        AND (i.completed_at, i.id) > ($4, $5)
      ORDER BY i.completed_at, i.id
      LIMIT $6`,
    [tenantId, sinceIso, untilIso, cursorCompleted, cursorId, pageSize],
  );
  const rows = page.rows as InvRow[];
  if (rows.length === 0) return { ok: true, runId, emitted: 0, nextCursor: null };

  const hitl = await hitlCountsFor(tenantId, rows.map((r) => r.id));
  const corrSince = correlationSinceMs();
  const out: CollabSessionRow[] = [];

  for (const r of rows) {
    const inv = await invocationsService.getInvocation(r.id, tenantId);
    if (!inv) continue;

    // A run with no outcome is UNFINISHED, not failed.
    //
    // This used to read `(inv.outcome ?? 'error') as 'success' | 'error' | 'escalated'`,
    // which was wrong twice over. The `?? 'error'` recorded every in-flight or
    // never-settled run as a failure — a fabricated verdict, indistinguishable
    // downstream from a run that genuinely failed. And the cast NARROWED AWAY
    // 'gated' at compile time while the value was emitted at runtime, so the
    // compiler never objected and reading this file honestly led to the
    // conclusion that the backfill could not produce that value. It could, and it
    // did.
    //
    // Skipping is the honest option. The page query already requires a
    // `completed_at` inside a window closed at now-24h, so a row reaching here
    // with no outcome is anomalous — `completeInvocation` writes both together.
    // Omitting it means the export has no row for that session, which is true;
    // the alternative was a row asserting it failed, which was not.
    //
    // Not self-healing: the object key is deterministic per (runId, page) and the
    // sink is create-only, so re-running the SAME window will 412 rather than
    // replace this page. Recovering such a row needs a different window or a
    // deliberate re-key.
    if (!inv.outcome) {
      logger.debug({ invocationId: r.id }, 'backfill: invocation has no outcome yet, skipping (not recording it as a failure)');
      continue;
    }

    // Human id: prefer the persisted column; for pre-311 rows fall back to the
    // thread's initiating user when the run was human-triggered.
    let humanId = inv.triggeredByUserId;
    if (!humanId && inv.triggeredBy === 'human' && inv.threadId) {
      const t = await pool.query(`SELECT initiated_by_user FROM threads WHERE id = $1 AND tenant_id = $2`, [inv.threadId, tenantId]);
      humanId = (t.rows[0]?.initiated_by_user as string) ?? null;
    }

    const trajRes = await pool.query(
      `SELECT gcs_path FROM agent_trajectories WHERE tenant_id = $1 AND invocation_id = $2`,
      [tenantId, r.id],
    );
    const gcsPath = (trajRes.rows[0]?.gcs_path as string) ?? null;
    const features = await loadTrajectoryFeatures(gcsPath);

    const counts = hitl.get(r.id);
    const completedMs = inv.completedAt ? inv.completedAt.getTime() : inv.startedAt.getTime();
    const attributable = completedMs > corrSince;
    // No correlated rows: real zeros only when the run completed after the
    // correlation cutoff; otherwise unattributable (null).
    const nReq = counts ? counts.requests : attributable ? 0 : null;
    const nApp = counts ? counts.approved : attributable ? 0 : null;
    const nRej = counts ? counts.rejected : attributable ? 0 : null;

    const costUsd = inv.costUsd === null ? null : inv.costUsd + inv.groundingCostUsd;
    const startedAt = inv.startedAt.toISOString();
    const completedAt = (inv.completedAt ?? inv.startedAt).toISOString();

    out.push({
      session_id: r.id,
      tenant_id: tenantId,
      agent_id: inv.agentId,
      human_id: humanId ?? null,
      thread_id: inv.threadId,
      triggered_by: inv.triggeredBy,
      task_ref: inv.triggeredByLabel ?? inv.triggerRef ?? null,
      provider: inv.provider,
      model: inv.modelId,
      outcome: inv.outcome,
      // `invocations` stores the four-value outcome and not the terminal state
      // behind it, so this producer genuinely does not know. NULL says exactly
      // that; it never guesses one.
      terminal_state: null,
      failure_class: inv.failureClass,
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
      cost_usd: costUsd,
      input_tokens: inv.inputTokens,
      output_tokens: inv.outputTokens,
      tool_call_count: inv.toolCalls.length,
      n_user_messages: features ? features.nUser : null,
      n_assistant_messages: features ? features.nAssistant : null,
      n_tool_errors: null,
      n_distinct_tools: features ? features.nDistinctTools : null,
      first_human_msg_idx: features ? features.firstHumanIdx : null,
      human_msg_spread: features ? features.spread : null,
      n_hitl_requests: nReq,
      n_hitl_approved: nApp,
      n_hitl_rejected: nRej,
      trajectory_gcs_uri: gcsPath,
      artifact_uris: null,
      emitted_at: new Date().toISOString(),
      source: 'backfill',
      schema_version: COLLAB_SESSION_SCHEMA_VERSION,
    });
  }

  const last = rows[rows.length - 1];
  const objectKey = `backfill/${runId}/${sinkKeyGuard(last.completed_at)}-${last.id}`;
  await sinkCollabSessions(out, objectKey);

  const nextCursor: BackfillCursor | null =
    rows.length < pageSize ? null : { completedAt: last.completed_at, id: last.id };
  return { ok: true, runId, emitted: out.length, nextCursor };
}
