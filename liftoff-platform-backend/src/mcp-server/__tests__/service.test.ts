// MCP Service Tool Handlers — unit tests
// Covers: happy paths, tenant boundary enforcement, sender_id from auth context,
// rate limiting, max-pending cap, atomic read.

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockPoolQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  // Production service runs every DB call under withTenantScope. Tests
  // already wire mockPoolQuery via mockResolvedValueOnce chains — expose the
  // same mock through the scoped client so existing expectations keep
  // matching.
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: { query: typeof mockPoolQuery }) => unknown) => {
    return fn({ query: mockPoolQuery });
  }),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockEnqueueAgentTask = jest.fn().mockResolvedValue(undefined);
const mockListAgentMemories = jest.fn();
const mockDeleteAgentMemory = jest.fn();
const mockListPendingApprovals = jest.fn().mockResolvedValue({ items: [], nextCursor: null });

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    enqueueAgentTask: (...args: unknown[]) => mockEnqueueAgentTask(...args),
    listAgentMemories: (...args: unknown[]) => mockListAgentMemories(...args),
    deleteAgentMemory: (...args: unknown[]) => mockDeleteAgentMemory(...args),
    listPendingApprovals: (...args: unknown[]) => mockListPendingApprovals(...args),
  },
}));

const mockAdmission = jest.fn();
jest.mock('../../agent-chat/admission', () => ({
  checkChatAdmission: (...args: unknown[]) => mockAdmission(...args),
}));

const mockEnqueueChatRun = jest.fn();
jest.mock('../chat-run-dispatch', () => ({
  enqueueChatRunTask: (...args: unknown[]) => mockEnqueueChatRun(...args),
}));
// A person's message cancels the continuations queued on the conversation
// before the run row is written. The store has its own suite; here it is
// a seam, so the ordered pool mocks below stay the run's own queries.
const mockCancelThreadContinuations = jest.fn(async () => 0);
jest.mock('../../chat-continuations/store', () => ({
  cancelThreadContinuations: (...args: unknown[]) => mockCancelThreadContinuations(...(args as [string, string])),
}));

jest.mock('../../internal-agent-oversight/service', () => ({
  oversightService: {
    getOrCreateOversightSettings: jest.fn().mockResolvedValue({
      tenantId: '11111111-1111-1111-1111-111111111111',
      currentVersion: 1,
      autonomy: 'balanced',
      escalation: 'important',
      sensitiveWork: {},
      communication: 'review',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  },
}));

// Platform-assistant collaborators: each assistant's surface repository, its
// rate limiter, and the CAIO thread client.
const mockLiftoffRateLimit = jest.fn().mockResolvedValue({ allowed: true, remaining: 10 });
jest.mock('../../liftoff/rate-limiter', () => ({
  checkAndIncrementLiftoffRateLimit: (...args: unknown[]) => mockLiftoffRateLimit(...args),
}));

const mockInsightsRateLimit = jest.fn().mockResolvedValue({ allowed: true, remaining: 10 });
jest.mock('../../insights/rate-limiter', () => ({
  checkAndIncrementInsightsRateLimit: (...args: unknown[]) => mockInsightsRateLimit(...args),
}));

const mockCreateLiftoffThread = jest.fn();
const mockGetLiftoffThread = jest.fn();
const mockListLiftoffThreads = jest.fn().mockResolvedValue({ threads: [], nextCursor: null, hasMore: false });
jest.mock('../../liftoff/chat-repository', () => ({
  createThread: (...args: unknown[]) => mockCreateLiftoffThread(...args),
  getThread: (...args: unknown[]) => mockGetLiftoffThread(...args),
  listThreads: (...args: unknown[]) => mockListLiftoffThreads(...args),
}));

const mockCreateInsightsThread = jest.fn();
const mockGetInsightsThread = jest.fn();
const mockListInsightsThreads = jest.fn().mockResolvedValue({ threads: [], nextCursor: null, hasMore: false });
jest.mock('../../insights/chat-repository', () => ({
  createThread: (...args: unknown[]) => mockCreateInsightsThread(...args),
  getThread: (...args: unknown[]) => mockGetInsightsThread(...args),
  listThreads: (...args: unknown[]) => mockListInsightsThreads(...args),
}));

const mockListAgentChatThreads = jest.fn().mockResolvedValue({ threads: [], nextCursor: null, hasMore: false });
const mockGetAgentChatThread = jest.fn();
jest.mock('../../agent-chat/chat-repository', () => ({
  listThreads: (...args: unknown[]) => mockListAgentChatThreads(...args),
  getThread: (...args: unknown[]) => mockGetAgentChatThread(...args),
}));

const mockListTeamPlanThreads = jest.fn().mockResolvedValue([]);
const mockTeamPlanThreadExists = jest.fn().mockResolvedValue(true);
jest.mock('../../workforce-plans/team-plan-thread-client', () => ({
  listTeamPlanThreads: (...args: unknown[]) => mockListTeamPlanThreads(...args),
  teamPlanThreadExists: (...args: unknown[]) => mockTeamPlanThreadExists(...args),
}));

// The share store behind every conversationId. upsertShare answers with one
// stable id; findShareById misses by default so continuation tests written
// against thread ids exercise the one-release legacy path.
const SHARE_ID = '88888888-8888-8888-8888-888888888888';
const mockUpsertShare = jest.fn().mockResolvedValue(SHARE_ID);
const mockFindShareById = jest.fn().mockResolvedValue(null);
jest.mock('../../chat-shares/repository', () => ({
  CAIO_SHARE_AGENT_ID: '00000000-0000-0000-0000-000000000001',
  upsertShare: (...args: unknown[]) => mockUpsertShare(...args),
  findShareById: (...args: unknown[]) => mockFindShareById(...args),
}));
// The external agents: listed on the roster, refused as a chat target.
const mockListCollaborators = jest.fn().mockResolvedValue([]);
const mockGetCollaborator = jest.fn().mockResolvedValue(null);
jest.mock('../../external-agents/service', () => ({
  externalAgentService: {
    listAllByTenant: (...args: unknown[]) => mockListCollaborators(...args),
    get: (...args: unknown[]) => mockGetCollaborator(...args),
  },
}));
const mockThreadVisibleToCaller = jest.fn().mockResolvedValue(true);
jest.mock('../../chat-shares/visibility', () => ({
  threadVisibleToCaller: (...args: unknown[]) => mockThreadVisibleToCaller(...args),
}));

const mockCreatePairedThread = jest.fn();
const mockStoreInboundMedia = jest.fn();
// The error classes the service imported: resetModules re-evaluates this
// factory on a later require, so the FIRST evaluation's classes are kept for
// the instanceof checks in the service.
const mockMediaErrors: { UnsupportedMediaTypeError?: new (t: string) => Error } = {};
jest.mock('../../media/inbound', () => {
  class UnsupportedMediaTypeError extends Error { constructor(t: string) { super(`Unsupported media type: ${t}`); } }
  class MediaContentMismatchError extends Error {}
  class MediaScreeningRefusedError extends Error {}
  mockMediaErrors.UnsupportedMediaTypeError ??= UnsupportedMediaTypeError;
  return {
    UnsupportedMediaTypeError: mockMediaErrors.UnsupportedMediaTypeError,
    MediaContentMismatchError, MediaScreeningRefusedError,
    storeInboundMedia: (...a: unknown[]) => mockStoreInboundMedia(...a),
  };
});

jest.mock('../../liftoff/caio-delegation', () => ({
  createPairedTeamPlanThread: (...args: unknown[]) => mockCreatePairedThread(...args),
  CAIODelegationError: class CAIODelegationError extends Error {},
}));

import { log } from '../../infrastructure/logging';
import {
  findTeammates,
  listLearnedContext,
  removeLearnedContext,
  delegateTask,
  chat,
  getChatReply,
  listConversations,
} from '../service';
import type { McpActor } from '../actor';

// ── Fixtures ───────────────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const KEY_ID = '33333333-3333-3333-3333-333333333333';
const AGENT_ID = '44444444-4444-4444-4444-444444444444';
const RECIPIENT_ID = '55555555-5555-5555-5555-555555555555';
const MSG_ID = '66666666-6666-6666-6666-666666666666';

function makeCtx(overrides: Partial<McpActor> = {}): McpActor {
  return {
    tenantId: TENANT_ID, accountId: ACCOUNT_ID, keyId: KEY_ID, keyType: 'claude_code',
    role: 'member', displayName: 'Alice Example', client: 'Claude Code',
    ...overrides,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Reset rate limit store between tests by reimporting (module-level map)
  jest.resetModules();
  mockUpsertShare.mockResolvedValue(SHARE_ID);
  mockFindShareById.mockResolvedValue(null);
  mockThreadVisibleToCaller.mockResolvedValue(true);
  mockListCollaborators.mockResolvedValue([]);
  mockGetCollaborator.mockResolvedValue(null);
  mockListPendingApprovals.mockResolvedValue({ items: [], nextCursor: null });
});

// ── findTeammates ──────────────────────────────────────────────────────────

describe('findTeammates', () => {
  it('returns agents, proxy keys, and collab tokens merged', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: AGENT_ID, role: 'HR Agent', messaging_nickname: 'HR', summary: 'Handles HR', type: 'internal_agent' }] })
      .mockResolvedValueOnce({ rows: [{ id: KEY_ID, name: 'Alice Claude', key_hint: 'abcd', email: 'alice@example.com', type: 'claude_code' }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await findTeammates({ query: 'HR' }, makeCtx()) as { teammates: { id: string; type: string }[] };
    expect(result.teammates.some((t) => t.type === 'internal_agent')).toBe(true);
    expect(result.teammates.some((t) => t.type === 'claude_code')).toBe(true);
  });

  it('enforces tenant isolation via tenantId param', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await findTeammates({ query: 'x' }, makeCtx());
    // All three queries must use the tenant ID as first parameter
    for (const call of mockPoolQuery.mock.calls) {
      expect(call[1][0]).toBe(TENANT_ID);
    }
  });

  it('caps results at limit', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `id-${i}`, role: `Role ${i}`, messaging_nickname: null, summary: null,
    }));
    mockPoolQuery.mockResolvedValueOnce({ rows }).mockResolvedValue({ rows: [] });

    const result = await findTeammates({ query: 'x', limit: 3 }, makeCtx()) as { teammates: unknown[] };
    expect(result.teammates.length).toBeLessThanOrEqual(3);
  });
});

