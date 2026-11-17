// The tenant registry: which tenants this runtime serves.
//
// Every property here is one a single-tenant runtime never needed, and every
// one of them is violated by the helper this module replaces —
// `SELECT id FROM tenants LIMIT 1`, memoized, answering for many tenants with
// one of them.

const mockQuery = jest.fn();
jest.mock('../database', () => ({ getPool: () => ({ query: mockQuery }) }));
jest.mock('../logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { listTenantIds, isKnownTenant, forEachTenant } from '../tenant-registry';

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const B = 'bbbbbbbb-2222-4222-8222-222222222222';
const C = 'cccccccc-3333-4333-8333-333333333333';

function servesRows(ids: string[]) {
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/WHERE\s+id/i.test(sql)) {
      const hit = ids.includes(String(params?.[0]));
      return { rows: hit ? [{ present: 1 }] : [], rowCount: hit ? 1 : 0 };
    }
    return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  servesRows([A, B]);
});

describe('listTenantIds', () => {
  it('returns every tenant, not the first one', async () => {
    await expect(listTenantIds()).resolves.toEqual([A, B]);
  });

  it('does not cache across calls', async () => {
    // A runtime gains tenants while it is running. Memoizing the list leaves the
    // newest tenant out of every sweep until the next deploy, which is the same
    // silent skip in a slower form.
    await listTenantIds();
    servesRows([A, B, C]);
    await expect(listTenantIds()).resolves.toEqual([A, B, C]);
  });
});

describe('isKnownTenant', () => {
  it('accepts any tenant this runtime serves', async () => {
    await expect(isKnownTenant(A)).resolves.toBe(true);
    await expect(isKnownTenant(B)).resolves.toBe(true);
  });

  it('rejects a tenant it does not serve', async () => {
    await expect(isKnownTenant(C)).resolves.toBe(false);
  });
});

describe('forEachTenant', () => {
  it('runs once per tenant', async () => {
    const seen: string[] = [];
    const result = await forEachTenant('t', async (id) => { seen.push(id); return id; });

    expect(seen).toEqual([A, B]);
    expect(result).toMatchObject({ tenants: 2, ok: 2, failed: 0 });
  });

  it('keeps going after a tenant throws, and reports the failure', async () => {
    // With one tenant a throw was the whole answer. With several it silently
    // truncates coverage at whichever tenant happens to be broken, and every
    // tenant after it in the ordering pays for a fault that is not theirs.
    const seen: string[] = [];
    const result = await forEachTenant('t', async (id) => {
      seen.push(id);
      if (id === A) throw new Error('boom');
      return id;
    });

    expect(seen).toEqual([A, B]);
    expect(result.tenants).toBe(2);
    expect(result.ok).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[0]).toEqual({ tenantId: A, error: 'boom' });
    expect(result.results[1]).toEqual({ tenantId: B, value: B });
  });

  it('reports tenants considered, not tenants succeeded', async () => {
    // "swept 1 of 2" has to be legible from the response. A count that only
    // reported successes would make a half-broken sweep look like a healthy one.
    const result = await forEachTenant('t', async (id) => {
      if (id !== A) throw new Error('boom');
      return id;
    });

    expect(result.tenants).toBe(2);
    expect(result.ok).toBe(1);
  });
});
