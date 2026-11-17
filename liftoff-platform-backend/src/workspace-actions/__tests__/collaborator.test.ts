// External agents, for the assistants: connect one with no credential
// through the same discovery the wizard runs and the wizard's default rules;
// update, pause and resume, rediscover behind the review gate, move the
// endpoint (a new version plus a rediscovery), archive. Every write is
// owner/admin and audited; every result is the view, never the endpoint URL
// in full.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockExternal = {
  get: jest.fn(), create: jest.fn(), update: jest.fn(), updateStatus: jest.fn(),
  rediscover: jest.fn(), updateEndpoint: jest.fn(), delete: jest.fn(),
};
jest.mock('../../external-agents/service', () => ({ externalAgentService: mockExternal }));
const mockAgents = { getById: jest.fn() };
jest.mock('../../internal-agents/service', () => ({ internalAgentService: mockAgents }));
const mockDiscover = jest.fn();
jest.mock('../../mcp/discovery-pipeline', () => ({ runDiscoveryPipeline: (...a: unknown[]) => mockDiscover(...a) }));
const mockAssertPublicUrl = jest.fn();
jest.mock('../../common/url-guard', () => {
  class BlockedUrlError extends Error { reason: string; constructor(reason: string) { super('blocked'); this.reason = reason; } }
  return { BlockedUrlError, assertPublicUrl: (...a: unknown[]) => mockAssertPublicUrl(...a) };
});

import { logAudit } from '../../infrastructure/logging';
import { BlockedUrlError } from '../../common/url-guard';
import { PermissionDenied, type Actor } from '../actor';
import {
  WIZARD_DEFAULT_PERMISSIONS, archiveCollaborator, connectCollaborator, getCollaborator,
  rediscoverCollaborator, setCollaboratorEndpoint, setCollaboratorStatus, updateCollaborator,
} from '../collaborator';

const TENANT = '22222222-2222-2222-2222-222222222222';
const TEAM = 'a0000000-0000-0000-0000-000000000001';
const actor = (role: Actor['role'] = 'admin'): Actor => ({ tenantId: TENANT, accountId: 'acct-1', role, displayName: 'Ada', surface: 'caio', via: 'mcp', client: 'Claude Code', credentialId: 'anchor-1' });

const collaborator = {
  id: 'c1', name: 'Billing Bot', description: 'invoices', endpointUrl: 'https://partner.example.com/mcp?token=SECRET',
  collaborationMode: 'request_help', status: 'connected', allowedInternalAgentIds: [TEAM],
  requestRules: [{ internalAgentId: TEAM, internalAgentName: 'Support', permissions: WIZARD_DEFAULT_PERMISSIONS }],
  costAmount: null, costType: null, summary: 'sums', detectedCapabilities: [{ name: 'invoice_lookup' }], capabilityChanges: [],
  currentVersion: 2, lastCheckedAt: null, lastError: null,
};
const discovered = {
  transportType: 'streamable_http', summary: 'sums', collaborationHints: [], capabilities: [{ name: 'invoice_lookup' }], resources: [],
  toolClassifications: [], rawMcpTools: [], rawMcpResources: [], correlationId: 'corr',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAgents.getById.mockImplementation(async (id: string) => (id === TEAM ? { id: TEAM, role: 'Support' } : null));
  mockAssertPublicUrl.mockResolvedValue(undefined);
  mockDiscover.mockResolvedValue(discovered);
  mockExternal.get.mockResolvedValue(collaborator);
});

describe('getCollaborator', () => {
  it('any member reads the view: the endpoint host, never the URL', async () => {
    const r = await getCollaborator(actor('viewer'), 'c1') as { collaborator: Record<string, unknown> };
    expect(r.collaborator).toMatchObject({ id: 'c1', endpointHost: 'partner.example.com', capabilities: ['invoice_lookup'], currentVersion: 2 });
    expect(JSON.stringify(r)).not.toContain('SECRET');
    mockExternal.get.mockResolvedValueOnce(null);
    expect(await getCollaborator(actor(), 'c9')).toMatchObject({ refused: 'not_found' });
  });
});