// ── Learned Context (dashboard parity) ─────────────────────────────────────────

describe('listLearnedContext', () => {
  it('resolves the team by name and returns the runtime list with ids', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID, role: 'Marketing', messaging_nickname: 'Marketing Team' }] }); // resolution roster
    mockListAgentMemories.mockResolvedValueOnce({
      memories: [{ id: MSG_ID, content: 'Prefers weekly summaries', source: 'chat', createdAt: '2026-09-01T00:00:00Z' }],
      nextCursor: null,
      total: 1,
    });
    const result = await listLearnedContext({ team: 'marketing team' }, makeCtx()) as Record<string, unknown>;
    expect(mockListAgentMemories).toHaveBeenCalledWith(TENANT_ID, AGENT_ID, {});
    expect(result.team).toEqual({ agentId: AGENT_ID, name: 'Marketing Team' });
    expect(result.memories).toEqual([{ id: MSG_ID, content: 'Prefers weekly summaries', createdAt: '2026-09-01T00:00:00Z' }]);
    expect(result.total).toBe(1);
  });

  it('passes limit and cursor through to the same client call the dashboard route makes', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID, role: 'Marketing', messaging_nickname: null }] });
    mockListAgentMemories.mockResolvedValueOnce({ memories: [], nextCursor: null, total: 0 });
    await listLearnedContext({ agentId: AGENT_ID, limit: 25, cursor: 'c1' }, makeCtx());
    expect(mockListAgentMemories).toHaveBeenCalledWith(TENANT_ID, AGENT_ID, { limit: 25, cursor: 'c1' });
  });

  it('refuses a viewer, the same floor as the dashboard routes', async () => {
    const result = await listLearnedContext({ agentId: AGENT_ID }, makeCtx({ role: 'viewer' })) as { success: boolean };
    expect(result.success).toBe(false);
    expect(mockListAgentMemories).not.toHaveBeenCalled();
  });

  it('refuses a platform assistant: only agents keep Learned Context', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // resolution roster: no teams
    const result = await listLearnedContext({ team: 'Insights Manager' }, makeCtx()) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('Learned Context');
    expect(mockListAgentMemories).not.toHaveBeenCalled();
  });
});

