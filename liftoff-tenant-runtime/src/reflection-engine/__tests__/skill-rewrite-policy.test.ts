// The description-rewrite bar, asserted as a boundary rather than a preference.
//
// The prompt asks the model to respect these conditions; this is what happens
// when it does not. Every case here is one the reflection engine will actually
// meet, because the model decides while reading untrusted execution history.

import {
  mayRewriteDescription,
  MIN_OBSERVATIONS_FOR_DESCRIPTION_REWRITE,
} from '../skill-rewrite-policy';

describe('mayRewriteDescription', () => {
  const enough = MIN_OBSERVATIONS_FOR_DESCRIPTION_REWRITE;

  it('allows a rewrite only when the score is non-positive AND evidenced', () => {
    expect(mayRewriteDescription({ usefulnessScore: 0, observationCount: enough })).toBe(true);
    expect(mayRewriteDescription({ usefulnessScore: -4, observationCount: enough })).toBe(true);
  });

  it('refuses a skill that is doing well, however much evidence there is', () => {
    // The pre-existing half of the rule. A positive score means the skill led
    // to action; rewriting what it matches would remove working guidance.
    expect(mayRewriteDescription({ usefulnessScore: 1, observationCount: enough * 10 })).toBe(false);
  });

  it('refuses a low score built from too few runs', () => {
    // The case this policy exists for. usefulness moves +/-1 per settled run,
    // so a skill injected twice and unlucky twice sits at -2 and satisfied the
    // old `<= 0` rule on no real evidence at all.
    expect(mayRewriteDescription({ usefulnessScore: -2, observationCount: 2 })).toBe(false);
    expect(mayRewriteDescription({ usefulnessScore: -1, observationCount: enough - 1 })).toBe(false);
  });

  it('fails closed when there is no evidence to judge', () => {
    // A skill the reflection context does not carry has no score to read.
    // "We do not know" must never read as "go ahead" — this is the direction
    // an absent value has to fail in.
    expect(mayRewriteDescription(undefined)).toBe(false);
  });

  it('has a threshold above the smallest unlucky streak', () => {
    // Guards the constant itself: at 1 or 2 the policy would permit exactly the
    // noise it was written to exclude, and the failure would be silent.
    //
    // Asserts a FLOOR, not a tuned value, and deliberately does not pin the
    // exact number — raising it is always safe, and nobody should have to edit
    // a test to be more conservative. The floor is what must not move: below 3
    // the gate stops excluding the never-observed skills it exists for.
    expect(MIN_OBSERVATIONS_FOR_DESCRIPTION_REWRITE).toBeGreaterThanOrEqual(3);
  });
});
