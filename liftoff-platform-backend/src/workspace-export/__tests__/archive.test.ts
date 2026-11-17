// A fixture archive, end to end: the exact top-level shape of every file, the
// manifest counts, the sorting, the optional keys, the files, and the
// no-identifiers rule enforced by SENTINEL rather than by pattern. Every
// fixture row carries a distinctive known id in every id column and the test
// asserts each is absent from the serialized bytes. A blanket "no UUID-shaped
// text" scan would be wrong: a person's message may legitimately contain one,
// and user-authored text is never altered to satisfy a test.

import JSZip from 'jszip';

const mockQuery = jest.fn();
const mockPoolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: async (_tenantId: string, fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
    fn({ query: mockQuery }),
  getPool: () => ({ query: mockPoolQuery }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
const listApprovals = jest.fn();
const listClarifications = jest.fn();
const listAgentMemories = jest.fn();
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    listReviewHistoryApprovals: (...a: unknown[]) => listApprovals(...a),
    listReviewHistoryClarifications: (...a: unknown[]) => listClarifications(...a),
    listAgentMemories: (...a: unknown[]) => listAgentMemories(...a),
  },
}));
const exportThreads = jest.fn();
const exportMessages = jest.fn();
jest.mock('../../workforce-plans/team-plan-thread-client', () => ({
  exportTeamPlanThreads: (...a: unknown[]) => exportThreads(...a),
  exportTeamPlanMessages: (...a: unknown[]) => exportMessages(...a),
}));
const getCatalog = jest.fn();
const listConnectors = jest.fn();
jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: (...a: unknown[]) => getCatalog(...a),
  listConnectorsForTenant: (...a: unknown[]) => listConnectors(...a),
}));
jest.mock('../../internal-agents/integration-enrichment', () => ({
  enrichIntegrationsWithType: jest.fn(async (_t: string, i: unknown[]) => i),
}));
const download = jest.fn();
jest.mock('../../generated-files/gcs-client', () => ({
  // The real client resolves `[Buffer]`.
  generatedFilesBucket: () => ({ file: (p: string) => ({ download: async () => [await download(p)] }) }),
}));

import { buildWorkspaceExport } from '../service';

// ── Sentinels: one distinctive id per id column ─────────────────────────
const S = {
  tenant: 'aaaaaaaa-0001-4000-8000-00000000c0de',
  owner: 'aaaaaaaa-0002-4000-8000-00000000c0de',
  member: 'aaaaaaaa-0003-4000-8000-00000000c0de',
  teamChatThread: 'aaaaaaaa-0004-4000-8000-00000000c0de',
  teamChatMsg1: 'aaaaaaaa-0005-4000-8000-00000000c0de',
  teamChatMsg2: 'aaaaaaaa-0006-4000-8000-00000000c0de',
  teamChatFileMsg: 'aaaaaaaa-0007-4000-8000-00000000c0de',
  liftoffThread: 'aaaaaaaa-0008-4000-8000-00000000c0de',
  liftoffMsg: 'aaaaaaaa-0009-4000-8000-00000000c0de',
  insightsThread: 'aaaaaaaa-0010-4000-8000-00000000c0de',
  insightsMsg: 'aaaaaaaa-0011-4000-8000-00000000c0de',
  caioThread: 'aaaaaaaa-0012-4000-8000-00000000c0de',
  caioMsg: 'aaaaaaaa-0013-4000-8000-00000000c0de',
  team1: 'aaaaaaaa-0014-4000-8000-00000000c0de',
  team2: 'aaaaaaaa-0015-4000-8000-00000000c0de',
  teamArchived: 'aaaaaaaa-0016-4000-8000-00000000c0de',
  knowledge: 'aaaaaaaa-0017-4000-8000-00000000c0de',
  connectorGithub: 'aaaaaaaa-0018-4000-8000-00000000c0de',
  connectorMcp: 'aaaaaaaa-0019-4000-8000-00000000c0de',
  approval: 'aaaaaaaa-0020-4000-8000-00000000c0de',
  clarification: 'aaaaaaaa-0021-4000-8000-00000000c0de',
  toolCall: 'aaaaaaaa-0023-4000-8000-00000000c0de',
  lateFeedback: 'aaaaaaaa-0024-4000-8000-00000000c0de',
  membership: 'aaaaaaaa-0025-4000-8000-00000000c0de',
  invitation: 'aaaaaaaa-0026-4000-8000-00000000c0de',
  assignment: 'aaaaaaaa-0027-4000-8000-00000000c0de',
  file1: 'aaaaaaaa-0028-4000-8000-00000000c0de',
  file2: 'aaaaaaaa-0029-4000-8000-00000000c0de',
  fileGdoc: 'aaaaaaaa-0030-4000-8000-00000000c0de',
  fileGone: 'aaaaaaaa-0031-4000-8000-00000000c0de',
  turn: 'aaaaaaaa-0032-4000-8000-00000000c0de',
  docCard: 'aaaaaaaa-0033-4000-8000-00000000c0de',
  collaborator: 'aaaaaaaa-0034-4000-8000-00000000c0de',
  collaboratorGone: 'aaaaaaaa-0035-4000-8000-00000000c0de',
  capability: 'aaaaaaaa-0036-4000-8000-00000000c0de',
  memory1: 'aaaaaaaa-0037-4000-8000-00000000c0de',
  memory2: 'aaaaaaaa-0038-4000-8000-00000000c0de',
  memoryLate: 'aaaaaaaa-0039-4000-8000-00000000c0de',
  slackRef: '1726660000.000100',
};
const UUID_IN_TEXT = '99999999-9999-4999-8999-999999999999';
const AS_OF = new Date('2026-09-18T21:04:11.318Z');
const d = (s: string) => new Date(s);