describe('removeLearnedContext', () => {
  it('removes one entry through the same client call the dashboard route makes', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID, role: 'Marketing', messaging_nickname: null }] });
    mockDeleteAgentMemory.mockResolvedValueOnce(undefined);
    const result = await removeLearnedContext({ agentId: AGENT_ID, memoryId: MSG_ID }, makeCtx()) as { success: boolean };
    expect(result.success).toBe(true);
    expect(mockDeleteAgentMemory).toHaveBeenCalledWith(TENANT_ID, AGENT_ID, MSG_ID);
  });

  it('maps the runtime 404 to a clean not-found result', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID, role: 'Marketing', messaging_nickname: null }] });
    mockDeleteAgentMemory.mockRejectedValueOnce(new Error('HTTP 404 from tenant runtime memories/delete'));
    const result = await removeLearnedContext({ agentId: AGENT_ID, memoryId: MSG_ID }, makeCtx()) as { success: boolean; error: string };
    expect(result).toEqual({ success: false, error: 'Memory not found' });
  });

  it('refuses a viewer', async () => {
    const result = await removeLearnedContext({ agentId: AGENT_ID, memoryId: MSG_ID }, makeCtx({ role: 'viewer' })) as { success: boolean };
    expect(result.success).toBe(false);
    expect(mockDeleteAgentMemory).not.toHaveBeenCalled();
  });
});

// ── delegateTask ───────────────────────────────────────────────────────────

describe('delegateTask', () => {
  it('rejects when agent not found or not active', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // agent not found
    const result = await delegateTask({ agentId: AGENT_ID, objective: 'do thing' }, makeCtx()) as { success: boolean };
    expect(result.success).toBe(false);
  });

  it('succeeds for any authenticated tenant member when agent is active', async () => {
    // v6.1 dual addressing: (1) resolveAddress agentId lookup, (2) active check.
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID, role: 'HR', messaging_nickname: null }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID }] });
    const result = await delegateTask({ agentId: AGENT_ID, objective: 'run payroll' }, makeCtx()) as { success: boolean; status: string };
    expect(result.success).toBe(true);
    expect(result.status).toBe('queued');
    expect(mockEnqueueAgentTask).toHaveBeenCalledWith(TENANT_ID, AGENT_ID, expect.objectContaining({
      objective: 'run payroll',
      triggeredBy: 'claude_code',
    }));
  });

  it('keys each delegation on its own run-level trigger, not on the MCP key alone', async () => {
    // The runtime deduplicates a run by its trigger key and replays the cached
    // result for a repeat. Keyed on the key alone, the second delegation from
    // this key would never run.
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID, role: 'HR', messaging_nickname: null }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID }] });
    await delegateTask({ agentId: AGENT_ID, objective: 'run the brief' }, makeCtx());
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID, role: 'HR', messaging_nickname: null }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID }] });
    await delegateTask({ agentId: AGENT_ID, objective: 'run the brief' }, makeCtx());
    expect(mockEnqueueAgentTask).toHaveBeenCalledTimes(2);
    const refs = mockEnqueueAgentTask.mock.calls.map((c) => (c[2] as { triggerRef: string }).triggerRef);
    for (const ref of refs) expect(ref).toMatch(/^mcp-delegate:[^:]+:[0-9a-f-]{36}$/);
    expect(refs[0]).not.toBe(refs[1]);
  });

  it('does not check person_agent_assignments for delegation grants', async () => {
    // v6.1: two lookups (resolve + active check) — and NEITHER touches
    // person_agent_assignments (migration-160 policy).
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID, role: 'HR', messaging_nickname: null }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID }] });
    await delegateTask({ agentId: AGENT_ID, objective: 'x' }, makeCtx());
    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    for (const call of mockPoolQuery.mock.calls) {
      expect(String(call[0])).not.toContain('person_agent_assignments');
    }
  });
});


// ── roster mode (plan v2.1) ────────────────────────────────────────────────

describe('findTeammates roster mode', () => {
  it('enumerates the active roster with no embedding call when query is omitted', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        { id: 'a1', role: 'HR', messaging_nickname: 'People Team', summary: 's1', type: 'internal_agent' },
        { id: 'a2', role: 'Marketing', messaging_nickname: null, summary: null, type: 'internal_agent' },
      ],
    });
    const result = await findTeammates({}, makeCtx()) as { teammates: Array<{ name: string; type: string }>; total: number };
    // The three platform assistants lead the roster, then the tenant teams.
    expect(result.total).toBe(5);
    expect(result.teammates.slice(0, 3).map((t) => t.name)).toEqual([
      'Liftoff', 'Chief AI Officer', 'Insights Manager',
    ]);
    expect(result.teammates.slice(0, 3).every((t) => t.type === 'assistant')).toBe(true);
    expect(result.teammates[3].name).toBe('People Team');
    expect(result.teammates[4].name).toBe('Marketing');
    // Single roster query — enumeration is not search.
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(String(mockPoolQuery.mock.calls[0][0])).toContain("status = 'active'");
  });

  it('lists the external agents after the teams, with chat: false', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'a1', role: 'HR', messaging_nickname: null, summary: null, type: 'internal_agent' }] });
    mockListCollaborators.mockResolvedValueOnce([
      { id: 'c1', name: 'Partner Bot', description: 'A partner system that files tickets', status: 'connected', collaborationMode: 'request_help' },
    ]);
    const result = await findTeammates({}, makeCtx()) as { teammates: Array<Record<string, unknown>> };
    const collaborator = result.teammates.find((t) => t.type === 'external_agent');
    expect(collaborator).toEqual({
      id: 'c1', type: 'external_agent', name: 'Partner Bot', summary: 'A partner system that files tickets',
      status: 'connected', collaborationMode: 'request_help', chat: false,
    });
  });
});

