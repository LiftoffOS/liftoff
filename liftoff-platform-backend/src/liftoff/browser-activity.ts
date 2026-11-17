// The browser-activity trail of a Liftoff conversation, as this service wrote
// it before the runtime recorded, and the fallback it still writes.
//
// The tenant runtime is now the ONE recorder of pane browser activity for
// every surface (its browser_activity, proto 0.25.0), and the
// source-conversation read reads the runtime's rows for every host. This
// table has two remaining roles: it holds the rows written before that
// cutover, which `listBrowserActivityPage` remains the permanent reader for,
// and it takes the fallback row the chat service writes ONLY when the runtime
// did not record a call — an older runtime that answered without an activity
// id, or a call that got no answer at all, written under the call's own id
// with the `[not answered]` marker so the reader's exact-id dedupe lets the
// runtime's row win if it did land. The writer is retired in a later cleanup
// once the minimum supported runtime is 0.25 and the insert-failure metric
// has shown the fallback is no longer needed.
//
// One writer and one reader, on purpose (migration 426 says why): the chat
// service records the fallback row as the turn runs, and the
// source-conversation route reads the trail back when the Chief AI Officer is
// asked to build a team from work that was already done here. Nothing else
// touches this table — the transcript stays speech, and the trail stays out of
// the frontend, the shares and the model's own history.
//
// What a row holds. The instruction the tool was given and one line on how it
// ended, as before; and for a delegated task, the loop's own steps
// (migration 480) as the runtime reported them: a bounded type, an action
// phrase with obvious quoted entered values scrubbed on a best-effort basis,
// and the page URL projected to origin and path with opaque id segments as
// `:id`. Steps are stored whole rather than cut inside the outcome line.
// `steps` is NULL when the tool reported none (a navigation, a read, a task on
// a vendor whose loop keeps its own trail) and `[]` when the loop ran and took
// none; the distinction is kept because the two answer differently.
//
// What a row does not hold. The person's own actions while they held the
// keyboard are not here: the runtime records those as takeover holds with the
// pages and named controls the person used (bounded control names, never a
// form value), and the source-conversation route reads them from the runtime
// and merges them by time between these rows. `person_took_over` keeps its
// meaning — the call that hit a takeover — and the hold rows are the segment.
//
// Retention. Rows here stay after a thread's soft delete (the reader refuses a
// soft-deleted thread through getThread); they leave with the thread's hard
// delete through the FK. The runtime's takeover rows leave with tenant
// deletion through their session's cascading FK.

import { sanitizeBrowserText, type SanitizedText } from '@liftoffos/redact';
import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { NOT_ANSWERED_OUTCOME, type BrowserTaskStep } from '../browser-sessions/assistant-tools';

/** Caps applied by the writer. Truncation, never rejection: a trail with a
 *  hole where the longest step was is the failure this table exists to end. */
const INSTRUCTION_CAP = 2000;
const OUTCOME_CAP = 1000;

/** The explicit markers a fallback row carries inside its old columns, so an
 *  old-runtime or failed-insert row still causes the Chief AI Officer to ask
 *  instead of treating an altered text as exact. Space for them is reserved
 *  BEFORE the text is sliced. */
export const PROTECTED_DATA_OMITTED_MARKER = '[protected data omitted]';
export const TRUNCATED_MARKER = '[truncated]';
/** The outcome of a fallback row written when the runtime never answered: a
 *  capture gap the reader maps to `not_answered`. One spelling, the tool's. */
export const NOT_ANSWERED_MARKER = NOT_ANSWERED_OUTCOME;

/** The runtime's takeover refusal, exactly as it crosses the wire. The
 *  assistant tools return a refusal VERBATIM as the whole outcome (runTask
 *  passes res.error straight through), and the pass-through of this exact
 *  sentence is pinned by src/browser-sessions/__tests__/assistant-tools.test.ts
 *  — so a prefix match is deterministic, and a success outcome ("The browser
 *  finished. What it reported: ...") can never collide with it, whatever the
 *  page content contained. */
const TAKEOVER_REFUSAL_PREFIX = 'The user has taken over this browser session';

export interface BrowserActivityRow {
  id: string;
  tool: string;
  instruction: string;
  outcome: string;
  personTookOver: boolean;
  /** The loop's steps as reported; null when the tool reported none. */
  steps: BrowserTaskStep[] | null;
  createdAt: string;
}

/** A safe text with its markers appended inside the cap: the markers are
 *  reserved first, then the text is cut to what is left. */
function withMarkers(safe: SanitizedText, cap: number, truncatedByCap: boolean): string {
  const markers = [
    ...(safe.protectedDataOmitted ? [PROTECTED_DATA_OMITTED_MARKER] : []),
    ...(safe.truncated || truncatedByCap ? [TRUNCATED_MARKER] : []),
  ];
  if (markers.length === 0) return safe.text.slice(0, cap);
  const suffix = ' ' + markers.join(' ');
  return safe.text.slice(0, Math.max(0, cap - suffix.length)) + suffix;
}

