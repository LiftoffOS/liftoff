// The Chief AI Officer's prompt lives in the database, so nothing type-checks it.
//
// Three of the four customer-facing surfaces import AGENT_VOICE_BLOCK directly, so a
// reworded rule reaches them the moment the module changes. The fourth is a seeded
// `internal_agents.system_prompt` row written by a migration, which is a string in a
// .sql file that no compiler, linter or test would otherwise read. That copy is the
// one that silently goes stale.
//
// This asserts the migration contains the block verbatim. Rewording the module without
// writing the follow-up migration fails here, which is the only place it can fail.
//
// It reads one migration specifically rather than "the newest migration that mentions
// caio", because an applied migration is never edited: when the block changes, a NEW
// migration lands and this file is pointed at it. That is deliberate manual work, the
// same as any other prompt change reaching the database. 359 was the first such
// migration; 509 is the current one (the vocabulary rule).

import { readFileSync } from 'fs';
import { join } from 'path';
import { AGENT_VOICE_BLOCK } from '../../src/shared/agent-voice';

/** Real verb contractions only; a possessive apostrophe-s is not one. */
const CONTRACTION =
  /\b\w+(?:'|’)(?:t|re|ve|ll|m)\b|\b(?:it|that|there|here|what|who|he|she|let)(?:'|’)s\b/i;

const MIGRATION = join(__dirname, '..', '..', 'migrations', '509_caio_ai_team_vocabulary.sql');

/**
 * The substitution migration 564 applies to the seeded prompt, read out of 564
 * itself.
 *
 * The prompt the database holds is no longer any single migration's text: it is
 * 509's, with 512's, 515's and 545's replacements in it, and then 564's
 * vocabulary substitution over the result. An applied migration is never edited,
 * so 509 will say "AI team" forever and comparing it directly to a module that
 * now says "agent" compares two things that were never meant to match.
 *
 * Parsing the pairs out of 564 rather than restating them here is the point. A
 * hand-copied list would be a second place to keep in step, which is the exact
 * failure this family of tests exists to catch.
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


describe('CAIO seeded prompt carries the canonical voice block', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  // Only the dollar-quoted literal is the prompt. The header comment and the
  // verification block both NAME the sections being removed, in order to explain
  // the change and to assert their absence in SQL, so scanning the whole file for
  // "is this string gone" answers the wrong question.
  const prompt = applyVocabularyMigration(sql.slice(
    sql.indexOf('$PROMPT$') + '$PROMPT$'.length,
    sql.lastIndexOf('$PROMPT$'),
  ));

  it('contains AGENT_VOICE_BLOCK verbatim', () => {
    expect(prompt).toContain(AGENT_VOICE_BLOCK);
  });

  it('drops the two sections the block replaced', () => {
    // The failure this guards is additive: a migration that pastes the new block in
    // while leaving the old, narrower rules above it, so the prompt states both.
    expect(prompt).not.toContain('## Internal implementation details');
    expect(prompt).not.toContain('Writing quality: avoid AI filler phrases');
  });

  it('folds in the patches applied after migration 327', () => {
    // A wholesale rewrite reverts every patch since the last one unless it is
    // reproduced. 336 and 337 were regexp/replace patches over 327's text; 509
    // starts from the replay of 1 to 508 and guards on its md5, so these stay.
    expect(prompt).toContain('## Oversight');
    expect(prompt).not.toContain('## HITL level guidance');
    expect(prompt).toContain('New agents follow the workspace oversight default.');
    expect(prompt).toContain('Do NOT call `workforce_plan__draft` again on a confirmation');
  });

  it('leaves each render token exactly once', () => {
    // renderSystemPrompt substitutes with a string needle, which replaces only the
    // first occurrence. A second copy of any token would survive into the prompt.
    for (const token of ['{{TODAY}}', '{{PLAN_STATE}}', '{{TOOLS}}']) {
      expect(prompt.split(token).length - 1).toBe(1);
    }
  });

  it('obeys the rules the block states', () => {
    // The prompt inherited four em dashes and five contraction sites from migration
    // 327, two of which were scripts the model is told to say VERBATIM to a user
    // ("You'll need to connect [X]..."). A prompt that instructs an output its own
    // rules forbid is worse than one that stays silent: the model follows the
    // concrete example over the abstract rule.
    const ownProse = prompt.replace(AGENT_VOICE_BLOCK, '').replace(/"[^"]*"/g, '');

    expect(prompt).not.toContain('—');
    expect(ownProse).not.toMatch(CONTRACTION);
  });

  it('never names an oversight or HITL level', () => {
    // Migration 336 replaced the "## HITL level guidance" SECTION but left three
    // references behind: responsibility 5 asked for specs "with HITL levels" and the
    // team-type guidance still said "Start at HITL level 2". So the prompt told the
    // Chief AI Officer not to choose a level, in a document that twice told it which
    // level to choose, while the block forbids naming one at all.
    // Both rules that legitimately name the concept are removed first: the block's
    // confidentiality bullet ("never expose ... HITL level numbers") and the
    // Oversight section. What is left is the prompt's own instructional prose,
    // which must not name a level at all.
    const ownProse = prompt
      .replace(AGENT_VOICE_BLOCK, '')
      .replace(/## Oversight[\s\S]*?(?=\n## )/, '');

    expect(ownProse).not.toMatch(/HITL level/i);
    expect(prompt).toContain('New agents follow the workspace oversight default.');
  });

  it('wraps the write in the FORCE RLS escape', () => {
    // internal_agents is FORCE RLS and system agents carry tenant_id IS NULL, so the
    // UPDATE matches zero rows without this. Enforced by the CI fence as well; kept
    // here so the failure names the reason rather than a shell exit code.
    expect(sql).toContain('ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;');
    expect(sql).toContain('ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;');
  });
});