describe('chat with a collaborator', () => {
  it('is refused by name: collaborators have no conversation', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // roster: no teams
    mockListCollaborators.mockResolvedValueOnce([
      { id: 'c1', name: 'Partner Bot', description: null, status: 'connected', collaborationMode: 'request_help' },
    ]);
    const result = await chat({ team: 'Partner Bot', message: 'hi', waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('rejected');
    expect(result.error).toBe('collaborators_have_no_conversation');
    expect(result.collaborator).toEqual({ id: 'c1', name: 'Partner Bot' });
    expect(mockEnqueueChatRun).not.toHaveBeenCalled();
  });

  it('is refused by id too', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // internal_agents miss
    mockGetCollaborator.mockResolvedValueOnce({ id: '99999999-9999-4999-8999-999999999999', name: 'Partner Bot' });
    const result = await chat({ agentId: '99999999-9999-4999-8999-999999999999', message: 'hi', waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('rejected');
    expect(result.error).toBe('collaborators_have_no_conversation');
  });
});

// ── liftoff_chat (durable run + long-poll) ────────────────────────────────

const TEAM_ROSTER_ROW = { id: AGENT_ID, role: 'Marketing', messaging_nickname: 'Marketing Team' };
const THREAD_ID = '66666666-6666-6666-6666-666666666666';
const RUN_ID = '77777777-7777-7777-7777-777777777777';

describe('chat', () => {
  beforeEach(() => {
    mockAdmission.mockResolvedValue({ allowed: true });
    mockEnqueueChatRun.mockResolvedValue(undefined);
  });

  it('resolves the team by exact name, creates thread+run, and returns the completed reply with team echo', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] })                     // roster for resolution
      .mockResolvedValueOnce({ rows: [{ id: THREAD_ID }] })                   // thread insert
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                       // participant insert
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })                      // run insert
      .mockResolvedValueOnce({ rows: [{ status: 'completed', target_kind: 'agent', assistant_message_id: 'msg-1', reply_content: null, approval_id: null, error_code: null }] })
      .mockResolvedValueOnce({ rows: [{ content: 'the reply' }] });           // message content

    const result = await chat({ team: 'marketing team', message: 'hi', waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(result.reply).toBe('the reply');
    // The conversation id is the thread's share id, minted for the new
    // thread as an agent-chat share carrying the team's id.
    expect(result.conversationId).toBe(SHARE_ID);
    expect(result.link).toBe(`${process.env.FRONTEND_URL}/share/${SHARE_ID}`);
    expect(mockUpsertShare).toHaveBeenCalledWith(TENANT_ID, AGENT_ID, THREAD_ID, ACCOUNT_ID, 'agent');
    expect(result.chatRunId).toBe(RUN_ID);
    expect(result.team).toEqual({ agentId: AGENT_ID, name: 'Marketing Team' });
    expect(mockEnqueueChatRun).toHaveBeenCalledWith(RUN_ID, TENANT_ID);
  });

  it('continues a team conversation by share id, including a dashboard-born thread (channel web)', async () => {
    mockFindShareById.mockResolvedValueOnce({ tenantId: TENANT_ID, agentId: AGENT_ID, threadId: THREAD_ID, threadKind: 'agent' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] })                     // resolution
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] })                            // participant check
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })                      // run insert
      .mockResolvedValueOnce({ rows: [{ status: 'completed', target_kind: 'agent', assistant_message_id: 'msg-1', reply_content: null, approval_id: null, error_code: null }] })
      .mockResolvedValueOnce({ rows: [{ content: 'again' }] });
    const result = await chat({ team: 'marketing team', message: 'hi', conversationId: SHARE_ID, waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(result.conversationId).toBe(SHARE_ID);
    // The dashboard's visibility rule admits the thread; no channel = 'mcp'
    // predicate is applied any more.
    expect(mockThreadVisibleToCaller).toHaveBeenCalledWith(expect.objectContaining({ threadKind: 'agent', threadId: THREAD_ID, role: 'member' }));
    for (const call of mockPoolQuery.mock.calls) expect(String(call[0])).not.toContain("channel = 'mcp'");
    expect(mockCreateLiftoffThread).not.toHaveBeenCalled();
    expect((log.info as jest.Mock).mock.calls.some((c) => c[1] === 'mcp.legacy_conversation_id')).toBe(false);
  });

  it("refuses another tenant's share id as conversation_not_found", async () => {
    mockFindShareById.mockResolvedValueOnce({ tenantId: '99999999-9999-9999-9999-999999999999', agentId: AGENT_ID, threadId: THREAD_ID, threadKind: 'agent' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] });
    const result = await chat({ team: 'marketing team', message: 'hi', conversationId: SHARE_ID, waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('failed');
    expect(result.error).toBe('conversation_not_found');
    expect(mockThreadVisibleToCaller).not.toHaveBeenCalled();
    expect(mockEnqueueChatRun).not.toHaveBeenCalled();
  });

  it('accepts a bare thread id for one release, applying the old predicates and logging it', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] })                     // resolution
      .mockResolvedValueOnce({ rows: [{ id: THREAD_ID }] })                   // legacy: agent_chat_threads channel = 'mcp'
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] })                            // participant check
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })                      // run insert
      .mockResolvedValueOnce({ rows: [{ status: 'completed', target_kind: 'agent', assistant_message_id: 'msg-1', reply_content: null, approval_id: null, error_code: null }] })
      .mockResolvedValueOnce({ rows: [{ content: 'again' }] });
    const result = await chat({ team: 'marketing team', message: 'hi', conversationId: THREAD_ID, waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    // The share id comes back so the client moves off the thread id.
    expect(result.conversationId).toBe(SHARE_ID);
    const legacy = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes("channel = 'mcp'"));
    expect(legacy![1]).toEqual([THREAD_ID, TENANT_ID, ACCOUNT_ID]);
    expect((log.info as jest.Mock).mock.calls.some((c) => c[1] === 'mcp.legacy_conversation_id')).toBe(true);
  });

  it('returns ranked candidates instead of auto-firing on a fuzzy name', async () => {
    // Tier 1+2 miss on the roster; the ranked fallback reuses findTeammates
    // (ILIKE fallback path: embedding returns null in tests).
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] })                     // roster (no exact/normalized match)
      .mockResolvedValueOnce({ rows: [{ id: AGENT_ID, role: 'Marketing', messaging_nickname: 'Marketing Team', summary: null, type: 'internal_agent', similarity: null }] })
      .mockResolvedValueOnce({ rows: [] });                                    // collab tokens
    const result = await chat({ team: 'the growth folks', message: 'hi', waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('ambiguous');
    expect(Array.isArray(result.candidates)).toBe(true);
    expect(mockEnqueueChatRun).not.toHaveBeenCalled();
  });

  it('surfaces admission rejection without creating a run', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] });
    mockAdmission.mockResolvedValueOnce({ allowed: false, httpStatus: 402, error: 'payment_required', reason: 'suspended' });
    const result = await chat({ team: 'marketing team', message: 'hi', waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('rejected');
    expect(result.error).toBe('payment_required');
    expect(mockEnqueueChatRun).not.toHaveBeenCalled();
  });

  it('unique-violation on the active-run index returns busy with the active run id', async () => {
    const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] })                     // resolution
      .mockResolvedValueOnce({ rows: [{ id: THREAD_ID }] })                   // conversation validate
      .mockResolvedValueOnce({ rows: [{ 1: 1 }] })                            // participant check
      .mockRejectedValueOnce(dup)                                              // run insert violates index
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] });                     // active-run lookup
    const result = await chat(
      { team: 'marketing team', message: 'hi', conversationId: THREAD_ID, waitSeconds: 5 },
      makeCtx(),
    ) as Record<string, unknown>;
    expect(result.status).toBe('busy');
    expect(result.activeChatRunId).toBe(RUN_ID);
  });

  it('compensates a failed enqueue: run marked failed, error surfaced', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: THREAD_ID }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                       // compensation UPDATE
    mockEnqueueChatRun.mockRejectedValueOnce(new Error('queue down'));
    const result = await chat({ team: 'marketing team', message: 'hi', waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('failed');
    expect(result.error).toBe('enqueue_failed');
    const comp = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes("SET status = 'failed', error_code = $2"));
    expect(comp![1]).toEqual([RUN_ID, 'enqueue_failed']);
  });
});

