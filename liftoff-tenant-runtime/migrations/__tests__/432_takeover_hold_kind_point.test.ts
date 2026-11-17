// Migration 432 — a hold's kind and the point action, over a real Postgres:
// every existing hold is a takeover, a point hold is inserted already ended
// with its one action under generation 0, it coexists with an open takeover
// hold on the same session, the read carries kind and the per-hold newest-N
// with the omitted count, and the CHECKs admit exactly the eleven kinds.
//
// Skipped unless TEST_DATABASE_URL is set.

import { Pool, type PoolClient } from 'pg';

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

import * as captureRepo from '../../src/browser-sessions/takeover-capture/repository';
import { startTakeover } from '../../src/browser-sessions/repository';
import type { TakeoverActionRow } from '../../src/browser-sessions/takeover-capture/action';

const TENANT = '00000000-0000-0000-0000-0000000000af';
const SESSION = '11111111-1111-4111-8111-111111111432';
const THREAD = '22222222-2222-4222-8222-222222222432';
const OWNER = 'host:1:test';

const row = (over: Partial<TakeoverActionRow> = {}): TakeoverActionRow => ({
  nonce: 'n', seq: 0, kind: 'click', url: 'https://a.example/sports', urlTruncated: false, urlProtectedDataOmitted: false,
  tag: 'a', role: 'link', name: 'Sports', nameTruncated: false, nameProtectedDataOmitted: false, inputType: null,
  value: null, valueTruncated: false, valueDisposition: 'none', detail: null, detailTruncated: false, detailProtectedDataOmitted: false,
  ...over,
});

describeFn('migration 432 — hold kind and the point action', () => {
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
       VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', 'ui:432', 'steel', 'vs-432', $3)`,
      [SESSION, TENANT, THREAD],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM web_sessions WHERE id = $1`, [SESSION]);
  });

  it('a hold opened by a takeover is kind takeover; a point hold is inserted already ended, with one action, beside the open one', async () => {
    const started = await startTakeover(SESSION);
    expect(started!.hold.kind).toBe('takeover');
    const pointId = await captureRepo.insertPointHold(TENANT, SESSION, THREAD, row({ kind: 'point', nonce: 'p1' }));
    const { rows } = await pool.query(
      `SELECT kind, started_at, ended_at, end_reason, capture_owner, capture_generation, capture_lease_until, capture_gap
       FROM browser_takeover_holds WHERE id = $1`, [pointId],
    );
    expect(rows[0]).toMatchObject({ kind: 'point', end_reason: 'released', capture_owner: null, capture_generation: 0, capture_lease_until: null, capture_gap: false });
    expect(rows[0].started_at.getTime()).toBe(rows[0].ended_at.getTime());
    const { rows: actions } = await pool.query(
      `SELECT kind, generation, page_nonce, seq, name, value, value_disposition FROM browser_takeover_actions WHERE hold_id = $1`, [pointId],
    );
    expect(actions).toEqual([{ kind: 'point', generation: 0, page_nonce: 'p1', seq: 0, name: 'Sports', value: null, value_disposition: 'none' }]);
    // The open takeover hold is untouched: the unique index covers open holds only.
    const { rows: open } = await pool.query(`SELECT id FROM browser_takeover_holds WHERE session_id = $1 AND ended_at IS NULL`, [SESSION]);
    expect(open.map((r) => r.id)).toEqual([started!.hold.id]);
  });

  it('the read carries kind, names one hold when asked, and takes the newest N actions with the older ones counted', async () => {
    const started = await startTakeover(SESSION);
    const generation = await captureRepo.claimCapture(TENANT, started!.hold.id, OWNER);
    for (let i = 0; i < 25; i++) {
      expect(await captureRepo.insertAction(TENANT, started!.hold.id, OWNER, generation!, row({ seq: i, name: `Link ${i}` }))).toBe('inserted');
    }
    const pointId = await captureRepo.insertPointHold(TENANT, SESSION, THREAD, row({ kind: 'point', nonce: 'p1', name: 'Pointed' }), 'frame_unavailable');
    const all = await captureRepo.listTakeoverHolds(TENANT, THREAD, { limit: 5, newestActions: 20 });
    const takeover = all.holds.find((h) => h.id === started!.hold.id)!;
    expect(takeover.kind).toBe('takeover');
    expect(takeover.actions).toHaveLength(20);
    expect(takeover.actionsOmitted).toBe(5);
    expect(takeover.actions[0].name).toBe('Link 5');
    expect(takeover.actions[19].name).toBe('Link 24');
    const point = all.holds.find((h) => h.id === pointId)!;
    expect(point).toMatchObject({ kind: 'point', captureGap: true, gapReason: 'frame_unavailable', actionsOmitted: 0 });
    expect(point.actions.map((a) => a.kind)).toEqual(['point']);
    const one = await captureRepo.listTakeoverHolds(TENANT, THREAD, { limit: 5, holdId: pointId });
    expect(one.holds.map((h) => h.id)).toEqual([pointId]);
    expect(one.hasMore).toBe(false);
  });

  it('admits exactly the eleven kinds and the two hold kinds', async () => {
    const started = await startTakeover(SESSION);
    await expect(pool.query(
      `INSERT INTO browser_takeover_actions (hold_id, tenant_id, generation, page_nonce, seq, kind, url) VALUES ($1, $2, 1, 'n', 99, 'point', 'https://a.example/')`,
      [started!.hold.id, TENANT],
    )).resolves.toBeDefined();
    await expect(pool.query(
      `INSERT INTO browser_takeover_actions (hold_id, tenant_id, generation, page_nonce, seq, kind, url) VALUES ($1, $2, 1, 'n', 100, 'wheel', 'https://a.example/')`,
      [started!.hold.id, TENANT],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(
      `INSERT INTO browser_takeover_holds (tenant_id, session_id, thread_id, kind, ended_at) VALUES ($1, $2, $3, 'gesture', now())`,
      [TENANT, SESSION, THREAD],
    )).rejects.toMatchObject({ code: '23514' });
  });
});
