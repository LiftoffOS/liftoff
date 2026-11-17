// Migration 424 — the takeover record carries what was entered, except
// protected data: the new columns and their defaults, the disposition and
// kind CHECKs, the backfill of pre-424 change/enter rows to
// legacy_unavailable, the hold gap-reason CHECK admitting frame_unavailable,
// and the cascade and RLS unchanged.
//
// Skipped unless TEST_DATABASE_URL is set. The migration is applied by the
// harness before this runs; the backfill is re-run from the file's own text
// against rows this test plants.

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

import * as captureRepo from '../../src/browser-sessions/takeover-capture/repository';
import type { TakeoverActionRow } from '../../src/browser-sessions/takeover-capture/action';

const TENANT = '00000000-0000-0000-0000-0000000000ad';
const OTHER = '00000000-0000-0000-0000-0000000000ae';
const SESSION = '11111111-1111-4111-8111-111111111423';
const THREAD = '22222222-2222-4222-8222-222222222423';
const OWNER = 'test:423';

const row = (over: Partial<TakeoverActionRow>): TakeoverActionRow => ({
  nonce: 'n', seq: 0, kind: 'click', url: 'https://a.example/issues?q=browser', urlTruncated: false, urlProtectedDataOmitted: false,
  tag: 'input', role: 'textbox', name: 'Search all issues', nameTruncated: false, nameProtectedDataOmitted: false, inputType: 'text',
  value: null, valueTruncated: false, valueDisposition: 'none', detail: null, detailTruncated: false, detailProtectedDataOmitted: false,
  ...over,
});

