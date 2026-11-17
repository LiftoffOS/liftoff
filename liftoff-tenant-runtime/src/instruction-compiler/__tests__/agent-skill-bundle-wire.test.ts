// The wire field that gets silently dropped.
//
// Skills reach this runtime as whole objects, but they are PERSISTED by two
// hand-written INSERT statements that name every column. A field added to the
// payload and not to those statements arrives, typechecks, and is thrown away
// — with nothing failing, because nothing compares the payload to the row.
//
// That is the failure this file exists to catch, so it asserts the statements
// themselves rather than a happy path through them: a happy-path test that
// mocked the pool would pass against a builder that dropped the column.

import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'internal-agent-instruction-service.ts'),
  'utf8',
);

/** Every `INSERT INTO agent_skills …` statement in the service, as text. */
function agentSkillInserts(): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = SOURCE.indexOf('INSERT INTO agent_skills', from);
    if (start === -1) break;
    // To the end of the template literal that holds the statement.
    const end = SOURCE.indexOf('`', start);
    out.push(SOURCE.slice(start, end === -1 ? start + 2000 : end));
    from = start + 1;
  }
  return out;
}

describe('agent_skills inserts carry the whole skill', () => {
  it('finds the statements at all, so this cannot pass vacuously', () => {
    expect(agentSkillInserts().length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['bundle', /\bbundle\b/],
    ['provenance', /\bprovenance\b/],
    ['protected', /\bprotected\b/],
  ])('every insert names %s in its column list', (_name, pattern) => {
    for (const statement of agentSkillInserts()) {
      const columnList = statement.slice(0, statement.indexOf('VALUES'));
      expect(columnList).toMatch(pattern);
    }
  });

  it('every insert also updates bundle on conflict', () => {
    // Without this an existing skill keeps whatever bundle it had when it was
    // first written, so removing or replacing a skill's files would never
    // reach the row.
    for (const statement of agentSkillInserts()) {
      expect(statement).toMatch(/bundle\s*=\s*EXCLUDED\.bundle/);
    }
  });
});
