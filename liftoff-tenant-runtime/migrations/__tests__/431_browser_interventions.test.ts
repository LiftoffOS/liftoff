// Migration 431 — browser_interventions, and the interventions module over a
// real Postgres: one pending per session, the ask, the answer by the takeover
// on the transaction's own client, the cancel with the session's close and
// with an unanswered takeover ending, the expiry, tenant isolation under
// FORCE RLS, the status CHECK, and the cascade from web_sessions.
//
// Skipped unless TEST_DATABASE_URL is set (the same guard every other
// migration test uses). The migration is applied by the harness before this
// runs.

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

import {
  requestIntervention, pendingIntervention, interventionForHold, endInterventions, INTERVENTION_TTL_MS,
} from '../../src/browser-sessions/interventions';
import { startTakeover, endTakeover, closeSession } from '../../src/browser-sessions/repository';

const TENANT = '00000000-0000-0000-0000-0000000000ad';
const OTHER = '00000000-0000-0000-0000-0000000000ae';
const SESSION = '11111111-1111-4111-8111-111111111431';
const THREAD = '22222222-2222-4222-8222-222222222431';

describeFn('migration 431 — browser_interventions', () => {
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
       VALUES ($1, $2, '00000000-0000-0000-0000-000000000000', 'ui:431', 'steel', 'vs-431', $3)`,
      [SESSION, TENANT, THREAD],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM web_sessions WHERE id = $1`, [SESSION]);
  });

  it('asks once: a second ask answers alreadyPending with the first request, and the partial unique index stands behind it', async () => {
    const first = await requestIntervention({ tenantId: TENANT, sessionId: SESSION, threadId: THREAD, reason: 'sign in to the account', requestedByInvocationId: 'inv-1' });
    expect(first.alreadyPending).toBe(false);
    expect(first.intervention).toMatchObject({ status: 'pending', reason: 'sign in to the account', requestedByInvocationId: 'inv-1', holdId: null });
    const second = await requestIntervention({ tenantId: TENANT, sessionId: SESSION, threadId: THREAD, reason: 'another' });
    expect(second.alreadyPending).toBe(true);
    expect(second.intervention.id).toBe(first.intervention.id);
    await expect(pool.query(
      `INSERT INTO browser_interventions (tenant_id, session_id, reason) VALUES ($1, $2, 'x')`, [TENANT, SESSION],
    )).rejects.toMatchObject({ code: '23505' });
    expect((await pendingIntervention(TENANT, SESSION))?.id).toBe(first.intervention.id);
  });

  it('the person taking over answers the pending request with the hold, on the transaction\'s own client', async () => {
    const { intervention } = await requestIntervention({ tenantId: TENANT, sessionId: SESSION, threadId: THREAD, reason: 'sign in' });
    const started = await startTakeover(SESSION);
    expect(started).not.toBeNull();
    const answered = await interventionForHold(TENANT, started!.hold.id);
    expect(answered).toMatchObject({ id: intervention.id, status: 'answered', holdId: started!.hold.id });
    expect(answered!.answeredAt).not.toBeNull();
    expect(await pendingIntervention(TENANT, SESSION)).toBeNull();
    // The hand-back cancels nothing: the request is already answered.
    const ended = await endTakeover(SESSION, 'released');
    expect(ended!.holdId).toBe(started!.hold.id);
    expect((await interventionForHold(TENANT, started!.hold.id))!.status).toBe('answered');
  });

  it('a request made while the person already held the wheel is cancelled when that takeover ends unanswered', async () => {
    const started = await startTakeover(SESSION);
    const { intervention } = await requestIntervention({ tenantId: TENANT, sessionId: SESSION, threadId: THREAD, reason: 'sign in' });
    await endTakeover(SESSION, 'released');
    const { rows } = await pool.query(`SELECT status, ended_at FROM browser_interventions WHERE id = $1`, [intervention.id]);
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].ended_at).not.toBeNull();
    expect(started!.hold.id).toBeTruthy();
  });

  it('the session closing cancels the pending request; a withdraw cancels it too', async () => {
    const { intervention } = await requestIntervention({ tenantId: TENANT, sessionId: SESSION, threadId: THREAD, reason: 'sign in' });
    expect(await endInterventions(undefined, SESSION, 'cancelled', TENANT)).toBe(1);
    expect(await endInterventions(undefined, SESSION, 'cancelled', TENANT)).toBe(0);
    const again = await requestIntervention({ tenantId: TENANT, sessionId: SESSION, threadId: THREAD, reason: 'sign in again' });
    expect(again.intervention.id).not.toBe(intervention.id);
    await closeSession(SESSION, 'user_ended');
    const { rows } = await pool.query(`SELECT id, status FROM browser_interventions WHERE session_id = $1 ORDER BY requested_at`, [SESSION]);
    expect(rows.map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('a pending request older than the TTL expires on the next read and on the next ask', async () => {
    const { intervention } = await requestIntervention({ tenantId: TENANT, sessionId: SESSION, threadId: THREAD, reason: 'sign in' });
    await pool.query(
      `UPDATE browser_interventions SET requested_at = now() - ($2::int * interval '1 millisecond') - interval '1 second' WHERE id = $1`,
      [intervention.id, INTERVENTION_TTL_MS],
    );
    expect(await pendingIntervention(TENANT, SESSION)).toBeNull();
    const { rows } = await pool.query(`SELECT status FROM browser_interventions WHERE id = $1`, [intervention.id]);
    expect(rows[0].status).toBe('expired');
    const fresh = await requestIntervention({ tenantId: TENANT, sessionId: SESSION, threadId: THREAD, reason: 'sign in' });
    expect(fresh.alreadyPending).toBe(false);
  });

  it('is FORCE RLS: another tenant reads nothing and writes nothing', async () => {
    await requestIntervention({ tenantId: TENANT, sessionId: SESSION, threadId: THREAD, reason: 'sign in' });
    expect(await pendingIntervention(OTHER, SESSION)).toBeNull();
    expect(await endInterventions(undefined, SESSION, 'cancelled', OTHER)).toBe(0);
    expect((await pendingIntervention(TENANT, SESSION))?.status).toBe('pending');
  });

  it('refuses an unknown status and an answered row without a hold, and cascades from the session', async () => {
    await expect(pool.query(
      `INSERT INTO browser_interventions (tenant_id, session_id, reason, status) VALUES ($1, $2, 'x', 'waiting')`, [TENANT, SESSION],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(
      `INSERT INTO browser_interventions (tenant_id, session_id, reason, status) VALUES ($1, $2, 'x', 'answered')`, [TENANT, SESSION],
    )).rejects.toMatchObject({ code: '23514' });
    const { intervention } = await requestIntervention({ tenantId: TENANT, sessionId: SESSION, threadId: THREAD, reason: 'sign in' });
    await pool.query(`DELETE FROM web_sessions WHERE id = $1`, [SESSION]);
    const { rows } = await pool.query(`SELECT 1 FROM browser_interventions WHERE id = $1`, [intervention.id]);
    expect(rows).toHaveLength(0);
  });
});
