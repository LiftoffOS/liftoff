// The upload validator and the database must accept the same output types.
//
// Nothing else ties the two together, so they can drift. When the zod enum
// gains a value the CHECK constraint does not list (as with 'pdf' and
// 'binary', which the tenant runtime sends for browser PDF saves and browser
// downloads), every such upload dies on a 23514 check_violation AFTER the bytes
// are already in GCS and AFTER the caller has been told nothing was wrong.
// Migration 389 brings the constraint up to date.
//
// This test is what stops it recurring. It reads the constraint out of
// the migrations the way the database will, and compares it to the enum the
// route validates with. Adding a value to one without the other fails here,
// before it can fail in production.

import * as fs from 'fs';
import * as path from 'path';
import { outputTypeSchema } from '../store';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'migrations');

/** Every `CHECK (output_type IN (...))` written for generated_files, in
 *  migration order. The LAST one is what a from-scratch database ends up with,
 *  and — because each of these drops the constraint first — what every already
 *  migrated database ends up with too. */
function outputTypeCheckClauses(): Array<{ file: string; values: string[] }> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const out: Array<{ file: string; values: string[] }> = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    // Only statements that (re)define the constraint, not a stray mention in a
    // comment: the ADD CONSTRAINT and its CHECK list have to appear together.
    const re = /ADD\s+CONSTRAINT\s+generated_files_output_type_check\s+CHECK\s*\(\s*output_type\s+IN\s*\(([^)]*)\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const values = m[1]
        .split(',')
        .map((v) => v.trim().replace(/^'|'$/g, ''))
        .filter((v) => v.length > 0);
      out.push({ file, values });
    }
  }
  return out;
}

describe('generated_files.output_type — schema and validator agree', () => {
  it('has a migration that defines the constraint', () => {
    expect(outputTypeCheckClauses().length).toBeGreaterThan(0);
  });

  it('accepts every member of outputTypeSchema', () => {
    const clauses = outputTypeCheckClauses();
    const latest = clauses[clauses.length - 1];
    const accepted = new Set(latest.values);
    const missing = outputTypeSchema.options.filter((v) => !accepted.has(v));
    expect({ file: latest.file, missing }).toEqual({ file: latest.file, missing: [] });
  });

  it('accepts nothing the validator would reject', () => {
    // The other direction, which is cheap and closes the same class: a value
    // the table allows but the route refuses is a row only a hand-written
    // INSERT can produce, and nothing downstream is written to expect it.
    const clauses = outputTypeCheckClauses();
    const latest = clauses[clauses.length - 1];
    const declared = new Set<string>(outputTypeSchema.options);
    const extra = latest.values.filter((v) => !declared.has(v));
    expect({ file: latest.file, extra }).toEqual({ file: latest.file, extra: [] });
  });
});
