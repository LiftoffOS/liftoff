// A team's memories and skills, its inbound webhook, and rollback: each read
// is any member's, each write is member and above (collaborator rollback is
// owner/admin) and audited under the person; the webhook's URL and secret
// never cross into a result; a runtime 404 is a typed refusal.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockRuntime = {
  listAgentMemories: jest.fn(),
  deleteAgentMemory: jest.fn(),
  updateAgentMemory: jest.fn(),
  getAgentSkills: jest.fn(),
};
jest.mock('../../connectors/tenant-runtime-client', () => ({ tenantRuntimeClient: mockRuntime }));

const mockAgents = { getById: jest.fn(), rollbackToVersion: jest.fn() };
jest.mock('../../internal-agents/service', () => ({ internalAgentService: mockAgents }));
const mockCollaborators = { rollback: jest.fn() };
jest.mock('../../external-agents/service', () => ({ externalAgentService: mockCollaborators }));

const mockSources = { getSourceForAgent: jest.fn(), listRecentDeliveries: jest.fn(), updateSource: jest.fn() };
jest.mock('../../event-sources/service', () => mockSources);

import { logAudit } from '../../infrastructure/logging';
import { PermissionDenied, type Actor } from '../actor';
import { deleteMemory, listMemories, listSkills, updateMemory } from '../team-memory';
import { getWebhook, setWebhook, webhookDeliveries } from '../team-webhook';
import { rollbackCollaborator, rollbackTeam } from '../team-rollback';

const TENANT = '22222222-2222-2222-2222-222222222222';
const AGENT = 'a0000000-0000-0000-0000-000000000001';
const actor = (role: Actor['role'] = 'member'): Actor => ({ tenantId: TENANT, accountId: 'acct-1', role, displayName: 'Ada', surface: 'insights' });

beforeEach(() => {
  jest.clearAllMocks();
  mockAgents.getById.mockResolvedValue({ id: AGENT, skills: [] });
});

describe('memories', () => {
  it('lists through the runtime for a team that exists', async () => {
    mockRuntime.listAgentMemories.mockResolvedValueOnce({ memories: [{ id: 'm1', content: 'x', source: 'chat', createdAt: 'now' }], nextCursor: null });
    expect(await listMemories(actor('viewer'), AGENT, { limit: 10 })).toEqual({ memories: [{ id: 'm1', content: 'x', source: 'chat', createdAt: 'now' }], nextCursor: null });
    expect(mockRuntime.listAgentMemories).toHaveBeenCalledWith(TENANT, AGENT, { limit: 10 });
    mockAgents.getById.mockResolvedValueOnce(null);
    expect(await listMemories(actor(), AGENT)).toMatchObject({ refused: 'not_found' });
  });

  it('delete and edit are member and above, audited, and a runtime 404 is not_found', async () => {
    await expect(deleteMemory(actor('viewer'), AGENT, 'm1')).rejects.toBeInstanceOf(PermissionDenied);
    mockRuntime.deleteAgentMemory.mockResolvedValueOnce(undefined);
    expect(await deleteMemory(actor(), AGENT, 'm1')).toEqual({ deleted: true });
    expect(logAudit).toHaveBeenCalledWith('internal_agent.memory_deleted', expect.objectContaining({ userId: 'acct-1', operation: 'insights' }), expect.objectContaining({ memoryId: 'm1' }));
    mockRuntime.deleteAgentMemory.mockRejectedValueOnce(new Error('HTTP 404 from runtime'));
    expect(await deleteMemory(actor(), AGENT, 'gone')).toMatchObject({ refused: 'not_found' });

    mockRuntime.updateAgentMemory.mockResolvedValueOnce({ id: 'm1', content: 'new', updatedAt: 'later' });
    expect(await updateMemory(actor(), AGENT, 'm1', 'new')).toEqual({ memory: { id: 'm1', content: 'new', updatedAt: 'later' } });
    expect(mockRuntime.updateAgentMemory).toHaveBeenCalledWith(TENANT, AGENT, 'm1', 'new');
    mockRuntime.updateAgentMemory.mockRejectedValueOnce(new Error('HTTP 500'));
    await expect(updateMemory(actor(), AGENT, 'm1', 'new')).rejects.toThrow('HTTP 500');
  });
});

