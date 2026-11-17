// The dedicated export reads: one ordered pass per table, composite keyset,
// asOf in SQL, and exactly the columns the archive needs.

const mockQuery = jest.fn();
const mockPoolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: async (_tenantId: string, fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
    fn({ query: mockQuery }),
  getPool: () => ({ query: mockPoolQuery }),
}));

import { ExportBudget, ExportTooLargeError } from '../budget';
import * as q from '../queries';

const TENANT = '11111111-1111-4111-8111-111111111111';
const AS_OF = new Date('2026-09-18T21:04:11.318Z');
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [] });
  mockPoolQuery.mockReset();
  mockPoolQuery.mockResolvedValue({ rows: [] });
});

const sqlOf = (n = 0) => mockQuery.mock.calls[n][0] as string;
const paramsOf = (n = 0) => mockQuery.mock.calls[n][1] as unknown[];

describe('every local read', () => {
  const reads: Array<[string, (t: string, a: Date, b: ExportBudget) => Promise<unknown[]>, string]> = [
    ['team chat threads', q.readTeamChatThreads, 'agent_chat_threads'],
    ['team chat messages', q.readTeamChatMessages, 'agent_chat_messages'],
    ['liftoff threads', q.readLiftoffThreads, 'liftoff_chat_threads'],
    ['liftoff messages', q.readLiftoffMessages, 'liftoff_chat_messages'],
    ['insights threads', q.readInsightsThreads, 'insights_chat_threads'],
    ['insights messages', q.readInsightsMessages, 'insights_chat_messages'],
    ['teams', q.readTeams, 'internal_agents'],
    ['knowledge', q.readKnowledge, 'knowledge_items'],
    ['custom MCP servers', q.readCustomMcpServers, 'custom_mcp_servers'],
    ['late feedback', q.readLateFeedback, 'hitl_late_feedback'],
    ['members', q.readMembers, 'tenant_members'],
    ['pending invitations', q.readPendingInvitations, 'tenant_invitations'],
    ['assignments', q.readAssignments, 'person_agent_assignments'],
    ['generated files', q.readGeneratedFiles, 'generated_files'],
  ];

  it.each(reads)('%s: tenant, asOf, composite keyset, ascending order, budgeted limit', async (_name, read, table) => {
    const budget = new ExportBudget(5, 1_000_000);
    await read(TENANT, AS_OF, budget);
    const sql = sqlOf();
    const params = paramsOf();
    expect(sql).toContain(`FROM ${table}`);
    expect(sql).toMatch(/tenant_id = \$1/);
    expect(sql).toContain('<= $2::timestamptz');
    expect(sql).toMatch(/\$3::timestamptz IS NULL OR \(.+\) > \(\$3::timestamptz, \$4::uuid\)/);
    expect(sql).toMatch(/ORDER BY .+ ASC, .+ ASC/);
    expect(sql).toContain('LIMIT $5');
    expect(params).toEqual([TENANT, AS_OF, null, null, 6]);
  });

  it('pages two rows with tied created_at without losing the second, and stops at the ceiling', async () => {
    const tied = '2026-09-01 10:00:00.123456+00';
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: A, sort_cursor: tied }, { id: B, sort_cursor: tied }] })
      .mockResolvedValueOnce({ rows: [] });
    const budget = new ExportBudget(1, 1_000_000);
    await expect(q.readKnowledge(TENANT, AS_OF, budget)).rejects.toBeInstanceOf(ExportTooLargeError);
    // limit was recordsLeft + 1 = 2: the second row is fetched, charged, refused.
    expect(paramsOf(0)[4]).toBe(2);

    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: A, sort_cursor: tied }, { id: B, sort_cursor: tied }] })
      .mockResolvedValueOnce({ rows: [] });
    const roomy = new ExportBudget(1, 1_000_000);
    roomy.recordsLeft = 1;
    // Page size 1 forces a second page keyed on the first row's text timestamp.
    const single = new ExportBudget(10, 1_000_000);
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: A, sort_cursor: tied }] })
      .mockResolvedValueOnce({ rows: [{ id: B, sort_cursor: tied }] })
      .mockResolvedValueOnce({ rows: [] });
    jest.spyOn(single, 'pageLimit').mockReturnValue(1);
    const rows = await q.readKnowledge(TENANT, AS_OF, single);
    expect(rows.map((r) => r.id)).toEqual([A, B]);
    expect(paramsOf(1)[2]).toBe(tied);
    expect(paramsOf(1)[3]).toBe(A);
    expect(paramsOf(2)[3]).toBe(B);
  });
});

