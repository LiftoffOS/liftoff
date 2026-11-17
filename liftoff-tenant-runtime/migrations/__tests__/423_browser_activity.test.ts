// Migration 423 — browser_activity, and the activity repository over a real
// Postgres: the caller's id written once, the page and its cursor, tenant
// isolation under FORCE RLS, the gap-reason CHECKs, the cascade from
// web_sessions, and the one-off removal of the cached raw current_url.
//
// Skipped unless TEST_DATABASE_URL is set (the same guard every other
// migration test uses). The migration is applied by the harness before this
// runs; the residue-removal statement is re-run from the file's own text
// against rows this test plants, since the harness already ran it once on an
// empty database.

import { Pool, type PoolClient } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

let pool: Pool;

jest.mock('../../src/infrastructure/database', () => ({
  withTenantScope: async (tenantId: string, fn: (client: PoolClient) => Promise<unknown>) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
  getPool: () => pool,
  getPoolForService: () => pool,
}));
jest.mock('../../src/infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { recordBrowserActivity, listBrowserActivity } from '../../src/browser-sessions/activity-repository';

const TENANT = '00000000-0000-0000-0000-0000000000ab';
const OTHER = '00000000-0000-0000-0000-0000000000ac';
const SESSION = '11111111-1111-4111-8111-111111111422';
const THREAD = '22222222-2222-4222-8222-222222222422';
const ID = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, '0')}`;

const base = {
  tenantId: TENANT, threadId: THREAD, sessionId: SESSION, tool: 'run_browser_task' as const,
  instruction: 'count the pull requests', outcome: 'Found 18', personTookOver: false,
  steps: [] as never[], captureGap: false, gapReason: null, stepsTruncated: false,
};

describeFn('migration 423 — browser_activity', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10 });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM web_sessions WHERE id = $1`, [SESSION]);
    await pool.query(
      `INSERT INTO web_sessions (id, tenant_id, agent_id, caller_session_id, vendor, vendor_session_id, thread_id)
       VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', 'ui:422', 'steel', 'vs-422', $3)`,
      [SESSION, TENANT, THREAD],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM web_sessions WHERE id = $1`, [SESSION]);
  });

  it('writes the caller\'s id once: the same id inserted twice leaves one row, and the second call still answers the id', async () => {
    expect(await recordBrowserActivity({ ...base, id: ID(1) })).toBe(ID(1));
    expect(await recordBrowserActivity({ ...base, id: ID(1), outcome: 'a retry with a different outcome' })).toBe(ID(1));
    const { rows } = await pool.query(`SELECT outcome FROM browser_activity WHERE id = $1`, [ID(1)]);
    expect(rows).toEqual([{ outcome: 'Found 18' }]);
  });

  it('stores the sanitized texts with their flags, steps as JSONB, and NULL steps for a tool with no sequence', async () => {
    await recordBrowserActivity({
      ...base, id: ID(2),
      instruction: 'open https://a.example/reset-password/3f2a91b8c07d4e659a1b0d3e5f7a9b1c?token=abc',
      outcome: 'x'.repeat(5000),
      steps: [{
        type: 'goto', action: 'https://a.example/', pageUrl: 'https://a.example/',
        actionTruncated: false, pageUrlTruncated: false, protectedDataOmitted: false, protectedKind: '',
        pageUrlProtectedDataOmitted: false, at: new Date('2026-09-20T10:00:00Z'),
      }],
      captureGap: true, gapReason: 'frame_unavailable', stepsTruncated: true,
    });
    await recordBrowserActivity({ ...base, id: ID(3), tool: 'navigate_browser_session', steps: null });
    const { rows } = await pool.query(
      `SELECT id, instruction, instruction_protected_data_omitted, outcome_truncated, length(outcome) AS len, steps, capture_gap, gap_reason, steps_truncated
       FROM browser_activity WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[ID(2), ID(3)]],
    );
    expect(rows[0]).toMatchObject({
      instruction: 'open https://a.example/reset-password/[redacted]?token=[redacted]',
      instruction_protected_data_omitted: true, outcome_truncated: true, len: 4000,
      capture_gap: true, gap_reason: 'frame_unavailable', steps_truncated: true,
    });
    expect(rows[0].steps).toEqual([expect.objectContaining({ type: 'goto', at: '2026-09-20T10:00:00.000Z' })]);
    expect(rows[1].steps).toBeNull();
  });

  it('pages newest first on (created_at, id) and a second tenant reads nothing', async () => {
    for (let i = 10; i < 15; i++) await recordBrowserActivity({ ...base, id: ID(i), outcome: `row ${i}` });
    const first = await listBrowserActivity(TENANT, THREAD, { limit: 2 });
    expect(first.hasMore).toBe(true);
    expect(first.rows).toHaveLength(2);
    const last = first.rows[1];
    const second = await listBrowserActivity(TENANT, THREAD, { limit: 10, before: { createdAt: last.createdAt, id: last.id } });
    expect(second.hasMore).toBe(false);
    expect(second.rows).toHaveLength(3);
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(5);
    expect(await listBrowserActivity(OTHER, THREAD, { limit: 10 })).toEqual({ rows: [], hasMore: false });
    const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM browser_activity WHERE thread_id = $1`, [THREAD]);
    expect(Number(rows[0].n)).toBe(5);
  });

  it('a malformed stored steps value reads as an empty list with a reconciliation gap, never as its fields', async () => {
    await pool.query(
      `INSERT INTO browser_activity (id, tenant_id, thread_id, session_id, tool, steps)
       VALUES ($1, $2, $3, $4, 'run_browser_task', '[{"type":"goto","evil":"<script>"}]'::jsonb)`,
      [ID(20), TENANT, THREAD, SESSION],
    );
    const { rows } = await listBrowserActivity(TENANT, THREAD, { limit: 10 });
    const row = rows.find((r) => r.id === ID(20))!;
    expect(row.steps).toEqual([]);
    expect(row).toMatchObject({ captureGap: true, gapReason: 'reconciliation_uncertain' });
  });

  it('refuses a gap reason outside the vocabulary, and a gap without a reason', async () => {
    await expect(pool.query(
      `INSERT INTO browser_activity (id, tenant_id, thread_id, session_id, tool, capture_gap, gap_reason)
       VALUES ($1, $2, $3, $4, 'run_browser_task', true, 'vendor said: Error: ECONNRESET')`,
      [ID(30), TENANT, THREAD, SESSION],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(
      `INSERT INTO browser_activity (id, tenant_id, thread_id, session_id, tool, capture_gap)
       VALUES ($1, $2, $3, $4, 'run_browser_task', true)`,
      [ID(31), TENANT, THREAD, SESSION],
    )).rejects.toMatchObject({ code: '23514' });
    // The insert never throws: a refused row is logged and answered null.
    expect(await recordBrowserActivity({ ...base, id: ID(32), tool: 'nope' as never })).toBe(ID(32));
  });

  it('cascades from the session, with the takeover tables, on tenant deletion', async () => {
    await recordBrowserActivity({ ...base, id: ID(40) });
    await pool.query(`DELETE FROM web_sessions WHERE id = $1`, [SESSION]);
    const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM browser_activity WHERE id = $1`, [ID(40)]);
    expect(Number(rows[0].n)).toBe(0);
  });

  it('removes the cached raw current_url from vendor_metadata without closing the session or touching other keys', async () => {
    await pool.query(
      `UPDATE web_sessions SET vendor_metadata = '{"current_url":"https://a.example/reset?token=abc","keep":1}'::jsonb WHERE id = $1`,
      [SESSION],
    );
    const sql = readFileSync(join(__dirname, '..', '423_browser_activity.sql'), 'utf8');
    const statement = sql.match(/UPDATE web_sessions\s+SET vendor_metadata = vendor_metadata - 'current_url'\s+WHERE vendor_metadata \? 'current_url';/);
    expect(statement).not.toBeNull();
    await pool.query(statement![0]);
    const { rows } = await pool.query(`SELECT vendor_metadata, closed_at FROM web_sessions WHERE id = $1`, [SESSION]);
    expect(rows[0].vendor_metadata).toEqual({ keep: 1 });
    expect(rows[0].closed_at).toBeNull();
  });

  it('leaves the row-security posture of web_sessions exactly as it found it', async () => {
    // The cleanup writes the table without a NO FORCE / FORCE pair: the table
    // has no row security, and a pair would leave it marked forced with no
    // policy, which the RLS ratchet reads as protection that does not exist.
    const { rows } = await pool.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'web_sessions'::regclass`,
    );
    expect(rows[0]).toEqual({ relrowsecurity: false, relforcerowsecurity: false });
    // browser_activity itself is enabled and forced.
    const own = await pool.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'browser_activity'::regclass`);
    expect(own.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    // And the page cursor's column round-trips through a millisecond Date.
    const col = await pool.query(
      `SELECT datetime_precision FROM information_schema.columns WHERE table_name = 'browser_activity' AND column_name = 'created_at'`,
    );
    expect(col.rows[0].datetime_precision).toBe(3);
  });
});
