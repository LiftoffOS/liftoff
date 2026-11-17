// Migration 294 + Agent Conversation Recall — DB-backed integration tests
// (plan v13 Testing section, cases (a)-(h); requires TEST_DATABASE_URL).
//
// Runs the REAL recall query (AGENT_CONVERSATIONS_SQL, exported from
// platform-tools-router) against the real schema under tenant context, so
// the privacy assertions exercise actual SQL semantics — never mocks.
//
// Run after migrations complete:
//   npx jest --config jest.integration.config.js migrations/__tests__/294_agent_conversations.integration.test.ts

import { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { AGENT_CONVERSATIONS_SQL } from '../../src/internal-api/platform-tools-router';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

interface TurnRow {
  turn_id: string;
  thread_id: string;
  channel: string;
  created_at: Date;
  messages: Array<{ role: string; preview: string; created_at: string }>;
}

/** Run the recall query under the given tenant's RLS context. */
async function recall(
  client: PoolClient,
  tenantId: string,
  agentId: string,
  accountId: string,
  opts: { query?: string; excludeTurnId?: string; limit?: number } = {},
): Promise<TurnRow[]> {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
  const pattern = opts.query ? `%${opts.query.replace(/[%_\\]/g, '\\$&')}%` : null;
  const rawLower = opts.query ? opts.query.toLowerCase() : null;
  const result = await client.query(AGENT_CONVERSATIONS_SQL, [
    tenantId,
    agentId,
    accountId,
    opts.limit ?? 10,
    pattern,
    opts.excludeTurnId ?? null,
    rawLower,
  ]);
  await client.query('COMMIT');
  return result.rows as TurnRow[];
}

/** Insert a thread + one attributed turn with user/assistant messages. */
async function seedTurn(
  client: PoolClient,
  args: {
    tenantId: string;
    agentId: string;
    channel: string;
    senderAccountId: string | null;
    userContent: string;
    assistantContent?: string;
    threadId?: string;      // reuse an existing thread
    threadDeletedAt?: Date; // soft-delete the thread after
  },
): Promise<{ threadId: string; turnId: string }> {
  const threadId = args.threadId ?? randomUUID();
  const turnId = randomUUID();
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [args.tenantId]);
  if (!args.threadId) {
    await client.query(
      `INSERT INTO agent_chat_threads (id, tenant_id, account_id, channel, title)
       VALUES ($1, $2, $3, $4, 'recall test thread')`,
      [threadId, args.tenantId, args.senderAccountId, args.channel],
    );
    await client.query(
      `INSERT INTO agent_chat_thread_participants (thread_id, agent_id, added_by)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [threadId, args.agentId, args.senderAccountId],
    );
  } else {
    await client.query(
      `INSERT INTO agent_chat_thread_participants (thread_id, agent_id, added_by)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [threadId, args.agentId, args.senderAccountId],
    );
  }
  await client.query(
    `INSERT INTO agent_chat_turns (id, tenant_id, thread_id, agent_id, sender_account_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [turnId, args.tenantId, threadId, args.agentId, args.senderAccountId],
  );
  await client.query(
    `INSERT INTO agent_chat_messages (tenant_id, thread_id, role, content, turn_id)
     VALUES ($1, $2, 'user', $3, $4)`,
    [args.tenantId, threadId, args.userContent, turnId],
  );
  await client.query(
    `INSERT INTO agent_chat_messages (tenant_id, thread_id, agent_id, role, content, turn_id)
     VALUES ($1, $2, $3, 'assistant', $4, $5)`,
    [args.tenantId, threadId, args.agentId, args.assistantContent ?? 'reply', turnId],
  );
  if (args.threadDeletedAt) {
    await client.query(
      `UPDATE agent_chat_threads SET deleted_at = $3 WHERE id = $1 AND tenant_id = $2`,
      [threadId, args.tenantId, args.threadDeletedAt],
    );
  }
  await client.query('COMMIT');
  return { threadId, turnId };
}

describeFn('Agent conversation recall (migration 294)', () => {
  let pool: Pool;
  let client: PoolClient;

  const tenantA = '00000000-0000-0000-0000-00000000c0aa';
  const tenantB = '00000000-0000-0000-0000-00000000c0bb';
  const acctA = '00000000-0000-0000-0000-00000000acc1';
  const acctB = '00000000-0000-0000-0000-00000000acc2';
  // One agent per tenant — internal agents are tenant-scoped.
  const agentA = '00000000-0000-0000-0000-00000000a9a1';
  const agentA2 = '00000000-0000-0000-0000-00000000a9a2';
  const agentB = '00000000-0000-0000-0000-00000000a9b1';

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    client = await pool.connect();

    await client.query('BEGIN');
    for (const [id, email] of [
      [acctA, 'recall-a@test.invalid'],
      [acctB, 'recall-b@test.invalid'],
    ] as const) {
      await client.query(
        `INSERT INTO accounts (id, firebase_uid, first_name, last_name, email, timezone, version)
         VALUES ($1, $2, 'Recall', 'Test', $3, 'UTC', 1)
         ON CONFLICT (id) DO NOTHING`,
        [id, `recall-test-${id.slice(-4)}`, email],
      );
    }
    for (const [id, name] of [
      [tenantA, 'Recall Tenant A'],
      [tenantB, 'Recall Tenant B'],
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
      [agentA2, tenantA],
      [agentB, tenantB],
    ] as const) {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      await client.query(
        `INSERT INTO internal_agents (id, tenant_id, role) VALUES ($1, $2, 'Recall Test Agent')
         ON CONFLICT (id) DO NOTHING`,
        [agentId, tenantId],
      );
      await client.query('COMMIT');
    }
  });

  afterAll(async () => {
    // Cleanup: children first under each tenant's context, then tenants.
    for (const t of [tenantA, tenantB]) {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [t]);
      await client.query(`DELETE FROM agent_chat_messages WHERE tenant_id = $1`, [t]);
      await client.query(`DELETE FROM agent_chat_turns WHERE tenant_id = $1`, [t]);
      await client.query(`DELETE FROM agent_chat_thread_participants WHERE thread_id IN (SELECT id FROM agent_chat_threads WHERE tenant_id = $1)`, [t]);
      await client.query(`DELETE FROM agent_chat_threads WHERE tenant_id = $1`, [t]);
      await client.query(`DELETE FROM internal_agents WHERE tenant_id = $1`, [t]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [t]);
      await client.query('COMMIT');
    }
    await client.query(`DELETE FROM accounts WHERE id IN ($1, $2)`, [acctA, acctB]);
    client.release();
    await pool.end();
  });

  it('(a) returns the same account\'s turns across web, slack, teams, and mcp threads', async () => {
    for (const channel of ['web', 'slack', 'teams', 'mcp']) {
      await seedTurn(client, {
        tenantId: tenantA, agentId: agentA, channel,
        senderAccountId: acctA, userContent: `cross-channel probe on ${channel}`,
      });
    }
    const rows = await recall(client, tenantA, agentA, acctA, { query: 'cross-channel probe' });
    const channels = rows.map((r) => r.channel).sort();
    expect(channels).toEqual(['mcp', 'slack', 'teams', 'web']);
  });

  it('(b) two users in ONE shared web thread each recall only their own turns', async () => {
    const { threadId } = await seedTurn(client, {
      tenantId: tenantA, agentId: agentA, channel: 'web',
      senderAccountId: acctA, userContent: 'shared thread question from A',
    });
    await seedTurn(client, {
      tenantId: tenantA, agentId: agentA, channel: 'web', threadId,
      senderAccountId: acctB, userContent: 'shared thread question from B',
    });

    const rowsA = await recall(client, tenantA, agentA, acctA, { query: 'shared thread question' });
    const rowsB = await recall(client, tenantA, agentA, acctB, { query: 'shared thread question' });
    expect(rowsA.every((r) => r.messages.every((m) => !m.preview.includes('from B')))).toBe(true);
    expect(rowsB.every((r) => r.messages.every((m) => !m.preview.includes('from A')))).toBe(true);
    expect(rowsA.some((r) => r.messages.some((m) => m.preview.includes('from A')))).toBe(true);
    expect(rowsB.some((r) => r.messages.some((m) => m.preview.includes('from B')))).toBe(true);
  });

  it('(c) different users discussing the same topic leak nothing cross-user in search mode', async () => {
    await seedTurn(client, {
      tenantId: tenantA, agentId: agentA, channel: 'web',
      senderAccountId: acctA, userContent: 'quarterly report draft alpha',
    });
    await seedTurn(client, {
      tenantId: tenantA, agentId: agentA, channel: 'web',
      senderAccountId: acctB, userContent: 'quarterly report draft beta',
    });
    const rowsA = await recall(client, tenantA, agentA, acctA, { query: 'quarterly report' });
    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsA.every((r) => r.messages.every((m) => !m.preview.includes('beta')))).toBe(true);
  });

  it('(d) multiple agents in one thread: the agent filter returns only that agent\'s turns', async () => {
    const { threadId } = await seedTurn(client, {
      tenantId: tenantA, agentId: agentA, channel: 'web',
      senderAccountId: acctA, userContent: 'multi-agent probe for first agent',
    });
    await seedTurn(client, {
      tenantId: tenantA, agentId: agentA2, channel: 'web', threadId,
      senderAccountId: acctA, userContent: 'multi-agent probe for second agent',
    });
    const rows = await recall(client, tenantA, agentA2, acctA, { query: 'multi-agent probe' });
    expect(rows.length).toBe(1);
    expect(rows[0].messages.some((m) => m.preview.includes('second agent'))).toBe(true);
  });

  it('(e) excludes the current TURN while returning earlier turns of the SAME thread', async () => {
    const { threadId, turnId: earlier } = await seedTurn(client, {
      tenantId: tenantA, agentId: agentA, channel: 'web',
      senderAccountId: acctA, userContent: 'same-thread earlier turn',
    });
    const { turnId: current } = await seedTurn(client, {
      tenantId: tenantA, agentId: agentA, channel: 'web', threadId,
      senderAccountId: acctA, userContent: 'same-thread current turn',
    });
    const rows = await recall(client, tenantA, agentA, acctA, {
      query: 'same-thread', excludeTurnId: current,
    });
    const ids = rows.map((r) => r.turn_id);
    expect(ids).toContain(earlier);
    expect(ids).not.toContain(current);
  });

  it('(f) never returns unattributed history (turn_id NULL messages, sender NULL turns)', async () => {
    // Legacy message without a turn.
    const legacyThread = randomUUID();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantA]);
    await client.query(
      `INSERT INTO agent_chat_threads (id, tenant_id, account_id, channel, title)
       VALUES ($1, $2, $3, 'web', 'legacy thread')`,
      [legacyThread, tenantA, acctA],
    );
    await client.query(
      `INSERT INTO agent_chat_messages (tenant_id, thread_id, role, content)
       VALUES ($1, $2, 'user', 'unattributed legacy needle')`,
      [tenantA, legacyThread],
    );
    await client.query('COMMIT');
    // Guest turn (sender NULL).
    await seedTurn(client, {
      tenantId: tenantA, agentId: agentA, channel: 'slack',
      senderAccountId: null, userContent: 'guest needle message',
    });

    const legacy = await recall(client, tenantA, agentA, acctA, { query: 'unattributed legacy needle' });
    expect(legacy).toHaveLength(0);
    const guest = await recall(client, tenantA, agentA, acctA, { query: 'guest needle' });
    expect(guest).toHaveLength(0);
  });

  it('(g) cross-tenant recall is empty', async () => {
    await seedTurn(client, {
      tenantId: tenantB, agentId: agentB, channel: 'web',
      senderAccountId: acctA, userContent: 'tenant-b private needle',
    });
    // Querying under tenant A's context for tenant B's agent yields nothing.
    const rows = await recall(client, tenantA, agentB, acctA, { query: 'tenant-b private needle' });
    expect(rows).toHaveLength(0);
  });

  it('(h) excludes turns of soft-deleted threads', async () => {
    await seedTurn(client, {
      tenantId: tenantA, agentId: agentA, channel: 'web',
      senderAccountId: acctA, userContent: 'deleted thread needle',
      threadDeletedAt: new Date(),
    });
    const rows = await recall(client, tenantA, agentA, acctA, { query: 'deleted thread needle' });
    expect(rows).toHaveLength(0);
  });
});
