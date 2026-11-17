// No-progress loop guard for reactive subscriptions.
//
// A reactive SWE team must not spin forever on one subject (a PR/issue). This is a
// COUNT-AND-CAP guard in ENFORCE mode. It distinguishes PROGRESS from NO-PROGRESS via a
// state signature: a title/body/label/state change yields a NEW signature (legitimate
// work), a repeat of the same state yields the SAME signature (a loop). It counts fires,
// with no lease/fence — run-idempotency (event_processing_ledger) dedupes redelivered
// events, so a couple of extra fires from a boundary race are harmless.

import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { withTenantScope } from '../infrastructure/database';
import type { SubscriptionRow } from './repository';

// Conservative-generous caps (policy floors, not distributions — NOT auto-calibrated), so a
// false-positive stop is near-impossible while a genuine loop is still caught. Env-overridable.
const WINDOW_HOURS = Number(process.env.LOOP_GUARD_WINDOW_HOURS ?? 6);
const MAX_NOPROGRESS = Number(process.env.LOOP_GUARD_MAX_NOPROGRESS ?? 5);
const MAX_FIRES = Number(process.env.LOOP_GUARD_MAX_FIRES ?? 50); // trailing 24h runaway backstop

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
function get(data: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), data);
}
function sortedNames(arr: unknown, key: string): string {
  if (!Array.isArray(arr)) return '';
  return arr.map((x) => (x && typeof x === 'object' ? String((x as Record<string, unknown>)[key] ?? '') : '')).sort().join(',');
}
function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/** Hash of the watched entity state. Paths root at the RAW GitHub body (env.payload.data).
 *  Per entity type, chosen so a real change (title/body/label/state) flips the signature and
 *  a repeat of the same state keeps it stable. */
export function stateSignature(entityType: string, data: Record<string, unknown>, watchedPaths: string[]): string {
  switch (entityType) {
    case 'PullRequest':
      return sha([
        str(get(data, 'pull_request.head.sha')), str(get(data, 'pull_request.state')),
        str(get(data, 'pull_request.mergeable_state')), sortedNames(get(data, 'pull_request.labels'), 'name'),
        sha(str(get(data, 'pull_request.title'))), sha(str(get(data, 'pull_request.body'))),
      ].join('|'));
    case 'Issue':
      return sha([
        str(get(data, 'issue.state')), sortedNames(get(data, 'issue.assignees'), 'login'),
        sortedNames(get(data, 'issue.labels'), 'name'),
        sha(str(get(data, 'issue.title'))), sha(str(get(data, 'issue.body'))),
      ].join('|'));
    case 'PullRequestReview':
      return sha([
        str(get(data, 'pull_request.head.sha')), str(get(data, 'review.id')),
        str(get(data, 'review.submitted_at')), str(get(data, 'review.state')),
        sha(str(get(data, 'review.body'))),
      ].join('|'));
    case 'WorkflowRun':
      return sha([str(get(data, 'workflow_run.id')), str(get(data, 'workflow_run.conclusion'))].join('|'));
    default:
      return sha(watchedPaths.map((p) => str(get(data, p))).join('|'));
  }
}

export type LoopGuardVerdict = 'ok' | 'no_progress' | 'runaway';

/** COUNT-only (no claim). Within WINDOW_HOURS, count same-signature fires for this subject
 *  (no_progress) and ALL fires in the trailing 24h (runaway). Best-effort by design. */
export async function checkLoopGuard(sub: SubscriptionRow, subjectKey: string, sig: string): Promise<LoopGuardVerdict> {
  return withTenantScope(sub.tenantId, async (c: PoolClient) => {
    const r = await c.query<{ same_sig: string; all_24h: string }>(
      `SELECT
         count(*) FILTER (WHERE state_sig = $3 AND fired_at >= now() - ($4::int * INTERVAL '1 hour')) AS same_sig,
         count(*) FILTER (WHERE fired_at >= now() - INTERVAL '24 hours') AS all_24h
       FROM reactive_fire_ledger
       WHERE subscription_id = $1 AND subject_key = $2`,
      [sub.id, subjectKey, sig, WINDOW_HOURS],
    );
    const sameSig = Number(r.rows[0]?.same_sig ?? 0);
    const all24h = Number(r.rows[0]?.all_24h ?? 0);
    if (sameSig >= MAX_NOPROGRESS) return 'no_progress';
    if (all24h >= MAX_FIRES) return 'runaway';
    return 'ok';
  });
}

/** INSERT one fire-log row (after an 'ok' verdict, before firing). */
export async function recordFire(sub: SubscriptionRow, subjectKey: string, sig: string): Promise<void> {
  await withTenantScope(sub.tenantId, (c: PoolClient) =>
    c.query(
      `INSERT INTO reactive_fire_ledger (tenant_id, subscription_id, subject_key, state_sig)
       VALUES ($1, $2, $3, $4)`,
      [sub.tenantId, sub.id, subjectKey, sig],
    ),
  );
}