// ── liftoff_get_chat_reply ────────────────────────────────────────────────

describe('chat attachments', () => {
  beforeEach(() => {
    mockAdmission.mockResolvedValue({ allowed: true });
    mockEnqueueChatRun.mockResolvedValue(undefined);
  });

  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const MEDIA_ID = '77777777-7777-7777-7777-777777777777';

  it('an upload attachment is persisted on the run row for the turn to carry', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: THREAD_ID }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })
      .mockResolvedValueOnce({ rows: [{ status: 'completed', target_kind: 'agent', assistant_message_id: 'msg-1', reply_content: null, approval_id: null, error_code: null }] })
      .mockResolvedValueOnce({ rows: [{ content: 'the reply' }] });
    const attachments = [{ kind: 'upload' as const, name: 'notes.md', content: '# notes', addedAt: '2026-09-16T10:00:00.000Z' }];
    const result = await chat({ team: 'marketing team', message: 'read this', waitSeconds: 5, attachments }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    const insert = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO mcp_chat_runs'))!;
    expect(String(insert[0])).toContain('attachments');
    expect(JSON.parse(insert[1][5])).toEqual(attachments);
    expect(mockStoreInboundMedia).not.toHaveBeenCalled();
  });

  it('inline media is stored against the prepared run\'s thread and surface, then written onto the run row', async () => {
    mockStoreInboundMedia.mockResolvedValueOnce({ mediaId: MEDIA_ID, mimeType: 'image/png', filename: 'shot.png', sizeBytes: PNG.length });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: THREAD_ID }] })                   // thread insert
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                       // participant insert
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })                      // run insert (uploads only)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                       // UPDATE attachments
      .mockResolvedValueOnce({ rows: [{ status: 'completed', target_kind: 'agent', assistant_message_id: 'msg-1', reply_content: null, approval_id: null, error_code: null }] })
      .mockResolvedValueOnce({ rows: [{ content: 'ok' }] });
    const result = await chat({
      team: 'marketing team', message: 'look', waitSeconds: 5,
      mediaInline: [{ name: 'shot.png', mimeType: 'image/png', base64: PNG.toString('base64') }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    // The run exists before the bytes are stored, and the upload is stamped
    // with the thread and surface that will claim it.
    const insertIndex = mockPoolQuery.mock.calls.findIndex((c) => String(c[0]).includes('INSERT INTO mcp_chat_runs'));
    expect(insertIndex).toBeGreaterThan(-1);
    expect(mockPoolQuery.mock.calls[insertIndex][1][5]).toBeNull();
    expect(mockStoreInboundMedia).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID, accountId: ACCOUNT_ID, surface: 'agent_chat', threadId: THREAD_ID, mimeType: 'image/png', filename: 'shot.png',
    }));
    expect(Buffer.compare(mockStoreInboundMedia.mock.calls[0][0].bytes, PNG)).toBe(0);
    const update = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE mcp_chat_runs SET attachments'))!;
    const stored = JSON.parse(update[1][1]);
    expect(update[1][0]).toBe(RUN_ID);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: 'media', name: 'shot.png', media: { mediaId: MEDIA_ID, mimeType: 'image/png' } });
    expect(mockEnqueueChatRun).toHaveBeenCalledWith(RUN_ID, TENANT_ID);
  });

  it('too much media is refused before any run exists', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] });
    const item = { name: 'a.png', mimeType: 'image/png', base64: PNG.toString('base64') };
    const result = await chat({
      team: 'marketing team', message: 'look', waitSeconds: 5,
      attachments: [{ kind: 'media', name: 'x.png', media: { mediaId: MEDIA_ID, mimeType: 'image/png', filename: 'x.png' }, addedAt: '2026-09-16T10:00:00.000Z' }],
      mediaInline: [item, item, item, item],
    }, makeCtx()) as Record<string, unknown>;
    expect(result).toMatchObject({ status: 'rejected', error: 'too_much_media' });
    expect(mockPoolQuery.mock.calls.some((c) => String(c[0]).includes('INSERT INTO mcp_chat_runs'))).toBe(false);
    expect(mockStoreInboundMedia).not.toHaveBeenCalled();
  });

  it('inline media over the decoded cap is refused, nothing is stored, and the prepared run is settled failed', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: THREAD_ID }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const tooBig = Buffer.alloc(1.5 * 1024 * 1024 + 1, 1).toString('base64');
    const result = await chat({
      team: 'marketing team', message: 'look', waitSeconds: 5,
      mediaInline: [{ name: 'big.png', mimeType: 'image/png', base64: tooBig }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result).toMatchObject({ status: 'rejected', error: 'media_too_large', chatRunId: RUN_ID });
    expect(String(result.message)).toContain('1.5 MiB');
    expect(mockStoreInboundMedia).not.toHaveBeenCalled();
    expect(mockEnqueueChatRun).not.toHaveBeenCalled();
    const settle = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes("SET status = 'failed', error_code = $2"))!;
    expect(settle[1]).toEqual([RUN_ID, 'media_refused']);
  });

  it('a media type the inbound path refuses is relayed as media_refused and the run is settled', async () => {
    mockStoreInboundMedia.mockRejectedValueOnce(new mockMediaErrors.UnsupportedMediaTypeError!('application/x-msdownload'));
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] })
      .mockResolvedValueOnce({ rows: [{ id: THREAD_ID }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const result = await chat({
      team: 'marketing team', message: 'look', waitSeconds: 5,
      mediaInline: [{ name: 'x.exe', mimeType: 'application/x-msdownload', base64: PNG.toString('base64') }],
    }, makeCtx()) as Record<string, unknown>;
    expect(result).toMatchObject({ status: 'rejected', error: 'media_refused' });
    expect(mockEnqueueChatRun).not.toHaveBeenCalled();
    const settle = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes("SET status = 'failed', error_code = $2"))!;
    expect(settle[1]).toEqual([RUN_ID, 'media_refused']);
  });
});