describe('team chat', () => {
  it('threads: live, conversational (the shared predicate), and read with the columns the entry needs', async () => {
    await q.readTeamChatThreads(TENANT, AS_OF, new ExportBudget());
    const sql = sqlOf();
    expect(sql).toContain('t.deleted_at IS NULL');
    expect(sql).toContain("m.role <> 'assistant' OR m.turn_id IS NOT NULL OR m.message_type IS NOT NULL");
    expect(sql).toContain('t.account_id, t.channel, t.title');
  });

  it("messages: the sender COALESCE copied from listMessages, gated on role='user' and the web channel", async () => {
    await q.readTeamChatMessages(TENANT, AS_OF, new ExportBudget());
    const sql = sqlOf();
    expect(sql).toContain("CASE WHEN m.role = 'user' THEN COALESCE(");
    expect(sql).toContain('t.sender_account_id');
    expect(sql).toContain("CASE WHEN th.channel = 'web' THEN th.account_id END");
    expect(sql).toContain("CASE WHEN m.role = 'user' THEN t.sender_label END AS sender_label");
    expect(sql).toContain('LEFT JOIN agent_chat_turns t');
    expect(sql).toContain('th.deleted_at IS NULL');
    expect(sql).not.toContain('tool_calls');
    expect(sql).not.toContain('citations');
  });

  it('messages: reads who else had a hand in each row', async () => {
    await q.readTeamChatMessages(TENANT, AS_OF, new ExportBudget());
    expect(sqlOf()).toContain('m.contributors');
  });
});

describe('the assistant surfaces', () => {
  it('join messages through their thread for tenancy and read the sender column', async () => {
    await q.readLiftoffMessages(TENANT, AS_OF, new ExportBudget());
    expect(sqlOf()).toContain('JOIN liftoff_chat_threads t ON t.id = m.thread_id');
    expect(sqlOf()).toContain('m.sender_account_id');
    expect(sqlOf()).toContain('m.author, m.author_label');
    await q.readInsightsMessages(TENANT, AS_OF, new ExportBudget());
    expect(sqlOf(1)).toContain('JOIN insights_chat_threads t ON t.id = m.thread_id');
    expect(sqlOf(1)).toContain('m.sender_account_id');
    expect(sqlOf(1)).not.toContain('m.author,');
  });

  it('read who else had a hand in a reply through each table\'s own record', async () => {
    // Liftoff stores it as the author pair, so its contributors column is the
    // empty list; the Insights Manager stores the list every other surface does.
    await q.readLiftoffMessages(TENANT, AS_OF, new ExportBudget());
    expect(sqlOf()).toContain("'[]'::jsonb AS contributors");
    expect(sqlOf()).not.toContain('m.contributors');
    await q.readInsightsMessages(TENANT, AS_OF, new ExportBudget());
    expect(sqlOf(1)).toContain('m.contributors');
  });
});

describe('teams and names', () => {
  it('reads live teams with no LIMIT 500', async () => {
    await q.readTeams(TENANT, AS_OF, new ExportBudget());
    expect(sqlOf()).toContain('a.deleted_at IS NULL');
    expect(sqlOf()).not.toContain('500');
    expect(sqlOf()).not.toContain('system_prompt');
    expect(sqlOf()).not.toContain('skills');
  });

  it('resolves team names with NO deleted_at predicate, so an archived team keeps its name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: A, role: 'Archived Reviewer' }] });
    const names = await q.readTeamNames(TENANT);
    expect(sqlOf()).not.toContain('deleted_at');
    expect(names.get(A)).toBe('Archived Reviewer');
  });
});

