// applyTeamUpdate — the role rule, the three distil modes, bindings and skill
// verbs, and the one property D4 states: a failed server-side distil writes
// nothing.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockGetById = jest.fn();
const mockUpdate = jest.fn();
jest.mock('../../internal-agents/service', () => ({
  internalAgentService: {
    getById: (...a: unknown[]) => mockGetById(...a),
    update: (...a: unknown[]) => mockUpdate(...a),
  },
}));

const mockDistill = jest.fn();
jest.mock('../../internal-agents/distill-service', () => ({
  distillInternalAgent: (...a: unknown[]) => mockDistill(...a),
}));

const mockGetArtifact = jest.fn();
jest.mock('../../internal-agents/distill-artifact-store', () => ({
  getDistillArtifact: (...a: unknown[]) => mockGetArtifact(...a),
}));

const mockValidateIntegrations = jest.fn(async (raw: unknown) => raw);
jest.mock('../../internal-agents/integration-validator', () => ({
  validateIntegrationsArray: (...a: unknown[]) => mockValidateIntegrations(...a),
  IntegrationValidationError: class IntegrationValidationError extends Error {
    context: unknown;
    constructor(message: string, context?: unknown) { super(message); this.context = context; }
  },
}));

jest.mock('../../internal-agents/pinned-knowledge', () => ({
  parseAndFilterPinnedKnowledge: jest.fn(async () => []),
}));
jest.mock('../../internal-agents/absorption-apply', () => ({ applyAbsorption: jest.fn(async () => undefined) }));
jest.mock('../../internal-agents/preference-aggregation', () => ({ collectRecurringPreferences: jest.fn(async () => []) }));
jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn(async () => ({ connectors: [{ type: 'google_mail', displayName: 'Gmail' }] })),
  listConnectorsForTenant: (...a: unknown[]) => mockListConnectors(...a),
}));
const mockListConnectors = jest.fn();
const mockDeleteMemory = jest.fn();
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { deleteAgentMemory: (...a: unknown[]) => mockDeleteMemory(...a) },
}));
jest.mock('../../external-agents/service', () => ({
  externalAgentService: { get: (...a: unknown[]) => mockGetCollaborator(...a) },
}));
const mockGetCollaborator = jest.fn();
jest.mock('../../shared/fire-and-forget', () => ({ fireAndForget: jest.fn() }));

// buildDistillInputFromAgent / buildUpdatePayload are the real ones, so the
// assertions below see the merged inputs the distiller is handed.
jest.mock('../../internal-agents/redistill-service', () => {
  const actual = jest.requireActual('../../internal-agents/redistill-service');
  return {
    buildDistillInputFromAgent: actual.buildDistillInputFromAgent,
    buildUpdatePayload: jest.fn((current: { integrations: unknown }, distilled: Record<string, unknown>) => ({
      systemPrompt: distilled.systemPrompt,
      integrations: current.integrations,
      skills: distilled.skills ?? [],
    })),
  };
});

import { applyTeamUpdate } from '../team-update';
import { PermissionDenied, type Actor } from '../actor';
import { logAudit } from '../../infrastructure/logging';

const TENANT = '22222222-2222-2222-2222-222222222222';
const AGENT = '55555555-5555-5555-5555-555555555555';
const ACCOUNT = '77777777-7777-7777-7777-777777777777';
const CONNECTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COLLABORATOR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PEER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function actor(role: Actor['role'], surface: Actor['surface'] = 'dashboard'): Actor {
  return { tenantId: TENANT, accountId: ACCOUNT, role, displayName: 'Alice', surface };
}

const CURRENT = {
  id: AGENT,
  tenantId: TENANT,
  role: 'Marketing',
  responsibilities: 'Write the weekly newsletter.',
  additionalContext: 'Keep it short.',
  integrations: [] as Array<{ id: string; type?: string; selectedObjects: string[] }>,
  pendingIntegrations: [] as string[],
  attachments: [] as unknown[],
  skills: [
    { id: 'sk-1', name: 'Tone', description: 'd', instruction: 'Be warm', provenance: 'distilled' },
    { id: 'sk-2', name: 'Length', description: 'd', instruction: 'Be brief', provenance: 'learned' },
  ],
  memoryScope: undefined,
  decisionRecord: undefined,
  autonomyOverride: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetById.mockResolvedValue({ ...CURRENT, skills: CURRENT.skills.map((s) => ({ ...s })) });
  mockUpdate.mockImplementation(async (_id: string, _t: string, input: Record<string, unknown>) => ({ ...CURRENT, ...input }));
  mockDistill.mockResolvedValue({ systemPrompt: 'compiled', skills: [] });
  mockValidateIntegrations.mockImplementation(async (raw: unknown) => raw);
});