describe('connectCollaborator', () => {
  const input = { name: 'Billing Bot', endpointUrl: 'https://partner.example.com/mcp', allowedTeamIds: [TEAM], collaborationMode: 'request_help' as const };

  it('is owner/admin', async () => {
    await expect(connectCollaborator(actor('member'), input)).rejects.toBeInstanceOf(PermissionDenied);
  });

  it('runs the wizard\'s discovery with no credential, seeds the wizard\'s default rules, creates with an idempotency key, audits', async () => {
    mockExternal.create.mockResolvedValueOnce(collaborator);
    const r = await connectCollaborator(actor(), input);
    expect(r).toMatchObject({ collaborator: { id: 'c1' } });
    expect(mockAssertPublicUrl).toHaveBeenCalledWith('https://partner.example.com/mcp', expect.anything());
    expect(mockDiscover).toHaveBeenCalledWith(expect.objectContaining({ endpointUrl: 'https://partner.example.com/mcp', authType: 'none', tenantId: TENANT }), expect.any(Function));
    const [tenantId, created, idempotencyKey] = mockExternal.create.mock.calls[0];
    expect(tenantId).toBe(TENANT);
    expect(created).toMatchObject({
      name: 'Billing Bot', authType: 'none', connectionType: 'custom', collaborationMode: 'request_help',
      allowedInternalAgentIds: [TEAM],
      requestRules: [{ internalAgentId: TEAM, internalAgentName: 'Support', permissions: WIZARD_DEFAULT_PERMISSIONS }],
      capabilitySource: 'mcp_discovery', transportType: 'streamable_http',
    });
    expect(typeof idempotencyKey).toBe('string');
    expect(logAudit).toHaveBeenCalledWith('external_agent.added', expect.objectContaining({ userId: 'acct-1', operation: 'caio' }), expect.objectContaining({ resourceId: 'c1', via: 'mcp', client: 'Claude Code' }));
  });

  it('refuses a blocked URL, an unknown team, and a discovery that fails; nothing is created', async () => {
    mockAssertPublicUrl.mockRejectedValueOnce(new BlockedUrlError('private_ip'));
    expect(await connectCollaborator(actor(), input)).toMatchObject({ refused: 'validation', context: { reason: 'private_ip' } });
    expect(await connectCollaborator(actor(), { ...input, allowedTeamIds: ['a0000000-0000-0000-0000-000000000009'] })).toMatchObject({ refused: 'validation', context: { unknown: ['a0000000-0000-0000-0000-000000000009'] } });
    mockDiscover.mockRejectedValueOnce(new Error('unreachable'));
    expect(await connectCollaborator(actor(), input)).toMatchObject({ refused: 'discovery_failed', message: expect.stringContaining('unreachable') });
    expect(mockExternal.create).not.toHaveBeenCalled();
  });
});