const empty = { rows: [] };
const rowsFor = (sql: string, fixtures: Record<string, unknown[]>) => {
  for (const [table, rows] of Object.entries(fixtures)) {
    if (sql.includes(`FROM ${table}`)) return { rows };
  }
  return empty;
};

function seedFixtures(fixtures: Record<string, unknown[]>, pool: Record<string, unknown[]>) {
  mockQuery.mockImplementation(async (sql: string) => rowsFor(sql, fixtures));
  mockPoolQuery.mockImplementation(async (sql: string) => rowsFor(sql, pool));
}

const FULL = {
  agent_chat_threads: [{
    id: S.teamChatThread, sort_cursor: 'x', account_id: S.owner, channel: 'slack', title: 'Review of PR 482',
    created_at: d('2026-09-12T14:02:00Z'), updated_at: d('2026-09-12T14:05:00Z'),
  }],
  agent_chat_messages: [
    { id: S.teamChatMsg1, sort_cursor: 'x', thread_id: S.teamChatThread, agent_id: null, role: 'user',
      content: `Can you review PR 482 before I merge it? Ticket ${UUID_IN_TEXT}.`, message_type: null,
      attachments: [{ kind: 'upload', name: 'diff.txt' }], media: null, created_at: d('2026-09-12T14:02:00Z'),
      sender_account_id: S.owner, sender_label: null },
    { id: S.teamChatFileMsg, sort_cursor: 'x', thread_id: S.teamChatThread, agent_id: S.team1, role: 'assistant',
      content: '', message_type: 'file_output',
      attachments: [{ generatedFileId: S.file1, filename: 'pr-482-review.md', outputType: 'docx', downloadUrl: 'https://storage.example/signed?sig=SECRETSIG' }],
      media: null, created_at: d('2026-09-12T14:02:30Z'), sender_account_id: null, sender_label: null,
      turn_id: null, produced_in_turn_id: S.turn },
    { id: S.teamChatMsg2, sort_cursor: 'x', thread_id: S.teamChatThread, agent_id: S.team1, role: 'assistant',
      content: 'Two findings.', message_type: null, attachments: null, media: null,
      created_at: d('2026-09-12T14:03:00Z'), sender_account_id: null, sender_label: null,
      turn_id: S.turn, produced_in_turn_id: null,
      tool_calls: [{ id: S.toolCall, name: 'mcp__github__get_pr' }] },
    { id: 'aaaaaaaa-0040-4000-8000-00000000c0de', sort_cursor: 'x', thread_id: S.teamChatThread, agent_id: null, role: 'tool',
      content: `{"tool_call_id":"${S.toolCall}"}`, message_type: null, attachments: null, media: null,
      created_at: d('2026-09-12T14:02:45Z'), sender_account_id: null, sender_label: null },
    { id: 'aaaaaaaa-0041-4000-8000-00000000c0de', sort_cursor: 'x', thread_id: S.teamChatThread, agent_id: S.teamArchived, role: 'assistant',
      content: 'From the archived team.', message_type: null, attachments: null, media: null,
      created_at: d('2026-09-12T14:04:00Z'), sender_account_id: null, sender_label: null },
    { id: 'aaaaaaaa-0042-4000-8000-00000000c0de', sort_cursor: 'x', thread_id: S.teamChatThread, agent_id: null, role: 'user',
      content: 'Thanks (from Slack)', message_type: null, attachments: null, media: null,
      created_at: d('2026-09-12T14:05:00Z'), sender_account_id: null, sender_label: 'Priya (Slack)' },
    { id: 'aaaaaaaa-0043-4000-8000-00000000c0de', sort_cursor: 'x', thread_id: S.teamChatThread, agent_id: S.team1, role: 'assistant',
      content: 'Waiting on approval', message_type: 'hitl_status', attachments: null, media: null,
      created_at: d('2026-09-12T14:05:30Z'), sender_account_id: null, sender_label: null },
    { id: 'aaaaaaaa-0044-4000-8000-00000000c0de', sort_cursor: 'x', thread_id: S.teamChatThread, agent_id: S.team1, role: 'assistant',
      content: '', message_type: 'media', attachments: null,
      media: [{ mediaId: S.file2, mimeType: 'image/png', filename: 'chart.png' }],
      created_at: d('2026-09-12T14:06:00Z'), sender_account_id: null, sender_label: null },
    { id: 'aaaaaaaa-0045-4000-8000-00000000c0de', sort_cursor: 'x', thread_id: S.teamChatThread, agent_id: S.team1, role: 'assistant',
      content: '', message_type: 'file_output',
      attachments: [{ generatedFileId: S.fileGone, filename: 'gone.xlsx', outputType: 'xlsx' }],
      media: null, created_at: d('2026-09-12T14:07:00Z'), sender_account_id: null, sender_label: null },
    // A Google Doc the team wrote through a connector: no generated_files row,
    // the card carries the link.
    { id: 'aaaaaaaa-0049-4000-8000-00000000c0de', sort_cursor: 'x', thread_id: S.teamChatThread, agent_id: S.team1, role: 'assistant',
      content: '', message_type: 'file_output',
      attachments: [{ generatedFileId: S.docCard, filename: 'Updated document', outputType: 'document', webViewUrl: 'https://docs.google.com/document/d/EXAMPLE_DOC_ID/edit' }],
      media: null, created_at: d('2026-09-12T14:08:00Z'), sender_account_id: null, sender_label: null },
  ],
  liftoff_chat_threads: [{
    id: S.liftoffThread, sort_cursor: 'x', account_id: S.member, title: null,
    created_at: d('2026-09-10T09:00:00Z'), updated_at: d('2026-09-10T09:01:00Z'),
  }],
  liftoff_chat_messages: [
    { id: S.liftoffMsg, sort_cursor: 'x', thread_id: S.liftoffThread, role: 'user', content: 'What can you do?',
      message_type: null, attachments: null, media: null, author: null, author_label: null,
      sender_account_id: null, created_at: d('2026-09-10T09:00:00Z') },
    { id: 'aaaaaaaa-0046-4000-8000-00000000c0de', sort_cursor: 'x', thread_id: S.liftoffThread, role: 'assistant',
      content: 'Plenty.', message_type: null, attachments: null, media: null, author: null, author_label: null,
      sender_account_id: null, created_at: d('2026-09-10T09:01:00Z') },
    { id: 'aaaaaaaa-0047-4000-8000-00000000c0de', sort_cursor: 'x', thread_id: S.liftoffThread, role: 'assistant',
      content: 'Here is the plan.', message_type: null, attachments: null, media: null, author: S.team2, author_label: 'Chief AI Officer',
      sender_account_id: null, created_at: d('2026-09-10T09:02:00Z') },
    { id: 'aaaaaaaa-0048-4000-8000-00000000c0de', sort_cursor: 'x', thread_id: S.liftoffThread, role: 'assistant',
      content: 'context', message_type: 'forwarded_context', attachments: null, media: null, author: null, author_label: null,
      sender_account_id: null, created_at: d('2026-09-10T09:00:30Z') },
  ],
  insights_chat_threads: [{
    id: S.insightsThread, sort_cursor: 'x', account_id: S.owner, title: 'Costs',
    created_at: d('2026-09-11T09:00:00Z'), updated_at: d('2026-09-11T09:01:00Z'),
  }],
  insights_chat_messages: [
    { id: S.insightsMsg, sort_cursor: 'x', thread_id: S.insightsThread, role: 'user', content: 'How much last week?',
      message_type: null, attachments: null, media: null, author: null, author_label: null,
      sender_account_id: S.member, created_at: d('2026-09-11T09:00:00Z') },
  ],
  internal_agents: [
    { id: S.team1, sort_cursor: 'x', role: 'Code Reviewer', summary: 'Reviews pull requests.', responsibilities: 'Review PRs.',
      additional_context: null, integrations: [{ id: S.connectorGithub, type: 'github', selectedObjects: [] }, { id: S.team2, type: 'internal_agent', selectedObjects: [] }],
      status: 'paused', created_at: d('2026-08-01T00:00:00Z'), system_prompt: 'SYSTEM_PROMPT_TEXT', skills: [{ id: 'skill-1' }] },
    { id: S.team2, sort_cursor: 'x', role: 'Release Coordinator', summary: '', responsibilities: 'Ship releases.',
      additional_context: 'Never on Fridays.',
      integrations: [
        { id: S.connectorMcp, type: 'custom_mcp_server', selectedObjects: [] },
        { id: S.collaborator, type: 'external_agent', selectedObjects: [] },
        { id: S.collaboratorGone, type: 'external_agent', selectedObjects: [] },
      ],
      status: 'draft', created_at: d('2026-08-02T00:00:00Z') },
  ],
  external_agents: [{
    id: S.collaborator, sort_cursor: 'x', name: 'Legal Bot', description: 'Reviews contracts before signature.', summary: 'A contract reviewer.',
    status: 'connected', collaboration_mode: 'request_help',
    detected_capabilities: [{ id: S.capability, name: 'Review contract', description: 'Reads a contract and flags risk.', rawToolName: 'mcp__legal__review_contract' }],
    allowed_internal_agent_ids: [S.team1, S.teamArchived],
    request_rules: [{ internalAgentId: S.team1, internalAgentName: 'Code Reviewer (old name)', permissions: {
      read_summaries: 'allowed', run_analysis: 'approval_required', draft_outputs: 'blocked', propose_updates: 'allowed' } }],
    created_at: d('2026-08-20T00:00:00Z'),
  }],
  knowledge_items: [{
    id: S.knowledge, sort_cursor: 'x', title: 'Refund policy', source_url: 'https://docs.google.com/document/d/refund',
    connector_type: 'google_drive', connector_id: 'aaaaaaaa-0050-4000-8000-00000000c0de', created_at: d('2026-09-01T10:14:00Z'),
  }],
  custom_mcp_servers: [{
    id: S.connectorMcp, sort_cursor: 'x', connector_id: S.connectorMcp, name: 'Internal Docs',
    endpoint_url: 'https://mcp.example.com/sse', created_at: d('2026-08-15T00:00:00Z'),
  }],
  hitl_late_feedback: [{
    id: S.lateFeedback, sort_cursor: 'x', approval_id: S.approval, decision: 'would_reject', decided_by: S.owner,
    rejection_reason: 'Wait until the deploy is verified.', created_at: d('2026-09-06T10:00:00Z'),
  }],
  tenant_members: [
    { id: S.membership, sort_cursor: 'x', account_id: S.owner, role: 'owner', joined_at: d('2026-03-02T18:20:00Z'),
      created_at: d('2026-03-02T18:20:00Z'), first_name: 'Alex', last_name: 'Rivera', email: 'person@example.com' },
    { id: 'aaaaaaaa-0051-4000-8000-00000000c0de', sort_cursor: 'x', account_id: S.member, role: 'member', joined_at: d('2026-04-02T18:20:00Z'),
      created_at: d('2026-04-02T18:20:00Z'), first_name: 'Priya', last_name: 'Natarajan', email: 'priya@example.com' },
  ],
  tenant_invitations: [{
    id: S.invitation, sort_cursor: 'x', email: 'colleague@example.com', role: 'member', created_at: d('2026-09-10T09:00:00Z'),
  }],
  person_agent_assignments: [{
    id: S.assignment, sort_cursor: 'x', account_id: S.owner, agent_id: S.team1, agent_name: 'Code Reviewer', created_at: d('2026-05-01T00:00:00Z'),
  }],
  generated_files: [
    { id: S.file1, sort_cursor: 'x', conversation_id: S.teamChatThread, agent_id: S.team1, agent_name: 'Code Reviewer',
      filename: 'pr-482-review.md', output_type: 'docx', gcs_path: 'tenants/t/agents/a/1/pr-482-review.md', web_view_url: null,
      size_bytes: '12', created_at: d('2026-09-12T14:02:30Z') },
    { id: S.file2, sort_cursor: 'x', conversation_id: S.teamChatThread, agent_id: S.team1, agent_name: 'Code Reviewer',
      filename: 'chart.png', output_type: 'media', gcs_path: 'tenants/t/agents/a/2/chart.png', web_view_url: null,
      size_bytes: 3, created_at: d('2026-09-12T14:06:00Z') },
    { id: S.fileGdoc, sort_cursor: 'x', conversation_id: null, agent_id: S.team2, agent_name: 'Release Coordinator',
      filename: 'Q3 plan', output_type: 'gdoc', gcs_path: null, web_view_url: 'https://docs.google.com/document/d/q3',
      size_bytes: null, created_at: d('2026-09-13T00:00:00Z') },
    { id: S.fileGone, sort_cursor: 'x', conversation_id: S.teamChatThread, agent_id: S.team1, agent_name: 'Code Reviewer',
      filename: 'gone.xlsx', output_type: 'xlsx', gcs_path: 'tenants/t/agents/a/3/gone.xlsx', web_view_url: null,
      size_bytes: 5, created_at: d('2026-09-12T14:07:00Z') },
  ],
};
// The name resolver reads internal_agents without the export columns; the
// pager and the resolver share the FROM, so hand the resolver the same rows
// plus the archived team.
const TEAM_NAME_ROWS = [...FULL.internal_agents, { id: S.teamArchived, role: 'Old Team' }];
// Same for External Agents: the resolver sees the removed one too.
const COLLABORATOR_NAME_ROWS = [{ id: S.collaborator, name: 'Legal Bot' }, { id: S.collaboratorGone, name: 'Retired Bot' }];