describe('getChatReply', () => {
  it('is ownership-scoped to the caller anchor token', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // no run for this anchor
    const result = await getChatReply({ chatRunId: RUN_ID }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('not_found');
  });

  it('reports waiting_on_human with the follow-up guidance (reporting-only HITL)', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ thread_id: THREAD_ID, agent_id: AGENT_ID, target_kind: 'agent', role: 'Marketing', messaging_nickname: 'Marketing Team' }] })
      .mockResolvedValueOnce({ rows: [{ status: 'waiting_on_human', target_kind: 'agent', assistant_message_id: null, reply_content: null, approval_id: 'appr-1', error_code: null }] });
    const result = await getChatReply({ chatRunId: RUN_ID }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('waiting_on_human');
    // The note says the decision can be made here, through Liftoff, or on
    // the dashboard, and that the same run resumes.
    expect(String(result.note)).toContain('ask Liftoff to review it');
    expect(String(result.note)).toContain('Liftoff dashboard');
    expect(String(result.note)).toContain('SAME run resumes');
    expect(result.team).toEqual({ agentId: AGENT_ID, name: 'Marketing Team' });
  });

  it('answers with the share id as conversationId, minting it for the run thread', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ thread_id: THREAD_ID, agent_id: AGENT_ID, target_kind: 'agent', role: 'Marketing', messaging_nickname: 'Marketing Team' }] })
      .mockResolvedValueOnce({ rows: [] }); // run not terminal yet
    const result = await getChatReply({ chatRunId: RUN_ID }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('in_progress');
    expect(result.conversationId).toBe(SHARE_ID);
    expect(result.link).toBe(`${process.env.FRONTEND_URL}/share/${SHARE_ID}`);
    expect(mockUpsertShare).toHaveBeenCalledWith(TENANT_ID, AGENT_ID, THREAD_ID, ACCOUNT_ID, 'agent');
  });

  it('surfaces answeredBy when a Liftoff run handed the reply to a colleague', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ thread_id: THREAD_ID, agent_id: null, target_kind: 'liftoff', role: null, messaging_nickname: null }] })
      .mockResolvedValueOnce({ rows: [{ status: 'completed', target_kind: 'liftoff', assistant_message_id: null, reply_content: 'Cost was 12 OUs.', answered_by: 'Insights Manager', approval_id: null, error_code: null }] });
    const result = await getChatReply({ chatRunId: RUN_ID }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(result.team).toEqual({ agentId: 'liftoff', name: 'Liftoff' });
    expect(result.answeredBy).toBe('Insights Manager');
  });

  it('names an assistant run by its kind, not the internal_agents join', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ thread_id: THREAD_ID, agent_id: null, target_kind: 'insights', role: null, messaging_nickname: null }] })
      .mockResolvedValueOnce({ rows: [{ status: 'completed', target_kind: 'insights', assistant_message_id: null, reply_content: 'From the data.', approval_id: null, error_code: null }] });
    const result = await getChatReply({ chatRunId: RUN_ID }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(result.reply).toBe('From the data.');
    expect(result.team).toEqual({ agentId: 'insights', name: 'Insights Manager' });
  });
});

// ── liftoff_chat: platform assistants ─────────────────────────────────────