/**
 * Record one browser tool call, as the fallback for a call the runtime did
 * not record. Never throws and never awaited on the hot path: a failed insert
 * costs a row of trail, not the turn that was making it. The row is written
 * under the call's own activity id, so the reader can drop it by exact id
 * when the runtime's row exists after all. Only safe text lands: the
 * sanitized instruction with its explicit markers, and the outcome through
 * the browser text sanitizer with the same markers.
 */
export async function recordBrowserActivity(params: {
  /** The call's activity id (liftoff_browser_activity.id accepts it). */
  id: string;
  tenantId: string;
  threadId: string;
  tool: string;
  /** The boundary sanitizer's result, as the tool result carried it
   *  (`browserInstructionFromInput` in assistant-tools.ts); never the raw
   *  input parsed again. */
  instruction: SanitizedText;
  outcome: string;
  /** Null when the tool reported no steps; `[]` when the loop took none. */
  steps: BrowserTaskStep[] | null;
}): Promise<void> {
  try {
    const outcome = sanitizeBrowserText(params.outcome, OUTCOME_CAP);
    const instructionCut = params.instruction.text.length > INSTRUCTION_CAP;
    await withTenantScope(params.tenantId, (client) =>
      client.query(
        `INSERT INTO liftoff_browser_activity
           (id, tenant_id, thread_id, tool, instruction, outcome, person_took_over, steps)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          params.id,
          params.tenantId,
          params.threadId,
          params.tool,
          withMarkers(params.instruction, INSTRUCTION_CAP, instructionCut),
          withMarkers(outcome, OUTCOME_CAP, false),
          params.outcome.startsWith(TAKEOVER_REFUSAL_PREFIX),
          params.steps === null ? null : JSON.stringify(params.steps),
        ],
      ),
    );
  } catch (err) {
    log.warn(
      { err: (err as Error).message, threadId: params.threadId, tool: params.tool },
      'liftoff browser activity: row not recorded',
    );
  }
}

/** Where a page of the trail ends: the last row's `(created_at, id)`, so two
 *  rows written in the same instant cannot be skipped between pages. */
export interface BrowserActivityCursor {
  createdAt: string;
  id: string;
}

/**
 * One page of the thread's trail, NEWEST first, from before `before`.
 *
 * Newest first because the reader keeps the newest rows under a budget and
 * stops when it is spent: an old, long thread must not be loaded in full to
 * return its last 20,000 characters. Ordered on `(created_at, id)`, with a
 * cursor of the same shape, so equal timestamps page cleanly.
 */
export async function listBrowserActivityPage(
  tenantId: string,
  threadId: string,
  opts: { limit: number; before?: BrowserActivityCursor },
): Promise<{ rows: BrowserActivityRow[]; hasMore: boolean }> {
  const result = await withTenantScope(tenantId, (client) =>
    client.query(
      `SELECT id, tool, instruction, outcome, person_took_over, steps, created_at
       FROM liftoff_browser_activity
       WHERE thread_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $4`,
      [threadId, opts.before?.createdAt ?? null, opts.before?.id ?? null, opts.limit + 1],
    ),
  );
  const hasMore = result.rows.length > opts.limit;
  const rows = result.rows.slice(0, opts.limit).map((row) => ({
    id: row.id as string,
    tool: row.tool as string,
    instruction: row.instruction as string,
    outcome: row.outcome as string,
    personTookOver: row.person_took_over as boolean,
    steps: parseSteps(row.steps),
    createdAt: (row.created_at as Date).toISOString(),
  }));
  return { rows, hasMore };
}

/** The column as stored, or null. A row written before migration 480, or by
 *  a tool that reported no steps, is null; anything not an array of step
 *  objects is read as null rather than trusted. A step written before the
 *  completeness flags existed reads with them false and no time; the reader
 *  runs every string through the sanitizer regardless. */
function parseSteps(raw: unknown): BrowserTaskStep[] | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!Array.isArray(value)) return null;
  return value
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s) => ({
      type: typeof s['type'] === 'string' ? s['type'] : '',
      action: typeof s['action'] === 'string' ? s['action'] : '',
      pageUrl: typeof s['pageUrl'] === 'string' ? s['pageUrl'] : '',
      actionTruncated: s['actionTruncated'] === true,
      pageUrlTruncated: s['pageUrlTruncated'] === true,
      protectedDataOmitted: s['protectedDataOmitted'] === true,
      protectedKind: typeof s['protectedKind'] === 'string' ? s['protectedKind'] : '',
      pageUrlProtectedDataOmitted: s['pageUrlProtectedDataOmitted'] === true,
      at: typeof s['at'] === 'string' ? s['at'] : null,
    }));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
