// Migration 338 + agent-chat unread state — DB-backed integration tests.
//
// The unread indicators are a SQL predicate and a backfill. Neither can be
// proven against a mocked client: a mock can show the statement was issued, not
// what it means. So this runs the REAL exported predicate
// (UNREAD_PREDICATE, chat-repository.ts) and the REAL backfill block lifted out
// of the migration file, against the real schema.
//
// Run after migrations complete:
//   TEST_DATABASE_URL=<migrated-db> npx jest --config jest.integration.config.js \
//     migrations/__tests__/338_agent_chat_unread.integration.test.ts

import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { UNREAD_PREDICATE } from '../../src/agent-chat/chat-repository';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function migrationSql(): string {
  return readFileSync(join(__dirname, '..', '338_agent_chat_unread.sql'), 'utf8');
}

describeFn('Agent chat unread state (migration 338)', () => {
  let pool: Pool;
  let client: PoolClient;

  const tenantA = '00000000-0000-0000-0000-00000000d0aa';
  const tenantB = '00000000-0000-0000-0000-00000000d0bb';
  const acctA = '00000000-0000-0000-0000-00000000ad01';
  const acctB = '00000000-0000-0000-0000-00000000ad02';
  const agentA = '00000000-0000-0000-0000-00000000ae01';
  const agentB = '00000000-0000-0000-0000-00000000ae02';
  const agentQuiet = '00000000-0000-0000-0000-00000000ae03';

  /** Is this thread unread for this account, per the shared predicate? */
  async function isUnread(
    tenantId: string,
    accountId: string,
    threadId: string,
  ): Promise<boolean> {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    const result = await client.query(
      `SELECT (${UNREAD_PREDICATE}) AS unread
       FROM agent_chat_threads t
       LEFT JOIN agent_chat_thread_reads r ON r.thread_id = t.id AND r.account_id = $1
       WHERE t.id = $2`,
      [accountId, threadId],
    );
    await client.query('COMMIT');
    return result.rows[0].unread === true;
  }

  /** The counts query, built on the same shared predicate the list uses. */
  async function unreadCounts(
    tenantId: string,
    accountId: string,
  ): Promise<Record<string, number>> {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    const result = await client.query(
      `SELECT p.agent_id, COUNT(*)::int AS unread
       FROM agent_chat_threads t
       JOIN agent_chat_thread_participants p ON p.thread_id = t.id
       LEFT JOIN agent_chat_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
       WHERE t.tenant_id = $1
         AND t.deleted_at IS NULL
         AND ${UNREAD_PREDICATE}
       GROUP BY p.agent_id`,
      [tenantId, accountId],
    );
    await client.query('COMMIT');
    const counts: Record<string, number> = {};
    for (const row of result.rows) counts[row.agent_id as string] = row.unread as number;
    return counts;
  }

  /** A thread with a participant, and optionally an assistant reply on it. */
  async function seedThread(args: {
    tenantId: string;
    agentId: string;
    ownerAccountId: string;
    assistantRepliedAt?: Date | null;
  }): Promise<string> {
    const threadId = randomUUID();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [args.tenantId]);
    await client.query(
      `INSERT INTO agent_chat_threads (id, tenant_id, account_id, channel, title, last_agent_message_at)
       VALUES ($1, $2, $3, 'web', 'unread test thread', $4)`,
      [threadId, args.tenantId, args.ownerAccountId, args.assistantRepliedAt ?? null],
    );
    await client.query(
      `INSERT INTO agent_chat_thread_participants (thread_id, agent_id, added_by)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [threadId, args.agentId, args.ownerAccountId],
    );
    await client.query('COMMIT');
    return threadId;
  }

  /** The same upsert markThreadRead() issues. */
  async function markRead(
    tenantId: string,
    accountId: string,
    threadId: string,
    at?: Date,
  ): Promise<void> {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    await client.query(
      `INSERT INTO agent_chat_thread_reads (thread_id, account_id, tenant_id, last_read_at)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()))
       ON CONFLICT (thread_id, account_id)
       DO UPDATE SET last_read_at = COALESCE($4::timestamptz, NOW())`,
      [threadId, accountId, tenantId, at ?? null],
    );
    await client.query('COMMIT');
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    client = await pool.connect();

    await client.query('BEGIN');
    for (const [id, email] of [
      [acctA, 'unread-a@test.invalid'],
      [acctB, 'unread-b@test.invalid'],
    ] as const) {
      await client.query(
        `INSERT INTO accounts (id, firebase_uid, first_name, last_name, email, timezone, version)
         VALUES ($1, $2, 'Unread', 'Test', $3, 'UTC', 1)
         ON CONFLICT (id) DO NOTHING`,
        [id, `unread-test-${id.slice(-4)}`, email],
      );
    }
    for (const [id, name] of [
      [tenantA, 'Unread Tenant A'],
      [tenantB, 'Unread Tenant B'],
    ] as const) {
      await client.query(
        `INSERT INTO tenants (id, account_id, name, tier, hosting_mode, status, migration_status)
         VALUES ($1, $2, $3, 'standard', 'shared', 'pending', 'pending')
         ON CONFLICT (id) DO NOTHING`,
        [id, acctA, name],
      );
    }
    await client.query('COMMIT');

    for (const [agentId, tenantId] of [
      [agentA, tenantA],
      [agentB, tenantB],
      [agentQuiet, tenantB],
    ] as const) {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      await client.query(
        `INSERT INTO internal_agents (id, tenant_id, role) VALUES ($1, $2, 'Unread Test Agent')
         ON CONFLICT (id) DO NOTHING`,
        [agentId, tenantId],
      );
      await client.query('COMMIT');
    }
  });

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [t]);
      await client.query(`DELETE FROM agent_chat_messages WHERE tenant_id = $1`, [t]);
      await client.query(
        `DELETE FROM agent_chat_thread_reads WHERE tenant_id = $1`, [t],
      );
      await client.query(
        `DELETE FROM agent_chat_thread_participants
         WHERE thread_id IN (SELECT id FROM agent_chat_threads WHERE tenant_id = $1)`,
        [t],
      );
      await client.query(`DELETE FROM agent_chat_threads WHERE tenant_id = $1`, [t]);
      await client.query(`DELETE FROM internal_agents WHERE tenant_id = $1`, [t]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [t]);
      await client.query('COMMIT');
    }
    await client.query(`DELETE FROM accounts WHERE id IN ($1, $2)`, [acctA, acctB]);
    client.release();
    await pool.end();
  });

  // ── The predicate ──────────────────────────────────────────────────────

  it('(a) a reply newer than the read marker is unread', async () => {
    const threadId = await seedThread({
      tenantId: tenantA, agentId: agentA, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-08-07T12:00:00.000Z'),
    });
    await markRead(tenantA, acctA, threadId, new Date('2026-08-07T11:00:00.000Z'));

    expect(await isUnread(tenantA, acctA, threadId)).toBe(true);
  });

  it('(b) a reply older than the read marker is read', async () => {
    const threadId = await seedThread({
      tenantId: tenantA, agentId: agentA, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-08-07T11:00:00.000Z'),
    });
    await markRead(tenantA, acctA, threadId, new Date('2026-08-07T12:00:00.000Z'));

    expect(await isUnread(tenantA, acctA, threadId)).toBe(false);
  });

  it('(c) a reply with no read marker at all is unread', async () => {
    const threadId = await seedThread({
      tenantId: tenantA, agentId: agentA, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-08-07T12:00:00.000Z'),
    });

    expect(await isUnread(tenantA, acctA, threadId)).toBe(true);
  });

  it('(d) a thread the team has never replied in is never unread', async () => {
    const threadId = await seedThread({
      tenantId: tenantA, agentId: agentA, ownerAccountId: acctA,
      assistantRepliedAt: null,
    });

    // No marker either — "never replied" wins over "never read".
    expect(await isUnread(tenantA, acctA, threadId)).toBe(false);
  });

  it("(e) another account's read marker does not mark it read for me", async () => {
    const threadId = await seedThread({
      tenantId: tenantA, agentId: agentA, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-08-07T12:00:00.000Z'),
    });
    await markRead(tenantA, acctB, threadId, new Date('2026-08-07T13:00:00.000Z'));

    expect(await isUnread(tenantA, acctB, threadId)).toBe(false);
    expect(await isUnread(tenantA, acctA, threadId)).toBe(true);
  });

  // ── The marker ─────────────────────────────────────────────────────────

  it('(f) marking read twice rewrites one row rather than adding a second', async () => {
    const threadId = await seedThread({
      tenantId: tenantA, agentId: agentA, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-08-07T12:00:00.000Z'),
    });

    await markRead(tenantA, acctA, threadId, new Date('2026-08-07T11:00:00.000Z'));
    await markRead(tenantA, acctA, threadId, new Date('2026-08-07T13:00:00.000Z'));

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
    const rows = await client.query(
      `SELECT last_read_at FROM agent_chat_thread_reads
       WHERE thread_id = $1 AND account_id = $2`,
      [threadId, acctA],
    );
    await client.query('COMMIT');

    expect(rows.rows).toHaveLength(1);
    expect(new Date(rows.rows[0].last_read_at as string).toISOString())
      .toBe('2026-08-07T13:00:00.000Z');
    expect(await isUnread(tenantA, acctA, threadId)).toBe(false);
  });

  // ── The counts ─────────────────────────────────────────────────────────

  it('(g) counts group by participant team and omit teams with nothing unread', async () => {
    // Two unread threads on one team.
    await seedThread({
      tenantId: tenantB, agentId: agentB, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-08-07T12:00:00.000Z'),
    });
    await seedThread({
      tenantId: tenantB, agentId: agentB, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-08-07T12:30:00.000Z'),
    });
    // A second team whose only thread has already been read.
    const readThread = await seedThread({
      tenantId: tenantB, agentId: agentQuiet, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-08-07T12:00:00.000Z'),
    });
    await markRead(tenantB, acctA, readThread, new Date('2026-08-07T13:00:00.000Z'));

    const counts = await unreadCounts(tenantB, acctA);

    expect(counts[agentB]).toBe(2);
    // Zero is absent, not present as 0 — the payload stays proportional to what
    // is actually unread.
    expect(counts[agentQuiet]).toBeUndefined();
  });

  it('(g2) a soft-deleted thread never counts', async () => {
    const threadId = await seedThread({
      tenantId: tenantB, agentId: agentQuiet, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-08-07T12:00:00.000Z'),
    });
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
    await client.query(
      `UPDATE agent_chat_threads SET deleted_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [threadId, tenantB],
    );
    await client.query('COMMIT');

    const counts = await unreadCounts(tenantB, acctA);
    expect(counts[agentQuiet]).toBeUndefined();
  });

  // ── Day one ────────────────────────────────────────────────────────────
  //
  // The migration deliberately backfills nothing. What has to hold is that a
  // thread which already existed — including one with an old reply, and one
  // with no owner at all — is unread for NOBODY until the team next speaks.

  it('(h) leaves a pre-existing thread with an old reply unread for nobody', async () => {
    // Exactly what the migration finds: an assistant reply in the messages
    // table, no last_agent_message_at, and no read marker for anyone.
    const threadId = randomUUID();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
    await client.query(
      `INSERT INTO agent_chat_threads (id, tenant_id, account_id, channel, title)
       VALUES ($1, $2, $3, 'web', 'pre-migration thread')`,
      [threadId, tenantA, acctA],
    );
    await client.query(
      `INSERT INTO agent_chat_messages (tenant_id, thread_id, agent_id, role, content, created_at)
       VALUES ($1, $2, $3, 'assistant', 'a reply from months ago', '2026-01-02T03:04:05Z')`,
      [tenantA, threadId, agentA],
    );
    await client.query('COMMIT');

    // The thread's author is caught up...
    expect(await isUnread(tenantA, acctA, threadId)).toBe(false);
    // ...and so is every colleague. Seeding only the author would have left
    // this one lit for everybody else, since threads are tenant-visible.
    expect(await isUnread(tenantA, acctB, threadId)).toBe(false);
  });

  it('(i) starts that same thread reading as unread once the team next replies', async () => {
    const threadId = randomUUID();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
    await client.query(
      `INSERT INTO agent_chat_threads (id, tenant_id, account_id, channel, title)
       VALUES ($1, $2, $3, 'web', 'pre-migration thread that wakes up')`,
      [threadId, tenantA, acctA],
    );
    await client.query('COMMIT');
    expect(await isUnread(tenantA, acctA, threadId)).toBe(false);

    // The next reply stamps the clock, exactly as touchThreadOnClient does.
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
    await client.query(
      `UPDATE agent_chat_threads SET last_agent_message_at = NOW() WHERE id = $1`,
      [threadId],
    );
    await client.query('COMMIT');

    expect(await isUnread(tenantA, acctA, threadId)).toBe(true);
  });

  it('(j) handles an ownerless guest thread', async () => {
    // agent_chat_threads.account_id has been nullable since migration 111
    // (Slack guest threads). An INSERT ... SELECT t.account_id backfill hits a
    // NOT NULL violation on exactly this row.
    const threadId = randomUUID();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
    await client.query(
      `INSERT INTO agent_chat_threads (id, tenant_id, account_id, channel, external_thread_ref, title)
       VALUES ($1, $2, NULL, 'slack', $3, 'guest thread')`,
      [threadId, tenantA, `ts-${threadId}`],
    );
    await client.query('COMMIT');

    expect(await isUnread(tenantA, acctA, threadId)).toBe(false);
  });

  it('(k) ships no row-touching statement, so it needs no RLS escape', () => {
    const sql = migrationSql()
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n');

    // Pure DDL. If a future edit adds a backfill it must also add the
    // NO FORCE / FORCE pair, because the migrate role has no BYPASSRLS.
    expect(/\bINSERT\s+INTO\b/i.test(sql)).toBe(false);
    expect(/\bUPDATE\s+agent_chat/i.test(sql)).toBe(false);
    expect(/NO FORCE ROW LEVEL SECURITY/i.test(sql)).toBe(false);
  });
});
