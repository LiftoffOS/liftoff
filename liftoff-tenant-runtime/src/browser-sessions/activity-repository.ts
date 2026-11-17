// The Postgres half of browser activity: the ONE recorder of pane browser
// work for every surface (migration 423).
//
// One row per recorded pane work call on a thread once a browser session has
// been resolved, whoever made it: a team's own tool path, or a platform
// assistant over the BrowserSessionsService RPCs. The id is the CALLER's,
// minted per call, and the insert is `ON CONFLICT (id) DO NOTHING`, which is
// what makes a retried or replayed call write once and lets the control
// plane's fallback row (same id, written when an answer never arrived) lose
// to this one by exact id in the reader's merge.
//
// Recording never holds a call's result hostage. `recordBrowserActivity`
// never throws: a failed insert is logged without payload values and the
// caller carries on with the outcome it already has. Every text lands
// bounded and through the protected data policy, and the flags say what
// that pass changed, so a reader never presents a cut or redacted text as
// exact. Steps are already capped by the capture that produced them.
//
// Both statements run under the tenant (`withTenantScope`): the table is
// FORCE RLS and the raw pool would read nothing.

import { z } from 'zod';
import { sanitizeBrowserText } from '@liftoffos/redact';
import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import type { BrowserTaskStep } from '../integrations/web-fetch/step-policy';

export const ACTIVITY_INSTRUCTION_CAP = 4000;
export const ACTIVITY_OUTCOME_CAP = 4000;
export const ACTIVITY_GAP_REASON_CAP = 400;

/** The closed vocabulary migration 423 admits. */
export const ACTIVITY_GAP_REASONS = [
  'attach_failed', 'frame_unavailable', 'disconnected', 'cap', 'reconciliation_uncertain',
] as const;
export type ActivityGapReason = (typeof ACTIVITY_GAP_REASONS)[number];

/** The tools whose calls are recorded as work. */
export const RECORDED_BROWSER_TOOLS = [
  'run_browser_task',
  'navigate_browser_session',
  'read_active_browser_session',
  'save_active_browser_page_as_pdf',
  'screenshot_browser_session',
  'list_browser_downloads',
  'fetch_browser_download',
  // The fine-grained pane actions (pane-actions.ts): a read of the page's
  // controls is work only when the caller says so; an action always is.
  'read_browser_session_controls',
  'act_in_browser_session',
  // Not a tool the model calls: the runtime's own saved-login fill
  // (integrations/onepassword/autofill.ts), one row per outcome on a pane
  // session, with the step in `steps`.
  'saved_login',
] as const;
export type RecordedBrowserTool = (typeof RECORDED_BROWSER_TOOLS)[number];

/** The strict bounded step schema, used at insertion and again at read: a
 *  malformed row is reported as a capture gap, never as attacker-shaped
 *  fields. */
export const activityStepSchema = z.object({
  type: z.string().max(64),
  action: z.string().max(2000),
  pageUrl: z.string().max(2048),
  actionTruncated: z.boolean(),
  pageUrlTruncated: z.boolean(),
  protectedDataOmitted: z.boolean(),
  protectedKind: z.string().max(32),
  pageUrlProtectedDataOmitted: z.boolean(),
  /** ISO 8601, or null when the loop did not report a time. */
  at: z.string().max(40).nullable(),
}).strict();
export const activityStepsSchema = z.array(activityStepSchema).max(60);

export type ActivityStep = z.infer<typeof activityStepSchema>;

export interface RecordBrowserActivityInput {
  /** The caller's activity id (the RPC's request field, or one minted by the
   *  runtime's own tool path). */
  id: string;
  tenantId: string;
  threadId: string;
  sessionId: string;
  tool: RecordedBrowserTool;
  /** Already through the browser text sanitizer where the caller had it; the
   *  repository bounds and sanitizes again and upgrades the flags. */
  instruction: string;
  instructionTruncated?: boolean;
  instructionProtectedDataOmitted?: boolean;
  outcome: string;
  outcomeTruncated?: boolean;
  outcomeProtectedDataOmitted?: boolean;
  personTookOver: boolean;
  /** null when the tool has no step sequence. */
  steps: BrowserTaskStep[] | null;
  captureGap: boolean;
  gapReason: ActivityGapReason | null;
  stepsTruncated: boolean;
}

