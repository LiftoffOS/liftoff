import type { Pool, PoolClient } from 'pg';
import { withTenantScope, withAdminScope } from './tenant-scope.js';

function buildMockClient() {
  const queries: string[] = [];
  const params: unknown[][] = [];
  const client = {
    query: jest.fn(async (sql: string, p?: unknown[]) => {
      queries.push(sql);
      params.push(p ?? []);
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  return { client, queries, params };
}

function buildMockPool(client: { query: jest.Mock; release: jest.Mock }): Pool {
  return {
    connect: jest.fn(async () => client),
  } as unknown as Pool;
}

describe('withTenantScope', () => {
  it('wraps fn in BEGIN + SET LOCAL + COMMIT + RESET', async () => {
    const { client, queries, params } = buildMockClient();
    const pool = buildMockPool(client);

    const result = await withTenantScope(
      pool,
      'tenant-abc',
      { rlsVariableName: 'app.current_tenant_id' },
      async (c) => {
        await (c as unknown as PoolClient).query('SELECT 42');
        return 42;
      },
    );

    expect(result).toBe(42);
    expect(queries).toEqual([
      'BEGIN',
      'SELECT set_config($1, $2, true)',
      'SELECT 42',
      'COMMIT',
      'RESET app.current_tenant_id',
    ]);
    expect(params[1]).toEqual(['app.current_tenant_id', 'tenant-abc']);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and re-throws on error', async () => {
    const { client, queries } = buildMockClient();
    const pool = buildMockPool(client);
    const boom = new Error('boom');

    await expect(
      withTenantScope(
        pool,
        'tenant-abc',
        { rlsVariableName: 'app.tenant_id' },
        async () => {
          throw boom;
        },
      ),
    ).rejects.toBe(boom);

    expect(queries).toContain('ROLLBACK');
    expect(queries).toContain('RESET app.tenant_id');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('calls onComplete with tenantId and duration', async () => {
    const { client } = buildMockClient();
    const pool = buildMockPool(client);
    const onComplete = jest.fn();

    await withTenantScope(
      pool,
      'tenant-abc',
      { rlsVariableName: 'app.current_tenant_id', onComplete },
      async () => 'ok',
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toBe('tenant-abc');
    expect(typeof onComplete.mock.calls[0][1]).toBe('number');
  });

  it('swallows onComplete errors', async () => {
    const { client } = buildMockClient();
    const pool = buildMockPool(client);
    const onComplete = jest.fn(() => { throw new Error('metering oops'); });

    await expect(
      withTenantScope(
        pool,
        'tenant-abc',
        { rlsVariableName: 'app.current_tenant_id', onComplete },
        async () => 'ok',
      ),
    ).resolves.toBe('ok');

    expect(onComplete).toHaveBeenCalled();
  });

  it('uses the configured RLS variable name', async () => {
    const { client, queries } = buildMockClient();
    const pool = buildMockPool(client);

    await withTenantScope(
      pool,
      'tenant-abc',
      { rlsVariableName: 'my.custom_var' },
      async () => undefined,
    );

    expect(queries).toContain('SELECT set_config($1, $2, true)');
    expect(queries).toContain('RESET my.custom_var');
  });
});

describe('withAdminScope', () => {
  it('wraps fn in BEGIN + RESET + COMMIT and fires onInvoke', async () => {
    const { client, queries } = buildMockClient();
    const pool = buildMockPool(client);
    const onInvoke = jest.fn();

    const result = await withAdminScope(
      pool,
      { caller: 'admin/router', actor: 'alice', reason: 'manual edit' },
      { rlsVariableName: 'app.current_tenant_id', onInvoke },
      async () => 'done',
    );

    expect(result).toBe('done');
    expect(onInvoke).toHaveBeenCalledWith({
      caller: 'admin/router',
      actor: 'alice',
      reason: 'manual edit',
    });
    expect(queries).toEqual([
      'BEGIN',
      'RESET app.current_tenant_id',
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and re-throws on error', async () => {
    const { client, queries } = buildMockClient();
    const pool = buildMockPool(client);
    const boom = new Error('boom');

    await expect(
      withAdminScope(
        pool,
        { caller: 'admin/router' },
        { rlsVariableName: 'app.current_tenant_id' },
        async () => { throw boom; },
      ),
    ).rejects.toBe(boom);

    expect(queries).toContain('ROLLBACK');
  });
});
