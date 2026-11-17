// The tool adapters over the team, collaborator and connection functions:
// every write carries its permission and is preview → confirm; a team is
// addressed by id or by name; a function's refusal reaches the model as a
// typed refusal, from the preview and from the execution alike; the
// previews show what changes without the ids the model must not see.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockAgents = { getById: jest.fn() };
jest.mock('../../internal-agents/service', () => ({ internalAgentService: mockAgents }));
const mockListAiWorkforce = jest.fn();
jest.mock('../teams', () => {
  const actual = jest.requireActual('../teams');
  return { ...actual, listAiWorkforce: (...a: unknown[]) => mockListAiWorkforce(...a) };
});
const mockApplyTeamUpdate = jest.fn();
jest.mock('../team-update', () => ({
  applyTeamUpdate: (...a: unknown[]) => mockApplyTeamUpdate(...a),
  isTeamUpdateRefusal: (r: { refused?: string }) => 'refused' in r,
}));
const mockSetTeamStatus = jest.fn();
jest.mock('../team-status', () => ({ setTeamStatus: (...a: unknown[]) => mockSetTeamStatus(...a) }));
const mockArchiveTeam = jest.fn();
jest.mock('../team-archive', () => ({ archiveTeam: (...a: unknown[]) => mockArchiveTeam(...a) }));
jest.mock('../team-memory', () => ({ listMemories: jest.fn(), deleteMemory: jest.fn(), updateMemory: jest.fn(), listSkills: jest.fn() }));
jest.mock('../team-webhook', () => ({
  getWebhook: jest.fn(), setWebhook: jest.fn(), webhookDeliveries: jest.fn(),
  webhookPatchSchema: jest.requireActual('zod').z.object({ enabled: jest.requireActual('zod').z.boolean().optional() }),
}));
jest.mock('../team-rollback', () => ({ rollbackTeam: jest.fn(), rollbackCollaborator: jest.fn() }));

const mockCollab = {
  getCollaborator: jest.fn(), connectCollaborator: jest.fn(), updateCollaborator: jest.fn(), setCollaboratorStatus: jest.fn(),
  rediscoverCollaborator: jest.fn(), setCollaboratorEndpoint: jest.fn(), archiveCollaborator: jest.fn(),
};
jest.mock('../collaborator', () => {
  const actual = jest.requireActual('../collaborator');
  return { ...actual, ...Object.fromEntries(Object.entries(mockCollab).map(([k, fn]) => [k, (...a: unknown[]) => (fn as jest.Mock)(...a)])) };
});
const mockWire = { wireCollaboration: jest.fn(), unwireCollaboration: jest.fn() };
jest.mock('../collaboration', () => ({
  wireCollaboration: (...a: unknown[]) => mockWire.wireCollaboration(...a),
  unwireCollaboration: (...a: unknown[]) => mockWire.unwireCollaboration(...a),
}));

const mockConn = {
  listConnections: jest.fn(), previewConnect: jest.fn(), startConnect: jest.fn(), verifyConnect: jest.fn(),
  previewDisconnect: jest.fn(), disconnect: jest.fn(), customMcpConnect: jest.fn(), customMcpUpdate: jest.fn(),
  customMcpDelete: jest.fn(), customMcpTools: jest.fn(), customMcpRediscover: jest.fn(), tunnelsState: jest.fn(),
};
jest.mock('../connections', () => Object.fromEntries(Object.entries(mockConn).map(([k, fn]) => [k, (...a: unknown[]) => (fn as jest.Mock)(...a)])));

import { PreviewRefused } from '../tools/types';
import { teamTools } from '../tools/team';
import { collaboratorTools } from '../tools/collaborator';
import { connectionsTools } from '../tools/connections';
import type { Actor } from '../actor';
import type { WorkspaceActionTool } from '../tools/types';

