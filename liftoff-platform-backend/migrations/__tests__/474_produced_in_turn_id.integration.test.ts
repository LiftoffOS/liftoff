// Migration 474 — a file card carries the turn it was produced in, two cards
// in one turn both insert, and the counting query draws every boundary the
// attachment-claim check depends on — against real rows.
//
// The unit tests beside the repository assert what the code WRITES and the
// shape of the statement; this one asserts what the database HOLDS and what
// the SAME statement (TURN_FILE_CARD_COUNTS_SQL, exported from the
// repository) answers under tenant context with rows on both sides of each
// line: a card from the previous turn, a media row, a card with no turn that
// appeared before the turn started, one that appeared after, a second card in
// the same turn beside the turn's own reply, and a turn that is not on record.
//
// Run after migrations complete:
//   TEST_DATABASE_URL=<migrated-db> npx jest --config jest.integration.config.js \
//     migrations/__tests__/474_produced_in_turn_id.integration.test.ts

import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { TURN_FILE_CARD_COUNTS_SQL } from '../../src/agent-chat/chat-repository';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeFn('agent_chat_messages.produced_in_turn_id (migration 474)', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    client = await pool.connect();
  });

  afterAll(async () => {
    client?.release();
    await pool?.end();
  });

  describe('schema', () => {
    it('exists as a nullable uuid', async () => {
      const res = await client.query<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable
         FROM information_schema.columns
         WHERE table_name = 'agent_chat_messages' AND column_name = 'produced_in_turn_id'`,
      );
      expect(res.rowCount).toBe(1);
      expect(res.rows[0]).toEqual({ data_type: 'uuid', is_nullable: 'YES' });
    });

    it('is indexed with the thread, non-unique, for the reader', async () => {
      const res = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE tablename = 'agent_chat_messages' AND indexname = 'idx_acm_produced_in_turn'`,
      );
      expect(res.rowCount).toBe(1);
      expect(res.rows[0].indexdef).toMatch(/\(thread_id, produced_in_turn_id\)/);
      expect(res.rows[0].indexdef).not.toMatch(/UNIQUE/);
    });

    it('leaves acm_assistant_turn_uniq on turn_id alone', async () => {
      const res = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
         WHERE tablename = 'agent_chat_messages' AND indexname = 'acm_assistant_turn_uniq'`,
      );
      expect(res.rowCount).toBe(1);
      expect(res.rows[0].indexdef).toMatch(/UNIQUE/);
      expect(res.rows[0].indexdef).toMatch(/\(turn_id\)/);
      expect(res.rows[0].indexdef).not.toMatch(/produced_in_turn_id/);
    });
  });

  describe('the counting query, with real rows', () => {
    const tenant = '00000000-0000-0000-0000-00000000f474';
    const account = '00000000-0000-0000-0000-0000000ac474';
    const agent = '00000000-0000-0000-0000-00000000a474';
    const thread = randomUUID();
    const earlierTurn = randomUUID();
    const turn = randomUUID();

    /** Run a statement under the tenant's RLS context. */
    async function scoped<T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
      await client.query('BEGIN');
      try {
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant]);
        const res = await client.query(sql, params);
        await client.query('COMMIT');
        return res.rows as T[];
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    /** A card row. `agoSeconds` backdates it on the DATABASE clock, the same
     *  clock the turn rows carry, so no application timestamp enters the
     *  comparison the query makes. */
    async function card(args: { producedInTurnId: string | null; agoSeconds?: number; messageType?: string }): Promise<void> {
      await scoped(
        `INSERT INTO agent_chat_messages
           (tenant_id, thread_id, agent_id, role, content, message_type, attachments, produced_in_turn_id, created_at)
         VALUES ($1, $2, $3, 'assistant', '', $4, '[{"generatedFileId":"f"}]'::jsonb, $5,
                 NOW() - make_interval(secs => $6::float8))`,
        [tenant, thread, agent, args.messageType ?? 'file_output', args.producedInTurnId, args.agoSeconds ?? 0],
      );
    }

    async function counts(forTurn: string): Promise<{ attributed: number; unattributed: number } | null> {
      const rows = await scoped<{ attributed: number; unattributed: number }>(
        TURN_FILE_CARD_COUNTS_SQL, [tenant, thread, forTurn],
      );
      return rows[0] ?? null;
    }

    beforeAll(async () => {
      await client.query(
        `INSERT INTO accounts (id, firebase_uid, first_name, last_name, email, timezone, version)
         VALUES ($1, 'cards-test-474', 'Cards', 'Test', 'cards-474@test.invalid', 'UTC', 1)
         ON CONFLICT (id) DO NOTHING`,
        [account],
      );
      await client.query(
        `INSERT INTO tenants (id, account_id, name, tier, hosting_mode, status, migration_status)
         VALUES ($1, $2, 'Cards Tenant 474', 'standard', 'shared', 'pending', 'pending')
         ON CONFLICT (id) DO NOTHING`,
        [tenant, account],
      );
      await scoped(
        `INSERT INTO internal_agents (id, tenant_id, role) VALUES ($1, $2, 'Cards Test Agent')
         ON CONFLICT (id) DO NOTHING`,
        [agent, tenant],
      );
      await scoped(
        `INSERT INTO agent_chat_threads (id, tenant_id, account_id, channel, title)
         VALUES ($1, $2, $3, 'web', 'cards test thread')`,
        [thread, tenant, account],
      );
      // The earlier turn started a minute ago; the turn under test starts now.
      await scoped(
        `INSERT INTO agent_chat_turns (id, tenant_id, thread_id, agent_id, sender_account_id, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW() - interval '60 seconds')`,
        [earlierTurn, tenant, thread, agent, account],
      );
      await scoped(
        `INSERT INTO agent_chat_turns (id, tenant_id, thread_id, agent_id, sender_account_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [turn, tenant, thread, agent, account],
      );
    });

    afterAll(async () => {
      await scoped(`DELETE FROM agent_chat_messages WHERE tenant_id = $1`, [tenant]);
      await scoped(`DELETE FROM agent_chat_turns WHERE tenant_id = $1`, [tenant]);
      await scoped(`DELETE FROM agent_chat_threads WHERE tenant_id = $1`, [tenant]);
      await scoped(`DELETE FROM internal_agents WHERE tenant_id = $1`, [tenant]);
      await scoped(`DELETE FROM tenants WHERE id = $1`, [tenant]);
      await client.query(`DELETE FROM accounts WHERE id = $1`, [account]);
    });

    it('answers zero and zero for a turn on record with no cards on the thread', async () => {
      expect(await counts(turn)).toEqual({ attributed: 0, unattributed: 0 });
    });

    it('answers no row for a turn that is not on record — never zero cards', async () => {
      expect(await counts(randomUUID())).toBeNull();
    });

    it('does not count the previous turn\'s card, seconds earlier on the same thread', async () => {
      await card({ producedInTurnId: earlierTurn, agoSeconds: 30 });
      expect(await counts(turn)).toEqual({ attributed: 0, unattributed: 0 });
      // It is that turn's, though.
      expect(await counts(earlierTurn)).toEqual({ attributed: 1, unattributed: 0 });
    });

    it('does not count a media row, even one tagged with this turn', async () => {
      await card({ producedInTurnId: turn, messageType: 'media' });
      expect(await counts(turn)).toEqual({ attributed: 0, unattributed: 0 });
    });

    it('does not count a card with no turn that appeared BEFORE the turn started', async () => {
      await card({ producedInTurnId: null, agoSeconds: 45 });
      expect(await counts(turn)).toEqual({ attributed: 0, unattributed: 0 });
    });

    it('sees a card with no turn that appeared after the turn started, as unattributed only', async () => {
      await card({ producedInTurnId: null });
      expect(await counts(turn)).toEqual({ attributed: 0, unattributed: 1 });
    });

    it('counts the turn\'s own cards, and a second card in the same turn inserts beside the turn\'s reply', async () => {
      await card({ producedInTurnId: turn });
      // The reply itself owns turn_id; a card never does, which is what lets
      // the next one in.
      await scoped(
        `INSERT INTO agent_chat_messages (tenant_id, thread_id, agent_id, role, content, turn_id)
         VALUES ($1, $2, $3, 'assistant', 'Attached below.', $4)`,
        [tenant, thread, agent, turn],
      );
      await card({ producedInTurnId: turn });
      expect(await counts(turn)).toEqual({ attributed: 2, unattributed: 1 });
    });
  });
});
