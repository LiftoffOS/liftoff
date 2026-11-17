// A pool stub that answers `infrastructure/tenant-registry`'s two questions.
//
// Why a fixture rather than a mock of the registry: the registry decides which
// tenants a sweep covers and which events it accepts, and mocking it replaces
// the very behaviour under test with the test author's assumption. A suite that
// mocked "the tenant this runtime serves" to a single fixed id asserted that
// foreign traffic was dropped and that sweeps ran — both true of the mock, and
// both wrong in a deployment serving sixteen tenants, where "foreign" meant
// fifteen real customers. The mock could not fail, because the premise it
// encoded was the defect.
//
// So tests stub the DATABASE and let the real registry read it. Give a suite
// more than one tenant and a fan-out that covers only the first fails, which is
// the property that actually matters.
//
// `eslint-rules/no-mocked-tenant-registry.js` enforces the distinction.

/** Minimum shape `getPool()` needs for the registry's two queries. */
export interface ServedTenantsPool {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
}

/**
 * A pool that reports `ids` as the tenants in this runtime's database.
 *
 * Pass at least two. A single-tenant fixture cannot tell a fan-out that covers
 * every tenant apart from one that covers the first and returns.
 */
export function servedTenantsPool(ids: string[]): ServedTenantsPool {
  return {
    query: async (sql: string, params?: unknown[]) => {
      // isKnownTenant — membership.
      if (/FROM\s+tenants\s+WHERE\s+id/i.test(sql)) {
        const hit = ids.includes(String(params?.[0]));
        return { rows: hit ? [{ present: 1 }] : [], rowCount: hit ? 1 : 0 };
      }
      // listTenantIds — the full set.
      if (/FROM\s+tenants/i.test(sql)) {
        return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
      }
      throw new Error(
        'servedTenantsPool: unexpected query. This fixture answers only the '
        + `tenant-registry reads; stub the rest explicitly. SQL: ${sql}`,
      );
    },
  };
}