const TENANT = '22222222-2222-2222-2222-222222222222';
const TEAM = 'a0000000-0000-0000-0000-000000000001';
const actor: Actor = { tenantId: TENANT, accountId: 'acct-1', role: 'admin', displayName: 'Ada', surface: 'liftoff' };
const team = {
  id: TEAM, role: 'Marketing', messagingNickname: 'Marketing Team', status: 'draft', responsibilities: 'r', additionalContext: 'a', summary: 's',
  integrations: [{ id: 'gm-1', type: 'google_mail', selectedObjects: [] }], pendingIntegrations: [], attachments: [], skills: [],
  autonomyOverride: null, aiVendorOverride: null, triggerConfig: { type: 'cron', cronExpr: '0 9 * * 1', timezone: 'UTC', companionCrons: [{ label: 'recap', cronExpr: '0 16 * * 5' }] }, currentVersion: 3,
};
const byName = (tools: WorkspaceActionTool[]) => new Map(tools.map((t) => [t.definition.name, t]));
const TEAM_TOOLS = byName(teamTools);
const COLLAB_TOOLS = byName(collaboratorTools);
const CONN_TOOLS = byName(connectionsTools);

beforeEach(() => {
  jest.clearAllMocks();
  mockAgents.getById.mockImplementation(async (id: string) => (id === TEAM ? team : null));
  mockListAiWorkforce.mockResolvedValue({ teams: [team], collaborators: [] });
});

describe('the registries', () => {
  it('every write names its permission, is preview → confirm, and takes a confirmationId', () => {
    for (const tool of [...teamTools, ...collaboratorTools, ...connectionsTools]) {
      if (!tool.mutating) continue;
      expect(tool.permission).not.toBeNull();
      expect(tool.definition.input_schema.properties?.confirmationId).toBeDefined();
    }
    expect(TEAM_TOOLS.get('team_update')?.permission).toBe('teams:update');
    expect(TEAM_TOOLS.get('team_status')?.permission).toBe('teams:status');
    expect(TEAM_TOOLS.get('team_archive')?.permission).toBe('teams:delete');
    expect(COLLAB_TOOLS.get('collaborator_connect')?.permission).toBe('collaborators:update');
    expect(CONN_TOOLS.get('connection_start')?.permission).toBe('connections:manage');
    for (const name of ['team_get', 'team_memories', 'team_skills', 'team_webhook_get', 'connections_list', 'custom_mcp_tools', 'tunnels_state']) {
      expect(byName([...teamTools, ...collaboratorTools, ...connectionsTools]).get(name)?.permission).toBeNull();
    }
    // Every collaborator tool, the read included, is owner/admin (plan §4.4).
    for (const tool of collaboratorTools) expect(tool.permission).toBe('collaborators:update');
  });
});

