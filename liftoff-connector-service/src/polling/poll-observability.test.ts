// A poll that publishes nothing must still say what it saw.
//
// `pollEntityType` used to log only `if (totalPublished > 0)`. That made the
// zero case unreadable from outside the process: a quiet vendor, a response
// that parsed to nothing, and a filter that dropped everything were the same
// observation — no log line at all.
//
// It cost real time. Gmail's poller published nothing for hours while a support
// mailbox went unread, and from the logs there was no way to distinguish "no
// new mail" from "broken", so the question could only be answered by reading
// the source and reasoning about what MIGHT have happened.
//
// This pins the counts, not the prose: `fetched` separates a quiet vendor from
// a broken parse, `droppedByFilter` names the filter when fetched > published,
// and `since` answers the other half of every missed-record question — a cursor
// that has run past the record looks exactly like a vendor with nothing to say.

import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(join(__dirname, 'scheduler.ts'), 'utf8');

describe('the per-entity poll summary', () => {
  it('is emitted unconditionally, not behind a published>0 guard', () => {
    // The precise regression: re-introducing the guard makes every zero-publish
    // poll invisible again.
    expect(source).not.toMatch(/if\s*\(\s*totalPublished\s*>\s*0\s*\)\s*\{\s*\n\s*logger\.info/);
    expect(source).toContain("event: 'poll_entity_complete'");
  });

  it('reports the counts that separate a quiet vendor from a broken one', () => {
    // Matches both `fetched: totalFetched` and the `pages` shorthand.
    for (const field of ['fetched', 'droppedByFilter', 'published', 'since', 'pages']) {
      expect(source).toMatch(new RegExp(`\\n\\s+${field}[,:]`));
    }
  });

  it('counts what the vendor returned, before normalization or filtering', () => {
    // fetched must come off result.records, not off the filtered set — the
    // whole point is to tell those two numbers apart.
    expect(source).toMatch(/totalFetched\s*\+=\s*result\.records\.length/);
    expect(source).toMatch(/totalDroppedByFilter\s*\+=\s*normalized\.length\s*-\s*filtered\.length/);
  });
});

// A record that arrives late must not be lost forever.
//
// `upsertSyncState` moves `last_sync_at` to NOW at the end of every poll, so
// without an overlap the search window is exactly one cycle wide — measured on
// dev, `since` sat 33 seconds before the query. Any vendor-side visibility lag
// then drops the record permanently:
//
//   poll N    queries after:T-33s  → not yet searchable, 0 results
//   poll N    sets last_sync_at = T
//   poll N+1  queries after:T      → the record's own timestamp is < T, so it
//                                    never matches again
//
// Nothing errors and the connector stays green. Re-fetching is safe because the
// runtime dedupes on eventId (externalId + content hash).
describe('the poll cursor overlap', () => {
  it('rewinds the cursor rather than querying from the last poll exactly', () => {
    expect(source).toMatch(/POLL_LOOKBACK_OVERLAP_MS/);
    expect(source).toMatch(/lastSyncAt\.getTime\(\)\s*-\s*POLL_LOOKBACK_OVERLAP_MS/);
  });

  it('keeps the first-poll fallback, which has no cursor to rewind', () => {
    expect(source).toMatch(/24 \* 60 \* 60 \* 1000/);
  });

  it('uses an overlap larger than the poll cycle, or it buys nothing', () => {
    const overlap = /POLL_LOOKBACK_OVERLAP_MS\s*=\s*(\d+)\s*\*\s*60_000/.exec(source);
    expect(overlap).not.toBeNull();
    expect(Number(overlap![1]) * 60_000).toBeGreaterThan(60_000);
  });
});

// The normalizer is a stage that can drop everything, silently.
//
// Gmail's normalizer only knew the raw Gmail API shapes (`messages`, `threads`,
// history, push notifications). The scheduler hands it `{results:[…]}` — its
// own envelope, documented at the same seam in github.ts — so every predicate
// returned false and normalize() returned []. Gmail polling published nothing
// for the life of the connector, with no error and a green connector.
//
// Two earlier fixes on this path (an empty bearer token 401ing every poll, then
// a 33-second cursor window) each produced the identical symptom and were each
// believed to be the cause. Counting the normalizer stage is what makes the
// third one name itself.
describe('the normalizer stage is counted', () => {
  it('reports `normalized` between fetched and published', () => {
    expect(source).toMatch(/\n\s+normalized[,:]/);
    expect(source).toMatch(/totalNormalized\s*\+=\s*normalized\.length/);
  });
});
