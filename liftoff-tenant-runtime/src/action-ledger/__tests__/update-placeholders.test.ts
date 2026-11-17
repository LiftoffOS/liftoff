// Every dynamic SET clause binds a PARAMETER, not the parameter's index.
//
// `${paramIndex++}` and `$${paramIndex++}` differ by one character and produce
// SQL that differs entirely: the first interpolates the NUMBER, so the clause
// becomes `completed_at = 7`.
//
// One of the two bugs this pins announced itself — Postgres refuses an integer
// for a timestamptz, which is how it was found, on the first real dispatch
// through this path. The other did not and could not: `target_ref` is text, so
// `target_ref = 6` is a valid assignment and the row silently stores "6".
//
// That one matters. `target_ref` is what the idempotency ledger reads to answer
// "have I already acted on this?", so a create whose target_ref is a small
// integer collides with every other create that happened to land on the same
// parameter position, and stops matching the thing it actually created. It is
// the same class of defect as the gate looking the catalog up in the wrong key
// space: no error, wrong answer, and the wrong answer looks ordinary.
//
// Checked as SOURCE because that is where the character is. Driving the
// repository would need a database, and the property is a property of the
// string being built, not of any row that comes back.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'repository.ts'), 'utf8');

describe('dynamic SET clauses', () => {
  it('never interpolates a bare parameter index', () => {
    // Matches `= ${paramIndex` or `THEN ${paramIndex` with no `$` in front.
    const bare = [...SRC.matchAll(/[^$]\$\{paramIndex\+\+\}/g)].map((m) => m[0]);
    expect(bare).toEqual([]);
  });

  it('builds every one as a real placeholder', () => {
    const placeholders = SRC.match(/\$\$\{paramIndex\+\+\}/g) ?? [];
    // Seven today. The count is asserted so that deleting a clause to make the
    // test above pass is not a way through.
    expect(placeholders.length).toBeGreaterThanOrEqual(7);
  });

  it('keeps the two that were wrong wired to parameters', () => {
    // Named, because these are the two that were broken and a regression here
    // is silent for one of them.
    expect(SRC).toMatch(/completed_at = \$\$\{paramIndex\+\+\}/);
    expect(SRC).toMatch(/target_ref = CASE WHEN target_ref = '' THEN \$\$\{paramIndex\+\+\}/);
  });
});
