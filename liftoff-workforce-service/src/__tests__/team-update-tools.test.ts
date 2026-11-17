// team__get_config + team__propose_update — kept for one release as thin
// calls to the workspace actions team_get / team_update that platform-backend
// serves and remote-workspace-actions.ts registers.
//
// What matters: the read returns the real stored text (never a paraphrase)
// through team_get, companion schedules included; the write applies the
// person's edits to that stored text exactly once (nothing outside the quoted
// text moves), sends ONLY prose fields as the person the CAIO speaks for
// (caller headers, origin included), relays team_update's preview and handle
// as they are, passes the handle on once the person confirms, and relays the
// platform's refusals honestly — a rebuild that did not go through changed
// nothing and must not read as success. When the workspace actions are not
// registered, both say so rather than pretending.

jest.mock('../infrastructure/config', () => ({
  loadConfig: () => ({ PLATFORM_BACKEND_URL: 'http://localhost:3000', WORKFORCE_SERVICE_TOKEN: 'test-service-auth' }),
}));
jest.mock('../infrastructure/service-auth', () => ({
  getServiceAuthHeaders: async () => ({ 'X-Service-Auth': 'test-service-auth' }),
}));
jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { teamGetConfigTool } from '../workforce-plans/tools/team-get-config.js';
import { teamProposeUpdateTool } from '../workforce-plans/tools/team-propose-update.js';
import { _resetRemoteWorkspaceActions, refreshRemoteWorkspaceActions } from '../workforce-plans/tools/remote-workspace-actions.js';
import { getRegisteredWorkforcePlanTool } from '../workforce-plans/tools/dispatcher.js';
import type { WorkforcePlanToolContext } from '../workforce-plans/tools/types.js';

const AGENT = 'agent-123';

const mockCtx: WorkforcePlanToolContext = {
  tenantId: 'tenant-123',
  accountId: 'account-123',
  role: 'owner',
};

const MANIFEST = {
  tools: [
    { definition: { name: 'team_get', description: 'read', input_schema: { type: 'object', properties: {} } }, permission: null, mutating: false, roles: ['owner', 'admin', 'member', 'viewer'] },
    { definition: { name: 'team_update', description: 'change', input_schema: { type: 'object', properties: {} } }, permission: 'teams:update', mutating: true, roles: ['owner', 'admin', 'member'] },
  ],
};

function dispatchResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => ({ result: JSON.stringify(payload) }), text: async () => '' } as unknown as Response;
}

