// An import belongs to a PERSON and an installation, not to a workspace.
//
// Migration 361 keyed everything on (tenant, source, fingerprint) and recorded
// no importer, which held together only while a workspace had exactly one
// person with exactly one machine running exactly one product. None of those
// three is true.
//
// What that produced, all of it invisible to a single-user test:
//
//   - a colleague's `switch` RESUMED someone else's migration when their
//     installation sat at the same path, and their upload overwrote it
//   - the wizard showed whichever workspace member imported most recently,
//     so Continue would have built that person's import under another name
//   - one person importing blocked everyone else, because the one-open rule
//     counted per tenant
//   - one machine could not import OpenClaw and Hermes concurrently
//   - the daily cap was shared by the whole workspace
//
// These tests pin the SCOPE of each query, which is the thing that was wrong.

import { sourceMigrationRepository as repo } from '../repository';
import { withTenantScope } from '../../infrastructure/database';

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(),
  getPool: jest.fn(),
}));

const mockScope = withTenantScope as jest.MockedFunction<typeof withTenantScope>;

const TENANT = '11111111-1111-4111-8111-111111111111';
const ALICE = '22222222-2222-4222-8222-222222222222';
const BOB = '33333333-3333-4333-8333-333333333333';

/** A row shaped enough for mapMigration, so an INSERT can return one. */
const ROW = {
  id: 'mig-1',
  tenant_id: TENANT,
  account_id: null,
  source: 'openclaw',
  state: 'importing',
  unsupported_items: [],
  hosting_requirements: [],
  diagnostics: [],
  library_approvals: [],
  created_at: new Date(),
  updated_at: new Date(),
};

/** Capture the SQL and parameters a repository call issues.
 *
 *  A SELECT returns nothing (so createOrResume falls through to the insert) and
 *  an INSERT returns a row, which is what the real queries do. */
function captureQuery(rows: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  mockScope.mockImplementation(async (_tenantId: string, fn: (c: unknown) => unknown) =>
    fn({
      query: (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        const out = sql.includes('INSERT INTO') ? [ROW] : rows;
        return Promise.resolve({ rows: out, rowCount: out.length });
      },
    }),
  );
  return calls;
}

beforeEach(() => jest.clearAllMocks());

describe('resuming an import', () => {
  it('matches on the importer as well as the installation', async () => {
    const calls = captureQuery([]);
    await repo.createOrResume(TENANT, {
      source: 'openclaw',
      adapterVersion: '1.0.0',
      installationFingerprint: 'fp',
      accountId: ALICE,
    });

    // Without the account in the predicate, Bob's identical path resumed
    // Alice's migration and his bundle replaced hers.
    expect(calls[0].sql).toContain('account_id IS NOT DISTINCT FROM');
    expect(calls[0].params).toContain(ALICE);
  });

  it('records the importer on the row it creates', async () => {
    const calls = captureQuery([]);
    await repo.createOrResume(TENANT, {
      source: 'hermes',
      adapterVersion: '1.0.0',
      installationFingerprint: 'fp',
      accountId: BOB,
    });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO source_migrations'));
    expect(insert).toBeDefined();
    expect(insert?.sql).toContain('account_id');
    expect(insert?.params).toContain(BOB);
  });
});

describe('what the wizard loads', () => {
  it('is this person import, not the workspace latest', async () => {
    const calls = captureQuery([]);
    await repo.findLatest(TENANT, ALICE, 'openclaw');

    expect(calls[0].sql).toContain('account_id IS NOT DISTINCT FROM');
    expect(calls[0].params).toContain(ALICE);
  });
});

describe('the limits', () => {
  it('counts the daily cap per person', async () => {
    // A ten-person workspace sharing three imports a day is a queue, not a
    // rate limit.
    const calls = captureQuery([{ n: 0 }]);
    await repo.countRecentForAccount(TENANT, BOB, 24);

    expect(calls[0].sql).toContain('account_id IS NOT DISTINCT FROM');
    expect(calls[0].params).toEqual([TENANT, BOB, '24']);
  });
});

describe('rows created before the importer existed', () => {
  it('treats a null importer as its own scope', async () => {
    // `IS NOT DISTINCT FROM` rather than `=`, so a legacy row matches only
    // another legacy row. With `=` every comparison against NULL is unknown,
    // and a pre-368 migration would be invisible to its own owner forever.
    const calls = captureQuery([]);
    await repo.findLatest(TENANT, null, 'openclaw');

    expect(calls[0].sql).toContain('IS NOT DISTINCT FROM');
    expect(calls[0].params).toContain(null);
  });
});
