// What this run actually did, as the run's own record rather than its memory.
//
// THE DEFECT THIS IS FOR. A reply can say the agent "approved the rest of the
// changes as good to go" while the review state it submitted was `COMMENTED`.
// Nothing need be wrong with the work — the review can be posted, correctly,
// with the state it meant. What is wrong is the account of
// it, and a reply that misreports what it did is a subtler version of the
// duplicate-post defect: the person reads the account, not the ledger, so an
// inaccurate account IS the outcome as far as they are concerned.
//
// WHY THE LEDGER AND NOT A BETTER PROMPT. Telling a model to "describe your
// actions accurately" is a hope, and this codebase has already paid for that
// lesson twice — `the-reply-is-part-of-the-work.md` records a prompt rule being
// the third-shallowest of three fixes. The model is not lying; it is
// summarising an intention it formed several thousand tokens ago, and the tool
// results that would correct it have long since been compacted out of its
// window. `actions` holds what was dispatched, keyed by this run's trace, and
// putting that in front of the model replaces recall with reading.
//
// SCOPE, DELIBERATELY NARROW ON THREE AXES:
//
//   - OUTWARD ACTS ONLY. A read repeated eight times is not something a reply
//     can misreport in a way that matters. `is_external_write` is the ledger's
//     own answer to "did this reach the far side", so the rule cannot drift
//     from the one the ledger already applies.
//   - COMPLETED ONLY. An intent row for a call that failed would invite the
//     opposite error — reporting work that did not land.
//   - CAPPED. A prompt budget that a long run can blow is a budget that fails
//     exactly on the runs most worth getting right, so the row count is bounded
//     and the overflow is STATED rather than silently dropped. A reply that
//     says "and 14 more" is honest; one that quietly describes 6 of 20 is the
//     defect again, one layer down.
//
// It reads through the tenant scope like every other query on this table, and
// `idx_actions_trace_id` (migration 008) serves the lookup.

import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

/** The most rows rendered into a step prompt. Beyond this the count is stated
 *  and the rows are not, which keeps a busy run from crowding out the step's
 *  actual input. */
export const MAX_RENDERED_ACTS = 12;

/** `actions.trace_id` is stored truncated. The lookup must truncate identically
 *  or a long trace matches nothing and this block is silently always empty —
 *  the same way the duplicate guard would have been. */
const TRACE_ID_MAX = 128;

export interface RecordedAct {
  actionType: string;
  targetRef: string;
  /** The multiplexed operation, when the action name hides one. `submit_pending`
   *  versus `create` is the difference between a published review and a draft,
   *  and it is exactly the distinction the observed misreport got wrong. */
  method: string | null;
  /** For a review submission, the state actually submitted — `COMMENT`,
   *  `APPROVE`, `REQUEST_CHANGES`. The single most misreportable field there is. */
  event: string | null;
}

/**
 * The outward acts this run completed, oldest first.
 *
 * FAILS SOFT. A lookup that errors returns an empty list and the step runs with
 * the prompt it would have had anyway. Failing a step because a diagnostic read
 * failed would turn an accuracy aid into a new way for a working agent to break.
 */
export async function actsThisRun(
  tenantId: string,
  traceId: string | undefined,
): Promise<RecordedAct[]> {
  if (!tenantId || !traceId) return [];
  try {
    return await withTenantScope(tenantId, async (client) => {
      const res = await client.query<{
        action_type: string; target_ref: string; method: string | null; event: string | null;
      }>(
        `SELECT action_type,
                target_ref,
                payload->>'method' AS method,
                payload->>'event'  AS event
           FROM actions
          WHERE tenant_id = $1
            AND trace_id = $2
            AND is_external_write = true
            AND status IN ('completed', 'succeeded')
          ORDER BY created_at ASC
          LIMIT $3`,
        [tenantId, traceId.substring(0, TRACE_ID_MAX), MAX_RENDERED_ACTS + 1],
      );
      return res.rows.map((r) => ({
        actionType: r.action_type,
        targetRef: r.target_ref,
        method: r.method,
        event: r.event,
      }));
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId, traceId },
      'acts-this-run: lookup failed, reporting without the ledger',
    );
    return [];
  }
}

/**
 * The prompt block, or null when the run has done nothing outward.
 *
 * Null rather than an empty section on purpose: a run that acted on nothing has
 * nothing to misreport, and a heading with no rows under it reads as an
 * assertion that the agent did nothing — which on a read-only run is true, and
 * on a run whose ledger write failed is not.
 */
export function renderActsThisRun(acts: RecordedAct[]): string | null {
  if (acts.length === 0) return null;

  const shown = acts.slice(0, MAX_RENDERED_ACTS);
  const overflow = acts.length - shown.length;

  const lines = shown.map((a) => {
    const qualifiers = [
      a.method ? `method=${a.method}` : null,
      a.event ? `state=${a.event}` : null,
    ].filter(Boolean).join(', ');
    return `- ${a.actionType}${qualifiers ? ` (${qualifiers})` : ''} on ${a.targetRef}`;
  });

  if (overflow > 0) {
    lines.push(`- ...and ${overflow} more outward action${overflow === 1 ? '' : 's'} not listed here.`);
  }

  return [
    'What you have ALREADY DONE in this run, from the action ledger. This is the',
    'record of what was dispatched, not a plan and not your recollection — where',
    'it disagrees with your memory of the run, it is right and your memory is not.',
    'Describe only these actions as done, in the terms they are recorded in: a',
    'review submitted with state=COMMENT was commented on, not approved.',
    ...lines,
  ].join('\n');
}
