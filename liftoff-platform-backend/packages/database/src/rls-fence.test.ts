import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runRlsFence } from './rls-fence.js';

describe('rls-fence', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rls-fence-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, contents: string): Promise<void> {
    const full = path.join(dir, name);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, contents);
  }

  it('flags raw pool.query calls outside withTenantContext', async () => {
    await write(
      'bad.ts',
      `import type { Pool } from 'pg';
export async function run(pool: Pool) {
  const { rows } = await pool.query('SELECT 1');
  return rows;
}`,
    );
    const violations = await runRlsFence(dir);
    expect(violations.length).toBe(1);
    expect(violations[0].code).toMatch(/pool\.query/);
  });

  it('allows client.query calls inside withTenantContext', async () => {
    await write(
      'ok.ts',
      `import { withTenantContext } from '@liftoffos/database';
export async function run(pool: any, tenantId: string) {
  return withTenantContext(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT 1');
    return rows;
  });
}`,
    );
    const violations = await runRlsFence(dir);
    expect(violations).toEqual([]);
  });

  // The defect this fence existed to catch, and did not: a type argument between
  // `.query` and the paren made the call invisible. It is the shape of an
  // unscoped `subscriptions` read that can break the referral programme.
  it('flags a query carrying a type argument', async () => {
    await write('svc.ts', [
      'export async function f(pool: any) {',
      '  const { rows } = await pool.query<{ count: string }>(`SELECT 1`);',
      '  return rows;',
      '}',
    ].join('\n'));

    const v = await runRlsFence(dir);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(2);
  });

  // The generic often wraps, putting the paren on a later line entirely.
  it('flags a query whose type argument spans lines', async () => {
    await write('svc.ts', [
      'export async function f(pool: any) {',
      '  const { rows } = await pool.query<{',
      '    count: string;',
      '  }>(`SELECT 1`);',
      '  return rows;',
      '}',
    ].join('\n'));

    const v = await runRlsFence(dir);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(2);
  });

  it('does not flag a scoped query that carries a type argument', async () => {
    await write('svc.ts', [
      'export async function f() {',
      '  return withTenantScope(t, async (client: any) => {',
      '    const { rows } = await client.query<{ id: string }>(`SELECT 1`);',
      '    return rows;',
      '  });',
      '}',
    ].join('\n'));

    expect(await runRlsFence(dir)).toHaveLength(0);
  });

  // A service that renames the helper still gets fenced, instead of papering
  // over correctly-scoped queries with allow directives.
  it('accepts a service-local wrapper name via extraWrappers', async () => {
    await write('svc.ts', [
      'export async function f() {',
      '  return withBillingTenant(t, async (client: any) => {',
      '    const { rows } = await client.query<{ id: string }>(`SELECT 1`);',
      '    return rows;',
      '  });',
      '}',
    ].join('\n'));

    expect(await runRlsFence(dir)).toHaveLength(1);
    expect(await runRlsFence(dir, { extraWrappers: ['withBillingTenant'] })).toHaveLength(0);
  });

  // extraWrappers must not blind the fence to genuinely unscoped calls.
  it('still flags an unscoped query when extraWrappers is set', async () => {
    await write('svc.ts', [
      'export async function f(pool: any) {',
      '  const { rows } = await pool.query<{ id: string }>(`SELECT 1`);',
      '  return rows;',
      '}',
    ].join('\n'));

    expect(await runRlsFence(dir, { extraWrappers: ['withBillingTenant'] })).toHaveLength(1);
  });

  // The case an earlier version of the boundary check got wrong: `hasActiveSubscription` is a class METHOD, so
  // a column-0 boundary never matched, the scan ran past it into a previous
  // method's wrapper, and the unscoped query was declared fine.
  it('does not let one method inherit scope from another', async () => {
    await write('svc.ts', [
      'export class Service {',
      '  async scoped(t: string) {',
      '    return withTenantScope(t, async (client: any) => {',
      '      const { rows } = await client.query<{ a: string }>(`SELECT 1`);',
      '      return rows;',
      '    });',
      '  }',
      '',
      '  private async unscoped(t: string) {',
      '    const { rows } = await this.pool.query<{ count: string }>(`SELECT 2`);',
      '    return rows;',
      '  }',
      '}',
    ].join('\n'));

    const v = await runRlsFence(dir);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(10);
  });

  // Scope set once at the top of a long handler covers the queries below it.
  // The old fixed 40-line lookback failed this, which is why correctly-scoped
  // code accumulated allow directives.
  it('honours scope established far above, within the same function', async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `  const x${i} = ${i};`);
    await write('svc.ts', [
      'export async function handler(client: any) {',
      "  await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', t]);",
      ...filler,
      '  const { rows } = await client.query<{ a: string }>(`SELECT 1`);',
      '  return rows;',
      '}',
    ].join('\n'));

    expect(await runRlsFence(dir)).toHaveLength(0);
  });

  // A control-flow block opens a brace but is not a declaration; treating it as
  // one would cut the scan short and re-introduce false positives.
  it('does not treat if/try blocks as a function boundary', async () => {
    await write('svc.ts', [
      'export async function handler(client: any) {',
      "  await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', t]);",
      '  try {',
      '    if (cond) {',
      '      const { rows } = await client.query<{ a: string }>(`SELECT 1`);',
      '      return rows;',
      '    }',
      '  } catch (e) {}',
      '}',
    ].join('\n'));

    expect(await runRlsFence(dir)).toHaveLength(0);
  });

  // A signature can prove scope where the fence cannot follow it. This is the
  // category that produced ten suppressions in billing: the caller scoped the
  // client, the callee could not say so, and a comment stood in for the fact.
  it('accepts a function that declares a TenantScopedClient', async () => {
    await write('svc.ts', [
      'export async function handler(',
      '  client: TenantScopedClient,',
      '  other: string,',
      ') {',
      '  const { rows } = await client.query<{ a: string }>(`SELECT 1`);',
      '  return rows;',
      '}',
    ].join('\n'));

    expect(await runRlsFence(dir)).toHaveLength(0);
  });

  it('still flags a function that takes a plain PoolClient', async () => {
    await write('svc.ts', [
      'export async function handler(',
      '  client: PoolClient,',
      ') {',
      '  const { rows } = await client.query<{ a: string }>(`SELECT 1`);',
      '  return rows;',
      '}',
    ].join('\n'));

    expect(await runRlsFence(dir)).toHaveLength(1);
  });

  // The type must be on THIS declaration, not a neighbouring one.
  it('does not let a scoped signature cover the next function', async () => {
    await write('svc.ts', [
      'export async function scoped(client: TenantScopedClient) {',
      '  return client.query(`SELECT 1`);',
      '}',
      '',
      'export async function unscoped(pool: any) {',
      '  const { rows } = await pool.query<{ a: string }>(`SELECT 2`);',
      '  return rows;',
      '}',
    ].join('\n'));

    const v = await runRlsFence(dir);
    expect(v).toHaveLength(1);
    expect(v[0].line).toBe(6);
  });

  // A statement that merely looks like a call must not end the scan. This one
  // did: `throw new Error('...');` sits between a scoped signature and a query
  // 70 lines below it, and the fence reported the query as unscoped.
  it('does not treat a throw statement as a function boundary', async () => {
    await write('svc.ts', [
      'export async function handler(',
      '  client: TenantScopedClient,',
      ') {',
      '  if (bad) {',
      "    throw new Error('no_stripe_customer_for_retry');",
      '  }',
      '  const { rows } = await client.query<{ a: string }>(`SELECT 1`);',
      '  return rows;',
      '}',
    ].join('\n'));

    expect(await runRlsFence(dir)).toHaveLength(0);
  });

  it('respects the allow directive', async () => {
    await write(
      'allowed.ts',
      `// rls-fence: allow
export async function run(pool: any) {
  return pool.query('SELECT * FROM tenants');
}`,
    );
    const violations = await runRlsFence(dir);
    expect(violations).toEqual([]);
  });

  it('skips test + dist + .d.ts files', async () => {
    await write(
      'bad.test.ts',
      `export async function run(pool: any) { return pool.query('x'); }`,
    );
    const violations = await runRlsFence(dir);
    expect(violations).toEqual([]);
  });

  it('does not flag transaction-control statements', async () => {
    await write(
      'tx.ts',
      `export async function run(client: any) {
  await client.query('BEGIN');
  await client.query('COMMIT');
  try { await client.query('ROLLBACK'); } catch { /* ignore */ }
}`,
    );
    const violations = await runRlsFence(dir);
    expect(violations).toEqual([]);
  });

  it('recognizes set_config-in-tx as establishing tenant scope', async () => {
    await write(
      'setconfig.ts',
      `export async function run(client: any, tenantId: string) {
  await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant_id', tenantId]);
  const { rows } = await client.query('SELECT * FROM subscriptions');
  return rows;
}`,
    );
    const violations = await runRlsFence(dir);
    expect(violations).toEqual([]);
  });

  it('supports an inline per-line allow directive', async () => {
    await write(
      'perline.ts',
      `export async function run(pool: any, tenantIds: string[]) {
  // deliberate cross-tenant admin op
  const a = await pool.query( // rls-fence: allow
    'DELETE FROM payment_methods WHERE tenant_id = ANY($1)', [tenantIds]);
  const b = await pool.query('SELECT 1 FROM x WHERE tenant_id = ANY($1)', [tenantIds]); // rls-fence: allow
  return [a, b];
}`,
    );
    const violations = await runRlsFence(dir);
    expect(violations).toEqual([]);
  });

  it('still flags an unscoped query when only OTHER lines are allowed', async () => {
    await write(
      'partial.ts',
      `export async function run(pool: any) {
  const a = await pool.query('SELECT 1'); // rls-fence: allow
  const b = await pool.query('SELECT 2');
  return [a, b];
}`,
    );
    const violations = await runRlsFence(dir);
    expect(violations.length).toBe(1);
    expect(violations[0].line).toBe(3);
  });

  it('honors an indented file-level allow directive', async () => {
    await write(
      'indented.ts',
      `export async function run(pool: any) {
  // rls-fence: allow
  return pool.query('SELECT * FROM tenants');
}`,
    );
    const violations = await runRlsFence(dir);
    expect(violations).toEqual([]);
  });
});