describe('team update tools', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(async () => {
    _resetRemoteWorkspaceActions();
    fetchSpy = jest.spyOn(global, 'fetch');
    fetchSpy.mockResolvedValueOnce({ ok: true, status: 200, json: async () => MANIFEST, text: async () => '' } as unknown as Response);
    await refreshRemoteWorkspaceActions();
    fetchSpy.mockClear();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    _resetRemoteWorkspaceActions();
  });

  // A read waits seconds; a mutating action can rebuild a team and waits as
  // long as a rebuild can take. A shorter wait can time out a confirm while
  // the rebuild is still finishing, and the Chief AI Officer then tells the
  // person nothing changed about a team already on its new version.
  it('waits a rebuild\'s time for a mutating action and a read\'s time for a read', async () => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    fetchSpy.mockResolvedValueOnce(dispatchResponse({ updated: true }));
    await getRegisteredWorkforcePlanTool('team_update')!.execute({ teamId: AGENT, confirmationId: 'c1' }, mockCtx);
    expect(timeoutSpy).toHaveBeenLastCalledWith(600_000);
    fetchSpy.mockResolvedValueOnce(dispatchResponse({ id: AGENT }));
    await getRegisteredWorkforcePlanTool('team_get')!.execute({ teamId: AGENT }, mockCtx);
    expect(timeoutSpy).toHaveBeenLastCalledWith(120_000);
    timeoutSpy.mockRestore();
  });

  it('get_config returns the stored prose and trigger summary through team_get', async () => {
    fetchSpy.mockResolvedValueOnce(dispatchResponse({
      id: AGENT, name: 'Weekly Vendor Chase', role: 'Weekly Vendor Chase', status: 'draft',
      responsibilities: 'Chase overdue invoices every Monday at 9am.',
      additionalContext: 'Never send the chase emails.',
      trigger: { type: 'cron', cronExpr: '0 9 * * 1', timezone: 'UTC', companions: [{ label: 'Friday recap', cronExpr: '0 16 * * 5' }] },
    }));

    const result = await teamGetConfigTool.execute({ internalAgentId: AGENT }, mockCtx) as {
      found: true; responsibilities: string; trigger: { cronExpr: string; companions: Array<{ label: string | null; cronExpr: string | null }> };
    };
    expect(result.trigger.companions).toEqual([{ label: 'Friday recap', cronExpr: '0 16 * * 5' }]);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/internal/workspace-actions');
    expect(JSON.parse(init.body as string)).toEqual({ tenantId: 'tenant-123', tool: 'team_get', input: { teamId: AGENT } });
    expect(result.found).toBe(true);
    expect(result.responsibilities).toBe('Chase overdue invoices every Monday at 9am.');
    expect(result.trigger.cronExpr).toBe('0 9 * * 1');
  });

  it('get_config treats not_found as an ordinary miss', async () => {
    fetchSpy.mockResolvedValueOnce(dispatchResponse({ refused: true, reason: 'not_found', message: 'No team by that id or name in this workspace.' }));
    const result = await teamGetConfigTool.execute({ internalAgentId: AGENT }, mockCtx) as { found: false };
    expect(result.found).toBe(false);
  });

  it('propose_update sends only the prose fields it was given, as the person, and relays the preview and handle', async () => {
    fetchSpy.mockResolvedValueOnce(dispatchResponse({ preview: { before: {}, after: {} }, confirmationId: 'cfm_abc' }));

    const result = await teamProposeUpdateTool.execute(
      { internalAgentId: AGENT, additionalContext: 'Run on Tuesdays at 9am instead.' },
      { ...mockCtx, origin: { via: 'mcp', client: 'Claude Code', credentialId: 'anchor-1' } },
    ) as { ok: true; preview: unknown; confirmationId: string };

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/api/internal/workspace-actions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      tenantId: 'tenant-123', tool: 'team_update',
      input: { teamId: AGENT, additionalContext: 'Run on Tuesdays at 9am instead.' },
    });
    const headers = init.headers as Record<string, string>;
    expect(headers['x-account-id']).toBe('account-123');
    expect(headers['x-tenant-role']).toBe('owner');
    expect(headers['X-Service-Auth']).toBe('test-service-auth');
    expect(JSON.parse(headers['x-origin'])).toEqual({ via: 'mcp', client: 'Claude Code', credentialId: 'anchor-1' });
    expect(result).toMatchObject({ ok: true, preview: { before: {}, after: {} }, confirmationId: 'cfm_abc' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('propose_update with the handle applies the change and reports it distilled', async () => {
    fetchSpy.mockResolvedValueOnce(dispatchResponse({ agent: { id: AGENT } }));
    const result = await teamProposeUpdateTool.execute(
      { internalAgentId: AGENT, additionalContext: 'Run on Tuesdays at 9am instead.', confirmationId: 'cfm_abc' },
      mockCtx,
    ) as { ok: true; distilled: true };
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).input).toEqual({
      teamId: AGENT, additionalContext: 'Run on Tuesdays at 9am instead.', confirmationId: 'cfm_abc',
    });
    expect(result.ok).toBe(true);
    expect(result.distilled).toBe(true);
  });

  it('propose_update refuses an empty edit before touching the platform', async () => {
    const result = await teamProposeUpdateTool.execute({ internalAgentId: AGENT }, mockCtx) as {
      ok: false; error: string;
    };
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The change the person confirmed is a before and an after; that is what
  // gets applied, to the stored text read through team_get, and nothing else
  // moves. The edited text is what goes to team_update.
  it('propose_update applies edits to the stored prose and sends the result to team_update', async () => {
    fetchSpy
      .mockResolvedValueOnce(dispatchResponse({
        id: AGENT, role: 'Watch', status: 'active',
        responsibilities: '1. Open https://old.example/login and read the banner.\n2. Pull the posts.\n## Outcomes\nA digest every Monday.',
        additionalContext: 'Never store a password.',
        trigger: null,
      }))
      .mockResolvedValueOnce(dispatchResponse({ preview: { changes: {} }, confirmationId: 'cfm_e' }));
    const out = await teamProposeUpdateTool.execute({
      internalAgentId: AGENT,
      edits: [
        { field: 'responsibilities', current: 'Open https://old.example/login and read the banner.', replacement: 'Open https://new.example/profile and record the user name shown.' },
      ],
    }, mockCtx);
    expect(out).toMatchObject({ ok: true, confirmationId: 'cfm_e' });
    const read = JSON.parse((fetchSpy.mock.calls[0] as [string, { body: string }])[1].body);
    expect(read).toEqual({ tenantId: 'tenant-123', tool: 'team_get', input: { teamId: AGENT } });
    const update = JSON.parse((fetchSpy.mock.calls[1] as [string, { body: string }])[1].body);
    expect(update).toEqual({
      tenantId: 'tenant-123', tool: 'team_update',
      input: { teamId: AGENT, responsibilities: '1. Open https://new.example/profile and record the user name shown.\n2. Pull the posts.\n## Outcomes\nA digest every Monday.' },
    });
  });

  it('propose_update refuses an edit whose current text the stored prose does not carry, or carries twice', async () => {
    const stored = { id: AGENT, role: 'Watch', status: 'active', responsibilities: 'Pull the posts. Pull the posts.', additionalContext: null, trigger: null };
    fetchSpy.mockResolvedValue(dispatchResponse(stored));
    const missing = await teamProposeUpdateTool.execute({
      internalAgentId: AGENT,
      edits: [{ field: 'responsibilities', current: 'Pull the tweets.', replacement: 'x' }],
    }, mockCtx);
    expect(missing).toMatchObject({ ok: false });
    expect((missing as { error: string }).error).toContain('does not contain the current text');
    const twice = await teamProposeUpdateTool.execute({
      internalAgentId: AGENT,
      edits: [{ field: 'responsibilities', current: 'Pull the posts.', replacement: 'x' }],
    }, mockCtx);
    expect((twice as { error: string }).error).toContain('occurs more than once');
    // Nothing was sent to team_update either time: only the reads happened.
    expect(fetchSpy.mock.calls.every(([, init]) => JSON.parse((init as { body: string }).body).tool === 'team_get')).toBe(true);
  });

  it('propose_update relays a failed rebuild as nothing changed, and a stale handle as a fresh preview', async () => {
    fetchSpy.mockResolvedValueOnce(dispatchResponse({ refused: true, reason: 'distill_failed', message: 'The team could not be rebuilt from the new text.' }));
    const result = await teamProposeUpdateTool.execute(
      { internalAgentId: AGENT, additionalContext: 'x', confirmationId: 'cfm_abc' },
      mockCtx,
    ) as { ok: false; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/nothing was changed/i);

    fetchSpy.mockResolvedValueOnce(dispatchResponse({ refused: true, reason: 'confirmation_expired', message: 'That confirmation has expired.' }));
    const stale = await teamProposeUpdateTool.execute(
      { internalAgentId: AGENT, additionalContext: 'x', confirmationId: 'cfm_old' },
      mockCtx,
    ) as { ok: false; error: string };
    expect(stale.error).toMatch(/expired.*without confirmationId/i);
  });

  it('both say so when the workspace actions are not registered', async () => {
    _resetRemoteWorkspaceActions();
    await expect(teamGetConfigTool.execute({ internalAgentId: AGENT }, mockCtx)).rejects.toThrow(/not available/);
    const result = await teamProposeUpdateTool.execute({ internalAgentId: AGENT, additionalContext: 'x' }, mockCtx) as { ok: false; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not be reached/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
