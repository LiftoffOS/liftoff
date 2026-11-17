// The egress-only wire has a producer, and keeps one.
//
// `egressOnly` names result fields that are for the PERSON and not the model:
// the runtime lifts them off the model's copy, leaves a placeholder, and hands
// the values to the surface. The field existed on this type for months, every
// overlay left it unset, and so the whole wire — guardrail, side channel,
// renderer — shipped and carried nothing. A capability nobody declares against
// is indistinguishable from one that does not exist, and a later change that
// broke it would have gone unnoticed for exactly as long.
//
// This is a ratchet, not a rule per connector. Which fields are "for the
// person" is a product judgement made on each overlay against the vendor's
// real output schema; what the ratchet stops is the set of declaring tools
// going back to empty, or shrinking without someone saying so here.

import { COMPOSIO_TOOL_OVERLAYS } from '../index';

/** Every tool that declares at least one egress-only field, as `toolkit/SLUG`.
 *  Add to it when a declaration is made; remove from it only with the reason
 *  the field stopped being for the person. */
const DECLARING_TOOLS = [
  'googledrive/GOOGLEDRIVE_DOWNLOAD_FILE',
  'one_drive/ONE_DRIVE_DOWNLOAD_FILE',
] as const;

const declaring = Object.entries(COMPOSIO_TOOL_OVERLAYS).flatMap(([toolkit, byName]) =>
  Object.entries(byName)
    .filter(([, overlay]) => (overlay.egressOnly ?? []).length > 0)
    .map(([slug]) => `${toolkit}/${slug}`),
).sort();

describe('egress-only declarations', () => {
  it('exist, so the wire built to carry them is not carrying nothing', () => {
    expect(declaring.length).toBeGreaterThan(0);
  });

  it('only grow: every tool that declared one still does', () => {
    const missing = DECLARING_TOOLS.filter((t) => !declaring.includes(t));
    expect(missing).toEqual([]);
  });

  it('are listed here when added, so a new one is a decision and not a side effect', () => {
    const unlisted = declaring.filter((t) => !(DECLARING_TOOLS as readonly string[]).includes(t));
    expect(unlisted).toEqual([]);
  });

  it('name dot paths in returnsIds syntax, never a value', () => {
    for (const [, byName] of Object.entries(COMPOSIO_TOOL_OVERLAYS)) {
      for (const overlay of Object.values(byName)) {
        for (const path of overlay.egressOnly ?? []) {
          // A field name or an array hop per segment; a URL, a space or a
          // slash is a value that leaked into a declaration.
          expect(path).toMatch(/^[A-Za-z_][A-Za-z0-9_-]*(\[\])?(\.[A-Za-z_][A-Za-z0-9_-]*(\[\])?)*$/);
        }
      }
    }
  });
});