describe('updateCollaborator, status, rediscover, endpoint, archive', () => {
  it('update validates the teams, completes the rule names, sends only what changed, audits the fields', async () => {
    mockExternal.update.mockResolvedValueOnce({ ...collaborator, name: 'Billing Bot 2' });
    const r = await updateCollaborator(actor(), 'c1', { name: 'Billing Bot 2', requestRules: [{ internalAgentId: TEAM, permissions: { ...WIZARD_DEFAULT_PERMISSIONS, draft_outputs: 'blocked' } }] });
    expect(r).toMatchObject({ collaborator: { name: 'Billing Bot 2' } });
    expect(mockExternal.update).toHaveBeenCalledWith('c1', TENANT, {
      name: 'Billing Bot 2',
      requestRules: [{ internalAgentId: TEAM, internalAgentName: 'Support', permissions: { ...WIZARD_DEFAULT_PERMISSIONS, draft_outputs: 'blocked' } }],
    });
    expect(logAudit).toHaveBeenCalledWith('external_agent.updated', expect.anything(), expect.objectContaining({ newState: { fields: ['name', 'requestRules'] } }));
    expect(await updateCollaborator(actor(), 'c1', { allowedInternalAgentIds: ['a0000000-0000-0000-0000-000000000009'] })).toMatchObject({ refused: 'validation' });
    mockExternal.update.mockResolvedValueOnce(null);
    expect(await updateCollaborator(actor(), 'c9', { name: 'x' })).toMatchObject({ refused: 'not_found' });
  });

  it('pause and resume go through updateStatus, which publishes the event', async () => {
    mockExternal.updateStatus.mockResolvedValueOnce({ ...collaborator, status: 'disconnected' });
    expect(await setCollaboratorStatus(actor(), 'c1', 'disconnected')).toMatchObject({ collaborator: { status: 'disconnected' } });
    expect(mockExternal.updateStatus).toHaveBeenCalledWith('c1', TENANT, 'disconnected');
    expect(logAudit).toHaveBeenCalledWith('external_agent.status_changed', expect.anything(), expect.objectContaining({ newState: { status: 'disconnected' } }));
    await expect(setCollaboratorStatus(actor('member'), 'c1', 'connected')).rejects.toBeInstanceOf(PermissionDenied);
  });

  it('rediscover runs the pipeline against the stored endpoint behind the review gate', async () => {
    mockExternal.rediscover.mockResolvedValueOnce({ agent: { ...collaborator, status: 'pending_review' }, changes: [{ kind: 'added', name: 'x' }], requiresReview: true });
    const r = await rediscoverCollaborator(actor(), 'c1');
    expect(r).toMatchObject({ requiresReview: true, changes: [{ kind: 'added' }], collaborator: { status: 'pending_review' } });
    expect(mockDiscover).toHaveBeenCalledWith(expect.objectContaining({ endpointUrl: collaborator.endpointUrl, agentId: 'c1' }), expect.any(Function));
    expect(mockExternal.rediscover).toHaveBeenCalledWith('c1', TENANT, expect.objectContaining({ transportType: 'streamable_http' }), { reviewPolicy: 'gate' });
    mockDiscover.mockRejectedValueOnce(new Error('timeout'));
    expect(await rediscoverCollaborator(actor(), 'c1')).toMatchObject({ refused: 'discovery_failed' });
  });

  it('moving the endpoint writes a new version, then rediscovers', async () => {
    mockExternal.updateEndpoint.mockResolvedValueOnce({ ...collaborator, endpointUrl: 'https://new.example.com/mcp' });
    mockExternal.get.mockResolvedValueOnce({ ...collaborator, endpointUrl: 'https://new.example.com/mcp' });
    mockExternal.rediscover.mockResolvedValueOnce({ agent: { ...collaborator, endpointUrl: 'https://new.example.com/mcp' }, changes: [], requiresReview: false });
    const r = await setCollaboratorEndpoint(actor(), 'c1', 'https://new.example.com/mcp');
    expect(r).toMatchObject({ collaborator: { endpointHost: 'new.example.com' }, requiresReview: false });
    expect(mockExternal.updateEndpoint).toHaveBeenCalledWith('c1', TENANT, 'https://new.example.com/mcp');
    expect(logAudit).toHaveBeenCalledWith('external_agent.endpoint_changed', expect.anything(), expect.objectContaining({ newState: { endpointHost: 'new.example.com' } }));
    mockAssertPublicUrl.mockRejectedValueOnce(new BlockedUrlError('localhost'));
    expect(await setCollaboratorEndpoint(actor(), 'c1', 'http://localhost/mcp')).toMatchObject({ refused: 'validation' });
  });

  it('archive is a soft delete, audited', async () => {
    mockExternal.delete.mockResolvedValueOnce(true);
    expect(await archiveCollaborator(actor(), 'c1')).toEqual({ archived: true });
    expect(mockExternal.delete).toHaveBeenCalledWith('c1', TENANT);
    expect(logAudit).toHaveBeenCalledWith('external_agent.removed', expect.anything(), expect.objectContaining({ resourceId: 'c1' }));
    mockExternal.delete.mockResolvedValueOnce(false);
    expect(await archiveCollaborator(actor(), 'c9')).toMatchObject({ refused: 'not_found' });
  });
});
