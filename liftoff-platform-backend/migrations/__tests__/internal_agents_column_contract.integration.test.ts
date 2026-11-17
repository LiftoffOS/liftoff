// Schema contract: hand-written SELECTs against `internal_agents` name only
// columns that exist (integration; requires TEST_DATABASE_URL).
//
//   npx jest --config jest.integration.config.js \
//     migrations/__tests__/internal_agents_column_contract.integration.test.ts
//
// Why this test exists.
//
// `internal_agents` was created as `ai_teams` in migration 016 with
// `responsibilities` and no `capabilities` column, and migration 055 only
// renamed it. A reader that selects a column the table does not have (for
// example `capabilities` or `lifecycle`) throws on every execution: an A2A
// agent-card endpoint would return 500 for every request, and a fire-and-forget
// caller such as capability embedding would fail quietly, leaving
// `capability_embedding_v2` NULL and `find_teammates` on its ILIKE fallback.
//
// Unit tests cannot catch this. They mock the pool and hand it a fabricated
// row, so a test asserting "skills come from capabilities" only asserts that
// the fixture had the field the code read. A mocked database cannot disagree
// with the query about what a table contains — only a real one can. Hence this
// test, which is the cheapest thing that can: take the column lists the
// production queries actually interpolate, and ask the live schema.
//
// Adding a column to one of those lists without adding it to the table fails
// here rather than in production.

import { Pool } from 'pg';
import { AGENT_CARD_COLUMNS } from '../../src/a2a/agent-card-router';
import { AGENT_EMBEDDING_COLUMNS } from '../../src/internal-agents/embedding-service';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** The column lists as the queries interpolate them, split back into names. */
const COLUMN_LISTS: Array<{ source: string; columns: string }> = [
  { source: 'a2a/agent-card-router AGENT_CARD_COLUMNS', columns: AGENT_CARD_COLUMNS },
  { source: 'internal-agents/embedding-service AGENT_EMBEDDING_COLUMNS', columns: AGENT_EMBEDDING_COLUMNS },
];

// Columns named in a WHERE clause rather than the projection, so they are not
// part of any exported list but are just as capable of not existing. `status` is
// here because the A2A readers filtered on `lifecycle` for their whole life.
const FILTER_COLUMNS = ['status', 'deleted_at', 'tenant_id', 'capability_embedding_v2'];

describeFn('internal_agents column contract', () => {
  let pool: Pool;
  let actual: Set<string>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const res = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'internal_agents'`,
    );
    actual = new Set(res.rows.map((r) => r.column_name));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('the table exists and was found', () => {
    // Guards the test itself: an empty set would make every assertion below
    // vacuously informative in the wrong direction.
    expect(actual.size).toBeGreaterThan(0);
  });

  it.each(COLUMN_LISTS)('every column selected by $source exists', ({ columns }) => {
    const missing = columns
      .split(',')
      .map((c) => c.trim())
      .filter((c) => !actual.has(c));
    expect(missing).toEqual([]);
  });

  it('columns used in WHERE clauses exist', () => {
    const missing = FILTER_COLUMNS.filter((c) => !actual.has(c));
    expect(missing).toEqual([]);
  });

  it('does not have a `capabilities` or `lifecycle` column', () => {
    // The inverse assertion, kept deliberately. If either name is ever added,
    // this fails and whoever adds it has to reconcile the two readers above
    // with the new column rather than leaving a second source of truth for what
    // a team member can do — the skills column is authoritative (ADR-043).
    expect(actual.has('capabilities')).toBe(false);
    expect(actual.has('lifecycle')).toBe(false);
  });
});