describe('team tools', () => {
  it('team_get by id or by name, with bindings ids, the schedule and its companions', async () => {
    const byId = await TEAM_TOOLS.get('team_get')!.execute({ teamId: TEAM }, actor) as Record<string, unknown>;
    expect(byId).toMatchObject({ id: TEAM, name: 'Marketing Team', bindings: [{ id: 'gm-1', type: 'google_mail' }], trigger: { cronExpr: '0 9 * * 1', companions: [{ label: 'recap', cronExpr: '0 16 * * 5' }] } });
    const byNameResult = await TEAM_TOOLS.get('team_get')!.execute({ team: 'marketing team' }, actor) as Record<string, unknown>;
    expect(byNameResult.id).toBe(TEAM);
    expect(await TEAM_TOOLS.get('team_get')!.execute({ team: 'nobody' }, actor)).toMatchObject({ refused: true, reason: 'not_found' });
  });

  it('team_update: the preview shows before/after per field; the execution runs the server distil and relays refusals', async () => {
    const tool = TEAM_TOOLS.get('team_update')!;
    const preview = await tool.preview!({ teamId: TEAM, responsibilities: 'new r', bindings: [{ kind: 'connector', type: 'slack' }] }, actor) as Record<string, unknown>;
    expect(preview).toMatchObject({ team: { id: TEAM, name: 'Marketing Team' }, changes: { responsibilities: { before: 'r', after: 'new r' } } });
    await expect(tool.preview!({ team: 'nobody', responsibilities: 'x' }, actor)).rejects.toBeInstanceOf(PreviewRefused);
    await expect(tool.preview!({ teamId: TEAM, temperature: 9 }, actor)).rejects.toMatchObject({ reason: 'validation' });

    mockApplyTeamUpdate.mockResolvedValueOnce({ agent: { ...team, responsibilities: 'new r' }, memoryDeletionsFailed: ['m9'] });
    const applied = await tool.execute({ teamId: TEAM, responsibilities: 'new r', memoryDeletions: ['m9'] }, actor) as Record<string, unknown>;
    expect(mockApplyTeamUpdate).toHaveBeenCalledWith(actor, TEAM, { responsibilities: 'new r', memoryDeletions: ['m9'] }, { distill: 'server' });
    expect(applied).toMatchObject({ updated: true, team: { responsibilities: 'new r' }, memoryDeletionsFailed: ['m9'] });

    mockApplyTeamUpdate.mockResolvedValueOnce({ refused: 'distill_failed', message: 'no converge' });
    expect(await tool.execute({ teamId: TEAM, responsibilities: 'x' }, actor)).toEqual({ refused: true, reason: 'distill_failed', message: 'no converge' });
  });

  // A rebuild re-runs the distiller, which writes a fresh distilled slice and a
  // new version, and costs a model call. It is warranted when the text the AI
  // team is built from changed, and not when a dropdown did — the Update Team
  // page draws the same line by sending a distill handle only in the first case,
  // so a change made here and the same change made there must land alike.
  it('team_update rebuilds only when a distiller input changed, and the preview says which it is', async () => {
    const tool = TEAM_TOOLS.get('team_update')!;
    const team_ = { agent: team };

    for (const patch of [
      { aiVendorOverride: 'anthropic' },
      { messagingNickname: 'mktg' },
      { autonomyOverride: 'controlled' },
      { temperature: 0.5 },
      { memoryDeletions: ['m1'] },
    ]) {
      mockApplyTeamUpdate.mockResolvedValueOnce(team_);
      await tool.execute({ teamId: TEAM, ...patch }, actor);
      expect(mockApplyTeamUpdate).toHaveBeenLastCalledWith(actor, TEAM, patch, { distill: 'none' });
      const preview = await tool.preview!({ teamId: TEAM, ...patch }, actor) as { note: string };
      expect(preview.note).toMatch(/not rebuilt/);
    }

    for (const patch of [
      { role: 'new role' },
      { responsibilities: 'new r' },
      { additionalContext: 'more' },
      { bindings: [{ kind: 'connector', type: 'slack' }] },
    ]) {
      mockApplyTeamUpdate.mockResolvedValueOnce(team_);
      await tool.execute({ teamId: TEAM, ...patch }, actor);
      expect(mockApplyTeamUpdate).toHaveBeenLastCalledWith(actor, TEAM, patch, { distill: 'server' });
      const preview = await tool.preview!({ teamId: TEAM, ...patch }, actor) as { note: string };
      expect(preview.note).toMatch(/rebuilt from the new text/);
    }

    // A patch carrying both takes the rebuild: the text did change.
    mockApplyTeamUpdate.mockResolvedValueOnce(team_);
    await tool.execute({ teamId: TEAM, role: 'r', aiVendorOverride: 'openai' }, actor);
    expect(mockApplyTeamUpdate).toHaveBeenLastCalledWith(actor, TEAM, { role: 'r', aiVendorOverride: 'openai' }, { distill: 'server' });
  });

  it('team_status and team_archive: preview names the transition; execution relays the function\'s refusal with its context', async () => {
    const status = TEAM_TOOLS.get('team_status')!;
    expect(await status.preview!({ team: 'Marketing Team', status: 'active' }, actor)).toEqual({ team: { id: TEAM, name: 'Marketing Team' }, from: 'draft', to: 'active' });
    mockSetTeamStatus.mockResolvedValueOnce({ refused: 'payment_required', message: 'needs an active plan', context: { reason: 'needs an active plan' } });
    expect(await status.execute({ teamId: TEAM, status: 'active' }, actor)).toEqual({ refused: true, reason: 'payment_required', message: 'needs an active plan', context: { reason: 'needs an active plan' } });
    mockSetTeamStatus.mockResolvedValueOnce({ refused: 'rate_limited', message: 'Too many activation requests, please try again later' });
    expect(await status.execute({ teamId: TEAM, status: 'active' }, actor)).toMatchObject({ refused: true, reason: 'rate_limited' });
    expect(await status.execute({ teamId: TEAM, status: 'running' }, actor)).toMatchObject({ refused: true, reason: 'validation' });
    mockSetTeamStatus.mockResolvedValueOnce({ agent: { ...team, status: 'paused' } });
    expect(await status.execute({ teamId: TEAM, status: 'paused' }, actor)).toEqual({ updated: true, team: { id: TEAM, name: 'Marketing Team', status: 'paused' } });

    const archive = TEAM_TOOLS.get('team_archive')!;
    expect(await archive.preview!({ teamId: TEAM }, actor)).toEqual({ team: { id: TEAM, name: 'Marketing Team', status: 'draft' }, action: 'archive' });
    mockArchiveTeam.mockResolvedValueOnce({ archived: true });
    expect(await archive.execute({ teamId: TEAM }, actor)).toEqual({ archived: true, team: { id: TEAM, name: 'Marketing Team' } });
    expect(mockArchiveTeam).toHaveBeenCalledWith(actor, TEAM);
  });
});