/** A step as the wire carries it, with the completeness fields defaulted for
 *  a producer that did not set them. */
function toStoredStep(step: BrowserTaskStep): ActivityStep {
  return {
    type: step.type,
    action: step.action,
    pageUrl: step.pageUrl,
    actionTruncated: step.actionTruncated === true,
    pageUrlTruncated: step.pageUrlTruncated === true,
    protectedDataOmitted: step.protectedDataOmitted === true,
    protectedKind: step.protectedKind ?? '',
    pageUrlProtectedDataOmitted: step.pageUrlProtectedDataOmitted === true,
    at: step.at ? step.at.toISOString() : null,
  };
}

/**
 * Record one pane work call. Returns the id when the row exists after the
 * call (inserted now or already there) or null, and never throws.
 */
export async function recordBrowserActivity(input: RecordBrowserActivityInput): Promise<string | null> {
  const instruction = sanitizeBrowserText(input.instruction, ACTIVITY_INSTRUCTION_CAP);
  const outcome = sanitizeBrowserText(input.outcome, ACTIVITY_OUTCOME_CAP);
  const gapReason = input.captureGap
    ? (input.gapReason ?? 'reconciliation_uncertain').slice(0, ACTIVITY_GAP_REASON_CAP)
    : null;
  let steps: ActivityStep[] | null = null;
  // Already capped by the producing capture; a longer list is cut here and
  // said so rather than refused.
  const stepsTruncated = input.stepsTruncated || (input.steps !== null && input.steps.length > 60);
  if (input.steps !== null) {
    const parsed = activityStepsSchema.safeParse(input.steps.slice(0, 60).map(toStoredStep));
    if (!parsed.success) {
      logger.warn({ activity_id: input.id, tool: input.tool, event: 'browser_activity_steps_rejected' },
        'browser activity: the steps did not match the bounded schema and were not stored');
      return await insert({
        ...input, instruction, outcome, stepsTruncated,
        gapReason: 'reconciliation_uncertain', captureGap: true, steps: [],
      });
    }
    steps = parsed.data;
  }
  return insert({ ...input, instruction, outcome, stepsTruncated, gapReason, steps });
}

async function insert(row: Omit<RecordBrowserActivityInput, 'instruction' | 'outcome' | 'steps' | 'gapReason'> & {
  instruction: { text: string; truncated: boolean; protectedDataOmitted: boolean };
  outcome: { text: string; truncated: boolean; protectedDataOmitted: boolean };
  steps: ActivityStep[] | null;
  gapReason: string | null;
}): Promise<string | null> {
  try {
    const { rows } = await withTenantScope(row.tenantId, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO browser_activity
           (id, tenant_id, thread_id, session_id, tool, instruction, outcome, person_took_over, steps,
            instruction_truncated, outcome_truncated, capture_gap, gap_reason, steps_truncated,
            instruction_protected_data_omitted, outcome_protected_data_omitted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          row.id, row.tenantId, row.threadId, row.sessionId, row.tool,
          row.instruction.text, row.outcome.text, row.personTookOver,
          row.steps === null ? null : JSON.stringify(row.steps),
          row.instructionTruncated === true || row.instruction.truncated,
          row.outcomeTruncated === true || row.outcome.truncated,
          row.gapReason !== null,
          row.gapReason,
          row.stepsTruncated === true,
          row.instructionProtectedDataOmitted === true || row.instruction.protectedDataOmitted,
          row.outcomeProtectedDataOmitted === true || row.outcome.protectedDataOmitted,
        ],
      ),
    );
    if (rows.length > 0) return rows[0].id;
    // ON CONFLICT DO NOTHING returns no row when it already existed: the row
    // exists after the call either way.
    const { rows: existing } = await withTenantScope(row.tenantId, (client) =>
      client.query<{ id: string }>(`SELECT id FROM browser_activity WHERE id = $1`, [row.id]),
    );
    return existing[0]?.id ?? null;
  } catch (err) {
    // No payload values in the log: the instruction and outcome are the
    // person's business and the log is not the record.
    logger.warn(
      { activity_id: row.id, tool: row.tool, thread_id: row.threadId, err: (err as Error).message, event: 'browser_activity_record_failed' },
      'browser activity: a call was not recorded',
    );
    return null;
  }
}

