// Migration 418 — browser_takeover_holds + browser_takeover_actions, and the
// two properties of the capture repository that only a real Postgres can show.
//
// The lease and the cap are statements, and their unit tests hold the
// statements to their shape (takeover-capture/__tests__/lease.test.ts). What
// a mock cannot show is what the database does when two transactions race:
// that the claim's locked CTE lets exactly one of two concurrent claimants
// through, and that the insert's lock-then-count admits exactly 500 rows when
// twenty writers arrive at once at 495. This file runs the REAL repository
// functions (withTenantScope is pointed at the test pool) against the migrated
// schema and pins both.
//
// Skipped unless TEST_DATABASE_URL is set (the same guard every other migration
// test uses). The migration is applied by the harness before this runs.

import { Pool, type PoolClient } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

let pool: Pool;

// The real repository, over this file's pool: one transaction per call with
// the tenant set, exactly as infrastructure/database's withTenantScope does.
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

import * as captureRepo from '../../src/browser-sessions/takeover-capture/repository';
import { ACTIONS_PER_HOLD_CAP } from '../../src/browser-sessions/takeover-capture/action';

/** The 423 fields every row carries now, at their defaults. */
const blankAction = {
  urlTruncated: false, urlProtectedDataOmitted: false, nameTruncated: false, nameProtectedDataOmitted: false,
  value: null, valueTruncated: false, valueDisposition: 'none' as const, detail: null, detailTruncated: false, detailProtectedDataOmitted: false,
};

const TENANT = '00000000-0000-0000-0000-0000000000aa';
const SESSION = '11111111-1111-4111-8111-111111111111';
const THREAD = '22222222-2222-4222-8222-222222222222';

