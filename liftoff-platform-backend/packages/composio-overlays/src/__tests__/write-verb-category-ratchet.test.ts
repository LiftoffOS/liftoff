// A tool whose slug names a mutation verb must not be tagged read-only.
//
// categoryOverrides is what tenant-runtime's oversight filter reads to decide
// whether a call needs HITL review, so a write tagged 'read' does not merely
// mislabel — it routes an unreviewed mutation straight through the gate.
//
// These tags are seeded by scaffold-connector.ts's inferCategories, a token
// heuristic that cannot read a vendor description. It shipped eight wrong:
// googlesheets append_values + clear_values, excel apply_table_filter +
// apply_table_sort, cal decline_booking, posthog persons + annotations, and
// fibery run_graphql — the last four because the vendor put a delete or a
// mutation behind a name that leads with LIST or QUERY.
//
// The heuristic is now prefix-stripped and carries the missing verbs, but a
// heuristic still cannot be trusted alone, so this ratchet holds the line:
// every mutation verb below must carry a write category, and any tool that
// legitimately does not has to be named in REVIEWED_READ_ONLY with a reason.
// The exemption list is the point — it forces a human to look at a vendor
// description once, and records what they concluded.

import { COMPOSIO_TOOL_OVERLAYS } from '../overlays';

// Verbs that mutate remote state. Deliberately excludes ambiguous ones
// (RUN, EXECUTE, QUERY) — those are judged per tool via the exemption list.
const MUTATION_VERBS = new Set([
  'CREATE', 'UPDATE', 'MODIFY', 'DELETE', 'DESTROY', 'ARCHIVE', 'PURGE', 'TRASH',
  'ADD', 'SET', 'REMOVE', 'INSERT', 'UPSERT', 'MOVE', 'COPY', 'DUPLICATE', 'SEND',
  'WRITE', 'REPLACE', 'STORE', 'ASSIGN', 'IMPORT', 'PUBLISH', 'INVITE', 'SHARE',
  'APPROVE', 'REJECT', 'CANCEL', 'ENABLE', 'DISABLE', 'UPLOAD', 'MARK', 'CONVERT',
  'APPEND', 'CLEAR', 'APPLY', 'DECLINE', 'ACCEPT', 'DRAFT', 'FORWARD', 'RENAME',
  'RESTORE', 'REVOKE', 'GRANT', 'SUBMIT', 'ACTIVATE', 'DEACTIVATE', 'LOCK',
  'UNLOCK', 'UNARCHIVE', 'DISCARD', 'RESET', 'REFUND', 'CAPTURE', 'VOID',
]);

const WRITE_CATEGORIES = ['write', 'destructive', 'outbound'];

// Tools that name a mutation verb but are genuinely read-only. Each needs a
// reason a reviewer checked against the vendor's own description.
const REVIEWED_READ_ONLY: Record<string, string> = {
  'supabase.SUPABASE_BETA_RUN_SQL_QUERY':
    'Read-only by enforcement, not by name: connector-service attaches the fail-closed ' +
    'sqlGuard (SQL_GUARD_OVERRIDES.supabase.run_query) which rejects non-SELECT in both ' +
    'dispatch paths, and the overlay descriptionSuffix states the restriction to the model.',
  'dataforseo.DATAFORSEO_GET_ON_PAGE_DUPLICATE_TAGS':
    'DUPLICATE is the noun, not the verb: the tool retrieves pages sharing a title or ' +
    'description tag from a finished On-Page crawl ("Returns lists of pages sharing the ' +
    'same title or description tags"). Nothing is copied; the crawl was started by ' +
    'start_site_audit, which is tagged write.',
};

/** Slug minus its toolkit prefix — FOLLOW_UP_BOSS_LIST_DEALS -> LIST_DEALS. */
function verbTokens(toolkit: string, slug: string): Set<string> {
  const prefix = toolkit.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  let rest = slug.toUpperCase();
  if (rest.startsWith(`${prefix}_`)) rest = rest.slice(prefix.length + 1);
  return new Set(rest.split('_'));
}

describe('write-verb category ratchet', () => {
  it('no tool naming a mutation verb is tagged read-only', () => {
    const violations: string[] = [];

    for (const [toolkit, overlays] of Object.entries(COMPOSIO_TOOL_OVERLAYS)) {
      for (const [vendorSlug, overlay] of Object.entries(overlays)) {
        const key = `${toolkit}.${vendorSlug}`;
        if (key in REVIEWED_READ_ONLY) continue;

        const cats = overlay.categoryOverrides ?? [];
        if (cats.some((c) => WRITE_CATEGORIES.includes(c))) continue;

        const hit = [...verbTokens(toolkit, vendorSlug)].find((t) => MUTATION_VERBS.has(t));
        if (hit) {
          violations.push(
            `  - ${key} (${overlay.stableName}) names '${hit}' but is tagged ` +
            `${JSON.stringify(cats)}`,
          );
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Tools naming a mutation verb but tagged read-only:\n${violations.join('\n')}\n\n` +
        'categoryOverrides drives the tenant-runtime HITL gate, so a write tagged read ' +
        'bypasses review. Read the tool description in Composio, then either fix the tag ' +
        'or add the tool to REVIEWED_READ_ONLY with the reason it is genuinely read-only.',
      );
    }
  });

  it('REVIEWED_READ_ONLY has no stale entries', () => {
    const stale = Object.keys(REVIEWED_READ_ONLY).filter((key) => {
      const [toolkit, ...rest] = key.split('.');
      const vendorSlug = rest.join('.');
      const overlay = COMPOSIO_TOOL_OVERLAYS[toolkit]?.[vendorSlug];
      // Gone from the overlays, or since retagged as a write — either way the
      // exemption guards nothing and should be deleted.
      return !overlay || (overlay.categoryOverrides ?? []).some((c) => WRITE_CATEGORIES.includes(c));
    });

    if (stale.length > 0) {
      throw new Error(
        `REVIEWED_READ_ONLY entries that no longer apply (removed, or now tagged write):\n` +
        stale.map((s) => `  - ${s}`).join('\n'),
      );
    }
  });
});