const POOL = {
  tenants: [{ name: 'Northwind Traders, Inc.' }],
  accounts: [
    { id: S.owner, first_name: 'Alex', last_name: 'Rivera', email: 'person@example.com' },
    { id: S.member, first_name: 'Priya', last_name: 'Natarajan', email: 'priya@example.com' },
  ],
};

const CATALOG = {
  connectors: [
    { type: 'github', displayName: 'GitHub' },
    { type: 'slack', displayName: 'Slack' },
    { type: 'google_drive', displayName: 'Google Drive' },
    { type: 'custom_mcp_server', displayName: 'Custom MCP Server' },
  ],
  version: 'v', categoryLabels: {},
};

function seedRemote() {
  // Learned Context: team 1 has two memories by asOf and one after, paged as
  // the runtime pages (newest first); team 2 has none.
  listAgentMemories.mockImplementation(async (_tenantId: string, agentId: string, opts: { cursor?: string }) => {
    if (agentId !== S.team1) return { memories: [], nextCursor: null, total: 0 };
    if (!opts.cursor) {
      return {
        memories: [
          { id: S.memoryLate, content: 'Learned after the cutoff.', source: 'learned', createdAt: '2026-09-19T00:00:00.000Z' },
          { id: S.memory2, content: `**Rule:** Use mcp__github-eaec0c30__get_pr for PRs\n**Why:** Ticket ${UUID_IN_TEXT} asked for it`, source: 'learned', createdAt: '2026-09-12T15:00:00.000Z' },
        ],
        nextCursor: '2026-09-12T15:00:00.000Z', total: 3,
      };
    }
    return { memories: [{ id: S.memory1, content: 'Prefers   short replies.', source: 'learned', createdAt: '2026-09-11T15:00:00.000Z' }], nextCursor: null, total: 3 };
  });
  listApprovals.mockResolvedValue({ items: [{
    id: S.approval, agentName: 'Release Coordinator', status: 'rejected', decision: 'rejected', decidedBy: S.owner,
    decidedAt: '2026-09-05T09:20:00.000Z', rejectionReason: 'Wait until the deploy is verified.', expiresAt: '2026-09-06T09:12:00.000Z',
    updatedAt: '2026-09-05T09:20:00.000Z', createdAt: '2026-09-05T09:12:00.000Z', hitlLevel: 1, reason: 'external_content_write',
    pendingToolCalls: [{ id: S.toolCall, name: 'mcp__slack-eaec0c30__send_message', input: {
      channel: '#announcements', text: 'Release 2.14 is live.', tenant_id: S.tenant, connectorId: S.connectorGithub,
      invocation: S.clarification, api_key: 'sk-live-SECRET', deep: { a: { b: { c: { d: { e: { f: { g: { h: { token: 'DEEPSECRET' } } } } } } } } },
    } }],
    editedToolInputs: null, actionSummary: null, whySummary: 'It quotes an outside page.', detail: null,
  }], nextCursor: null });
  listClarifications.mockResolvedValue({ items: [{
    id: S.clarification, agentName: null, question: 'Which region should the report cover?', status: 'resume_inflight',
    firesAt: '2026-09-09T16:40:00.000Z', firedAt: null, cancelledAt: null, updatedAt: '2026-09-08T17:02:00.000Z',
    createdAt: '2026-09-08T16:40:00.000Z', resolutionKind: 'answered', resolvedBy: S.owner, resolvedByLabel: null,
    resolvedAt: '2026-09-08T17:02:00.000Z',
  }], nextCursor: null });
  exportThreads.mockResolvedValue({ items: [{
    id: S.caioThread, accountId: S.owner, title: 'Support pod', createdAt: '2026-09-09T08:00:00.000Z', updatedAt: '2026-09-09T08:01:00.000Z',
  }], nextCursor: null });
  exportMessages.mockResolvedValue({ items: [
    { id: S.caioMsg, threadId: S.caioThread, role: 'user', content: 'Plan me a support pod.', senderAccountId: S.owner,
      attachments: [], media: null, messageType: null, createdAt: '2026-09-09T08:00:00.000Z' },
    { id: 'aaaaaaaa-0052-4000-8000-00000000c0de', threadId: S.caioThread, role: 'assistant', content: 'Here is a pod.', senderAccountId: null,
      attachments: [], media: null, messageType: null, createdAt: '2026-09-09T08:01:00.000Z', toolTrail: [{ tool: 'x', input: {}, outcome: 'y' }] },
  ], nextCursor: null });
  getCatalog.mockResolvedValue(CATALOG);
  listConnectors.mockResolvedValue([
    { id: S.connectorGithub, type: 'github', name: 'GitHub', status: 'active', installState: null, createdAt: '2026-08-01T00:00:00.000Z' },
    { id: 'aaaaaaaa-0053-4000-8000-00000000c0de', type: 'slack', name: 'Slack', status: 'error', installState: null, createdAt: '2026-08-01T00:00:00.000Z' },
    { id: S.connectorMcp, type: 'custom_mcp_server', name: 'Internal Docs (77)', status: 'active', installState: null, createdAt: '2026-08-15T00:00:00.000Z' },
  ]);
  download.mockImplementation(async (p: string) => {
    if (p.endsWith('gone.xlsx')) throw Object.assign(new Error('No such object'), { code: 404 });
    return Buffer.from(`bytes of ${p}`);
  });
}

