// What the chat history modal is allowed to show — DB-backed integration tests.
//
// IS_CONVERSATION_PREDICATE is SQL, and a mocked client can only show that the
// statement was issued, never what it means. The unit tests beside this file
// pin the shape; this runs the REAL exported predicate against the REAL schema
// and asserts on which rows come back, which is the only thing that answers
// "does this hide the junk without hiding a conversation".
//
// Run after migrations complete:
//   TEST_DATABASE_URL=<migrated-db> npx jest --config jest.integration.config.js \
//     src/agent-chat/__tests__/conversation-predicate.integration.test.ts

import { Pool, PoolClient } from 'pg';
import { IS_CONVERSATION_PREDICATE } from '../chat-repository';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeFn('agent-chat / what counts as a conversation', () => {
  let pool: Pool;
  let client: PoolClient;

  const tenantId = '00000000-0000-0000-0000-00000000c0aa';
  const accountId = '00000000-0000-0000-0000-00000000c0bb';
  const agentId = '00000000-0000-0000-0000-00000000c0cc';

  /** Does the predicate consider this thread a conversation? */
  async function isConversation(threadId: string): Promise<boolean> {
    const result = await client.query(
      `SELECT (${IS_CONVERSATION_PREDICATE}) AS is_conversation
       FROM agent_chat_threads t
       WHERE t.id = $1`,
      [threadId],
    );
    return result.rows[0].is_conversation === true;
  }

  async function makeThread(title: string | null = null): Promise<string> {
    const r = await client.query(
      `INSERT INTO agent_chat_threads (tenant_id, account_id, channel, title)
       VALUES ($1, $2, 'web', $3) RETURNING id`,
      [tenantId, accountId, title],
    );
    return r.rows[0].id as string;
  }

  async function addMessage(
    threadId: string,
    role: string,
    opts: { turnId?: string | null; messageType?: string | null } = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO agent_chat_messages
         (tenant_id, thread_id, agent_id, role, content, message_type, turn_id)
       VALUES ($1, $2, $3, $4, 'text', $5, $6)`,
      [
        tenantId,
        threadId,
        role === 'user' ? null : agentId,
        role,
        opts.messageType ?? null,
        opts.turnId ?? null,
      ],
    );
  }

  /** A turn row, so a reply can carry a real turn_id like the live path does. */
  async function makeTurn(threadId: string): Promise<string> {
    const r = await client.query(
      `INSERT INTO agent_chat_turns (id, tenant_id, thread_id, agent_id, sender_account_id)
       VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
      [tenantId, threadId, agentId, accountId],
    );
    return r.rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    client = await pool.connect();
    // agent_chat_threads and agent_chat_messages are FORCE RLS, so every
    // statement here needs the tenant scope the app sets per transaction.
    await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenantId]);

    await client.query(
      `INSERT INTO accounts (id, firebase_uid, first_name, last_name, email, timezone, version)
       VALUES ($1, 'conversation-predicate-test', 'Conversation', 'Test', $2, 'UTC', 1)
       ON CONFLICT (id) DO NOTHING`,
      [accountId, `conversation-predicate-${accountId.slice(-4)}@example.test`],
    );
    await client.query(
      `INSERT INTO tenants (id, account_id, name, tier, hosting_mode, status, migration_status)
       VALUES ($1, $2, 'Conversation Predicate Tenant', 'standard', 'shared', 'pending', 'pending')
       ON CONFLICT (id) DO NOTHING`,
      [tenantId, accountId],
    );
    await client.query(
      `INSERT INTO internal_agents (id, tenant_id, role)
       VALUES ($1, $2, 'Conversation Predicate Agent')
       ON CONFLICT (id) DO NOTHING`,
      [agentId, tenantId],
    );
  });

  afterAll(async () => {
    await client.query(`DELETE FROM agent_chat_messages WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM agent_chat_turns WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM agent_chat_threads WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM internal_agents WHERE tenant_id = $1`, [tenantId]);
    await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    await client.query(`DELETE FROM accounts WHERE id = $1`, [accountId]);
    client.release();
    await pool.end();
  });

  // ── The two junk shapes this exists to hide ──────────────────────────────

  it('hides a thread holding nothing but the auto-greeting', async () => {
    const threadId = await makeThread();
    // Exactly what stream-router greeting mode writes: assistant role, no turn,
    // no message type.
    await addMessage(threadId, 'assistant');

    expect(await isConversation(threadId)).toBe(false);
  });

  it('hides a thread with no messages at all', async () => {
    const threadId = await makeThread();

    expect(await isConversation(threadId)).toBe(false);
  });

  it('hides a greeting-only thread even when it carries a title', async () => {
    // Some do: a suggested-prompt click passes a title to thread creation,
    // then never sends the message.
    const threadId = await makeThread('So what can you do?');
    await addMessage(threadId, 'assistant');

    expect(await isConversation(threadId)).toBe(false);
  });

  // ── Everything that must survive it ──────────────────────────────────────

  it('shows a thread the moment a person says something', async () => {
    const threadId = await makeThread();
    await addMessage(threadId, 'assistant');
    const turnId = await makeTurn(threadId);
    await addMessage(threadId, 'user', { turnId });

    expect(await isConversation(threadId)).toBe(true);
  });

  it('shows a thread whose only content is a reply from a real turn', async () => {
    const threadId = await makeThread();
    const turnId = await makeTurn(threadId);
    await addMessage(threadId, 'assistant', { turnId });

    expect(await isConversation(threadId)).toBe(true);
  });

  it('shows a thread whose only content is a typed out-of-turn row', async () => {
    // A routine proposal, a learning confirmation, a HITL status line. All are
    // written outside a turn, so turn_id is null and message_type is what
    // distinguishes them from a greeting.
    for (const messageType of ['suggestion', 'hitl_status', 'delegation_status']) {
      const threadId = await makeThread();
      await addMessage(threadId, 'assistant', { messageType });

      expect(await isConversation(threadId)).toBe(true);
    }
  });

  it('shows a thread whose only content is a tool row', async () => {
    const threadId = await makeThread();
    await addMessage(threadId, 'tool');

    expect(await isConversation(threadId)).toBe(true);
  });

  it('shows a thread that was greeted and then actually used', async () => {
    const threadId = await makeThread();
    await addMessage(threadId, 'assistant');
    const turnId = await makeTurn(threadId);
    await addMessage(threadId, 'user', { turnId });
    await addMessage(threadId, 'assistant', { turnId });

    expect(await isConversation(threadId)).toBe(true);
  });
});