describe('chat with platform assistants', () => {
  beforeEach(() => {
    mockEnqueueChatRun.mockResolvedValue(undefined);
  });

  it('resolves the Insights Manager by exact name, creates its thread, and replies from the run row', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] })   // resolution roster (no collision)
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })    // run insert
      .mockResolvedValueOnce({ rows: [{ status: 'completed', target_kind: 'insights', assistant_message_id: null, reply_content: 'Cost was 12 OUs.', approval_id: null, error_code: null }] });
    mockCreateInsightsThread.mockResolvedValueOnce({ id: THREAD_ID });

    const result = await chat({ team: 'Insights Manager', message: 'what did we spend', waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(result.reply).toBe('Cost was 12 OUs.');
    // The message cancelled the continuations queued on the thread, before
    // the run row was written.
    expect(mockCancelThreadContinuations).toHaveBeenCalledWith(TENANT_ID, THREAD_ID);
    expect(mockCancelThreadContinuations.mock.invocationCallOrder[0]).toBeLessThan(mockEnqueueChatRun.mock.invocationCallOrder[0]);
    expect(result.conversationId).toBe(SHARE_ID);
    expect(mockUpsertShare).toHaveBeenCalledWith(TENANT_ID, null, THREAD_ID, ACCOUNT_ID, 'insights');
    expect(result.team).toEqual({ agentId: 'insights', name: 'Insights Manager' });
    expect(mockInsightsRateLimit).toHaveBeenCalledWith(TENANT_ID, ACCOUNT_ID);
    // The team admission path (billing guard, agent lookup) is not consulted.
    expect(mockAdmission).not.toHaveBeenCalled();
    // The run insert carries the kind and a NULL agent_id.
    const runInsert = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO mcp_chat_runs'));
    expect(String(runInsert![0])).toContain('target_kind');
    expect(runInsert![1]).toEqual([TENANT_ID, KEY_ID, THREAD_ID, 'what did we spend', 'insights', null]);
    expect(mockEnqueueChatRun).toHaveBeenCalledWith(RUN_ID, TENANT_ID);
  });

  it('reaches the Chief AI Officer by normalized name, through a workforce thread', async () => {
    mockCreatePairedThread.mockResolvedValueOnce(THREAD_ID);
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })                  // resolution roster: no teams
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })    // run insert
      .mockResolvedValueOnce({ rows: [{ status: 'completed', target_kind: 'caio', assistant_message_id: null, reply_content: 'Here is a plan.', approval_id: null, error_code: null }] });

    const result = await chat({ team: 'chief ai officer', message: 'plan me a team', waitSeconds: 5 }, makeCtx({ role: 'admin' })) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(result.team).toEqual({ agentId: 'caio', name: 'Chief AI Officer' });
    // The actor's real role travels to workforce-service; nothing is looked up.
    expect(mockCreatePairedThread).toHaveBeenCalledWith({
      caller: { tenantId: TENANT_ID, accountId: ACCOUNT_ID, role: 'admin' },
    });
    // A CAIO thread is shared as a team plan with the seeded CAIO agent id.
    expect(mockUpsertShare).toHaveBeenCalledWith(TENANT_ID, '00000000-0000-0000-0000-000000000001', THREAD_ID, ACCOUNT_ID, 'team_plan');
  });

  it('continues a Chief AI Officer conversation by its team-plan share id', async () => {
    mockFindShareById.mockResolvedValueOnce({ tenantId: TENANT_ID, agentId: '00000000-0000-0000-0000-000000000001', threadId: THREAD_ID, threadKind: 'team_plan' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })                  // resolution roster
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })    // run insert
      .mockResolvedValueOnce({ rows: [{ status: 'completed', target_kind: 'caio', assistant_message_id: null, reply_content: 'Continued.', approval_id: null, error_code: null }] });
    const result = await chat({ team: 'Chief AI Officer', message: 'go on', conversationId: SHARE_ID, waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(mockCreatePairedThread).not.toHaveBeenCalled();
    expect(mockThreadVisibleToCaller).toHaveBeenCalledWith(expect.objectContaining({ threadKind: 'team_plan', threadId: THREAD_ID }));
  });

  it('refuses a share of another kind than the assistant addressed', async () => {
    // A Liftoff share continued as the Insights Manager is not that conversation.
    mockFindShareById.mockResolvedValueOnce({ tenantId: TENANT_ID, threadId: THREAD_ID, threadKind: 'liftoff' });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const result = await chat({ team: 'Insights Manager', message: 'hi', conversationId: SHARE_ID, waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('failed');
    expect(result.error).toBe('conversation_not_found');
  });

  it('a team named like an assistant comes back ambiguous, never silently either one', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: AGENT_ID, role: 'Insights Manager', messaging_nickname: null }] });
    const result = await chat({ team: 'Insights Manager', message: 'hi', waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('ambiguous');
    const candidates = result.candidates as Array<{ agentId: string }>;
    expect(candidates.map((c) => c.agentId).sort()).toEqual([AGENT_ID, 'insights'].sort());
    expect(mockEnqueueChatRun).not.toHaveBeenCalled();
  });

  it('continues a Liftoff conversation by share id', async () => {
    mockFindShareById.mockResolvedValueOnce({ tenantId: TENANT_ID, threadId: THREAD_ID, threadKind: 'liftoff' });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })                  // resolution roster
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })    // run insert
      .mockResolvedValueOnce({ rows: [{ status: 'completed', target_kind: 'liftoff', assistant_message_id: null, reply_content: 'Done.', approval_id: null, error_code: null }] });

    const result = await chat({ team: 'Liftoff', message: 'again', conversationId: SHARE_ID, waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    expect(result.conversationId).toBe(SHARE_ID);
    expect(result.link).toBe(`${process.env.FRONTEND_URL}/share/${SHARE_ID}`);
    expect(mockCreateLiftoffThread).not.toHaveBeenCalled();
    const runInsert = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO mcp_chat_runs'));
    expect(runInsert![1]).toEqual([TENANT_ID, KEY_ID, THREAD_ID, 'again', 'liftoff', null]);
  });

  it('continues a Liftoff conversation by bare thread id for one release, with anchor history and a live thread', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })                  // resolution roster
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) // legacy anchor-history check
      .mockResolvedValueOnce({ rows: [{ id: RUN_ID }] })    // run insert
      .mockResolvedValueOnce({ rows: [{ status: 'completed', target_kind: 'liftoff', assistant_message_id: null, reply_content: 'Done.', approval_id: null, error_code: null }] });
    mockGetLiftoffThread.mockResolvedValueOnce({ id: THREAD_ID });

    const result = await chat({ team: 'Liftoff', message: 'again', conversationId: THREAD_ID, waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('completed');
    const historyCheck = mockPoolQuery.mock.calls.find((c) => String(c[0]).includes('anchor_token_id = $2 AND target_kind = $3'));
    expect(historyCheck![1]).toEqual([THREAD_ID, KEY_ID, 'liftoff']);
    expect(mockCreateLiftoffThread).not.toHaveBeenCalled();
    expect((log.info as jest.Mock).mock.calls.some((c) => c[1] === 'mcp.legacy_conversation_id')).toBe(true);
  });

  it('refuses a conversationId that is neither a share nor a thread this anchor used', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })                  // resolution roster
      .mockResolvedValueOnce({ rows: [] });                 // legacy anchor-history check misses
    const result = await chat({ team: 'Liftoff', message: 'again', conversationId: THREAD_ID, waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('failed');
    expect(result.error).toBe('conversation_not_found');
    expect(mockEnqueueChatRun).not.toHaveBeenCalled();
  });

  it('surfaces the Liftoff rate limit as rejected with retryAfter', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });      // resolution roster
    mockLiftoffRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 30, remaining: 0 });
    const result = await chat({ team: 'Liftoff', message: 'hi', waitSeconds: 5 }, makeCtx()) as Record<string, unknown>;
    expect(result.status).toBe('rejected');
    expect(result.retryAfter).toBe(30);
    expect(mockEnqueueChatRun).not.toHaveBeenCalled();
  });
});

// ── delegateTask: assistants are chat-only ────────────────────────────────

describe('delegateTask to a platform assistant', () => {
  it('refuses with a pointer at liftoff_chat', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });      // resolution roster
    const result = await delegateTask({ team: 'caio', objective: 'make a team' }, makeCtx()) as { success: boolean; error: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('liftoff_chat');
    expect(mockEnqueueAgentTask).not.toHaveBeenCalled();
  });
});

// ── liftoff_list_conversations ────────────────────────────────────────────