describe('skills', () => {
  it('the platform column is authoritative; the runtime supplies ids and anything it runs that the column has not recorded shows as learned', async () => {
    mockAgents.getById.mockResolvedValueOnce({
      id: AGENT,
      skills: [
        { name: 'Triage', description: 'd', instruction: 'i', tags: ['t'], provenance: 'operator', protected: true, archived: false },
        { id: 's2', name: 'Old', description: 'd', instruction: 'i', archived: true },
      ],
    });
    mockRuntime.getAgentSkills.mockResolvedValueOnce({ skills: [
      { id: 'rt-1', name: 'triage', description: 'd', instruction: 'i', tags: [] },
      { id: 'rt-3', name: 'Newly learned', description: 'd', instruction: 'i', tags: [] },
    ] });
    const r = await listSkills(actor('viewer'), AGENT);
    expect(r).toEqual({ skills: [
      { id: 'rt-1', name: 'Triage', description: 'd', instruction: 'i', tags: ['t'], provenance: 'operator', protected: true, archived: false },
      { id: 's2', name: 'Old', description: 'd', instruction: 'i', tags: [], provenance: 'distilled', protected: false, archived: true },
      { id: 'rt-3', name: 'Newly learned', description: 'd', instruction: 'i', tags: [], provenance: 'learned', protected: false, archived: false },
    ] });
  });

  it('a runtime that cannot be read leaves the stored set', async () => {
    mockAgents.getById.mockResolvedValueOnce({ id: AGENT, skills: [{ id: 's1', name: 'A', description: 'd', instruction: 'i' }] });
    mockRuntime.getAgentSkills.mockRejectedValueOnce(new Error('down'));
    const r = await listSkills(actor(), AGENT) as { skills: Array<{ id?: string }> };
    expect(r.skills.map((s) => s.id)).toEqual(['s1']);
  });
});

describe('webhook', () => {
  const source = {
    id: 'src-1', enabled: true, hmacRequired: true, signingSecretHint: '••••ab12', rateLimitPerMinute: 60,
    contentFilterEnabled: true, piiHashMode: false, lastEventAt: null,
    publicUrl: 'https://hooks.example.com/in/SECRET-PATH', signingSecret: 'whsec_SECRET',
  };

  it('the settings never carry the URL or the secret', async () => {
    mockSources.getSourceForAgent.mockResolvedValueOnce(source);
    const r = await getWebhook(actor('viewer'), AGENT);
    expect(r).toEqual({ webhook: { enabled: true, hmacRequired: true, secretHint: '••••ab12', rateLimitPerMinute: 60, contentFilterEnabled: true, piiHashMode: false, lastEventAt: null } });
    expect(JSON.stringify(r)).not.toContain('SECRET');
    mockSources.getSourceForAgent.mockResolvedValueOnce(null);
    expect(await getWebhook(actor(), AGENT)).toMatchObject({ refused: 'not_provisioned' });
  });

  it('a settings change goes through the event-sources service as the person and is audited', async () => {
    await expect(setWebhook(actor('viewer'), AGENT, { enabled: false })).rejects.toBeInstanceOf(PermissionDenied);
    mockSources.getSourceForAgent.mockResolvedValueOnce(source);
    mockSources.updateSource.mockResolvedValueOnce({ ...source, enabled: false });
    const r = await setWebhook(actor(), AGENT, { enabled: false });
    expect(r).toMatchObject({ webhook: { enabled: false } });
    expect(mockSources.updateSource).toHaveBeenCalledWith({ tenantId: TENANT, sourceId: 'src-1', patch: { enabled: false }, actorUserId: 'acct-1' });
    expect(logAudit).toHaveBeenCalledWith('internal_agent.webhook_settings_updated', expect.anything(), expect.objectContaining({ sourceId: 'src-1', patch: { enabled: false } }));
  });

  it('recent deliveries are read for the team\'s source', async () => {
    mockSources.getSourceForAgent.mockResolvedValueOnce(source);
    mockSources.listRecentDeliveries.mockResolvedValueOnce([{ id: 'd1' }]);
    expect(await webhookDeliveries(actor('viewer'), AGENT, 3)).toEqual({ deliveries: [{ id: 'd1' }] });
    expect(mockSources.listRecentDeliveries).toHaveBeenCalledWith(TENANT, 'src-1', 3);
  });
});

describe('rollback', () => {
  it('a team restore is member and above and writes a new version', async () => {
    await expect(rollbackTeam(actor('viewer'), AGENT, 2)).rejects.toBeInstanceOf(PermissionDenied);
    mockAgents.rollbackToVersion.mockResolvedValueOnce({ id: AGENT, currentVersion: 5 });
    expect(await rollbackTeam(actor(), AGENT, 2)).toMatchObject({ agent: { currentVersion: 5 } });
    expect(mockAgents.rollbackToVersion).toHaveBeenCalledWith(AGENT, TENANT, 2, 'acct-1');
    expect(logAudit).toHaveBeenCalledWith('internal_agent.rollback', expect.anything(), expect.objectContaining({ targetVersion: 2, newVersion: 5 }));
    mockAgents.rollbackToVersion.mockResolvedValueOnce(null);
    expect(await rollbackTeam(actor(), AGENT, 9)).toMatchObject({ refused: 'not_found' });
  });

  it('a collaborator restore is owner/admin', async () => {
    await expect(rollbackCollaborator(actor('member'), 'c1', 1)).rejects.toBeInstanceOf(PermissionDenied);
    mockCollaborators.rollback.mockResolvedValueOnce({ id: 'c1', currentVersion: 3 });
    expect(await rollbackCollaborator(actor('admin'), 'c1', 1)).toMatchObject({ collaborator: { currentVersion: 3 } });
    expect(mockCollaborators.rollback).toHaveBeenCalledWith('c1', TENANT, 1);
    expect(logAudit).toHaveBeenCalledWith('external_agent.rollback', expect.anything(), expect.objectContaining({ resourceId: 'c1' }));
  });
});