describeFn('migration 424 — takeover action values', () => {
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
       VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', 'ui:423', 'steel', 'vs-423', $3)`,
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

  it('the new columns default as declared, and the repository writes and reads every one', async () => {
    const holdId = await openHold();
    const generation = await captureRepo.claimCapture(TENANT, holdId, OWNER);
    expect(generation).toBe(1);
    expect(await captureRepo.insertAction(TENANT, holdId, OWNER, 1, row({
      kind: 'change', value: 'browser', valueDisposition: 'recorded', urlProtectedDataOmitted: true, nameTruncated: true,
    }))).toBe('inserted');
    expect(await captureRepo.insertAction(TENANT, holdId, OWNER, 1, row({
      seq: 1, kind: 'enter', valueDisposition: 'authentication_omitted', inputType: 'password', name: 'Password', detail: 'Control+Enter', detailTruncated: true,
    }))).toBe('inserted');
    expect(await captureRepo.insertAction(TENANT, holdId, OWNER, 1, row({
      seq: 2, kind: 'scroll', tag: null, role: null, name: null, inputType: null, detail: 'scroll down to 0%,42%',
    }))).toBe('inserted');
    const { rows: raw } = await pool.query(
      `SELECT value, value_disposition, detail, url_truncated, name_truncated, value_truncated, detail_truncated,
              url_protected_data_omitted, name_protected_data_omitted, detail_protected_data_omitted
       FROM browser_takeover_actions WHERE hold_id = $1 ORDER BY seq`, [holdId],
    );
    expect(raw[0]).toEqual({
      value: 'browser', value_disposition: 'recorded', detail: null, url_truncated: false, name_truncated: true, value_truncated: false,
      detail_truncated: false, url_protected_data_omitted: true, name_protected_data_omitted: false, detail_protected_data_omitted: false,
    });
    expect(raw[1]).toMatchObject({ value: null, value_disposition: 'authentication_omitted', detail: 'Control+Enter', detail_truncated: true });
    expect(raw[2]).toMatchObject({ value_disposition: 'none', detail: 'scroll down to 0%,42%' });

    const { holds } = await captureRepo.listTakeoverHolds(TENANT, THREAD, { limit: 5 });
    expect(holds[0].actions.map((a) => [a.kind, a.value, a.valueDisposition, a.detail])).toEqual([
      ['change', 'browser', 'recorded', null],
      ['enter', null, 'authentication_omitted', 'Control+Enter'],
      ['scroll', null, 'none', 'scroll down to 0%,42%'],
    ]);
    expect(holds[0].actions[0]).toMatchObject({ urlProtectedDataOmitted: true, nameTruncated: true });
  });

  it('admits the five new kinds and refuses an unknown one', async () => {
    const holdId = await openHold();
    await captureRepo.claimCapture(TENANT, holdId, OWNER);
    let seq = 0;
    for (const kind of ['key', 'scroll', 'drag', 'contextmenu', 'hover'] as const) {
      expect(await captureRepo.insertAction(TENANT, holdId, OWNER, 1, row({ seq: seq++, kind }))).toBe('inserted');
    }
    await expect(pool.query(
      `INSERT INTO browser_takeover_actions (hold_id, tenant_id, generation, page_nonce, seq, kind, url) VALUES ($1, $2, 1, 'n', 99, 'wheel', 'https://a.example/')`,
      [holdId, TENANT],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses an unknown disposition rather than coercing it', async () => {
    const holdId = await openHold();
    await expect(pool.query(
      `INSERT INTO browser_takeover_actions (hold_id, tenant_id, generation, page_nonce, seq, kind, url, value_disposition)
       VALUES ($1, $2, 1, 'n', 0, 'change', 'https://a.example/', 'credential')`,
      [holdId, TENANT],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('backfills pre-424 change and enter rows to legacy_unavailable and leaves other actions at none', async () => {
    const holdId = await openHold();
    // Rows as 418 wrote them: no disposition, so the column default `none`.
    await pool.query(
      `INSERT INTO browser_takeover_actions (hold_id, tenant_id, generation, page_nonce, seq, kind, url)
       VALUES ($1, $2, 1, 'legacy', 0, 'navigate', 'https://a.example/'),
              ($1, $2, 1, 'legacy', 1, 'change', 'https://a.example/'),
              ($1, $2, 1, 'legacy', 2, 'enter', 'https://a.example/'),
              ($1, $2, 1, 'legacy', 3, 'click', 'https://a.example/')`,
      [holdId, TENANT],
    );
    const sql = readFileSync(join(__dirname, '..', '424_takeover_action_values.sql'), 'utf8');
    const statement = sql.match(/UPDATE browser_takeover_actions\s+SET value_disposition = 'legacy_unavailable'\s+WHERE kind IN \('change', 'enter'\);/);
    expect(statement).not.toBeNull();
    await pool.query(statement![0]);
    const { rows } = await pool.query(
      `SELECT kind, value_disposition FROM browser_takeover_actions WHERE hold_id = $1 ORDER BY seq`, [holdId],
    );
    expect(rows).toEqual([
      { kind: 'navigate', value_disposition: 'none' },
      { kind: 'change', value_disposition: 'legacy_unavailable' },
      { kind: 'enter', value_disposition: 'legacy_unavailable' },
      { kind: 'click', value_disposition: 'none' },
    ]);
    const { holds } = await captureRepo.listTakeoverHolds(TENANT, THREAD, { limit: 5 });
    expect(holds[0].actions.map((a) => a.valueDisposition)).toEqual(['none', 'legacy_unavailable', 'legacy_unavailable', 'none']);
  });

  it("the hold cursor's column is millisecond precision, so (started_at, id) round-trips through a Date", async () => {
    const { rows } = await pool.query(
      `SELECT datetime_precision FROM information_schema.columns WHERE table_name = 'browser_takeover_holds' AND column_name = 'started_at'`,
    );
    expect(rows[0].datetime_precision).toBe(3);
  });

  it('the hold gap-reason CHECK admits frame_unavailable and refuses an unknown reason', async () => {
    const holdId = await openHold();
    await captureRepo.markCaptureGap(TENANT, holdId, 'frame_unavailable');
    const { rows } = await pool.query(`SELECT capture_gap, gap_reason FROM browser_takeover_holds WHERE id = $1`, [holdId]);
    expect(rows[0]).toEqual({ capture_gap: true, gap_reason: 'frame_unavailable' });
    await expect(pool.query(`UPDATE browser_takeover_holds SET gap_reason = 'because' WHERE id = $1`, [holdId]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('cascade and RLS are unchanged: another tenant reads nothing, and the session\'s deletion removes the actions', async () => {
    const holdId = await openHold();
    await captureRepo.claimCapture(TENANT, holdId, OWNER);
    await captureRepo.insertAction(TENANT, holdId, OWNER, 1, row({ kind: 'change', value: 'browser', valueDisposition: 'recorded' }));
    expect((await captureRepo.listTakeoverHolds(OTHER, THREAD, { limit: 5 })).holds).toEqual([]);
    await pool.query(`DELETE FROM web_sessions WHERE id = $1`, [SESSION]);
    const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM browser_takeover_actions WHERE hold_id = $1`, [holdId]);
    expect(Number(rows[0].n)).toBe(0);
  });
});
