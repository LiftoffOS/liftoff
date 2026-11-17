// Resolving a tenant's connector to a row that can actually be used.
//
// A newer dead row can shadow the row that holds the credential, e.g. an
// import placeholder created after the real connector:
//
//   aaaaaaaa  github  disconnected  (newer)   import placeholder, no credential
//   bbbbbbbb  github  active        (older)   the real connector, token here
//
// The org picker then fails with "No credentials found for connector
// aaaaaaaa…" moments after the authorize leg has successfully stored a token.
// Not a race — the write and the read are aimed at DIFFERENT ROWS.
//
// `findConnectorByTenantAndType` is `ORDER BY created_at DESC LIMIT 1` with no
// status filter, so the newer dead row wins. Reconnecting can never fix it,
// because reconnecting writes to the live row and the lookup keeps reading the
// placeholder.
//
// That ordering is CORRECT for the OAuth reconnect path, which looks for a dead
// row precisely so it can reuse it. So the fix is a second, narrower question —
// "which row can I make a call with" — rather than a change to the shared one.
//
// These tests drive the SQL through a fake client, because the property that
// broke is entirely in the query: which row comes back first.

const captured: Array<{ text: string; values: unknown[] }> = [];
let rows: Array<Record<string, unknown>> = [];

jest.mock('../../db/pool.js', () => ({
  withTenantScope: async (_tenantId: string, fn: (c: unknown) => Promise<unknown>) =>
    fn({
      query: (text: string, values: unknown[]) => {
        captured.push({ text, values });
        return Promise.resolve({ rows });
      },
    }),
  withAdminScope: jest.fn(),
}));
jest.mock('../../infra/logging.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { findUsableConnectorByTenantAndType } from '../connector-ops.js';

beforeEach(() => {
  captured.length = 0;
  rows = [];
});

describe('findUsableConnectorByTenantAndType', () => {
  it('excludes disconnected rows in SQL, not in JavaScript', () => {
    // Filtering after the fact would still have taken LIMIT 1 of the wrong
    // ordering and returned nothing at all.
    void findUsableConnectorByTenantAndType('t1', 'github');
    expect(captured[0].text).toMatch(/status\s*<>\s*'disconnected'/);
  });

  it('orders active first, then newest — not newest first', () => {
    // The exact inversion that picks the dead row.
    const sql = (void findUsableConnectorByTenantAndType('t1', 'github'), captured[0].text);
    expect(sql).toMatch(/ORDER BY\s*\(status = 'active'\) DESC,\s*created_at DESC/);
  });

  it('returns the active row even when a dead row is newer', async () => {
    rows = [
      {
        id: '7d07a896', tenant_id: 't1', type: 'github', name: 'GitHub',
        status: 'active', config: { externalAccountLabel: 'octocat' }, api_key_hint: null,
      },
    ];
    const found = await findUsableConnectorByTenantAndType('t1', 'github');
    expect(found?.id).toBe('7d07a896');
  });

  it('returns null rather than a placeholder when nothing is usable', async () => {
    rows = [];
    expect(await findUsableConnectorByTenantAndType('t1', 'github')).toBeNull();
  });

  it('scopes the query to the tenant and type it was asked about', async () => {
    await findUsableConnectorByTenantAndType('t1', 'github');
    expect(captured[0].values).toEqual(['t1', 'github']);
  });
});
