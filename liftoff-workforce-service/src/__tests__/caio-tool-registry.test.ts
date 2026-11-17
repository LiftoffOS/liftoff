// Regression ratchet for the CAIO tool registry.
//
// The registry was populated by a single `registerWorkforcePlanTools()` call in
// platform-backend's src/index.ts. The Phase-4 extraction moved this module into
// workforce-service and did not bring that line, so for three months
// getToolDefinitionsForRole() returned [], no `tools` array reached the model,
// and the CAIO improvised tool calls as prose while claiming writes it never
// made. Nothing failed: lint, typecheck and every unit test stayed green.
//
// These tests assert the registry is populated *without any explicit
// registration call*, which is what the accessors in tools/index.ts now
// guarantee. If somebody unwires that, this file goes red.

jest.mock('../infrastructure/config', () => ({
  loadConfig: () => ({ PLATFORM_BACKEND_URL: 'https://pb.test', WORKFORCE_SERVICE_TOKEN: 'wf-tok' }),
}));
jest.mock('../infrastructure/service-auth', () => ({
  getServiceAuthHeaders: async () => ({ 'X-Service-Auth': 'wf-tok' }),
}));
jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  REMOTE_TOOL_PERMISSIONS,
  TOOL_ACCESS_MATRIX,
  _resetRemoteWorkspaceActions,
  canRoleCallTool,
  ensureRemoteWorkspaceActions,
  getRegisteredWorkforcePlanTool,
  getRemoteWorkspaceActionsStatus,
  getToolDefinitionsForRole,
  refreshRemoteWorkspaceActions,
  registerRemoteWorkspaceActions,
  registerWorkforcePlanTools,
  startupRetriesSettled,
  toolsForRole,
} from '../workforce-plans/tools/index.js';
import { log } from '../infrastructure/logging.js';
import type { WorkforcePlanToolContext } from '../workforce-plans/tools/types.js';

// The four browser tools are the tenant runtime's names, shared with Liftoff and
// the Insights Manager so all three platform assistants offer the same browser.
// A viewer gets none of them: a session costs money for as long as it is open.
const BROWSER_TOOL_NAMES = [
  'navigate_browser_session',
  'run_browser_task',
  'start_browser_session',
  'read_active_browser_session',
];

const ALL_TOOL_NAMES = [
  ...BROWSER_TOOL_NAMES,
  'workforce_plan__draft',
  'workforce_plan__commit',
  'workforce_plan__approve',
  'org__get_existing_structure',
  'connectors__list_available',
  'agent_templates__list',
  'agent_templates__get',
  // Owner/admin only: it reads another conversation's content and exists to
  // feed plan drafting, so it follows workforce_plan__draft's row.
  'source_conversation__read',
  // Owner/admin only: the other end of the same pairing, the opening move of
  // plan drafting.
  'preview_with_liftoff',
  // Owner/admin only, like source_conversation__read: they read conversation
  // content to feed plan drafting.
  'conversations__list',
  'conversation__read',
  // Searching those same conversations by words, narrowed to this person's turns.
  'recall_conversations',
  // Owner/admin only, same reasoning: changing an existing team.
  'team__get_config',
  'team__propose_update',
  'memory_save',
  'memory_retrieve',
  // The absorbed data-vendor capabilities: owner/admin/member (not a viewer).
  'capability_search',
  'run_capability',
  // Everyone: the colleague to bring in. Not a registered tool (the chat
  // service hands the turn over instead of dispatching it), but offered on
  // every ordinary turn.
  // Everyone: showing a file this workspace already holds, to the person
  // already in the conversation. It reads nothing new and changes nothing.
  'show_file',
  'bring_in_colleague',
];

const VIEWER_TOOL_NAMES = [
  'org__get_existing_structure',
  'connectors__list_available',
  'agent_templates__list',
  'agent_templates__get',
  'memory_retrieve',
  'show_file',
  'bring_in_colleague',
];

/** The names that run as tools; the colleague is a hand-over. */
const REGISTERED_TOOL_NAMES = ALL_TOOL_NAMES.filter((n) => n !== 'bring_in_colleague');