/** Whether a thread has any browser record: an activity row or a takeover
 *  hold. One existence read, for the tool gate on a thread whose session
 *  has closed. */
export async function threadHasBrowserRecord(tenantId: string, threadId: string): Promise<boolean> {
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM browser_activity WHERE tenant_id = $1 AND thread_id = $2)
           OR EXISTS (SELECT 1 FROM browser_takeover_holds WHERE tenant_id = $1 AND thread_id = $2) AS present`,
      [tenantId, threadId],
    );
    return rows[0]?.present === true;
  });
}

// ── The read behind ListBrowserActivity ──────────────────────────────────────

export interface BrowserActivityRead {
  id: string;
  tool: string;
  instruction: string;
  outcome: string;
  personTookOver: boolean;
  /** null when the tool has no step sequence. */
  steps: ActivityStep[] | null;
  createdAt: Date;
  instructionTruncated: boolean;
  outcomeTruncated: boolean;
  captureGap: boolean;
  gapReason: string;
  stepsTruncated: boolean;
  instructionProtectedDataOmitted: boolean;
  outcomeProtectedDataOmitted: boolean;
}

export interface ActivityCursor {
  createdAt: Date;
  id: string;
}

/** Newest rows first for a thread, `limit` at a time, from before `before`.
 *
 *  Keyed on `(created_at, id)` rather than the timestamp alone, so two rows
 *  written in the same instant cannot be skipped between pages. One row past
 *  the limit is fetched to know whether an older page exists. A row whose
 *  stored steps no longer match the bounded schema is returned with an empty
 *  list and a `reconciliation_uncertain` gap rather than its stored fields. */
export async function listBrowserActivity(
  tenantId: string,
  threadId: string,
  opts: { limit: number; before?: ActivityCursor },
): Promise<{ rows: BrowserActivityRead[]; hasMore: boolean }> {
  return withTenantScope(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, tool, instruction, outcome, person_took_over, steps, created_at,
              instruction_truncated, outcome_truncated, capture_gap, gap_reason, steps_truncated,
              instruction_protected_data_omitted, outcome_protected_data_omitted
       FROM browser_activity
       WHERE tenant_id = $1 AND thread_id = $2
         AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $5`,
      [tenantId, threadId, opts.before?.createdAt ?? null, opts.before?.id ?? null, opts.limit + 1],
    );
    const hasMore = rows.length > opts.limit;
    const page = rows.slice(0, opts.limit) as Array<Record<string, unknown>>;
    return {
      hasMore,
      rows: page.map((r) => {
        let steps: ActivityStep[] | null = null;
        let captureGap = r.capture_gap === true;
        let gapReason = typeof r.gap_reason === 'string' ? r.gap_reason : '';
        if (r.steps !== null && r.steps !== undefined) {
          const parsed = activityStepsSchema.safeParse(r.steps);
          if (parsed.success) {
            steps = parsed.data;
          } else {
            steps = [];
            captureGap = true;
            gapReason = gapReason || 'reconciliation_uncertain';
          }
        }
        return {
          id: r.id as string,
          tool: r.tool as string,
          instruction: (r.instruction ?? '') as string,
          outcome: (r.outcome ?? '') as string,
          personTookOver: r.person_took_over === true,
          steps,
          createdAt: r.created_at as Date,
          instructionTruncated: r.instruction_truncated === true,
          outcomeTruncated: r.outcome_truncated === true,
          captureGap,
          gapReason,
          stepsTruncated: r.steps_truncated === true,
          instructionProtectedDataOmitted: r.instruction_protected_data_omitted === true,
          outcomeProtectedDataOmitted: r.outcome_protected_data_omitted === true,
        };
      }),
    };
  });
}
