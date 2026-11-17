// The export's reads against the REAL schema — DB-backed integration tests.
//
// The unit tests beside this file pin each statement's shape; a mocked client
// can show that a predicate was issued, never what it means. This runs the
// real queries against a migrated database and asserts on which rows come
// back: an assignment created after asOf is absent and one removed after asOf
// is present, a late-feedback row created after asOf is absent, two rows that
// share a boundary timestamp survive a page break, a person's upload is never
// a produced file, and the team-chat sender resolves the way listMessages
// resolves it.
//
// Run after migrations complete:
//   TEST_DATABASE_URL=<migrated-db> npx jest --config jest.integration.config.js \
//     src/workspace-export/__tests__/queries.integration.test.ts

import { Pool, type PoolClient } from 'pg';

const describeFn = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// The queries reach the database through the app's wrappers; route them at
// the test database with the same per-transaction RLS scope the app sets.
let testPool: Pool | null = null;
jest.mock('../../infrastructure/database', () => ({
  getPool: () => testPool,
  withTenantScope: async (tenantId: string, fn: (client: PoolClient) => Promise<unknown>) => {
    const client = await (testPool as Pool).connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
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
}));

import { ExportBudget } from '../budget';
import * as q from '../queries';

const AS_OF = new Date('2026-09-18T21:04:11.318Z');
const BEFORE = '2026-09-10T10:00:00Z';
const AFTER = '2026-09-19T10:00:00Z';

const T = '00000000-0000-0000-0000-00000000e0a0';
const OWNER = '00000000-0000-0000-0000-00000000e0a1';
const MEMBER = '00000000-0000-0000-0000-00000000e0a2';
const LATE_MEMBER = '00000000-0000-0000-0000-00000000e0a3';
const TEAM = '00000000-0000-0000-0000-00000000e0b1';
const ARCHIVED_TEAM = '00000000-0000-0000-0000-00000000e0b2';
const CONNECTOR = '00000000-0000-0000-0000-00000000e0c1';
const COLLABORATOR = '00000000-0000-0000-0000-00000000e0d1';
const REMOVED_COLLABORATOR = '00000000-0000-0000-0000-00000000e0d2';
const LATE_COLLABORATOR = '00000000-0000-0000-0000-00000000e0d3';

describeFn('workspace-export / the reads against the real schema', () => {
  let client: PoolClient;

  const budget = () => new ExportBudget();

  /** Everything this suite writes, removed. Run before as well as after, so a
   *  run that was killed mid-way cannot leave fixtures that skew the next. */
  async function cleanUp(): Promise<void> {
    for (const table of ['liftoff_chat_messages', 'insights_chat_messages']) {
      await client.query(`DELETE FROM ${table} WHERE thread_id IN (SELECT id FROM ${table.replace('_messages', '_threads')} WHERE tenant_id = $1)`, [T]);
    }
    // The last-owner trigger refuses to delete an owner row; demote it first.
    await client.query(`UPDATE tenant_members SET role = 'admin' WHERE tenant_id = $1 AND role = 'owner'`, [T]);
    for (const table of ['liftoff_chat_threads', 'insights_chat_threads', 'agent_chat_messages', 'agent_chat_turns', 'agent_chat_threads',
      'generated_files', 'custom_mcp_servers', 'connectors', 'knowledge_items', 'hitl_late_feedback', 'person_agent_assignments',
      'tenant_invitations', 'tenant_members', 'external_agents', 'internal_agents']) {
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [T]);
    }
    await client.query(`DELETE FROM tenants WHERE id = $1`, [T]);
    await client.query(`DELETE FROM accounts WHERE id = ANY($1::uuid[])`, [[OWNER, MEMBER, LATE_MEMBER]]);
  }

  beforeAll(async () => {
    testPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    client = await testPool.connect();
    await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [T]);
    await cleanUp();

    for (const [id, first, email] of [[OWNER, 'Alex', 'wx-owner'], [MEMBER, 'Priya', 'wx-member'], [LATE_MEMBER, 'Late', 'wx-late']]) {
      await client.query(
        `INSERT INTO accounts (id, firebase_uid, first_name, last_name, email, timezone, version)
         VALUES ($1, $2, $3, 'Export', $4, 'UTC', 1) ON CONFLICT (id) DO NOTHING`,
        [id, `workspace-export-${email}`, first, `${email}@example.test`],
      );
    }
    await client.query(
      `INSERT INTO tenants (id, account_id, name, tier, hosting_mode, status, migration_status)
       VALUES ($1, $2, 'Workspace Export Tenant', 'standard', 'shared', 'pending', 'pending')
       ON CONFLICT (id) DO NOTHING`,
      [T, OWNER],
    );
    await client.query(
      `INSERT INTO internal_agents (id, tenant_id, role, summary, responsibilities, created_at)
       VALUES ($1, $2, 'Export Reviewer', 'Reviews.', 'Review PRs.', $3),
              ($4, $2, 'Old Team', NULL, 'Was here.', $3)
       ON CONFLICT (id) DO NOTHING`,
      [TEAM, T, BEFORE, ARCHIVED_TEAM],
    );
    await client.query(`UPDATE internal_agents SET deleted_at = $2 WHERE id = $1`, [ARCHIVED_TEAM, BEFORE]);

    // External Agents: one live, one removed before asOf, one added after.
    await client.query(
      `INSERT INTO external_agents (id, tenant_id, name, endpoint_url, description, connection_type, auth_type, collaboration_mode,
                                    detected_capabilities, allowed_internal_agent_ids, request_rules, status, created_at, deleted_at)
       VALUES ($1, $2, 'Legal Bot', 'https://legal.example.test/mcp', 'Reviews contracts.', 'custom', 'bearer_token', 'request_help',
               $6::jsonb, $7::uuid[], $8::jsonb, 'connected', $4, NULL),
              ($3, $2, 'Retired Bot', 'https://old.example.test/mcp', NULL, 'custom', 'none', 'observe_only',
               '[]'::jsonb, '{}'::uuid[], '[]'::jsonb, 'disconnected', $4, $4),
              ($9, $2, 'Late Bot', 'https://late.example.test/mcp', NULL, 'custom', 'none', 'observe_only',
               '[]'::jsonb, '{}'::uuid[], '[]'::jsonb, 'pending', $5, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [COLLABORATOR, T, REMOVED_COLLABORATOR, BEFORE, AFTER,
        JSON.stringify([{ id: 'cap-1', name: 'Review contract', description: 'Flags risk.', rawToolName: 'mcp__legal__review' }]),
        [TEAM],
        JSON.stringify([{ internalAgentId: TEAM, internalAgentName: 'Export Reviewer', permissions: { read_summaries: 'allowed' } }]),
        LATE_COLLABORATOR],
    );

    // Members: two joined before asOf, one after.
    await client.query(
      `INSERT INTO tenant_members (tenant_id, account_id, role, joined_at, created_at)
       VALUES ($1, $2, 'owner', $4, $4), ($1, $3, 'member', $4, $4), ($1, $5, 'viewer', $6, $6)
       ON CONFLICT (tenant_id, account_id) DO NOTHING`,
      [T, OWNER, MEMBER, BEFORE, LATE_MEMBER, AFTER],
    );
    // Invitations: pending before, pending after, accepted before.
    await client.query(
      `INSERT INTO tenant_invitations (tenant_id, email, role, invite_token_hash, status, invited_by, expires_at, created_at)
       VALUES ($1, 'pending-before@example.test', 'member', 'h1', 'pending', $2, $4, $3),
              ($1, 'pending-after@example.test', 'member', 'h2', 'pending', $2, $4, $4),
              ($1, 'accepted@example.test', 'member', 'h3', 'accepted', $2, $4, $3)`,
      [T, OWNER, BEFORE, AFTER],
    );
    // Assignments: live, created after asOf, deleted after asOf, deleted before asOf.
    await client.query(
      `INSERT INTO person_agent_assignments (tenant_id, account_id, agent_id, agent_origin, created_at, deleted_at)
       VALUES ($1, $2, $3, 'internal', $4, NULL),
              ($1, $5, $3, 'internal', $6, NULL),
              ($1, $5, $7, 'internal', $4, $6),
              ($1, $2, $7, 'internal', $4, $4)`,
      [T, OWNER, TEAM, BEFORE, MEMBER, AFTER, ARCHIVED_TEAM],
    );
    // Late feedback: one before asOf, one after.
    await client.query(
      `INSERT INTO hitl_late_feedback
         (tenant_id, approval_id, agent_id, hitl_level, tool_calls_hash, pending_tool_calls, gate_reason, decision,
          decided_by, decided_by_role, approval_created_at, approval_expired_at, created_at)
       VALUES ($1, 'approval-before', 'agent', 1, 'h', '[]', 'level_1_gate', 'would_reject', $2, 'owner', $3, $3, $3),
              ($1, 'approval-after', 'agent', 1, 'h', '[]', 'level_1_gate', 'would_approve', $2, 'owner', $3, $3, $4)`,
      [T, OWNER, BEFORE, AFTER],
    );
    // Knowledge: three rows, two sharing one created_at to the microsecond.
    await client.query(
      `INSERT INTO knowledge_items (id, tenant_id, title, created_at)
       VALUES ('00000000-0000-0000-0000-00000000e0d1', $1, 'K1', '2026-09-01 10:00:00.123456+00'),
              ('00000000-0000-0000-0000-00000000e0d2', $1, 'K2', '2026-09-01 10:00:00.123456+00'),
              ('00000000-0000-0000-0000-00000000e0d3', $1, 'K3', '2026-09-02 10:00:00+00'),
              ('00000000-0000-0000-0000-00000000e0d4', $1, 'K-after', $2)`,
      [T, AFTER],
    );
    // Custom MCP server, with the local connectors row its FK needs.
    await client.query(
      `INSERT INTO connectors (id, tenant_id, type, name, status) VALUES ($1, $2, 'custom_mcp_server', 'Internal Docs', 'active')
       ON CONFLICT (id) DO NOTHING`,
      [CONNECTOR, T],
    );
    await client.query(
      `INSERT INTO custom_mcp_servers (tenant_id, name, delivery_mode, endpoint_url, auth_type, auth_secret_name, raw_mcp_tools, connector_id, created_at)
       VALUES ($1, 'Internal Docs', 'public_url', 'https://mcp.example.test/sse', 'bearer_token', 'secret-name-never-exported', '[{"name":"tool"}]', $2, $3)`,
      [T, CONNECTOR, BEFORE],
    );
    // Files: one produced by the team, one a person's upload, one after asOf.
    await client.query(
      `INSERT INTO generated_files (tenant_id, agent_id, filename, base_name, version, output_type, gcs_path, size_bytes, uploaded_by_account_id, created_at)
       VALUES ($1, $2, 'report_v1.xlsx', 'report', 1, 'xlsx', 'tenants/t/agents/a/1/report_v1.xlsx', 100, NULL, $3),
              ($1, NULL, 'shot_v1.png', 'shot', 1, 'media', 'tenants/t/uploads/u/1/shot_v1.png', 50, $4, $3),
              ($1, $2, 'later_v1.xlsx', 'later', 1, 'xlsx', 'tenants/t/agents/a/2/later_v1.xlsx', 100, NULL, $5)`,
      [T, TEAM, BEFORE, OWNER, AFTER],
    );
    // Staged bytes: written, never presented, due to be discarded. Beside it,
    // one that WAS presented — same producer, same day, lifetime cleared —
    // because the predicate has to keep that one.
    await client.query(
      `INSERT INTO generated_files (tenant_id, agent_id, filename, base_name, version, output_type, gcs_path, size_bytes, uploaded_by_account_id, created_at, discard_after)
       VALUES ($1, $2, 'staged_v1.pdf', 'staged', 1, 'pdf', 'tenants/t/agents/a/3/staged_v1.pdf', 100, NULL, $3, NOW() + INTERVAL '1 day'),
              ($1, $2, 'shown_v1.pdf', 'shown', 1, 'pdf', 'tenants/t/agents/a/4/shown_v1.pdf', 100, NULL, $3, NULL)`,
      [T, TEAM, BEFORE],
    );
    // Team chat: a web thread (pre-turn message, turn message), a Slack thread
    // (guest turn), a greeting-only thread, a deleted thread, a thread after asOf.
    const web = (await client.query(
      `INSERT INTO agent_chat_threads (id, tenant_id, account_id, channel, title, created_at)
       VALUES ('00000000-0000-0000-0000-00000000e0e1', $1, $2, 'web', 'Web thread', $3) RETURNING id`, [T, OWNER, BEFORE])).rows[0].id;
    const slack = (await client.query(
      `INSERT INTO agent_chat_threads (id, tenant_id, account_id, channel, title, created_at)
       VALUES ('00000000-0000-0000-0000-00000000e0e2', $1, NULL, 'slack', 'Slack thread', $2) RETURNING id`, [T, BEFORE])).rows[0].id;
    await client.query(
      `INSERT INTO agent_chat_threads (id, tenant_id, account_id, channel, title, created_at)
       VALUES ('00000000-0000-0000-0000-00000000e0e3', $1, $2, 'web', 'Greeting only', $3),
              ('00000000-0000-0000-0000-00000000e0e4', $1, $2, 'web', 'Deleted', $3),
              ('00000000-0000-0000-0000-00000000e0e5', $1, $2, 'web', 'After', $4)`,
      [T, OWNER, BEFORE, AFTER]);
    await client.query(`UPDATE agent_chat_threads SET deleted_at = $1 WHERE id = '00000000-0000-0000-0000-00000000e0e4'`, [BEFORE]);
    const turn = (await client.query(
      `INSERT INTO agent_chat_turns (id, tenant_id, thread_id, agent_id, sender_account_id, sender_label)
       VALUES (gen_random_uuid(), $1, $2, $3, NULL, 'Priya (Slack)') RETURNING id`, [T, slack, TEAM])).rows[0].id;
    await client.query(
      `INSERT INTO agent_chat_messages (tenant_id, thread_id, agent_id, role, content, message_type, turn_id, created_at)
       VALUES ($1, $2, NULL, 'user', 'pre-294 web message', NULL, NULL, $5),
              ($1, $2, $4, 'assistant', 'reply', NULL, NULL, $5),
              ($1, $3, NULL, 'user', 'from slack', NULL, $6, $5),
              ($1, $3, $4, 'assistant', 'reply', NULL, NULL, $5),
              ($1, '00000000-0000-0000-0000-00000000e0e3', $4, 'assistant', 'greeting', NULL, NULL, $5),
              ($1, '00000000-0000-0000-0000-00000000e0e4', NULL, 'user', 'in a deleted thread', NULL, NULL, $5),
              ($1, $2, NULL, 'user', 'after asOf', NULL, NULL, $7)`,
      [T, web, slack, TEAM, BEFORE, turn, AFTER]);
    // Liftoff and Insights: a live thread with a recorded and an unrecorded sender, a deleted thread.
    for (const [threads, messages] of [['liftoff_chat_threads', 'liftoff_chat_messages'], ['insights_chat_threads', 'insights_chat_messages']]) {
      const live = (await client.query(
        `INSERT INTO ${threads} (tenant_id, account_id, title, created_at) VALUES ($1, $2, 'Live', $3) RETURNING id`, [T, OWNER, BEFORE])).rows[0].id;
      const gone = (await client.query(
        `INSERT INTO ${threads} (tenant_id, account_id, title, created_at, deleted_at) VALUES ($1, $2, 'Gone', $3, $3) RETURNING id`, [T, OWNER, BEFORE])).rows[0].id;
      await client.query(
        `INSERT INTO ${messages} (thread_id, role, content, sender_account_id, created_at)
         VALUES ($1, 'user', 'recorded', $3, $4), ($1, 'user', 'before the column', NULL, $4), ($1, 'assistant', 'reply', NULL, $4),
                ($2, 'user', 'in a deleted thread', $3, $4), ($1, 'user', 'after asOf', $3, $5)`,
        [live, gone, MEMBER, BEFORE, AFTER]);
    }
  });

  afterAll(async () => {
    await cleanUp();
    client.release();
    await (testPool as Pool).end();
  });

  it('assignments: created by asOf and not removed by asOf, the removed-after one included', async () => {
    const rows = await q.readAssignments(T, AS_OF, budget());
    // The two share a created_at and tie-break on their random ids.
    expect(rows.map((r) => [r.account_id, r.agent_name]).sort()).toEqual([
      [OWNER, 'Export Reviewer'],
      [MEMBER, 'Old Team'],
    ]);
  });

  it('late feedback: a row created after asOf is absent', async () => {
    const rows = await q.readLateFeedback(T, AS_OF, budget());
    expect(rows.map((r) => r.approval_id)).toEqual(['approval-before']);
  });

  it('members and pending invitations: bounded by asOf, invitations pending only', async () => {
    expect((await q.readMembers(T, AS_OF, budget())).map((m) => m.email).sort()).toEqual(['wx-member@example.test', 'wx-owner@example.test']);
    expect((await q.readPendingInvitations(T, AS_OF, budget())).map((i) => i.email)).toEqual(['pending-before@example.test']);
  });

  it('knowledge: two rows sharing a boundary timestamp survive a page break, and the cutoff holds', async () => {
    const one = budget();
    jest.spyOn(one, 'pageLimit').mockReturnValue(1);
    const rows = await q.readKnowledge(T, AS_OF, one);
    expect(rows.map((r) => r.title)).toEqual(['K1', 'K2', 'K3']);
  });

  it('custom MCP servers: the four columns, never the secret or the tools', async () => {
    const [row] = await q.readCustomMcpServers(T, AS_OF, budget());
    expect(row).toMatchObject({ connector_id: CONNECTOR, name: 'Internal Docs', endpoint_url: 'https://mcp.example.test/sse' });
    expect(Object.keys(row).sort()).toEqual(['connector_id', 'created_at', 'endpoint_url', 'id', 'name', 'sort_cursor']);
    expect(JSON.stringify(row)).not.toContain('secret-name-never-exported');
  });

  it('files: the team\'s produced file, never a person\'s upload, nothing after asOf', async () => {
    const rows = await q.readGeneratedFiles(T, AS_OF, budget());
    expect(rows.map((r) => r.filename).sort()).toEqual(['report_v1.xlsx', 'shown_v1.pdf']);
    expect(rows.find((r) => r.filename === 'report_v1.xlsx')?.agent_name).toBe('Export Reviewer');
  });

  it('files: staged bytes nobody presented are not the workspace\'s output', async () => {
    // Written and never shown, so it is due to be discarded: an archive
    // carrying it would hand back a file nobody has seen and that will not
    // exist next week. Its sibling, presented (discard_after cleared), rides.
    const rows = await q.readGeneratedFiles(T, AS_OF, budget());
    const names = rows.map((r) => r.filename);
    expect(names).not.toContain('staged_v1.pdf');
    expect(names).toContain('shown_v1.pdf');
  });

  it('team chat: conversational live threads by asOf, senders resolved as listMessages resolves them', async () => {
    const threads = await q.readTeamChatThreads(T, AS_OF, budget());
    expect(threads.map((t) => t.title).sort()).toEqual(['Slack thread', 'Web thread']);
    const messages = await q.readTeamChatMessages(T, AS_OF, budget());
    const byContent = Object.fromEntries(messages.map((m) => [m.content, m]));
    // The web thread's pre-turn message falls back to the thread's creator.
    expect(byContent['pre-294 web message'].sender_account_id).toBe(OWNER);
    // A Slack guest has no account: no fallback to the creator, the label rides.
    expect(byContent['from slack'].sender_account_id).toBeNull();
    expect(byContent['from slack'].sender_label).toBe('Priya (Slack)');
    // Assistant rows never pick up a sender.
    expect(messages.filter((m) => m.role === 'assistant').every((m) => m.sender_account_id === null)).toBe(true);
    expect(byContent['in a deleted thread']).toBeUndefined();
    expect(byContent['after asOf']).toBeUndefined();
  });

  it('the assistant surfaces: the sender column, no deleted thread, nothing after asOf', async () => {
    for (const [readThreads, readMessages] of [[q.readLiftoffThreads, q.readLiftoffMessages], [q.readInsightsThreads, q.readInsightsMessages]] as const) {
      expect((await readThreads(T, AS_OF, budget())).map((t) => t.title)).toEqual(['Live']);
      const messages = await readMessages(T, AS_OF, budget());
      // The three share a created_at and tie-break on their random ids.
      expect(messages.map((m) => [m.content, m.sender_account_id]).sort()).toEqual([
        ['before the column', null], ['recorded', MEMBER], ['reply', null],
      ]);
    }
  });

  it('teams and names: live teams only, but every team name for the resolver', async () => {
    expect((await q.readTeams(T, AS_OF, budget())).map((t) => t.role)).toEqual(['Export Reviewer']);
    const names = await q.readTeamNames(T);
    expect(names.get(TEAM)).toBe('Export Reviewer');
    expect(names.get(ARCHIVED_TEAM)).toBe('Old Team');
    expect(await q.readWorkspaceName(T)).toBe('Workspace Export Tenant');
    expect((await q.readAccountNames([OWNER, 'not-an-id'])).get(OWNER)).toEqual({ display: 'Alex Export', email: 'wx-owner@example.test' });
  });

  it('external agents: live ones by asOf with what the page shows and nothing of the connection; every name for the resolver', async () => {
    const rows = await q.readExternalCollaborators(T, AS_OF, budget());
    expect(rows.map((r) => r.name)).toEqual(['Legal Bot']);
    const [legal] = rows;
    expect(legal.status).toBe('connected');
    expect(legal.collaboration_mode).toBe('request_help');
    expect(legal.allowed_internal_agent_ids).toEqual([TEAM]);
    expect(legal.detected_capabilities).toEqual([{ id: 'cap-1', name: 'Review contract', description: 'Flags risk.', rawToolName: 'mcp__legal__review' }]);
    expect(legal.request_rules).toEqual([{ internalAgentId: TEAM, internalAgentName: 'Export Reviewer', permissions: { read_summaries: 'allowed' } }]);
    // The row carries no connection field at all.
    for (const secret of ['endpoint_url', 'auth_type', 'credential_secret_name', 'api_key_hint', 'bearer_token_hint', 'custom_header_keys', 'tool_classifications', 'raw_mcp_tools']) {
      expect({ secret, present: secret in legal }).toEqual({ secret, present: false });
    }
    const names = await q.readExternalCollaboratorNames(T);
    expect(names.get(COLLABORATOR)).toBe('Legal Bot');
    expect(names.get(REMOVED_COLLABORATOR)).toBe('Retired Bot');
    expect(names.get(LATE_COLLABORATOR)).toBe('Late Bot');
  });
});
