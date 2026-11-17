// A toolkit declares BOTH sides of write provenance, or neither.
//
// `idArgs` on a write says "judge this call against what the run has seen".
// `returnsIds` on a read says "these are the ids the run has now seen". A
// toolkit that declares only the first is strictly worse than one that declares
// nothing: every one of its writes gets judged, nothing in the toolkit can ever
// provenance one, and the shadow metric fills with false positives for correct
// behaviour. A metric that fires on correct behaviour is one everybody learns to
// ignore, which costs more than the coverage was worth.
//
// So the rule is a pairing rule, and it is checked here rather than left to
// review, because the failure looks like PROGRESS in a diff — more declarations
// than last week, on the tools that obviously needed them.
//
// The declarations are also checked for shape. They are stated in CANONICAL
// terms: `idArgs` names arguments the agent passes (what translateInput
// receives), and `returnsIds` paths are read against the canonical response
// (what translateOutput emits). A vendor-shape name compiles, matches nothing,
// and reads as "declares nothing" — indistinguishable from a tool nobody
// covered.

import { CANONICAL_RESPONSE_SHAPES } from '../canonical-shapes';
import { COMPOSIO_TOOL_OVERLAYS, COMPOSIO_HISTORY_MAPPINGS } from '../index';
import type { ComposioToolOverlay } from '../types';

type Entry = { toolkit: string; overlay: ComposioToolOverlay };

const ALL: Entry[] = Object.entries(COMPOSIO_TOOL_OVERLAYS).flatMap(([toolkit, byName]) =>
  Object.values(byName).map((overlay) => ({ toolkit, overlay })),
);

/** Every source of ids in a toolkit: reads that declare what they return, plus
 *  the history mappings, which are reads by construction. */
function idSourcesIn(toolkit: string): number {
  const fromOverlays = ALL.filter(
    (e) => e.toolkit === toolkit && (e.overlay.returnsIds ?? []).length > 0,
  ).length;
  const fromHistory = (COMPOSIO_HISTORY_MAPPINGS[toolkit] ?? []).filter(
    (m) => (m.returnsIds ?? []).length > 0,
  ).length;
  return fromOverlays + fromHistory;
}

describe('a toolkit declares both sides or neither', () => {
  it('has an id source for every toolkit whose writes are judged', () => {
    const judged = [...new Set(
      ALL.filter((e) => (e.overlay.idArgs ?? []).length > 0).map((e) => e.toolkit),
    )];

    const orphaned = judged.filter((toolkit) => idSourcesIn(toolkit) === 0);

    expect(orphaned).toEqual([]);
  });

  it('covers gmail, so the assertions above are not vacuous', () => {
    // A guard on the guard: were the declarations dropped or the fields
    // renamed, every check here would pass on an empty set.
    const gmail = ALL.filter((e) => e.toolkit === 'gmail');
    expect(gmail.filter((e) => (e.overlay.idArgs ?? []).length > 0).length).toBeGreaterThan(0);
    expect(idSourcesIn('gmail')).toBeGreaterThan(0);
  });
});

describe('declarations are in canonical shape', () => {
  it('gives every returnsIds entry both an entity type and a path', () => {
    // An empty entityType silently downgrades every match to the untyped
    // fallback, which is how a message id ends up vouching for a thread.
    const bad: string[] = [];
    for (const { toolkit, overlay } of ALL) {
      for (const r of overlay.returnsIds ?? []) {
        if (!r.entityType || !r.path) bad.push(`${toolkit}.${overlay.stableName}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('reads returnsIds paths against a response shape that exists', () => {
    // The path is evaluated on the CANONICAL response. A toolkit that declares
    // paths without a canonical shape is declaring against Composio's raw
    // response, which the runtime never sees.
    const bad: string[] = [];
    for (const { toolkit, overlay } of ALL) {
      if ((overlay.returnsIds ?? []).length === 0) continue;
      const key = `${toolkit}.${overlay.stableName}`;
      if (!(key in CANONICAL_RESPONSE_SHAPES)) bad.push(key);
    }
    expect(bad).toEqual([]);
  });

  it('names no argument in idArgs that translateInput would have renamed', () => {
    // The trap this catches: declaring Composio's name (`thread_id` where the
    // agent passes `threadId`). It cannot be checked against a JSON schema here
    // the way the native registry checks it — these tools have no schema in this
    // package — so it is checked against the canonical name being at least
    // plausible: no SCREAMING_CASE vendor tool names, no dotted vendor paths.
    const bad: string[] = [];
    for (const { toolkit, overlay } of ALL) {
      for (const arg of overlay.idArgs ?? []) {
        if (!/^[a-z][a-zA-Z0-9_]*$/.test(arg)) bad.push(`${toolkit}.${overlay.stableName} → '${arg}'`);
      }
    }
    expect(bad).toEqual([]);
  });
});
