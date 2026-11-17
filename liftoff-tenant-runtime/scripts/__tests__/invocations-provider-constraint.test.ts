// The CHECK constraints that enumerate providers and engines must admit
// everything the code can resolve.
//
// Each of them is a hand-written copy of a TypeScript union, living in SQL
// where the type system cannot see it, and each has been missed once per value
// added:
//
//   chk_invocations_provider          missed 'openrouter' (fixed by 310),
//                                     then 'xai' (391)
//   chk_*_execution_engine            missed 'xai-openai-wire' (392)
//
// The two fail differently, and the quieter one is worse. A missing PROVIDER
// fails the invocation INSERT, so the run dies with a message naming a
// constraint rather than a vendor. A missing ENGINE does not fail at all — the
// column is nullable, so the row records NULL and reads back as
// `unknown-legacy`, and the run succeeds, bills and returns with no provenance.
//
// Reading the lists out of the migrations is the only way to compare them
// without a database: the unit suite has none, and the migration gate can only
// prove the SQL applies, not that it agrees with the code.

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { RESOLVED_PROVIDERS } from '../../src/agent-execution/adapter/types';
import { VENDOR_ENGINE_IDS, UNKNOWN_ENGINE } from '../../src/agent-execution/adapter/vendors';

/** Every engine id that exists, sentinel included — which is exactly what the
 *  constraints must admit: a row can hold the sentinel even though nothing
 *  resolves to it. */
const ALL_ENGINE_IDS = [...VENDOR_ENGINE_IDS, UNKNOWN_ENGINE];

const MIGRATIONS = join(__dirname, '..', '..', 'migrations');

/** Values the column HOLDS that nothing resolves any more.
 *
 *  'openrouter' named the gateway that GLM, Qwen, DeepSeek and Kimi are reached
 *  through, and every run on those four recorded it until they became providers
 *  in their own right. The rows stay as written — history is not rewritten to
 *  match a vocabulary it predates — so the constraint must keep admitting it
 *  while nothing produces it.
 *
 *  'anthropic-vertex' is the same shape from the other direction: it named
 *  Claude served over Google Vertex, which is retired and absent from VENDORS,
 *  so nothing resolves it — but migration 045 backfilled EVERY pre-045
 *  invocations row to it as the fallback default, which makes it the most
 *  common value in the table's early history. Dropping it from the constraint
 *  would make those rows unupdatable and break repricing. */
const HISTORICAL_ONLY = new Set(['openrouter', 'anthropic-vertex']);

/** The value list from the LAST migration that defines `constraint`.
 *
 *  Last, not first: these constraints are dropped and recreated each time they
 *  are widened, so only the newest definition is in effect. */
function currentConstraintValues(constraint: string, column: string): string[] {
  const defining = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => readFileSync(join(MIGRATIONS, f), 'utf8').includes(`ADD CONSTRAINT ${constraint}`))
    // Numeric order — '99' sorts after '310' as a string.
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  const newest = defining[defining.length - 1];
  if (!newest) throw new Error(`no migration defines ${constraint}`);

  const sql = readFileSync(join(MIGRATIONS, newest), 'utf8');
  const after = sql.slice(sql.lastIndexOf(`ADD CONSTRAINT ${constraint}`));
  const list = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(after);
  if (!list) throw new Error(`could not read the ${column} list out of ${newest}`);

  return [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('the schema admits every provider and engine the code can resolve', () => {
  it('invocations.provider matches RESOLVED_PROVIDERS', () => {
    // Set equality in BOTH directions. A provider missing from the constraint
    // fails every run that resolves it; one in the constraint that the code
    // cannot resolve is usually the trace of a provider removed without the
    // schema following.
    //
    // HISTORICAL_ONLY is the exception, and it is deliberately a list rather
    // than a loosening: a value here is one the column still HOLDS and nothing
    // still WRITES. Tolerating unresolvable values in general would give back
    // exactly the second half of this check.
    expect(currentConstraintValues('chk_invocations_provider', 'provider')
      .filter((v) => !HISTORICAL_ONLY.has(v))
      .sort())
      .toEqual([...RESOLVED_PROVIDERS].sort());
  });

  it('keeps admitting the values already written', () => {
    // An invocations row records what ran. Dropping one of these would make the
    // constraint disagree with the table it guards — and the next ALTER that
    // revalidates it would fail on data nobody can change.
    const admitted = new Set(currentConstraintValues('chk_invocations_provider', 'provider'));
    for (const value of HISTORICAL_ONLY) expect({ value, admitted: admitted.has(value) })
      .toEqual({ value, admitted: true });
  });

  it.each([
    ['chk_invocations_execution_engine'],
    ['chk_agent_trajectories_execution_engine'],
  ])('%s matches ALL_ENGINE_IDS', (constraint) => {
    // Both tables carry the same list for the same reason. Widening one alone
    // leaves a trajectory that cannot describe the invocation it belongs to,
    // so they are checked together.
    expect(currentConstraintValues(constraint, 'execution_engine').sort())
      .toEqual([...ALL_ENGINE_IDS].sort());
  });
});