describe('CAIO tool registry', () => {
  it('is populated on first read, with no explicit registration call', () => {
    const names = getToolDefinitionsForRole('owner').map(d => d.name);
    expect(names.sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('gives a viewer the read-only tools only', () => {
    const names = getToolDefinitionsForRole('viewer').map(d => d.name);
    expect(names.sort()).toEqual([...VIEWER_TOOL_NAMES].sort());
  });

  it('has a registered executor for every name in the access matrix, bar the hand-over', () => {
    for (const name of Object.keys(TOOL_ACCESS_MATRIX)) {
      if (name === 'bring_in_colleague') continue;
      expect(getRegisteredWorkforcePlanTool(name)).toBeDefined();
    }
    // The colleague is never dispatched: the chat service intercepts the call.
    expect(getRegisteredWorkforcePlanTool('bring_in_colleague')).toBeUndefined();
    expect(REGISTERED_TOOL_NAMES).not.toContain('bring_in_colleague');
  });

  it('offers a hand-over everything but a colleague of its own', () => {
    const ordinary = getToolDefinitionsForRole('owner').map((d) => d.name);
    const handedOver = getToolDefinitionsForRole('owner', { handover: true }).map((d) => d.name);
    expect(ordinary).toContain('bring_in_colleague');
    expect(handedOver).toEqual(ordinary.filter((n) => n !== 'bring_in_colleague'));
    expect(toolsForRole('viewer', { handover: true })).not.toContain('bring_in_colleague');
  });

  it('lists the colleague last, as a definition the model can call by name', () => {
    const defs = getToolDefinitionsForRole('owner');
    expect(defs.at(-1)?.name).toBe('bring_in_colleague');
    expect(defs.at(-1)?.input_schema).toMatchObject({
      required: ['colleague', 'request'],
      properties: { colleague: { enum: ['insights', 'liftoff'] } },
    });
  });

  it('has an access-matrix entry for every registered tool', () => {
    // The inverse of the check above: a tool the matrix does not know about is
    // denied to every role, so it would be dead on arrival.
    for (const name of ALL_TOOL_NAMES) {
      expect(TOOL_ACCESS_MATRIX[name]).toBeDefined();
    }
    expect(toolsForRole('owner').sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('is safe to register more than once', () => {
    // buildApp() registers eagerly and the accessors register lazily, so the
    // second call has to be a no-op rather than the duplicate-name throw.
    expect(() => {
      registerWorkforcePlanTools();
      registerWorkforcePlanTools();
    }).not.toThrow();
    expect(getToolDefinitionsForRole('owner')).toHaveLength(ALL_TOOL_NAMES.length);
  });

  it('hands the model a well-formed definition for every tool', () => {
    // A definition missing description or input_schema is a 400 from the
    // provider mid-turn, which surfaces to the user as a dead conversation.
    for (const def of getToolDefinitionsForRole('owner')) {
      expect(typeof def.name).toBe('string');
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.input_schema.type).toBe('object');
      expect(def.input_schema.properties).toBeDefined();
    }
  });
});

// The workspace actions platform-backend serves, registered from its manifest
// as the CAIO's own tools. The manifest carries the role rule already applied
// (`roles`), so this side records who may call each tool without a copy of
// platform-backend's permissions table.
describe('remote workspace actions', () => {
  const fetchMock = jest.fn();
  const manifest = (tools: unknown[]) => ({ ok: true, status: 200, json: async () => ({ tools }), text: async () => '' });
  const TEAM_UPDATE = {
    definition: { name: 'team_update', description: 'change a team', input_schema: { type: 'object', properties: {} } },
    permission: 'teams:update', mutating: true, roles: ['owner', 'admin', 'member'],
  };
  const TEAM_GET = {
    definition: { name: 'team_get', description: 'read a team', input_schema: { type: 'object', properties: {} } },
    permission: null, mutating: false, roles: ['owner', 'admin', 'member', 'viewer'],
  };
  const noSleep = async () => undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    _resetRemoteWorkspaceActions();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => { _resetRemoteWorkspaceActions(); });

  it('first fetch rejects, second resolves → the tools are registered and the status is ok; the retry never blocks the start', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(manifest([TEAM_UPDATE, TEAM_GET]));
    const outcome = await registerRemoteWorkspaceActions({ sleep: noSleep, schedule: false });
    // The awaited first attempt failed; the server may listen now.
    expect(outcome).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await startupRetriesSettled()).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, opts0] = fetchMock.mock.calls[0] as [string, { signal?: AbortSignal }];
    expect(opts0.signal).toBeInstanceOf(AbortSignal);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe('https://pb.test/api/internal/workspace-actions/tools');
    expect(opts.headers['X-Service-Auth']).toBe('wf-tok');
    expect(getRegisteredWorkforcePlanTool('team_update')).toBeDefined();
    expect(getRegisteredWorkforcePlanTool('team_get')).toBeDefined();
    expect(REMOTE_TOOL_PERMISSIONS.team_update).toEqual({ permission: 'teams:update', mutating: true, roles: ['owner', 'admin', 'member'] });
    expect(getRemoteWorkspaceActionsStatus()).toMatchObject({ status: 'ok', lastError: null, toolCount: 2 });
    expect(getRemoteWorkspaceActionsStatus().lastSuccessAt).not.toBeNull();
    // The one failure logged at error.
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ error: 'ECONNREFUSED' }), expect.stringContaining('manifest fetch failed'));
    // The built-in set is untouched and the model sees both.
    const names = getToolDefinitionsForRole('owner').map(d => d.name);
    expect(names).toEqual(expect.arrayContaining([...ALL_TOOL_NAMES, 'team_update', 'team_get']));
  });

  it('denies by the manifest roles: a viewer may read but not change', async () => {
    fetchMock.mockResolvedValueOnce(manifest([TEAM_UPDATE, TEAM_GET]));
    await registerRemoteWorkspaceActions({ sleep: noSleep, schedule: false });
    expect(canRoleCallTool('team_update', 'viewer')).toBe(false);
    expect(canRoleCallTool('team_update', 'member')).toBe(true);
    expect(canRoleCallTool('team_get', 'viewer')).toBe(true);
    expect(toolsForRole('viewer')).toEqual(expect.arrayContaining(['team_get']));
    expect(toolsForRole('viewer')).not.toContain('team_update');
    expect(getToolDefinitionsForRole('viewer').map(d => d.name)).not.toContain('team_update');
  });

  it('every attempt fails → the registry is without them and the outcome is unavailable', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    const outcome = await registerRemoteWorkspaceActions({ sleep: noSleep, schedule: false });
    expect(outcome).toBe('unavailable');
    expect(await startupRetriesSettled()).toBe('unavailable');
    // One awaited attempt plus the four backed-off retries.
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(getRegisteredWorkforcePlanTool('team_update')).toBeUndefined();
    expect(canRoleCallTool('team_update', 'owner')).toBe(false);
    expect(getRemoteWorkspaceActionsStatus()).toMatchObject({ status: 'unavailable', lastError: 'down', lastSuccessAt: null });
    // The built-ins are still there.
    expect(getToolDefinitionsForRole('owner').map(d => d.name).sort()).toEqual([...ALL_TOOL_NAMES].sort());
  });

  it('a manifest that drops a tool unregisters it; one that keeps it does not throw', async () => {
    fetchMock.mockResolvedValueOnce(manifest([TEAM_UPDATE, TEAM_GET]));
    await registerRemoteWorkspaceActions({ sleep: noSleep, schedule: false });
    fetchMock.mockResolvedValueOnce(manifest([TEAM_GET]));
    expect(await refreshRemoteWorkspaceActions()).toBe('ok');
    expect(getRegisteredWorkforcePlanTool('team_update')).toBeUndefined();
    expect(REMOTE_TOOL_PERMISSIONS.team_update).toBeUndefined();
    expect(getRegisteredWorkforcePlanTool('team_get')).toBeDefined();
    fetchMock.mockResolvedValueOnce(manifest([TEAM_GET]));
    await expect(refreshRemoteWorkspaceActions()).resolves.toBe('ok');
  });

  it('a turn waits for an attempt in flight, and makes one of its own when the set is empty and the last attempt is stale', async () => {
    // In flight: the first registration attempt has not answered yet.
    let answer: (v: unknown) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const starting = registerRemoteWorkspaceActions({ sleep: noSleep, schedule: false });
    const ensured = ensureRemoteWorkspaceActions();
    // The fetch is issued after the auth headers resolve; let it be issued.
    await new Promise((r) => setImmediate(r));
    answer(manifest([TEAM_GET]));
    await starting;
    await ensured;
    expect(getRegisteredWorkforcePlanTool('team_get')).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Empty and stale: a fresh attempt.
    _resetRemoteWorkspaceActions();
    fetchMock.mockResolvedValueOnce(manifest([TEAM_GET]));
    await ensureRemoteWorkspaceActions();
    expect(getRegisteredWorkforcePlanTool('team_get')).toBeDefined();

    // Populated: nothing to do.
    await ensureRemoteWorkspaceActions();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a remote tool POSTs the dispatch as the person, with the origin, and relays the result', async () => {
    fetchMock.mockResolvedValueOnce(manifest([TEAM_UPDATE]));
    await registerRemoteWorkspaceActions({ sleep: noSleep, schedule: false });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: JSON.stringify({ preview: { a: 1 }, confirmationId: 'cfm_x' }) }), text: async () => '' });
    const ctx = {
      tenantId: 't1', accountId: 'acct-1', role: 'owner',
      origin: { via: 'mcp', client: 'claude-code', credentialId: 'key-1' },
    } as unknown as WorkforcePlanToolContext;
    const out = await getRegisteredWorkforcePlanTool('team_update')!.execute({ teamId: 'a1' }, ctx);
    expect(out).toEqual({ preview: { a: 1 }, confirmationId: 'cfm_x' });
    const [url, opts] = fetchMock.mock.calls[1] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe('https://pb.test/api/internal/workspace-actions');
    expect(opts.method).toBe('POST');
    expect(opts.headers['x-account-id']).toBe('acct-1');
    expect(opts.headers['x-tenant-role']).toBe('owner');
    expect(JSON.parse(opts.headers['x-origin'])).toEqual({ via: 'mcp', client: 'claude-code', credentialId: 'key-1' });
    expect(JSON.parse(opts.body)).toEqual({ tenantId: 't1', tool: 'team_update', input: { teamId: 'a1' } });
  });

  it('team__propose_update is a thin call to team_update: the preview and handle come back, the handle is passed on', async () => {
    fetchMock.mockResolvedValueOnce(manifest([TEAM_UPDATE]));
    await registerRemoteWorkspaceActions({ sleep: noSleep, schedule: false });
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: JSON.stringify({ preview: { before: 'a', after: 'b' }, confirmationId: 'cfm_1' }) }), text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ result: JSON.stringify({ agent: { id: 'a1' } }) }), text: async () => '' });
    const ctx = { tenantId: 't1', accountId: 'acct-1', role: 'owner' } as unknown as WorkforcePlanToolContext;
    const tool = getRegisteredWorkforcePlanTool('team__propose_update')!;
    const previewed = await tool.execute({ internalAgentId: 'a1', responsibilities: 'Reads the inbox each morning.' }, ctx);
    expect(previewed).toMatchObject({ ok: true, preview: { before: 'a', after: 'b' }, confirmationId: 'cfm_1' });
    const first = JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body);
    expect(first.input).toEqual({ teamId: 'a1', responsibilities: 'Reads the inbox each morning.' });
    const applied = await tool.execute({ internalAgentId: 'a1', responsibilities: 'Reads the inbox each morning.', confirmationId: 'cfm_1' }, ctx);
    expect(applied).toMatchObject({ ok: true, distilled: true });
    const second = JSON.parse((fetchMock.mock.calls[2] as [string, { body: string }])[1].body);
    expect(second.input).toEqual({ teamId: 'a1', responsibilities: 'Reads the inbox each morning.', confirmationId: 'cfm_1' });
  });
});
