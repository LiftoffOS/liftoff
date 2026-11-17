/**
 * Pins the parallel-sessions-by-thread contract.
 *
 * Why this test exists:
 *
 * The user reported skepticism about whether parallel browser sessions
 * actually work — specifically: when a user switches between conversation
 * threads quickly, each thread should get its own session, and multiple
 * sessions should be able to coexist for the same agent.
 *
 * What we contractually allow:
 *   - At most ONE active anchor session per (tenant_id, thread_id). This
 *     is enforced by the `web_sessions_one_active_per_thread` partial
 *     unique index in migration 280.
 *   - Multiple active sessions are explicitly ALLOWED across different
 *     threads of the same (tenant, agent, owner_account_id). The index
 *     doesn't include agent_id or owner_account_id; only thread_id.
 *     Two threads of the same agent for the same user = two independent
 *     sessions running concurrently.
 *
 * The persisted Anchor profile name is per-(tenant, agent, account) — see
 * anchor-client.ts:717 `liftoff-${tenantId}-${agentId}-${ownerAccountId}`.
 * Cookies/storage persist to that profile on session termination, so
 * cross-thread login state is shared. Two concurrent sessions on the same
 * profile will both write back at termination, which is a last-writer-wins
 * race on the persisted state — accepted for the same-user case where both
 * sessions belong to the same person interacting with the same accounts on
 * the same sites. The race could matter if a single user logged into two
 * different accounts on the same site in two threads simultaneously; we
 * treat that as out-of-scope.
 *
 * This test pins the schema-level invariant by asserting that:
 *   1. The same-thread uniqueness applies as expected.
 *   2. The cross-thread / same-agent / same-user case is NOT blocked.
 * Failing either assertion = regression on parallelism.
 */
import { Pool } from 'pg';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const AGENT_ID = '00000000-0000-0000-0000-000000000002';
const OWNER_ACCOUNT_ID = '00000000-0000-0000-0000-000000000003';

const itDb = (process.env.PGHOST || process.env.DATABASE_URL) ? it : it.skip;

describe('web_sessions parallelism — per-thread uniqueness, per-(agent, user) sharing', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool();
  });
  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      `DELETE FROM web_sessions WHERE tenant_id = $1 AND agent_id = $2`,
      [TENANT_ID, AGENT_ID],
    );
  });

  itDb('allows multiple ACTIVE sessions across different threads of the same agent/user', async () => {
    const insertSession = (threadId: string) =>
      pool.query(
        `INSERT INTO web_sessions (
           tenant_id, agent_id, thread_id, caller_session_id, vendor,
           vendor_session_id, vendor_metadata, owner_account_id
         ) VALUES ($1, $2, $3, $4, 'anchor', $5, $6, $7)`,
        [
          TENANT_ID,
          AGENT_ID,
          threadId,
          `ui:${threadId}`,
          `vendor-session-${threadId}`,
          JSON.stringify({ live_view_url: `https://live/${threadId}` }),
          OWNER_ACCOUNT_ID,
        ],
      );

    // Two distinct threads = two active sessions. Must succeed.
    await expect(insertSession('00000000-0000-0000-0000-000000000010')).resolves.toBeDefined();
    await expect(insertSession('00000000-0000-0000-0000-000000000011')).resolves.toBeDefined();
    await expect(insertSession('00000000-0000-0000-0000-000000000012')).resolves.toBeDefined();

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM web_sessions
       WHERE tenant_id = $1 AND agent_id = $2 AND closed_at IS NULL`,
      [TENANT_ID, AGENT_ID],
    );
    expect(rows[0].n).toBe(3);
  });

  itDb('blocks a SECOND active session on the SAME thread (partial unique index)', async () => {
    const threadId = '00000000-0000-0000-0000-000000000020';
    const insertSession = (vendorSessionId: string) =>
      pool.query(
        `INSERT INTO web_sessions (
           tenant_id, agent_id, thread_id, caller_session_id, vendor,
           vendor_session_id, vendor_metadata, owner_account_id
         ) VALUES ($1, $2, $3, $4, 'anchor', $5, $6, $7)`,
        [
          TENANT_ID,
          AGENT_ID,
          threadId,
          `ui:${vendorSessionId}`,
          vendorSessionId,
          JSON.stringify({ live_view_url: `https://live/${vendorSessionId}` }),
          OWNER_ACCOUNT_ID,
        ],
      );

    await expect(insertSession('vendor-A')).resolves.toBeDefined();
    // Second insert on the SAME (tenant, thread) with both open must violate
    // web_sessions_one_active_per_thread.
    await expect(insertSession('vendor-B')).rejects.toMatchObject({ code: '23505' });

    // After closing the first, the second must succeed (the index is partial:
    // WHERE closed_at IS NULL).
    await pool.query(
      `UPDATE web_sessions SET closed_at = NOW(), closed_reason = 'user_ended'
       WHERE tenant_id = $1 AND thread_id = $2 AND vendor_session_id = 'vendor-A'`,
      [TENANT_ID, threadId],
    );
    await expect(insertSession('vendor-B')).resolves.toBeDefined();
  });
});
