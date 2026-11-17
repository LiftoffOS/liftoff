// A STABLE name that names a write verb must not be classified read-only.
//
// Sibling of write-verb-category-ratchet.test.ts, over the other name. That one
// reads the VENDOR slug, which is what Composio calls the tool; this one reads
// the stable name, which is what the agent, the distiller and the oversight
// filter call it. The two differ often enough to matter — monday's
// MONDAY_CHANGE_SIMPLE_COLUMN_VALUE is `update_column_value` on our side, and
// CHANGE is not a verb the vendor-slug list carries.
//
// The verb list is WRITE_VERB from src/internal-agents/distill-service.ts,
// mirrored rather than imported: this package must not depend on the backend
// tree. It is the list the distiller uses to decide whether an unannotated tool
// writes, so a tool this package tags `read` while that regex reads it as a
// write is a disagreement about the same name between two parts of one system.
//
// A tool that genuinely reads despite its name goes in REVIEWED_READ_ONLY with
// the reason a human checked against the vendor's own description.

import { COMPOSIO_TOOL_OVERLAYS } from '../overlays';

/** WRITE_VERB, verbatim from distill-service.ts. Whole-token match on `_`
 *  boundaries, so `update_column_value` hits and `readme` does not. */
const WRITE_VERB =
  /(^|_)(create|update|append|insert|write|replace|upsert|patch|edit|add|send|post|put|save|upload)(_|$)/i;

const WRITE_CATEGORIES = ['write', 'destructive', 'outbound'];

/** Stable names that name a write verb but genuinely only read. Keyed
 *  `<toolkit>.<vendorSlug>` so an entry cannot silently follow a rename. */
const REVIEWED_READ_ONLY: Record<string, string> = {
  'reddit_ads.REDDIT_ADS_GET_POST':
    '"post" is the Reddit noun, not the HTTP verb: the tool retrieves a promoted or organic ' +
    'post by id ("Returns post details including type, content, headline, and metadata"). ' +
    'The one that publishes is create_post, tagged write + outbound.',
};

describe('stable-name write-verb ratchet', () => {
  it('no stable name that names a write verb is classified read-only', () => {
    const violations: string[] = [];

    for (const [toolkit, overlays] of Object.entries(COMPOSIO_TOOL_OVERLAYS)) {
      for (const [vendorSlug, overlay] of Object.entries(overlays)) {
        const key = `${toolkit}.${vendorSlug}`;
        if (key in REVIEWED_READ_ONLY) continue;

        const cats = overlay.categoryOverrides ?? [];
        if (cats.some((c) => WRITE_CATEGORIES.includes(c))) continue;

        if (WRITE_VERB.test(overlay.stableName)) {
          violations.push(
            `  - ${key} -> '${overlay.stableName}' is tagged ${JSON.stringify(cats)}`,
          );
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Stable names that name a write verb but are classified read-only:\n${violations.join('\n')}\n\n` +
        'The category axis drives the runtime oversight gate and the distiller\'s read/write ' +
        'reasoning, so a write tagged read is a mutation nothing reviews. Read the tool ' +
        'description in Composio, then either fix categoryOverrides or add the tool to ' +
        'REVIEWED_READ_ONLY with the reason it is genuinely read-only.',
      );
    }
  });

  it('REVIEWED_READ_ONLY has no stale entries', () => {
    const stale = Object.keys(REVIEWED_READ_ONLY).filter((key) => {
      const [toolkit, ...rest] = key.split('.');
      const overlay = COMPOSIO_TOOL_OVERLAYS[toolkit]?.[rest.join('.')];
      // Gone, renamed out of the verb list, or since retagged as a write —
      // either way the exemption guards nothing.
      return (
        !overlay
        || !WRITE_VERB.test(overlay.stableName)
        || (overlay.categoryOverrides ?? []).some((c) => WRITE_CATEGORIES.includes(c))
      );
    });

    if (stale.length > 0) {
      throw new Error(
        'REVIEWED_READ_ONLY entries that no longer apply (removed, renamed, or now tagged write):\n'
        + stale.map((s) => `  - ${s}`).join('\n'),
      );
    }
  });
});
