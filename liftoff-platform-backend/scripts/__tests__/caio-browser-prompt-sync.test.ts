// Every host reads the browser in one phrasing, and there is now one place
// that phrasing lives.
//
// This file used to assert that migration 512's seeded text and Liftoff's
// TypeScript prompt spelled the same sentences word for word — the only place
// a reworded sentence on one side could fail, because a row a migration writes
// is not type-checked. That was the right guard for the wrong arrangement:
// keeping two copies in step by testing them is weaker than having one copy,
// and it did not cover the Insights Manager (which had no browser section at
// all) or the runtime.
//
// `@liftoffos/browser-tools` owns the paragraph now. Liftoff and the Insights
// Manager interpolate it, workforce-service appends it to the Chief AI
// Officer's rendered prompt, and migration 544 takes 512's copy back out of
// the row so it cannot drift underneath. What is left to assert here is the
// half a package cannot enforce: that the seed really is emptied of it, and
// that the text the package holds keeps the product's voice.
//
// The rendered-prompt half lives in
// src/browser-sessions/__tests__/browser-tools-parity.test.ts.

import { readFileSync } from 'fs';
import { join } from 'path';
import { BROWSER_GUIDANCE } from '@liftoffos/browser-tools';

/** Real verb contractions only; a possessive apostrophe-s is not one. */
const CONTRACTION =
  /\b\w+(?:'|’)(?:t|re|ve|ll|m)\b|\b(?:it|that|there|here|what|who|he|she|let)(?:'|’)s\b/i;

const MIGRATION_512 = join(__dirname, '..', '..', 'migrations', '512_caio_browser_state_and_pane_actions.sql');
const MIGRATION_544 = join(__dirname, '..', '..', 'migrations', '544_caio_browser_guidance_leaves_the_seed.sql');

describe('the browser paragraph lives in one place', () => {
  const sql512 = readFileSync(MIGRATION_512, 'utf8');
  const sql544 = readFileSync(MIGRATION_544, 'utf8');

  it('migration 544 removes exactly what 512 wrote, byte for byte', () => {
    const written = sql512.slice(sql512.indexOf('$Hn$') + '$Hn$'.length, sql512.lastIndexOf('$Hn$'));
    const removed = sql544.slice(sql544.indexOf('$Ho$') + '$Ho$'.length, sql544.indexOf('$Ho$,'));
    // 512 appended its paragraph after an anchor sentence it also quotes; the
    // removal is that paragraph and the blank line before it, and nothing else.
    expect(written.endsWith(removed)).toBe(true);
    expect(removed.trim().startsWith('The Browser section below this prompt')).toBe(true);
  });

  it('migration 544 proves the seed is empty of it, and leaves 512\'s anchor and 515\'s paragraph standing', () => {
    expect(sql544).toContain("RAISE EXCEPTION 'migration 544: the seeded browser paragraph is still in the row'");
    expect(sql544).toContain("RAISE EXCEPTION 'migration 544: the anchor migration 512 appended to was lost'");
    expect(sql544).toContain("RAISE EXCEPTION 'migration 544: migration 515 sign-in guidance was lost'");
    expect(sql544).toContain('ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;');
    expect(sql544).toContain('ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;');
  });

  // The product's voice: no contractions, no em dashes, and "agent" rather
  // than the earlier coined noun "AI team", which may not appear.
  it('keeps the product\'s voice: no contractions, no em dashes, never "AI team"', () => {
    expect(BROWSER_GUIDANCE).not.toMatch(CONTRACTION);
    expect(BROWSER_GUIDANCE).not.toContain('—');
    expect(BROWSER_GUIDANCE).not.toMatch(/\bAI teams?\b/i);
  });
});