describeFn('migration 418 — takeover holds and actions', () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 30 });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM web_sessions WHERE id = $1`, [SESSION]);
    await pool.query(
      `INSERT INTO web_sessions (id, tenant_id, agent_id, caller_session_id, vendor, vendor_session_id, thread_id)
       VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', 'ui:418', 'steel', 'vs-418', $3)`,
      [SESSION, TENANT, THREAD],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM web_sessions WHERE id = $1`, [SESSION]);
  });

  async function openHold(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO browser_takeover_holds (tenant_id, session_id, thread_id) VALUES ($1, $2, $3) RETURNING id`,
      [TENANT, SESSION, THREAD],
    );
    return rows[0].id;
  }

  it('creates both tables with FORCE row security and the open-hold unique index', async () => {
    const { rows } = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('browser_takeover_holds', 'browser_takeover_actions') ORDER BY relname`,
    );
    expect(rows).toEqual([
      { relname: 'browser_takeover_actions', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'browser_takeover_holds', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    const idx = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'browser_takeover_holds_open'`,
    );
    expect(idx.rows[0].indexdef).toMatch(/UNIQUE INDEX .* \(session_id\) WHERE \(ended_at IS NULL\)/);
  });

  it('admits exactly one open hold per session: a second insert conflicts', async () => {
    await openHold();
    await expect(openHold()).rejects.toMatchObject({ code: '23505' });
  });

  it('lets exactly one of two concurrent claimants through, and the lapsed lease hands over as lost_owner', async () => {
    const holdId = await openHold();
    const [a, b] = await Promise.all([
      captureRepo.claimCapture(TENANT, holdId, 'owner-a'),
      captureRepo.claimCapture(TENANT, holdId, 'owner-b'),
    ]);
    expect([a, b].filter((g) => g === 1)).toHaveLength(1);
    expect([a, b].filter((g) => g === null)).toHaveLength(1);
    const winner = a === 1 ? 'owner-a' : 'owner-b';
    const loser = winner === 'owner-a' ? 'owner-b' : 'owner-a';

    expect(await captureRepo.renewCapture(TENANT, holdId, winner, 1)).toBe(true);
    expect(await captureRepo.renewCapture(TENANT, holdId, loser, 1)).toBe(false);

    await pool.query(`UPDATE browser_takeover_holds SET capture_lease_until = now() - interval '1 second' WHERE id = $1`, [holdId]);
    expect(await captureRepo.claimCapture(TENANT, holdId, loser)).toBe(2);
    const { rows } = await pool.query(`SELECT capture_owner, capture_gap, gap_reason FROM browser_takeover_holds WHERE id = $1`, [holdId]);
    expect(rows[0]).toEqual({ capture_owner: loser, capture_gap: true, gap_reason: 'lost_owner' });
    // The old generation renews nothing and writes nothing.
    expect(await captureRepo.renewCapture(TENANT, holdId, winner, 1)).toBe(false);
    expect(await captureRepo.insertAction(TENANT, holdId, winner, 1, {
      ...blankAction, nonce: 'stale', seq: 0, kind: 'click', url: 'https://a.example/', tag: null, role: null, name: null, inputType: null,
    })).toBe('stale');
  });

  it('admits exactly 500 actions when twenty writers arrive at once at 495, and records the cap once', async () => {
    const holdId = await openHold();
    expect(await captureRepo.claimCapture(TENANT, holdId, 'owner-a')).toBe(1);
    const action = (nonce: string, seq: number) => ({
      ...blankAction, nonce, seq, kind: 'click' as const, url: 'https://a.example/', tag: 'button', role: 'button', name: 'Go', inputType: null,
    });
    for (let i = 0; i < ACTIONS_PER_HOLD_CAP - 5; i++) {
      expect(await captureRepo.insertAction(TENANT, holdId, 'owner-a', 1, action('warm', i))).toBe('inserted');
    }
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => captureRepo.insertAction(TENANT, holdId, 'owner-a', 1, action(`race-${i}`, 0))),
    );
    expect(outcomes.filter((o) => o === 'inserted')).toHaveLength(5);
    expect(outcomes.filter((o) => o === 'capped')).toHaveLength(15);
    const count = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM browser_takeover_actions WHERE hold_id = $1`, [holdId]);
    expect(Number(count.rows[0].n)).toBe(ACTIONS_PER_HOLD_CAP);
    const hold = await pool.query(`SELECT capture_gap, gap_reason FROM browser_takeover_holds WHERE id = $1`, [holdId]);
    expect(hold.rows[0]).toEqual({ capture_gap: true, gap_reason: 'cap' });
  });

  it('writes nothing from a release on an ended hold: a close is not a lost owner', async () => {
    const holdId = await openHold();
    expect(await captureRepo.claimCapture(TENANT, holdId, 'owner-a')).toBe(1);
    await pool.query(`UPDATE browser_takeover_holds SET ended_at = now(), end_reason = 'session_closed' WHERE id = $1`, [holdId]);
    await captureRepo.releaseCapture(TENANT, holdId, 'owner-a', 1, 'lost_owner');
    const { rows } = await pool.query(`SELECT capture_gap, gap_reason FROM browser_takeover_holds WHERE id = $1`, [holdId]);
    expect(rows[0]).toEqual({ capture_gap: false, gap_reason: null });
  });

  it('cascades the hold and its actions away with the session', async () => {
    const holdId = await openHold();
    expect(await captureRepo.claimCapture(TENANT, holdId, 'owner-a')).toBe(1);
    await captureRepo.insertAction(TENANT, holdId, 'owner-a', 1, {
      ...blankAction,
      nonce: 'n', seq: 0, kind: 'navigate', url: 'https://a.example/', tag: null, role: null, name: null, inputType: null,
    });
    await pool.query(`DELETE FROM web_sessions WHERE id = $1`, [SESSION]);
    const holds = await pool.query(`SELECT 1 FROM browser_takeover_holds WHERE id = $1`, [holdId]);
    const actions = await pool.query(`SELECT 1 FROM browser_takeover_actions WHERE hold_id = $1`, [holdId]);
    expect(holds.rowCount).toBe(0);
    expect(actions.rowCount).toBe(0);
  });
});