describe('collaborator tools', () => {
  it('collaborator_connect previews the request and refuses a bad mode; collaboration_wire relays partial results', async () => {
    const connect = COLLAB_TOOLS.get('collaborator_connect')!;
    await expect(connect.preview!({ name: 'x', endpointUrl: 'https://x', allowedTeamIds: [TEAM], collaborationMode: 'sideways' }, actor)).rejects.toMatchObject({ reason: 'validation' });
    mockCollab.connectCollaborator.mockResolvedValueOnce({ collaborator: { id: 'c1', name: 'x' } });
    const r = await connect.execute({ name: 'x', endpointUrl: 'https://x', allowedTeamIds: [TEAM], collaborationMode: 'request_help' }, actor) as Record<string, unknown>;
    expect(r).toMatchObject({ connected: true });
    expect(mockCollab.connectCollaborator).toHaveBeenCalledWith(actor, expect.objectContaining({ name: 'x', allowedTeamIds: [TEAM], collaborationMode: 'request_help' }));

    const wire = COLLAB_TOOLS.get('collaboration_wire')!;
    mockCollab.getCollaborator.mockResolvedValue({ collaborator: { id: 'c1', name: 'Partner', allowedInternalAgentIds: [] } });
    expect(await wire.preview!({ team: 'Marketing Team', collaboratorId: 'c1' }, actor)).toMatchObject({ team: { id: TEAM }, collaborator: { id: 'c1' } });
    mockWire.wireCollaboration.mockResolvedValueOnce({ partial: 'collaborator_side_only', retry: true, message: 'run again' });
    expect(await wire.execute({ teamId: TEAM, collaboratorId: 'c1' }, actor)).toMatchObject({ partial: 'collaborator_side_only', retry: true });
    mockWire.wireCollaboration.mockResolvedValueOnce({ refused: 'team_update_failed', message: 'no' });
    expect(await wire.execute({ teamId: TEAM, collaboratorId: 'c1' }, actor)).toEqual({ refused: true, reason: 'team_update_failed', message: 'no' });
  });

  it('collaborator_get relays not_found; collaborator_status validates the status', async () => {
    mockCollab.getCollaborator.mockResolvedValueOnce({ refused: 'not_found', message: 'External agent not found' });
    expect(await COLLAB_TOOLS.get('collaborator_get')!.execute({ id: 'c9' }, actor)).toEqual({ refused: true, reason: 'not_found', message: 'External agent not found' });
    expect(await COLLAB_TOOLS.get('collaborator_status')!.execute({ id: 'c1', status: 'asleep' }, actor)).toMatchObject({ refused: true, reason: 'validation' });
  });
});

