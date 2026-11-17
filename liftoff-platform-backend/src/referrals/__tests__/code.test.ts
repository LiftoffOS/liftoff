// The share code's shape.
//
// It goes in a URL somebody may read aloud or retype from a phone screen, and it
// is minted once and never rotated, so a rename cannot break links already in
// inboxes. It also must not carry anything about the workspace: the previous
// format embedded the workspace name, and because most workspaces are still on
// the default the common link published the owner's first name.

import { mintReferralCode } from '../code';

describe('mintReferralCode', () => {
  const draw = (n: number) => Array.from({ length: n }, () => mintReferralCode());

  it('is six characters of digits and consonants', () => {
    for (const code of draw(200)) {
      expect(code).toMatch(/^[0-9bcdfghjkmnpqrstvwxyz]{6}$/);
    }
  });

  // No vowels, so a random draw can never spell a word at somebody.
  it('cannot spell anything', () => {
    for (const code of draw(500)) {
      expect(code).not.toMatch(/[aeiou]/);
    }
  });

  // i/l/o/u are the characters people mistake for 1 and 0.
  it('omits the characters that are misread', () => {
    for (const code of draw(500)) {
      expect(code).not.toMatch(/[ilou]/);
    }
  });

  // The whole point of the change: the code is opaque. The signature enforces it
  // — there is no workspace to pass — and this is the regression guard for
  // anyone tempted to reintroduce a readable stem.
  it('takes nothing about the workspace', () => {
    expect(mintReferralCode).toHaveLength(0);
  });

  // Six characters over a 30-character alphabet is 729,000,000 codes, so 5,000
  // draws collide 1.70% of the time — this asserted zero collisions and failed
  // roughly one run in 59, which is what it did.
  //
  // Zero is not assertable and was never the contract: mintReferralCode returns
  // a CANDIDATE, and `ensureCode` retries on the unique violation because "the
  // constraint is the only thing that actually decides". A test demanding a
  // guarantee the function disclaims fails at random and teaches people to
  // re-run the build.
  //
  // What is worth pinning is the entropy. Expected collisions here are 0.017,
  // so a bound of four fails about once in 282,000,000 runs, while a generator
  // that lost even one character of length would produce ~15 and a generator
  // down to three characters ~463. The bound separates those cleanly.
  it('draws from the full code space, so collisions stay vanishingly rare', () => {
    const codes = draw(5_000);
    const collisions = codes.length - new Set(codes).size;
    expect(collisions).toBeLessThanOrEqual(4);
  });

  // 256 is not a multiple of 30, so a plain `byte % 30` would map bytes 240-255
  // onto the FIRST SIXTEEN characters a second time, drawing them 9/256 of the
  // time against 8/256 for the rest.
  //
  // A max-versus-min frequency bound does not catch that: the skew is about 5%
  // and per-character noise at any sane sample size is larger. The bias is
  // structural though — it lands entirely on a known half of the alphabet — so
  // compare the two groups instead. Unbiased the ratio is just 16/14 = 1.143;
  // with the modulo bias it goes to 1.286, which this bound separates cleanly.
  it('draws the alphabet evenly, with no modulo bias', () => {
    const OVER_REPRESENTED = '0123456789bcdfgh'; // indices 0-15
    const REST = 'jkmnpqrstvwxyz'; // indices 16-29

    let head = 0;
    let tail = 0;
    const seen = new Set<string>();
    for (const code of draw(4_000)) {
      for (const ch of code) {
        seen.add(ch);
        if (OVER_REPRESENTED.includes(ch)) head += 1;
        else if (REST.includes(ch)) tail += 1;
        else throw new Error(`character outside the alphabet: ${ch}`);
      }
    }

    expect(seen.size).toBe(30);
    expect(head / tail).toBeLessThan(1.2);
    expect(head / tail).toBeGreaterThan(1.09);
  });
});