async function build() {
  const result = await buildWorkspaceExport({ tenantId: S.tenant, actor: { accountId: S.owner, role: 'owner' }, asOf: AS_OF });
  const zip = await JSZip.loadAsync(result.buffer);
  const text = async (name: string) => (await zip.file(name)!.async('string'));
  const json = async (name: string) => JSON.parse(await text(name));
  return { result, zip, text, json };
}

describe('a fixture archive', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedFixtures({ ...FULL, internal_agents: FULL.internal_agents }, POOL);
    // The name resolver's query has no cutoff parameter; serve it the archived team too.
    mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM internal_agents WHERE tenant_id = $1') && params.length === 1) return { rows: TEAM_NAME_ROWS };
      if (sql.includes('FROM external_agents WHERE tenant_id = $1') && params.length === 1) return { rows: COLLABORATOR_NAME_ROWS };
      return rowsFor(sql, FULL);
    });
    seedRemote();
  });

  it('has every file with its exact top-level shape, the manifest counts equal to the array lengths, and the archive name', async () => {
    const { result, zip, json, text } = await build();
    expect(result.filename).toBe('liftoff-northwind-traders-inc-export-2026-09-18.zip');
    expect(Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort()).toEqual([
      'README.txt', 'ai-teams.json', 'connections.json', 'conversations.json', 'external-collaborators.json',
      'files/2026-09-12-review-of-pr-482/chart.png', 'files/2026-09-12-review-of-pr-482/pr-482-review.md',
      'knowledge.json', 'members.json', 'review.json', 'workspace.json',
    ]);
    const manifest = await json('workspace.json');
    expect(manifest).toEqual({
      'Export format version': 1,
      Workspace: 'Northwind Traders, Inc.',
      Exported: expect.any(String),
      'As of': '2026-09-18T21:04:11.318Z',
      Note: expect.stringContaining('created at or before As of'),
      'Exported by': { Name: 'Alex Rivera', Email: 'person@example.com' },
      Counts: {
        Conversations: 4, Messages: 13, 'Agents': 2, Knowledge: 1, Connected: 3,
        Approvals: 1, Clarifications: 1, Members: 2, Files: 2, 'Pending invitations': 1,
        'External Agents': 1,
      },
    });
    const conversations = await json('conversations.json');
    expect(Object.keys(conversations)).toEqual(['Conversations']);
    expect(conversations.Conversations).toHaveLength(4);
    expect(conversations.Conversations.reduce((n: number, c: { Messages: unknown[] }) => n + c.Messages.length, 0)).toBe(13);
    expect(Object.keys(await json('ai-teams.json'))).toEqual(['Agents']);
    expect(Object.keys(await json('external-collaborators.json'))).toEqual(['External Agents']);
    expect(Object.keys(await json('knowledge.json'))).toEqual(['Knowledge']);
    expect(Object.keys(await json('connections.json'))).toEqual(['Connected']);
    expect(Object.keys(await json('review.json'))).toEqual(['Approvals', 'Clarifications']);
    expect(Object.keys(await json('members.json'))).toEqual(['Members', 'Pending invitations']);
    expect(result.counts).toEqual(manifest.Counts);
    const readme = await text('README.txt');
    expect(readme).toContain('"Northwind Traders, Inc."');
    expect(readme).toContain('Alex Rivera (person@example.com)');
    expect(readme).toContain('as of 2026-09-18T21:04:11.318Z');
    for (const f of ['workspace.json', 'conversations.json', 'ai-teams.json', 'external-collaborators.json', 'knowledge.json', 'connections.json', 'review.json', 'members.json', 'files/']) {
      expect(readme).toContain(`${f}:`);
    }
    // The three bullets the help-centre article promises, in the README's own words.
    expect(readme).toContain('Learned Context');
    expect(readme).toContain('External Agents and connections it works with');
    expect(readme).toContain('what it can ask each agent to do');
    // Product voice: no contractions and no em dashes.
    expect(readme).not.toMatch(/—/);
    expect(readme).not.toMatch(/\b\w+n't\b|\b\w+'(re|ll|ve|d|m)\b/);
  });

  it('sorts conversations by created time and writes each surface as its page names it', async () => {
    const { json } = await build();
    const { Conversations } = await json('conversations.json');
    expect(Conversations.map((c: { Surface: string; Title: string }) => [c.Surface, c.Title])).toEqual([
      ['Chief AI Officer', 'Support pod'],
      ['Liftoff', 'Untitled chat'],
      ['Insights Manager', 'Costs'],
      ['Agent', 'Review of PR 482'],
    ]);
    const teamChat = Conversations[3];
    expect(teamChat).toMatchObject({
      With: ['Code Reviewer', 'Old Team'], Channel: 'Slack', 'Started by': 'Alex Rivera',
      Started: '2026-09-12T14:02:00.000Z', 'Last message': '2026-09-12T14:08:00.000Z',
    });
    expect(teamChat.Messages).toEqual([
      { From: 'Alex Rivera', Sent: '2026-09-12T14:02:00.000Z', Message: `Can you review PR 482 before I merge it? Ticket ${UUID_IN_TEXT}.`, Attachments: ['diff.txt'] },
      // The card rides on the reply of the turn that produced it.
      { From: 'Code Reviewer', Sent: '2026-09-12T14:03:00.000Z', Message: 'Two findings.',
        Files: [{ Name: 'pr-482-review.md', Path: 'files/2026-09-12-review-of-pr-482/pr-482-review.md' }] },
      { From: 'Old Team', Sent: '2026-09-12T14:04:00.000Z', Message: 'From the archived team.' },
      { From: 'Priya (Slack)', Sent: '2026-09-12T14:05:00.000Z', Message: 'Thanks (from Slack)' },
      { From: 'Code Reviewer', Sent: '2026-09-12T14:06:00.000Z', Files: [{ Name: 'chart.png', Path: 'files/2026-09-12-review-of-pr-482/chart.png' }] },
      { From: 'Code Reviewer', Sent: '2026-09-12T14:07:00.000Z', Files: [{ Name: 'gone.xlsx' }] },
      { From: 'Code Reviewer', Sent: '2026-09-12T14:08:00.000Z', Files: [{ Name: 'Updated document', Link: 'https://docs.google.com/document/d/EXAMPLE_DOC_ID/edit' }] },
    ]);
    const liftoff = Conversations[1];
    expect(liftoff).toMatchObject({ With: ['Liftoff', 'Chief AI Officer'], 'Started by': 'Priya Natarajan' });
    expect(liftoff.Messages.map((m: { From: string }) => m.From)).toEqual(['Workspace member', 'Liftoff', 'Chief AI Officer']);
    expect(Conversations[2].Messages[0].From).toBe('Priya Natarajan');
    expect(Conversations[0].Messages.map((m: { From: string }) => m.From)).toEqual(['Alex Rivera', 'Chief AI Officer']);
  });

  it('writes the other sections as the pages label them', async () => {
    const { json } = await build();
    expect((await json('ai-teams.json'))['Agents']).toEqual([
      // Team 1 is bound to GitHub and to team 2: the builder's "who and what"
      // heading. Its Learned Context is the two memories learned by asOf, as
      // the page shows them, oldest first; the one learned after asOf is out.
      { Team: 'Code Reviewer', Status: 'Paused', Description: 'Reviews pull requests.', 'What do you want them to do?': 'Review PRs.',
        'Who and what should they work with?': ['GitHub', 'Release Coordinator'],
        'Learned Context': [
          { Context: 'Prefers short replies.', Learned: '2026-09-11T15:00:00.000Z' },
          { Context: `Rule: Use get_pr for PRs · Why: Ticket ${UUID_IN_TEXT} asked for it`, Learned: '2026-09-12T15:00:00.000Z' },
        ] },
      // Team 2 is bound to the custom server, a live collaborator and a removed
      // one; the removed one keeps its name.
      { Team: 'Release Coordinator', Status: 'Awaiting Launch', Description: 'Ship releases.', 'What do you want them to do?': 'Ship releases.',
        'Who and what should they work with?': ['Internal Docs', 'Legal Bot', 'Retired Bot'], 'Any additional guidance they should know?': 'Never on Fridays.',
        'Learned Context': [] },
    ]);
    expect((await json('external-collaborators.json'))['External Agents']).toEqual([{
      'Collaborator name': 'Legal Bot',
      Status: 'Active',
      Description: 'Reviews contracts before signature.',
      'What does this collaborator do?': 'Reviews contracts before signature.',
      Capabilities: [{ Name: 'Review contract', Description: 'Reads a contract and flags risk.' }],
      // The archived team still has its name; the rule's stored name yields to
      // the team's current one.
      'Who can this collaborator work with?': ['Code Reviewer', 'Old Team'],
      'How should they collaborate?': 'Request help',
      'Request Permissions': [{ Team: 'Code Reviewer', Rules: ['Can read summaries', 'Needs approval to run analysis', 'Cannot draft outputs', 'Can propose updates'] }],
    }]);
    expect((await json('knowledge.json')).Knowledge).toEqual([
      { Title: 'Refund policy', Link: 'https://docs.google.com/document/d/refund', Source: 'Google Drive', Section: 'Documents', Added: '2026-09-01T10:14:00.000Z' },
    ]);
    expect((await json('connections.json')).Connected).toEqual([
      { App: 'GitHub', Status: 'Connected' },
      { App: 'Slack', Status: 'Needs Reconnect' },
      { App: 'Internal Docs', Status: 'Connected', 'MCP endpoint URL': 'https://mcp.example.com/sse' },
    ]);
    const review = await json('review.json');
    expect(review.Approvals).toEqual([{
      'Agent': 'Release Coordinator', Requested: '2026-09-05T09:12:00.000Z', Level: 'Standard', Reason: 'Acting on outside content',
      'Requested Actions': [{
        App: 'Slack', Action: 'Send message',
        Details: {
          Channel: '#announcements', Text: 'Release 2.14 is live.', 'Tenant ID': 'Hidden', 'Connector ID': 'GitHub',
          Invocation: 'Hidden', 'API key': 'Hidden', Deep: { A: { B: 'Hidden' } },
        },
      }],
      Why: 'It quotes an outside page.', Status: 'Rejected', 'Decided by': 'Alex Rivera', Decided: '2026-09-05T09:20:00.000Z',
      'Rejection reason': 'Wait until the deploy is verified.',
    }]);
    expect(review.Clarifications).toEqual([{
      'Agent': 'Unknown agent', Asked: '2026-09-08T16:40:00.000Z', Question: 'Which region should the report cover?',
      Status: 'Answered', 'Answered by': 'Alex Rivera', Answered: '2026-09-08T17:02:00.000Z',
    }]);
    expect(await json('members.json')).toEqual({
      Members: [
        { Name: 'Alex Rivera', Email: 'person@example.com', Role: 'Owner', Joined: '2026-03-02T18:20:00.000Z', 'Works with': ['Code Reviewer'] },
        { Name: 'Priya Natarajan', Email: 'priya@example.com', Role: 'Member', Joined: '2026-04-02T18:20:00.000Z' },
      ],
      'Pending invitations': [{ Email: 'colleague@example.com', Role: 'Member', Invited: '2026-09-10T09:00:00.000Z' }],
    });
  });

  it('places every produced file where the transcript points, with the fixture bytes, and a Google Doc as a link', async () => {
    const { zip, json } = await build();
    const { Conversations } = await json('conversations.json');
    const paths = Conversations.flatMap((c: { Messages: Array<{ Files?: Array<{ Path?: string }> }> }) =>
      c.Messages.flatMap((m) => (m.Files ?? []).map((f) => f.Path).filter(Boolean)));
    expect(paths).toEqual(['files/2026-09-12-review-of-pr-482/pr-482-review.md', 'files/2026-09-12-review-of-pr-482/chart.png']);
    for (const p of paths) {
      const bytes = await zip.file(p as string)!.async('nodebuffer');
      expect(bytes.toString()).toMatch(/^bytes of tenants\//);
    }
    // The Google Doc has no bytes here and appears nowhere under files/.
    expect(Object.keys(zip.files).some((f) => f.includes('q3') || f.includes('Q3'))).toBe(false);
  });

  it('carries no identifier, secret, tool call, system prompt or skill anywhere in the archive, and keeps a UUID in a person\'s text', async () => {
    const { zip } = await build();
    const everything: string[] = [];
    for (const [name, entry] of Object.entries(zip.files)) {
      if (!entry.dir && !name.startsWith('files/')) everything.push(await entry.async('string'));
    }
    const blob = everything.join('\n');
    for (const [key, sentinel] of Object.entries(S)) {
      expect({ key, present: blob.includes(sentinel) }).toEqual({ key, present: false });
    }
    for (const forbidden of ['SECRETSIG', 'sk-live-SECRET', 'DEEPSECRET', 'SYSTEM_PROMPT_TEXT', 'skill-1', 'tool_calls', 'toolTrail', 'system_prompt', 'hitl_status', 'forwarded_context',
      'mcp__legal', 'mcp__github', 'Code Reviewer (old name)', 'Learned after the cutoff', 'request_help', 'approval_required']) {
      expect({ forbidden, present: blob.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
    expect(blob).toContain(UUID_IN_TEXT);
  });
});

describe('an empty workspace', () => {
  it('produces every file with empty arrays and zero counts', async () => {
    jest.clearAllMocks();
    seedFixtures({}, { tenants: [{ name: '' }], accounts: [] });
    listApprovals.mockResolvedValue({ items: [], nextCursor: null });
    listClarifications.mockResolvedValue({ items: [], nextCursor: null });
    exportThreads.mockResolvedValue({ items: [], nextCursor: null });
    exportMessages.mockResolvedValue({ items: [], nextCursor: null });
    listAgentMemories.mockResolvedValue({ memories: [], nextCursor: null, total: 0 });
    getCatalog.mockResolvedValue(CATALOG);
    listConnectors.mockResolvedValue([]);
    const { result, zip, json } = await build();
    expect(result.filename).toBe('liftoff-workspace-export-2026-09-18.zip');
    expect(Object.keys(zip.files).filter((f) => !zip.files[f].dir).sort()).toEqual([
      'README.txt', 'ai-teams.json', 'connections.json', 'conversations.json', 'external-collaborators.json',
      'knowledge.json', 'members.json', 'review.json', 'workspace.json',
    ]);
    expect(await json('conversations.json')).toEqual({ Conversations: [] });
    expect(await json('ai-teams.json')).toEqual({ 'Agents': [] });
    expect(await json('external-collaborators.json')).toEqual({ 'External Agents': [] });
    // No teams, so the runtime is never asked for Learned Context.
    expect(listAgentMemories).not.toHaveBeenCalled();
    expect(await json('knowledge.json')).toEqual({ Knowledge: [] });
    expect(await json('connections.json')).toEqual({ Connected: [] });
    expect(await json('review.json')).toEqual({ Approvals: [], Clarifications: [] });
    expect(await json('members.json')).toEqual({ Members: [], 'Pending invitations': [] });
    expect((await json('workspace.json')).Counts).toEqual({
      Conversations: 0, Messages: 0, 'Agents': 0, Knowledge: 0, Connected: 0, Approvals: 0, Clarifications: 0, Members: 0, Files: 0, 'Pending invitations': 0,
      'External Agents': 0,
    });
    expect(await json('workspace.json')).not.toHaveProperty('Exported by');
    expect(download).not.toHaveBeenCalled();
  });
});