describe('connection tools', () => {
  it('connection_start previews through previewConnect, relaying page_only with the page, and executes through startConnect', async () => {
    const tool = CONN_TOOLS.get('connection_start')!;
    mockConn.previewConnect.mockResolvedValueOnce({ refused: 'page_only', message: 'Stripe connects with a key', page: 'https://example.com/dashboard/connections' });
    await expect(tool.preview!({ connectorType: 'stripe' }, actor)).rejects.toMatchObject({ reason: 'page_only', message: expect.stringContaining('/dashboard/connections') });
    mockConn.previewConnect.mockResolvedValueOnce({ kind: 'oauth', connectorType: 'zendesk', name: 'Zendesk', subdomainRequired: { label: 'Zendesk subdomain', suffix: '.zendesk.com' } });
    expect(await tool.preview!({ connectorType: 'zendesk', subdomain: 'acme' }, actor)).toMatchObject({ kind: 'oauth', subdomain: 'acme' });
    mockConn.startConnect.mockResolvedValueOnce({ kind: 'oauth', connectorType: 'zendesk', link: 'https://v/auth', note: 'n' });
    expect(await tool.execute({ connectorType: 'zendesk', subdomain: 'acme' }, actor)).toMatchObject({ kind: 'oauth', link: 'https://v/auth' });
    expect(mockConn.startConnect).toHaveBeenCalledWith(actor, 'zendesk', expect.objectContaining({ subdomain: 'acme' }));
    mockConn.startConnect.mockResolvedValueOnce({ refused: 'validation', message: 'projectId is required' });
    expect(await tool.execute({ connectorType: 'google_bigquery' }, actor)).toEqual({ refused: true, reason: 'validation', message: 'projectId is required' });
  });

  it('connection_disconnect previews the caveat and relays not_found on execution', async () => {
    const tool = CONN_TOOLS.get('connection_disconnect')!;
    mockConn.previewDisconnect.mockResolvedValueOnce({ connector: { id: 'gh-1', type: 'github' }, githubAppCaveat: 'keeps access' });
    expect(await tool.preview!({ connectorId: 'gh-1' }, actor)).toMatchObject({ githubAppCaveat: 'keeps access' });
    mockConn.disconnect.mockResolvedValueOnce({ refused: 'not_found', message: 'No connection with that id.' });
    expect(await tool.execute({ connectorId: 'x' }, actor)).toEqual({ refused: true, reason: 'not_found', message: 'No connection with that id.' });
  });

  it('custom_mcp_tools is a read; a rediscovery is refused there and belongs to custom_mcp_rediscover', async () => {
    mockConn.customMcpTools.mockResolvedValueOnce({ server: { id: 'm1', tools: [] } });
    expect(await CONN_TOOLS.get('custom_mcp_tools')!.execute({ id: 'm1' }, actor)).toEqual({ id: 'm1', tools: [] });
    expect(await CONN_TOOLS.get('custom_mcp_tools')!.execute({ id: 'm1', rediscover: true }, actor)).toMatchObject({ refused: true, reason: 'use_custom_mcp_rediscover' });
    mockConn.customMcpTools.mockResolvedValueOnce({ server: { id: 'm1', name: 'Ops', endpointHost: 'h', tools: [{ name: 'a' }] } });
    expect(await CONN_TOOLS.get('custom_mcp_rediscover')!.preview!({ id: 'm1' }, actor)).toMatchObject({ server: { toolCount: 1 }, action: 'rediscover' });
  });
});