describe('external agents', () => {
  it('reads live collaborators by asOf with exactly what the Update Team page shows, and nothing of the connection', async () => {
    await q.readExternalCollaborators(TENANT, AS_OF, new ExportBudget());
    const sql = sqlOf();
    expect(sql).toContain('FROM external_agents ea');
    expect(sql).toContain('ea.deleted_at IS NULL');
    expect(sql).toContain('ea.name, ea.description, ea.summary, ea.status, ea.collaboration_mode');
    expect(sql).toContain('ea.detected_capabilities, ea.allowed_internal_agent_ids, ea.request_rules, ea.created_at');
    for (const secret of ['endpoint_url', 'auth_type', 'credential', 'api_key_hint', 'bearer_token_hint', 'custom_header_keys',
      'transport_type', 'tool_classifications', 'raw_mcp_tools', 'raw_mcp_resources', 'detected_resources', 'SELECT *']) {
      expect({ secret, present: sql.includes(secret) }).toEqual({ secret, present: false });
    }
    expect(paramsOf()).toEqual([TENANT, AS_OF, null, null, 1000]);
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('resolves collaborator names with NO deleted_at predicate, so a team bound to a removed one keeps its name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: A, name: 'Legal Bot' }] });
    const names = await q.readExternalCollaboratorNames(TENANT);
    expect(sqlOf()).toContain('FROM external_agents');
    expect(sqlOf()).not.toContain('deleted_at');
    expect(names.get(A)).toBe('Legal Bot');
  });
});

describe('custom MCP servers', () => {
  it('selects exactly connector_id, name, endpoint_url, created_at and never the secret or the tools', async () => {
    await q.readCustomMcpServers(TENANT, AS_OF, new ExportBudget());
    const sql = sqlOf();
    expect(sql).toContain('s.connector_id, s.connector_id AS id, s.name, s.endpoint_url, s.created_at');
    expect(sql).not.toContain('auth_secret_name');
    expect(sql).not.toContain('raw_mcp_tools');
    expect(sql).not.toContain('SELECT *');
    // Inside withTenantScope: the query went to the scoped client, not the pool.
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe('members, invitations, assignments', () => {
  it('invitations: pending only', async () => {
    await q.readPendingInvitations(TENANT, AS_OF, new ExportBudget());
    expect(sqlOf()).toContain("ti.status = 'pending'");
    expect(sqlOf()).not.toContain('invite_token_hash');
  });

  it('assignments: created by asOf and not deleted by asOf, teams joined regardless of deleted_at', async () => {
    await q.readAssignments(TENANT, AS_OF, new ExportBudget());
    const sql = sqlOf();
    expect(sql).toContain('(pa.deleted_at IS NULL OR pa.deleted_at > $2::timestamptz)');
    expect(sql).toContain("LEFT JOIN internal_agents ia ON ia.id = pa.agent_id AND pa.agent_origin = 'internal'");
    expect(sql).toContain("LEFT JOIN external_agents ea ON ea.id = pa.agent_id AND pa.agent_origin = 'external'");
    expect(sql).toContain('COALESCE(ia.role, ea.name) AS agent_name');
    expect(sql).not.toMatch(/ia\.deleted_at/);
  });
});

describe('generated files', () => {
  it('reads every output type the teams produced, never a person\'s upload', async () => {
    await q.readGeneratedFiles(TENANT, AS_OF, new ExportBudget());
    const sql = sqlOf();
    expect(sql).toContain('gf.agent_id IS NOT NULL');
    expect(sql).not.toMatch(/output_type\s*(=|IN)/);
    expect(sql).toContain('gf.filename, gf.output_type, gf.gcs_path, gf.web_view_url, gf.size_bytes');
  });
});

describe('names', () => {
  it('resolves every account in one lookup, name then email, skipping anything that is not an id', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { id: A, first_name: 'Alex', last_name: 'Rivera', email: 'person@example.com' },
      { id: B, first_name: null, last_name: null, email: 'deleted@example.com' },
    ] });
    const names = await q.readAccountNames([A, B, A, 'system', '']);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery.mock.calls[0][0]).toContain('SELECT id, first_name, last_name, email FROM accounts WHERE id = ANY($1::uuid[])');
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([[A, B]]);
    expect(names.get(A)).toEqual({ display: 'Alex Rivera', email: 'person@example.com' });
    expect(names.get(B)).toEqual({ display: 'deleted@example.com', email: 'deleted@example.com' });
  });

  it('asks nothing for no ids', async () => {
    expect(await q.readAccountNames([])).toEqual(new Map());
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});
