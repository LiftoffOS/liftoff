// Every field the CLI sends must survive the wire validator.
//
// zod's `.object()` STRIPS unknown keys. It does not warn and it does not fail:
// the parsed value is then cast to MigrationBundleV1, so TypeScript sees a
// complete object and the missing field is invisible from both directions.
//
// That is how every imported schedule was lost. `cronExpr` was added to the CLI
// contract, the backend type, the distill input, the trigger override, the
// provisioning helper's precedence rule, and a test for each — and not to the
// schema. So distill_input.cronExpr was null for all four team members of a real
// import, and every trigger came from the distiller's guess instead of the
// source. One of them happened to guess a weekly cron for a member whose brief
// said "Monday", which is exactly how a single sample makes a broken path look
// like a working one.
//
// This test reads BOTH declarations and fails when a field exists on the wire
// type but not in the validator. It is a ratchet: adding a field to the contract
// without teaching the schema about it cannot pass.

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const CONTRACT = readFileSync(
  join(REPO_ROOT, 'packages', 'liftoff-cli', 'src', 'switch', 'contract.ts'),
  'utf8',
);
const ROUTER = readFileSync(join(REPO_ROOT, 'src', 'source-migrations', 'router.ts'), 'utf8');

/** Top-level property names declared in a TS interface body. */
function interfaceFields(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name}`);
  if (start < 0) throw new Error(`interface ${name} not found`);
  const body = source.slice(start, source.indexOf('\n}', start));
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]);
}

/** Top-level keys declared in a zod object literal. */
function zodKeys(source: string, name: string): string[] {
  const start = source.indexOf(`const ${name} = z.object({`);
  if (start < 0) throw new Error(`schema ${name} not found`);
  const body = source.slice(start, source.indexOf('\n});', start));
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]);
}

describe('the wire validator accepts everything the CLI sends', () => {
  it('finds both declarations, so this cannot pass vacuously', () => {
    expect(interfaceFields(CONTRACT, 'ImportedAgent').length).toBeGreaterThan(5);
    expect(zodKeys(ROUTER, 'agentSchema').length).toBeGreaterThan(5);
    expect(interfaceFields(CONTRACT, 'MigrationBundleV1').length).toBeGreaterThan(5);
    expect(zodKeys(ROUTER, 'bundleSchema').length).toBeGreaterThan(5);
  });

  it('keeps every ImportedAgent field', () => {
    const stripped = interfaceFields(CONTRACT, 'ImportedAgent').filter(
      (f) => !zodKeys(ROUTER, 'agentSchema').includes(f),
    );
    expect(stripped).toEqual([]);
  });

  it('keeps every MigrationBundleV1 field', () => {
    const schema = zodKeys(ROUTER, 'bundleSchema');
    const stripped = interfaceFields(CONTRACT, 'MigrationBundleV1').filter(
      (f) => !schema.includes(f),
    );
    expect(stripped).toEqual([]);
  });

  it('carries cronExpr specifically', () => {
    // Named on its own because it is the field whose loss had no symptom: the
    // import succeeded, four team members were created, and every one of them
    // ran on a schedule nobody asked for.
    expect(zodKeys(ROUTER, 'agentSchema')).toContain('cronExpr');
  });
});