describe('listConversations', () => {
  const T1 = 'a1111111-1111-1111-1111-111111111111';
  const T2 = 'a2222222-2222-2222-2222-222222222222';
  const T3 = 'a3333333-3333-3333-3333-333333333333';
  const T4 = 'a4444444-4444-4444-4444-444444444444';

  function seedSources(): void {
    mockListAgentChatThreads.mockResolvedValue({ threads: [{ id: T1, title: 'Launch plan', updatedAt: '2026-09-16T10:00:00Z' }], nextCursor: null, hasMore: false });
    mockListLiftoffThreads.mockResolvedValue({ threads: [{ id: T2, title: 'Cost question', updatedAt: '2026-09-16T12:00:00Z' }], nextCursor: null, hasMore: false });
    mockListInsightsThreads.mockResolvedValue({ threads: [{ id: T3, title: 'Weekly spend', updatedAt: '2026-09-16T11:00:00Z' }], nextCursor: null, hasMore: false });
    mockListTeamPlanThreads.mockResolvedValue([{ id: T4, title: 'New support team', updatedAt: '2026-09-16T09:00:00Z' }]);
  }

  it('merges the four surfaces newest first, names the team or assistant, and carries share ids and links', async () => {
    seedSources();
    mockUpsertShare.mockImplementation(async (_t: string, _a: string | null, threadId: string) => `share-${threadId}`);
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ thread_id: T1, id: AGENT_ID, role: 'Marketing', messaging_nickname: 'Marketing Team' }] }) // participants
      .mockResolvedValueOnce({ rows: [{ thread_id: T3 }] });                                                                       // waiting_on_human
    const result = await listConversations({ limit: 20 }, makeCtx()) as { conversations: Array<Record<string, unknown>>; total: number };
    expect(result.total).toBe(4);
    expect(result.conversations.map((c) => c.title)).toEqual(['Cost question', 'Weekly spend', 'Launch plan', 'New support team']);
    expect(result.conversations[0].assistant).toEqual({ agentId: 'liftoff', name: 'Liftoff' });
    expect(result.conversations[1].assistant).toEqual({ agentId: 'insights', name: 'Insights Manager' });
    expect(result.conversations[1].waitingOnHuman).toBe(true);
    expect(result.conversations[2].team).toEqual({ agentId: AGENT_ID, name: 'Marketing Team' });
    expect(result.conversations[2].waitingOnHuman).toBe(false);
    expect(result.conversations[3].assistant).toEqual({ agentId: 'caio', name: 'Chief AI Officer' });
    expect(result.conversations[2].conversationId).toBe(`share-${T1}`);
    expect(result.conversations[2].link).toBe(`${process.env.FRONTEND_URL}/share/share-${T1}`);
    // The CAIO row is shared as a team plan with the seeded agent id.
    expect(mockUpsertShare).toHaveBeenCalledWith(TENANT_ID, '00000000-0000-0000-0000-000000000001', T4, ACCOUNT_ID, 'team_plan');
    // The workforce call carries the caller's real role.
    expect(mockListTeamPlanThreads).toHaveBeenCalledWith({ tenantId: TENANT_ID, accountId: ACCOUNT_ID, role: 'member' }, { limit: 20, query: undefined });
  });

  it('passes the title query to every source', async () => {
    seedSources();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    await listConversations({ query: 'spend', limit: 20 }, makeCtx());
    expect(mockListAgentChatThreads).toHaveBeenCalledWith(TENANT_ID, ACCOUNT_ID, expect.objectContaining({ titleQuery: 'spend' }));
    expect(mockListLiftoffThreads).toHaveBeenCalledWith(TENANT_ID, ACCOUNT_ID, expect.objectContaining({ titleQuery: 'spend' }));
    expect(mockListInsightsThreads).toHaveBeenCalledWith(TENANT_ID, ACCOUNT_ID, expect.objectContaining({ titleQuery: 'spend' }));
    expect(mockListTeamPlanThreads).toHaveBeenCalledWith(expect.anything(), { limit: 20, query: 'spend' });
  });

  it('a team filter restricts the fan-out to that team, an assistant filter to that surface', async () => {
    seedSources();
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [TEAM_ROSTER_ROW] })   // resolution
      .mockResolvedValue({ rows: [] });
    await listConversations({ team: 'Marketing Team', limit: 20 }, makeCtx());
    expect(mockListAgentChatThreads).toHaveBeenCalledWith(TENANT_ID, ACCOUNT_ID, expect.objectContaining({ agentId: AGENT_ID }));
    expect(mockListLiftoffThreads).not.toHaveBeenCalled();
    expect(mockListInsightsThreads).not.toHaveBeenCalled();
    expect(mockListTeamPlanThreads).not.toHaveBeenCalled();

    jest.clearAllMocks();
    seedSources();
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValue({ rows: [] });
    await listConversations({ team: 'Insights Manager', limit: 20 }, makeCtx());
    expect(mockListInsightsThreads).toHaveBeenCalled();
    expect(mockListAgentChatThreads).not.toHaveBeenCalled();
    expect(mockListLiftoffThreads).not.toHaveBeenCalled();
  });

  it('a viewer sees the same set a member does (tenant-wide rule; the role only travels to workforce)', async () => {
    seedSources();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const asMember = await listConversations({ limit: 20 }, makeCtx({ role: 'member' })) as { total: number };
    const asViewer = await listConversations({ limit: 20 }, makeCtx({ role: 'viewer' })) as { total: number };
    expect(asViewer.total).toBe(asMember.total);
    expect(mockListTeamPlanThreads).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'viewer' }), expect.anything());
  });

  it('applies the limit after the merge', async () => {
    seedSources();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const result = await listConversations({ limit: 2 }, makeCtx()) as { conversations: Array<{ title: string }> };
    expect(result.conversations.map((c) => c.title)).toEqual(['Cost question', 'Weekly spend']);
  });

  it('a pause the runtime queue names by thread counts as waiting, whichever surface started the turn', async () => {
    seedSources();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    mockListPendingApprovals.mockResolvedValueOnce({
      items: [
        { kind: 'approval', id: 'ap-1', threadId: T2, agentId: 'rt-1' },
        { kind: 'clarification', id: 'cl-1', threadId: 'b9999999-9999-9999-9999-999999999999', agentId: 'rt-2' },
      ],
      nextCursor: null,
    });
    const result = await listConversations({ limit: 20 }, makeCtx()) as { conversations: Array<Record<string, unknown>> };
    expect(mockListPendingApprovals).toHaveBeenCalledWith(TENANT_ID, { window: 'actionable', limit: 100 });
    expect(result.conversations.find((c) => c.title === 'Cost question')!.waitingOnHuman).toBe(true);
    expect(result.conversations.find((c) => c.title === 'Weekly spend')!.waitingOnHuman).toBe(false);
  });

  it('a queue that cannot be read leaves the MCP-run signal alone', async () => {
    seedSources();
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })                    // participants: none (T1 has no participant row)
      .mockResolvedValueOnce({ rows: [{ thread_id: T3 }] })   // waiting_on_human
      .mockResolvedValue({ rows: [] });                       // first-participant lookup for T1
    mockListPendingApprovals.mockRejectedValueOnce(new Error('runtime down'));
    const result = await listConversations({ limit: 20 }, makeCtx()) as { conversations: Array<Record<string, unknown>>; total: number };
    expect(result.conversations.find((c) => c.title === 'Weekly spend')!.waitingOnHuman).toBe(true);
    // The team thread with no participant is left out rather than shared under no team.
    expect(result.total).toBe(3);
    expect(result.conversations.map((c) => c.title)).not.toContain('Launch plan');
    expect(mockUpsertShare).not.toHaveBeenCalledWith(TENANT_ID, null, T1, ACCOUNT_ID, 'agent');
  });
});
