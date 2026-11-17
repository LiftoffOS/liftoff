// The Chief AI Officer's copy of the removal rule, which no compiler reads.
//
// Liftoff and the Insights Manager import REMOVING_AN_AI_TEAM_BLOCK, so a
// reworded rule reaches them as soon as the module changes. The third copy is a
// seeded `internal_agents.system_prompt` row written by a migration: a string in
// a .sql file that nothing else in this repo would ever read. That is the copy
// that goes stale, and this is the only place it can fail.
//
// Same shape as caio-prompt-voice-sync.test.ts, and for the same reason it names
// one migration rather than "the newest one mentioning caio": an applied
// migration is never edited, so when the rule changes a NEW migration lands and
// this file is pointed at it.

import { readFileSync } from 'fs';
import { join } from 'path';
import { REMOVING_AN_AI_TEAM_BLOCK } from '../../src/shared/removing-an-ai-team';

/** Real verb contractions only; a possessive apostrophe-s is not one. */
const CONTRACTION =
  /\b\w+(?:'|’)(?:t|re|ve|ll|m)\b|\b(?:it|that|there|here|what|who|he|she|let)(?:'|’)s\b/i;

const MIGRATION = join(__dirname, '..', '..', 'migrations', '545_caio_removing_an_ai_team_is_one_action.sql');

/**
 * The substitution migration 564 applies to the seeded prompt, read out of 564
 * itself.
 *
 * 545 is applied and therefore frozen, so it says "AI team" and always will.
 * The row it wrote has since had 564's vocabulary substitution over it, and that
 * is what the module constant now describes. Parsing the pairs out of 564 rather
 * than restating them keeps this test from becoming a second place to maintain.
 */
function applyVocabularyMigration(text: string): string {
  const sql = readFileSync(
    join(__dirname, '..', '..', 'migrations', '564_caio_agent_vocabulary.sql'),
    'utf8',
  );
  // Order matters and mirrors the migration exactly: the eight noun passes run
  // first, then the one sentence pass over what they produce. Reversing them
  // restores the contradiction 564 exists to remove.
  const pairs = [
    ...sql.matchAll(/\$a\$(.*?)\$a\$,\s*\$b\$(.*?)\$b\$/g),
    ...sql.matchAll(/\$v\$(.*?)\$v\$,\s*\$w\$(.*?)\$w\$/g),
  ];
  if (pairs.length === 0) throw new Error('564 carries no substitution pairs');
  let out = text;
  for (const [, from, to] of pairs) out = out.split(from).join(to);
  return out;
}


describe('CAIO seeded prompt carries the removal rule', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  // Only the dollar-quoted replacement is the prompt text. The header comment
  // and both DO blocks NAME sentences from it in order to explain the change and
  // to assert on it, so scanning the whole file answers the wrong question.
  const inserted = applyVocabularyMigration(sql.slice(sql.indexOf('$Hn$') + '$Hn$'.length, sql.lastIndexOf('$Hn$')));

  it('contains REMOVING_AN_AI_TEAM_BLOCK verbatim', () => {
    expect(inserted).toContain(REMOVING_AN_AI_TEAM_BLOCK);
  });

  it('re-states the anchor it replaced, so the insert does not eat the next section', () => {
    expect(inserted).toContain('\n\n## Voice');
  });

  it('is written in the product voice', () => {
    expect(REMOVING_AN_AI_TEAM_BLOCK).not.toMatch(CONTRACTION);
    expect(REMOVING_AN_AI_TEAM_BLOCK).not.toMatch(/—/);
  });

  it('says the three things the rule is for', () => {
    // One action, no explanation, and no question standing between the person
    // and what they asked for. Each was a separate failure in the conversation
    // this came from; a reword that drops one leaves that failure open.
    expect(REMOVING_AN_AI_TEAM_BLOCK).toMatch(/all mean the same single action/);
    expect(REMOVING_AN_AI_TEAM_BLOCK).toMatch(/never explain what removing an agent does or does not keep/);
    expect(REMOVING_AN_AI_TEAM_BLOCK).toMatch(/never ask the person to accept a distinction before anything happens/);
  });
});