describe('applyTeamUpdate', () => {
  it('viewer → PermissionDenied (403) before anything is read', async () => {
    await expect(applyTeamUpdate(actor('viewer'), AGENT, { responsibilities: 'x' }, { distill: 'none' }))
      .rejects.toBeInstanceOf(PermissionDenied);
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('member → ok: writes the patch with source manual and audits under the person and surface', async () => {
    const result = await applyTeamUpdate(actor('member', 'liftoff'), AGENT, { responsibilities: 'New text' }, { distill: 'none' });
    expect('agent' in result).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith(AGENT, TENANT, expect.objectContaining({ responsibilities: 'New text', pinnedKnowledgeIds: [] }), ACCOUNT, 'manual');
    expect(logAudit).toHaveBeenCalledWith(
      'internal_agent.updated',
      { tenantId: TENANT, userId: ACCOUNT, operation: 'liftoff' },
      expect.objectContaining({ internalAgentId: AGENT, surface: 'liftoff' }),
    );
  });

  it("distill:'server' calls distillInternalAgent with the merged inputs and writes with source distill", async () => {
    const result = await applyTeamUpdate(
      actor('admin', 'caio'),
      AGENT,
      { responsibilities: 'Write the DAILY newsletter.', messagingNickname: 'News' },
      { distill: 'server' },
    );
    expect('agent' in result).toBe(true);
    // The distiller sees the patch projected onto the stored agent.
    expect(mockDistill).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      agentId: AGENT,
      role: 'Marketing',
      responsibilities: 'Write the DAILY newsletter.',
      additionalContext: 'Keep it short.',
    }));
    // One version, source 'distill', carrying the patched prose, the
    // distiller's output and the non-primary field from the patch.
    expect(mockUpdate).toHaveBeenCalledWith(
      AGENT, TENANT,
      expect.objectContaining({ responsibilities: 'Write the DAILY newsletter.', systemPrompt: 'compiled', messagingNickname: 'News' }),
      ACCOUNT, 'distill',
    );
  });

  it('distil throw → refused distill_failed and nothing written', async () => {
    mockDistill.mockRejectedValueOnce(new Error('graph did not converge'));
    const result = await applyTeamUpdate(actor('member'), AGENT, { responsibilities: 'x' }, { distill: 'server' });
    expect(result).toEqual({ refused: 'distill_failed', message: 'graph did not converge' });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockDeleteMemory).not.toHaveBeenCalled();
  });

  it("distill:'client' redeems the artifact and refuses an expired handle without writing", async () => {
    mockGetArtifact.mockResolvedValueOnce(null);
    const expired = await applyTeamUpdate(
      actor('member'), AGENT, { responsibilities: 'x', distillId: '99999999-9999-4999-8999-999999999999' }, { distill: 'client' },
    );
    expect(expired).toMatchObject({ refused: 'validation' });
    expect(mockUpdate).not.toHaveBeenCalled();

    mockGetArtifact.mockResolvedValueOnce({ systemPrompt: 'from artifact', userInstructions: 'u', instructionsMd: 'm', skills: [], capabilityTier: 'connector_only', resultRules: [] });
    const ok = await applyTeamUpdate(
      actor('member'), AGENT, { responsibilities: 'x', distillId: '99999999-9999-4999-8999-999999999999' }, { distill: 'client' },
    );
    expect('agent' in ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith(AGENT, TENANT, expect.objectContaining({ systemPrompt: 'from artifact' }), ACCOUNT, 'distill');
  });

  it('bindings: one connected type, one unconnected type, one collaborator, one peer → integrations + pendingIntegrations, and the distiller sees them', async () => {
    mockListConnectors.mockResolvedValue([
      { id: CONNECTOR, type: 'google_mail', status: 'active' },
      { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', type: 'google_mail', status: 'active' },
    ]);
    mockGetCollaborator.mockResolvedValue({ id: COLLABORATOR });
    mockGetById.mockImplementation(async (id: string) => (id === PEER ? { id: PEER, role: 'Support' } : { ...CURRENT }));

    await applyTeamUpdate(actor('member'), AGENT, {
      bindings: [
        { kind: 'connector', type: 'google_mail', selectedObjects: ['inbox'] },
        { kind: 'connector', type: 'slack' },
        { kind: 'collaborator', id: COLLABORATOR },
        { kind: 'team', id: PEER },
      ],
    }, { distill: 'server' });

    const expectedIntegrations = [
      { id: CONNECTOR, type: 'google_mail', selectedObjects: ['inbox'] },
      { id: COLLABORATOR, type: 'external_agent', selectedObjects: [] },
      { id: PEER, type: 'internal_agent', selectedObjects: [] },
    ];
    expect(mockDistill).toHaveBeenCalledWith(expect.objectContaining({
      integrations: [
        expect.objectContaining({ id: CONNECTOR, type: 'google_mail', name: 'Gmail', selectedObjects: ['inbox'] }),
        expect.objectContaining({ id: COLLABORATOR, type: 'external_agent' }),
        expect.objectContaining({ id: PEER, type: 'internal_agent' }),
      ],
    }));
    expect(mockUpdate).toHaveBeenCalledWith(
      AGENT, TENANT,
      expect.objectContaining({ integrations: expectedIntegrations, pendingIntegrations: ['slack'] }),
      ACCOUNT, 'distill',
    );
    expect(mockValidateIntegrations).toHaveBeenCalledWith(expectedIntegrations, { tenantId: TENANT, agentId: AGENT });
  });

  it('skill verbs: an instruction change and a preserve hand the skill to the operator; archive/restore toggle', async () => {
    await applyTeamUpdate(actor('member'), AGENT, {
      skillEdits: [
        { id: 'sk-1', instruction: 'Be warm and direct' },
        { id: 'sk-2', preserve: true, archive: true },
      ],
    }, { distill: 'none' });
    const written = (mockUpdate.mock.calls[0][2] as { skills: Array<Record<string, unknown>> }).skills;
    expect(written).toEqual([
      expect.objectContaining({ id: 'sk-1', instruction: 'Be warm and direct', provenance: 'operator' }),
      expect.objectContaining({ id: 'sk-2', instruction: 'Be brief', provenance: 'operator', archived: true }),
    ]);

    mockUpdate.mockClear();
    await applyTeamUpdate(actor('member'), AGENT, { skillEdits: [{ id: 'sk-2', restore: true }] }, { distill: 'none' });
    const restored = (mockUpdate.mock.calls[0][2] as { skills: Array<Record<string, unknown>> }).skills;
    expect(restored[1]).toEqual(expect.objectContaining({ id: 'sk-2', archived: false }));
  });

  it('memory deletions run only after a successful save; a 404 counts as done; the rest are reported', async () => {
    mockDeleteMemory
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('HTTP 404 from tenant runtime memories/delete'))
      .mockRejectedValueOnce(new Error('HTTP 503 from tenant runtime memories/delete'));
    const result = await applyTeamUpdate(actor('member'), AGENT, {
      responsibilities: 'x',
      memoryDeletions: ['m-1', 'm-2', 'm-3'],
    }, { distill: 'none' });
    expect(mockUpdate).toHaveBeenCalled();
    expect(mockDeleteMemory).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ memoryDeletionsFailed: ['m-3'] });
  });

  it('maps a nickname conflict and a tampered workflow to typed refusals', async () => {
    mockUpdate.mockRejectedValueOnce(Object.assign(new Error('taken'), { code: 'NICKNAME_CONFLICT' }));
    expect(await applyTeamUpdate(actor('member'), AGENT, { messagingNickname: 'x' }, { distill: 'none' }))
      .toEqual({ refused: 'nickname_conflict', message: 'taken' });
    mockUpdate.mockRejectedValueOnce(Object.assign(new Error('tampered'), { code: 'WORKFLOW_TAMPERED' }));
    expect(await applyTeamUpdate(actor('member'), AGENT, { messagingNickname: 'x' }, { distill: 'none' }))
      .toEqual({ refused: 'workflow_tampered', message: 'tampered' });
  });

  it('unknown team → not_found', async () => {
    mockGetById.mockResolvedValueOnce(null);
    expect(await applyTeamUpdate(actor('member'), AGENT, { responsibilities: 'x' }, { distill: 'none' }))
      .toEqual({ refused: 'not_found', message: 'agent not found' });
  });
});
