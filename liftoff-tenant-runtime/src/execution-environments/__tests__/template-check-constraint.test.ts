// FITNESS FUNCTION — every sandbox template the code can ask for is one the
// database will accept.
//
// `ExecutionEnvironmentType` is a TypeScript union. The two tables that record a
// sandbox carry a CHECK constraint listing the same values, and nothing connects
// them: adding a member to the union compiles, passes lint, passes every unit
// test, and fails the first time a real sandbox is provisioned with it —
//
//   new row for relation "sandbox_state" violates check constraint
//   "sandbox_state_template_check"
//
// reaching the agent as "sandbox workspace unavailable ... transport_500".
//
// This has now happened twice. Migration 266 widened `sandbox_state` and left
// `sandbox_usage_log` behind, so sandboxes provisioned and only the billing
// insert failed, which migration 282 came back for. Adding
// 'aio-sandbox-coding' repeated the first half of it.
//
// Both tables are checked, because widening one is what made the second bug
// survivable enough to ship.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..');
const TYPES = readFileSync(join(ROOT, 'src', 'execution-environments', 'types.ts'), 'utf8');

/** The members of the ExecutionEnvironmentType union.
 *
 *  Comments are stripped BEFORE the union is split on its terminating `;`.
 *  The first version of this did not, and a doc comment on the last member
 *  contained a semicolon — so the union was truncated one member early, the
 *  new template was never in the parsed set, and this whole file passed while
 *  the constraint it checks was missing. It reproduced, inside its own
 *  parser, the class of defect it exists to catch. */
function templatesInCode(): string[] {
  const withoutComments = TYPES
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const block = withoutComments.split('export type ExecutionEnvironmentType =')[1]?.split(';')[0] ?? '';
  return [...block.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
}

/** The values the LAST migration to touch a table's template CHECK allows. */
function templatesAllowedBySql(table: string): string[] {
  const dir = join(ROOT, 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  let allowed: string[] = [];
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    // `ADD CONSTRAINT <table>_template_check CHECK (template IN (...))`
    const re = new RegExp(
      `ALTER TABLE\\s+${table}\\s+ADD CONSTRAINT\\s+\\S*template\\S*\\s+CHECK\\s*\\(\\s*template IN \\(([^)]*)\\)`,
      'is',
    );
    const m = sql.match(re);
    if (m) allowed = [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]).sort();
  }
  return allowed;
}

describe('sandbox templates', () => {
  const inCode = templatesInCode();

  it('parses the WHOLE union, including its last member', () => {
    // Naming the last member specifically: a parser that truncates the union
    // makes every assertion below pass for the wrong reason, and the newest
    // member is always the one at risk.
    expect(inCode.length).toBeGreaterThan(0);
    expect(inCode).toContain('aio-sandbox');
    expect(inCode).toContain('aio-sandbox-coding');
  });

  it.each(['sandbox_state', 'sandbox_usage_log'])(
    '%s accepts every template the code can ask for',
    (table) => {
      const allowed = templatesAllowedBySql(table);
      const missing = inCode.filter((t) => !allowed.includes(t));
      expect({
        table,
        missing,
        hint: missing.length === 0
          ? 'ok'
          : `Add a migration widening ${table}'s template CHECK. A template the database `
            + 'rejects fails at provisioning time, and reaches the agent as an opaque '
            + '"sandbox workspace unavailable ... transport_500".',
      }).toEqual({ table, missing: [], hint: 'ok' });
    },
  );

  it('the two tables agree with each other', () => {
    // They drifted once (266 widened one, 282 fixed the other months later),
    // and the gap is invisible until a sandbox runs and its billing row does not.
    expect(templatesAllowedBySql('sandbox_state'))
      .toEqual(templatesAllowedBySql('sandbox_usage_log'));
  });
});
