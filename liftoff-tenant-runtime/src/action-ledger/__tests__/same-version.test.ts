// A recorded revision and the one an agent asks about are the same revision,
// written two different lengths.
//
// The ledger stores what the API returned — a full forty-character sha — and
// the event that wakes an agent carries the abbreviated form a person reads.
// Compared with `===`, a review that WAS recorded answered "no record" for the
// very commit it had just reviewed, so the idempotency check could never fire
// on the one connector that records a version at all.
import { sameVersion } from '../service';

const FULL = '2358e179af17b24b8b57cdaabdce4b514f4b0859';

describe('sameVersion', () => {
  it('matches an abbreviated sha against the full one, either way round', () => {
    expect(sameVersion(FULL, '2358e17')).toBe(true);
    expect(sameVersion('2358e17', FULL)).toBe(true);
  });

  it('still matches identical values', () => {
    expect(sameVersion(FULL, FULL)).toBe(true);
  });

  it('refuses a prefix shorter than git abbreviates to', () => {
    // Below seven characters a prefix stops naming one commit, and a false
    // "you already did this" silently drops work.
    expect(sameVersion(FULL, '2358e1')).toBe(false);
  });

  it('does not prefix-match non-hex versions', () => {
    // The rule is about shas. Applied to arbitrary version strings it would
    // make "v1" vouch for "v12".
    expect(sameVersion('v12', 'v1')).toBe(false);
    expect(sameVersion('2026-09-10T12:00:00Z', '2026-09')).toBe(false);
  });

  it('refuses a different commit that shares no prefix', () => {
    expect(sameVersion(FULL, 'fca023b')).toBe(false);
  });

  it('treats a missing version as no answer, never a match', () => {
    expect(sameVersion(null, '2358e17')).toBe(false);
    expect(sameVersion(FULL, null)).toBe(false);
    expect(sameVersion(FULL, undefined)).toBe(false);
  });

  it('ignores case, since shas are written both ways', () => {
    expect(sameVersion(FULL.toUpperCase(), '2358e17')).toBe(true);
  });
});
