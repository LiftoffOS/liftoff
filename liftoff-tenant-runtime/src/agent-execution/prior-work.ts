// What this agent has produced BEFORE this run, as a record rather than a search.
//
// THE DEFECT THIS IS FOR. A competitive-intelligence agent can report "No
// battle card exists yet for <competitor>" when a battle card for that
// competitor exists — one the agent wrote itself, on an earlier run.
//
// It is not lying and it is not lazy. If its graph dispatches only Google Docs
// tools and a chat post, NONE of them can answer "what have I made". So it does
// the only thing available: keyword searches over a document store, none of
// which need contain "battle card" or the competitor's name in a form the store
// matches. Finding nothing, it reports nothing. The failure is the search, not
// the conclusion drawn from it.
//
// WHY THIS AND NOT `have_i_acted_on`. That tool answers "have I acted on THIS
// target" and takes a target_ref derived from arguments the caller already
// holds — owner/repo/pull_number, a channel, a thread id. The question here is
// the inverse: the agent holds a competitor's NAME and wants the artifact it
// produced about it. You cannot look up a target you cannot name, which is why
// the tool was never going to close this and why measuring its call count
// measures the wrong thing.
//
// WHY INJECTED AND NOT OFFERED. A tool is a decision the model has to make, and
// the decision is made at exactly the moment it believes there is nothing to
// look for. Context costs no decision. `acts-this-run.ts` established the shape
// for the within-run half of this and states the reason better than a
// restatement would: it "replaces recall with reading". This is its cross-run
// sibling — same table, same soft-fail, same capped-and-stated overflow, keyed
// on the AGENT across a window instead of on one trace.
//
// SCOPE, on the same three axes as its sibling, plus one:
//
//   - OUTWARD ACTS ONLY (`is_external_write`), because a read produced nothing.
//   - COMPLETED ONLY, because an artifact that failed to write does not exist.
//   - CAPPED, with the overflow STATED. A block that silently shows 20 of 200
//     teaches the agent that the list is exhaustive, which is the same
//     false-absence this exists to prevent, one layer down.
//   - ONE ROW PER TARGET. Eight updates to one document are one artifact, and
//     rendering them eight times would spend the cap proving that.
//
// WHAT IT CANNOT SEE, and the block says so rather than leaving it implied:
// sandbox work (`backstopLedger` exempts sandbox tools, so a file written with
// a shell is invisible here) and anything older than the window.

import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { collectIdentity } from '../audit/result-identity';

/** The most artifacts rendered. Beyond this the count is stated and the rows
 *  are not. */
export const MAX_RENDERED_PRIOR_WORK = 25;

/** How far back the block looks. Matches `hasActedOn`'s default so the two
 *  ledger surfaces do not disagree about what "before" covers. */
export const PRIOR_WORK_WINDOW_DAYS = 90;

export interface PriorArtifact {
  targetRef: string;
  connector: string;
  actionType: string;
  createdAt: Date;
  /** What the artifact is called, from the response the vendor returned.
   *  Absent when the response named nothing. */
  name?: string;
  /** Where it lives, when the response gave a link. */
  url?: string;
}

/** The first identity field present, in the order `collectIdentity` returns
 *  them: what it is called before what it is, and where it lives last. */
