// The voice block cannot change quietly.
//
// It is carried by four customer-facing surfaces across two repos and one database
// row, and three of those copies are reached by mechanisms no compiler checks: a
// sibling checkout, and a seeded `internal_agents.system_prompt`. So the text is
// pinned to a checksum. Editing a rule fails here, and the failure is the reminder
// that the same edit has to reach:
//
//   1. the sibling repo's packages/shared-types (scripts/ci-fences/agent-voice-parity.sh)
//   2. the Chief AI Officer's seeded row, via a NEW migration
//      (scripts/__tests__/caio-prompt-voice-sync.test.ts pins that one)
//
// Without the pin, a one-word edit here ships to Liftoff and the Insights Manager
// immediately, reaches customer agents only when the tenant-runtime is next
// deployed, and never reaches the Chief AI Officer at all. Three surfaces would then
// state three different versions of the same rule, which is precisely the state this
// work was done to end.

import { createHash } from 'crypto';
import { AGENT_VOICE_BLOCK, AGENT_VOICE_BLOCK_SHA } from '../agent-voice';

/** Real verb contractions only. A possessive apostrophe-s is not one, so `'s`
 *  counts only after the pronouns that actually form a contraction. Shared with
 *  the per-surface prompt tests, which apply the same rule to their own prose. */
export const CONTRACTION =
  /\b\w+(?:'|’)(?:t|re|ve|ll|m)\b|\b(?:it|that|there|here|what|who|he|she|let)(?:'|’)s\b/i;

describe('the canonical voice block', () => {
  it('matches its pinned checksum', () => {
    const actual = createHash('sha256').update(AGENT_VOICE_BLOCK).digest('hex').slice(0, 16);

    expect(actual).toBe(AGENT_VOICE_BLOCK_SHA);
  });

  it('obeys the rules it states', () => {
    // A prompt that breaks its own rule is a demonstration, and a model follows
    // demonstrations more readily than instructions. Contractions are checked
    // outside the quoted examples, which quote banned phrasing verbatim so the
    // model recognises it.
    //
    // Possessives are not contractions: "the team's own name" is fine, "it's" is
    // not. So `'s` counts only after the pronouns that form a real contraction.
    const withoutQuotedExamples = AGENT_VOICE_BLOCK.replace(/"[^"]*"/g, '');

    expect(AGENT_VOICE_BLOCK).not.toContain('—');
    expect(withoutQuotedExamples).not.toMatch(CONTRACTION);
  });

  it('states every rule the four surfaces used to disagree about', () => {
    // Each of these was present on some surfaces and missing from others before the
    // block existed. Listing them here is what makes "uniform" checkable rather
    // than a claim in a commit message.
    const required = [
      'No throat-clearing openers',
      'leverage, empower, streamline',
      'No binary-contrast or negative-listing tics',
      'No faux-insight setups',
      'Vary sentence length',
      'no emoji headings',
      'Never use an em dash',
      'Write "do not", "it is", "you will" in full',
      'never "AI team"',
      'The product is called Liftoff.',
      'the underlying model or vendor',
      'Never narrate your tool access',
      'Never expose internal errors',
      'Never expose raw database identifiers',
      'Do not invent capabilities you were not granted',
    ];

    for (const rule of required) {
      expect(AGENT_VOICE_BLOCK).toContain(rule);
    }
  });

  it('is re-exported, never redeclared, in this repo', () => {
    // A second declaration would pass every other assertion here while drifting
    // from the package the sibling repo and the migration are pinned to.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'agent-voice.ts'),
      'utf8',
    );

    expect(src).toContain("from '@liftoffos/shared-types'");
    expect(src).not.toMatch(/const AGENT_VOICE_BLOCK\s*=/);
  });
});
