// Migration 433 + Liftoff chat unread state — DB-backed integration tests.
//
// The 338 suite, replayed against the Liftoff stack: the unread indicator is a
// SQL predicate, and a mock can show the statement was issued, not what it
// means. So this runs the REAL exported predicate (UNREAD_PREDICATE,
// src/liftoff/chat-repository.ts) against the real schema.
//
// Run after migrations complete:
//   TEST_DATABASE_URL=<migrated-db> npx jest --config jest.integration.config.js \
//     migrations/__tests__/433_liftoff_chat_unread.integration.test.ts

import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { UNREAD_PREDICATE } from '../../src/liftoff/chat-repository';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function migrationSql(): string {
  return readFileSync(join(__dirname, '..', '433_liftoff_chat_unread.sql'), 'utf8');
}

describeFn('Liftoff chat unread state (migration 433)', () => {
  let pool: Pool;
  let client: PoolClient;

  const tenantA = '00000000-0000-0000-0000-00000000d1aa';
  const tenantB = '00000000-0000-0000-0000-00000000d1bb';
  const acctA = '00000000-0000-0000-0000-00000000ad11';
  const acctB = '00000000-0000-0000-0000-00000000ad12';

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
       FROM liftoff_chat_threads t
       LEFT JOIN liftoff_chat_thread_reads r ON r.thread_id = t.id AND r.account_id = $1
       WHERE t.id = $2`,
      [accountId, threadId],
    );
    await client.query('COMMIT');
    return result.rows[0].unread === true;
  }

  /** The count query getUnreadThreadCount() issues, on the same predicate. */
  async function unreadCount(tenantId: string, accountId: string): Promise<number> {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    const result = await client.query(
      `SELECT COUNT(*)::int AS unread
       FROM liftoff_chat_threads t
       LEFT JOIN liftoff_chat_thread_reads r ON r.thread_id = t.id AND r.account_id = $2
       WHERE t.tenant_id = $1
         AND t.deleted_at IS NULL
         AND ${UNREAD_PREDICATE}`,
      [tenantId, accountId],
    );
    await client.query('COMMIT');
    return result.rows[0].unread as number;
  }

  /** A thread, optionally with the reply clock already stamped. */
  async function seedThread(args: {
    tenantId: string;
    ownerAccountId: string;
    assistantRepliedAt?: Date | null;
  }): Promise<string> {
    const threadId = randomUUID();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [args.tenantId]);
    await client.query(
      `INSERT INTO liftoff_chat_threads (id, tenant_id, account_id, title, last_assistant_message_at)
       VALUES ($1, $2, $3, 'unread test thread', $4)`,
      [threadId, args.tenantId, args.ownerAccountId, args.assistantRepliedAt ?? null],
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
      `INSERT INTO liftoff_chat_thread_reads (thread_id, account_id, tenant_id, last_read_at)
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
        [id, `unread-${id.slice(-4)}`, email],
      );
    }
    for (const [id, name] of [
      [tenantA, 'Liftoff Unread Tenant A'],
      [tenantB, 'Liftoff Unread Tenant B'],
    ] as const) {
      await client.query(
        `INSERT INTO tenants (id, account_id, name, tier, hosting_mode, status, migration_status)
         VALUES ($1, $2, $3, 'standard', 'shared', 'pending', 'pending')
         ON CONFLICT (id) DO NOTHING`,
        [id, acctA, name],
      );
    }
    await client.query('COMMIT');
  });

  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [t]);
      await client.query(
        `DELETE FROM liftoff_chat_messages
         WHERE thread_id IN (SELECT id FROM liftoff_chat_threads WHERE tenant_id = $1)`,
        [t],
      );
      await client.query(`DELETE FROM liftoff_chat_thread_reads WHERE tenant_id = $1`, [t]);
      await client.query(`DELETE FROM liftoff_chat_threads WHERE tenant_id = $1`, [t]);
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
      tenantId: tenantA, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-09-07T12:00:00.000Z'),
    });
    await markRead(tenantA, acctA, threadId, new Date('2026-09-07T11:00:00.000Z'));

    expect(await isUnread(tenantA, acctA, threadId)).toBe(true);
  });

  it('(b) a reply older than the read marker is read', async () => {
    const threadId = await seedThread({
      tenantId: tenantA, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-09-07T11:00:00.000Z'),
    });
    await markRead(tenantA, acctA, threadId, new Date('2026-09-07T12:00:00.000Z'));

    expect(await isUnread(tenantA, acctA, threadId)).toBe(false);
  });

  it('(c) a reply with no read marker at all is unread', async () => {
    const threadId = await seedThread({
      tenantId: tenantA, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-09-07T12:00:00.000Z'),
    });

    expect(await isUnread(tenantA, acctA, threadId)).toBe(true);
  });

  it('(d) a thread Liftoff has never replied in is never unread', async () => {
    const threadId = await seedThread({
      tenantId: tenantA, ownerAccountId: acctA,
      assistantRepliedAt: null,
    });

    // No marker either — "never replied" wins over "never read".
    expect(await isUnread(tenantA, acctA, threadId)).toBe(false);
  });

  it("(e) another account's read marker does not mark it read for me", async () => {
    // Threads are workspace-visible (migration 351), so this is the case that
    // makes the marker per-account rather than per-thread.
    const threadId = await seedThread({
      tenantId: tenantA, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-09-07T12:00:00.000Z'),
    });
    await markRead(tenantA, acctB, threadId, new Date('2026-09-07T13:00:00.000Z'));

    expect(await isUnread(tenantA, acctB, threadId)).toBe(false);
    expect(await isUnread(tenantA, acctA, threadId)).toBe(true);
  });

  // ── The marker ─────────────────────────────────────────────────────────

  it('(f) marking read twice rewrites one row rather than adding a second', async () => {
    const threadId = await seedThread({
      tenantId: tenantA, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-09-07T12:00:00.000Z'),
    });

    await markRead(tenantA, acctA, threadId, new Date('2026-09-07T11:00:00.000Z'));
    await markRead(tenantA, acctA, threadId, new Date('2026-09-07T13:00:00.000Z'));

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
    const rows = await client.query(
      `SELECT last_read_at FROM liftoff_chat_thread_reads
       WHERE thread_id = $1 AND account_id = $2`,
      [threadId, acctA],
    );
    await client.query('COMMIT');

    expect(rows.rows).toHaveLength(1);
    expect(new Date(rows.rows[0].last_read_at as string).toISOString())
      .toBe('2026-09-07T13:00:00.000Z');
    expect(await isUnread(tenantA, acctA, threadId)).toBe(false);
  });

  // ── The count ──────────────────────────────────────────────────────────

  it('(g) counts unread threads and ignores read and soft-deleted ones', async () => {
    await seedThread({
      tenantId: tenantB, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-09-07T12:00:00.000Z'),
    });
    await seedThread({
      tenantId: tenantB, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-09-07T12:30:00.000Z'),
    });
    const readThread = await seedThread({
      tenantId: tenantB, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-09-07T12:00:00.000Z'),
    });
    await markRead(tenantB, acctA, readThread, new Date('2026-09-07T13:00:00.000Z'));
    const deletedThread = await seedThread({
      tenantId: tenantB, ownerAccountId: acctA,
      assistantRepliedAt: new Date('2026-09-07T12:00:00.000Z'),
    });
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantB]);
    await client.query(
      `UPDATE liftoff_chat_threads SET deleted_at = NOW() WHERE id = $1 AND tenant_id = $2`,
      [deletedThread, tenantB],
    );
    await client.query('COMMIT');

    expect(await unreadCount(tenantB, acctA)).toBe(2);
  });

  // ── Day one ────────────────────────────────────────────────────────────
  //
  // The migration deliberately backfills nothing. What has to hold is that a
  // thread which already existed — including one with an old reply in the
  // messages table — is unread for NOBODY until Liftoff next speaks.

  it('(h) leaves a pre-existing thread with an old reply unread for nobody', async () => {
    const threadId = randomUUID();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
    await client.query(
      `INSERT INTO liftoff_chat_threads (id, tenant_id, account_id, title)
       VALUES ($1, $2, $3, 'pre-migration thread')`,
      [threadId, tenantA, acctA],
    );
    await client.query(
      `INSERT INTO liftoff_chat_messages (thread_id, role, content, created_at)
       VALUES ($1, 'assistant', 'a reply from months ago', '2026-01-02T03:04:05Z')`,
      [threadId],
    );
    await client.query('COMMIT');

    // The author is caught up, and so is every colleague: threads are
    // workspace-visible, so seeding only the author would have left this one
    // lit for everybody else.
    expect(await isUnread(tenantA, acctA, threadId)).toBe(false);
    expect(await isUnread(tenantA, acctB, threadId)).toBe(false);
  });

  it('(i) starts that same thread reading as unread once Liftoff next replies', async () => {
    const threadId = await seedThread({
      tenantId: tenantA, ownerAccountId: acctA, assistantRepliedAt: null,
    });
    expect(await isUnread(tenantA, acctA, threadId)).toBe(false);

    // The next reply stamps the clock, exactly as touchThread does.
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
    await client.query(
      `UPDATE liftoff_chat_threads SET last_assistant_message_at = NOW() WHERE id = $1`,
      [threadId],
    );
    await client.query('COMMIT');

    expect(await isUnread(tenantA, acctA, threadId)).toBe(true);
  });

  it('(j) ships no row-touching statement, so it needs no RLS escape', () => {
    const sql = migrationSql()
      .split('\n')
      .map((l) => l.replace(/--.*$/, ''))
      .join('\n');

    // Pure DDL. If a future edit adds a backfill it must also add the
    // NO FORCE / FORCE pair, because the migrate role has no BYPASSRLS.
    expect(/\bINSERT\s+INTO\b/i.test(sql)).toBe(false);
    expect(/\bUPDATE\s+liftoff_chat/i.test(sql)).toBe(false);
    expect(/NO FORCE ROW LEVEL SECURITY/i.test(sql)).toBe(false);
  });
});