function pickString(identity: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = identity[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Artifacts this agent produced before now, newest first, one per target.
 *
 * FAILS SOFT, like its sibling: a lookup that errors returns an empty list and
 * the run proceeds with the prompt it would have had. A diagnostic read must
 * not be a new way for a working agent to break.
 */
export async function priorWork(
  tenantId: string,
  agentId: string,
  windowDays: number = PRIOR_WORK_WINDOW_DAYS,
): Promise<PriorArtifact[]> {
  if (!tenantId || !agentId) return [];
  try {
    return await withTenantScope(tenantId, async (client) => {
      // DISTINCT ON collapses a target's history to its most recent row, and the
      // outer ORDER BY puts the newest artifacts first. Done in SQL rather than
      // by fetching everything and deduping here: a long-lived agent's history
      // is unbounded and the point of the cap is to never hold it all.
      // TWO HALVES, and they read different rows on purpose.
      //
      // WHICH artifacts to list comes from the writes: a read produced nothing
      // and does not belong in a list of things this agent made.
      //
      // What each one is CALLED comes from any row that touched it, read or
      // write. Google Docs returns a title when you create a document and not
      // when you update one, so an agent working on a document a PERSON created
      // has no titled write anywhere — the only place its name appears is the
      // response to a read. Without this, a person's own destination document
      // would be listed as an opaque id while the `get_document` rows for that
      // same id each carry its title.
      //
      // The `?|` test is an ORDERING HINT, not the extraction. It prefers a
      // response that obviously names something; `collectIdentity` still does
      // the reading, so the key list stays in one place and a response this
      // hint misses is no worse off than before.
      const res = await client.query<{
        target_ref: string;
        connector: string;
        action_type: string;
        created_at: Date;
        external_response: unknown;
      }>(
        `WITH produced AS (
           SELECT DISTINCT ON (target_ref) target_ref, connector, action_type, created_at
             FROM actions
            WHERE tenant_id = $1
              AND agent_id = $2
              AND is_external_write = true
              AND status IN ('completed', 'succeeded')
              AND target_ref <> ''
              AND created_at > now() - ($3 || ' days')::interval
            ORDER BY target_ref, created_at DESC
         ),
         named AS (
           SELECT DISTINCT ON (a.target_ref) a.target_ref, a.external_response
             FROM actions a
             JOIN produced p ON p.target_ref = a.target_ref
            WHERE a.tenant_id = $1
              AND a.agent_id = $2
              AND jsonb_typeof(a.external_response) = 'object'
            ORDER BY a.target_ref,
                     (a.external_response ?| ARRAY['title','name','filename','subject']) DESC,
                     a.created_at DESC
         )
         SELECT p.target_ref, p.connector, p.action_type, p.created_at, n.external_response
           FROM produced p
           LEFT JOIN named n ON n.target_ref = p.target_ref
          ORDER BY p.created_at DESC
          LIMIT $4`,
        [tenantId, agentId, String(windowDays), MAX_RENDERED_PRIOR_WORK + 1],
      );
      return res.rows.map((r) => {
        const identity = collectIdentity(r.external_response);
        return {
          targetRef: r.target_ref,
          connector: r.connector,
          actionType: r.action_type,
          createdAt: r.created_at,
          name: pickString(identity, ['title', 'name', 'filename', 'subject']),
          url: pickString(identity, ['display_url', 'document_url', 'webViewLink', 'webViewUrl', 'url', 'permalink', 'html_url']),
        };
      });
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId, agentId },
      'prior-work: lookup failed, running without the ledger',
    );
    return [];
  }
}

/**
 * The prompt block, or null when this agent has produced nothing yet.
 *
 * Null rather than an empty heading, for the reason its sibling gives: a
 * heading with no rows reads as an assertion that nothing was produced, which
 * is true for a first run and false for a run whose ledger read failed. The
 * two must not look alike.
 */
export function renderPriorWorkBlock(artifacts: PriorArtifact[]): string | null {
  if (artifacts.length === 0) return null;

  const shown = artifacts.slice(0, MAX_RENDERED_PRIOR_WORK);
  const overflow = artifacts.length - shown.length;

  const lines = shown.map((a) => {
    // The name is what a person and a model both match against; the target ref
    // is the fallback and is a key, not a label. The date carries no time: the
    // question this answers is "does this exist", never "by how many minutes".
    const label = a.name ?? a.targetRef;
    const where = a.url ? ` — ${a.url}` : '';
    const when = a.createdAt instanceof Date
      ? a.createdAt.toISOString().slice(0, 10)
      : String(a.createdAt).slice(0, 10);
    return `- ${label}${where} (${a.connector}, last written ${when})`;
  });

  if (overflow > 0) {
    lines.push(
      `- ...and at least ${overflow} more not listed. This list is capped, so its END is not the end of your work.`,
    );
  }

  return [
    'WHAT YOU HAVE ALREADY PRODUCED, from the action ledger. These are things',
    'you made yourself on earlier runs, recorded when they were dispatched.',
    'Check here BEFORE searching for your own prior work, and before reporting',
    'that something you would have made does not exist: a search that finds',
    'nothing means your search terms missed, not that nothing is there.',
    'Update what is listed here rather than creating a second copy of it.',
    `Covers work dispatched through your tools in the last ${PRIOR_WORK_WINDOW_DAYS} days.`,
    'Anything you did inside a sandbox shell is NOT recorded here, so this list',
    'can be an undercount and never a proof of absence. Which is the reason to',
    'prefer a connector tool over a shell command for anything that reaches a',
    'person or another system: what you do through your tools you can see here',
    'next time, and what you do through the shell you cannot.',
    ...lines,
  ].join('\n');
}
