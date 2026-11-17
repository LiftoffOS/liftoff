// Workspace administration functions: each write is gated by the single
// role rule, goes through the service the settings page's route calls, and
// writes the same audit row under the person and their surface; the owner
// rules and the Enterprise gate are relayed as refusals, never thrown at
// the model.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockMembers = {
  listMembers: jest.fn(),
  listInvitations: jest.fn(),
  inviteMember: jest.fn(),
  getMembership: jest.fn(),
  updateMemberRole: jest.fn(),
  removeMember: jest.fn(),
};
jest.mock('../../tenant-members/service', () => {
  const actual = jest.requireActual('../../tenant-members/service');
  return { ...actual, tenantMembersService: mockMembers };
});

const mockAssignments = { listPersonnelWithAssignments: jest.fn(), updateAssignmentsForPerson: jest.fn() };
jest.mock('../../person-assignments/service', () => ({ personAssignmentsService: mockAssignments }));

const mockTenant = { getById: jest.fn(), updateName: jest.fn() };
jest.mock('../../tenants/service', () => ({ TenantService: jest.fn(() => mockTenant) }));

const mockRegistry = { getWorkspaceVendor: jest.fn(), setWorkspaceVendor: jest.fn() };
jest.mock('../../model-registry/service', () => ({ ModelRegistryService: jest.fn(() => mockRegistry) }));

const mockOversight = { getOrCreateOversightSettings: jest.fn(), updateOversightSettings: jest.fn() };
jest.mock('../../internal-agent-oversight/service', () => ({ oversightService: mockOversight }));

const mockAudit = { isEnterprise: jest.fn(), list: jest.fn() };
jest.mock('../../audit-log/service', () => ({ auditLogService: mockAudit }));

const mockKnowledge = { listItems: jest.fn(), createItem: jest.fn() };
jest.mock('../../knowledge/service', () => mockKnowledge);

import { logAudit } from '../../infrastructure/logging';
import { ConflictError, ForbiddenError, ValidationError } from '../../tenant-members/service';
import { PermissionDenied, type Actor } from '../actor';
import { setAssignments } from '../assignments';
import { changeRole, inviteMember, removeMember } from '../members';
import { readAuditLog, renameWorkspace, setAiVendor, setOversight } from '../workspace';
import { addKnowledgeUrl } from '../knowledge';
import { workspaceAdminTools } from '../tools/workspace-admin';

const TENANT = '22222222-2222-2222-2222-222222222222';
const actor = (over: Partial<Actor> = {}): Actor => ({
  tenantId: TENANT, accountId: 'acct-1', role: 'admin', displayName: 'Ada', surface: 'liftoff',
  via: 'mcp', client: 'Claude Code', credentialId: 'anchor-1', ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the role rule', () => {
  it('a member cannot administer; an admin can', async () => {
    await expect(inviteMember(actor({ role: 'member' }), 'x@y.z', 'member')).rejects.toBeInstanceOf(PermissionDenied);
    await expect(changeRole(actor({ role: 'member' }), 'acct-2', 'viewer')).rejects.toBeInstanceOf(PermissionDenied);
    await expect(removeMember(actor({ role: 'member' }), 'acct-2')).rejects.toBeInstanceOf(PermissionDenied);
    await expect(setAssignments(actor({ role: 'member' }), 'acct-2', [])).rejects.toBeInstanceOf(PermissionDenied);
    await expect(renameWorkspace(actor({ role: 'member' }), 'New')).rejects.toBeInstanceOf(PermissionDenied);
    await expect(setAiVendor(actor({ role: 'member' }), 'anthropic')).rejects.toBeInstanceOf(PermissionDenied);
    await expect(setOversight(actor({ role: 'member' }), { autonomy: 'balanced' })).rejects.toBeInstanceOf(PermissionDenied);
    await expect(readAuditLog(actor({ role: 'member' }), {})).rejects.toBeInstanceOf(PermissionDenied);
    // Knowledge is member and above; a viewer is refused.
    await expect(addKnowledgeUrl(actor({ role: 'viewer' }), { title: 't', sourceUrl: 'https://a.b' })).rejects.toBeInstanceOf(PermissionDenied);
    expect(mockMembers.inviteMember).not.toHaveBeenCalled();
    expect(mockTenant.updateName).not.toHaveBeenCalled();
  });

  it('the tools carry the same permissions, and every write is preview → confirm', () => {
    const byName = new Map(workspaceAdminTools.map((t) => [t.definition.name, t]));
    expect(byName.get('member_invite')?.permission).toBe('members:invite');
    expect(byName.get('member_role')?.permission).toBe('members:change_role');
    expect(byName.get('member_remove')?.permission).toBe('members:remove');
    expect(byName.get('assignments_set')?.permission).toBe('assignments:manage');
    expect(byName.get('workspace_rename')?.permission).toBe('workspace:rename');
    expect(byName.get('workspace_ai_vendor')?.permission).toBe('workspace:ai_vendor');
    expect(byName.get('oversight_set')?.permission).toBe('oversight:update');
    expect(byName.get('audit_log_read')?.permission).toBe('audit:read');
    expect(byName.get('knowledge_add_url')?.permission).toBe('knowledge:write');
    for (const name of ['member_invite', 'member_role', 'member_remove', 'assignments_set', 'workspace_rename', 'workspace_ai_vendor', 'oversight_set', 'knowledge_add_url']) {
      expect(byName.get(name)?.mutating).toBe(true);
      expect(byName.get(name)?.definition.input_schema.properties?.confirmationId).toBeDefined();
    }
    for (const name of ['assignments_list', 'members_list', 'workspace_get', 'knowledge_list']) {
      expect(byName.get(name)?.permission).toBeNull();
    }
  });
});

describe('members', () => {
  it('invites through the service and audits under the person with the origin', async () => {
    mockMembers.inviteMember.mockResolvedValue({ invitation: { id: 'inv-1', email: 'x@y.z', role: 'member', expiresAt: new Date('2026-10-01') }, token: 'secret' });
    const r = await inviteMember(actor(), 'x@y.z', 'member');
    expect(r).toMatchObject({ invited: true, invitation: { id: 'inv-1', email: 'x@y.z', role: 'member' } });
    expect(JSON.stringify(r)).not.toContain('secret');
    expect(mockMembers.inviteMember).toHaveBeenCalledWith(TENANT, { email: 'x@y.z', role: 'member' }, 'acct-1');
    expect(logAudit).toHaveBeenCalledWith(
      'tenant_member.invited',
      { tenantId: TENANT, userId: 'acct-1', operation: 'liftoff' },
      expect.objectContaining({ invitationId: 'inv-1', surface: 'liftoff', via: 'mcp', client: 'Claude Code' }),
    );
  });

  it("relays the service's owner rules and conflicts as refusals", async () => {
    mockMembers.inviteMember.mockRejectedValueOnce(new ConflictError('User is already a member of this tenant'));
    expect(await inviteMember(actor(), 'x@y.z', 'member')).toMatchObject({ refused: 'conflict' });

    mockMembers.getMembership.mockResolvedValue({ id: 'm-2', role: 'owner' });
    mockMembers.updateMemberRole.mockRejectedValueOnce(new ForbiddenError('Only owners can modify owner roles'));
    expect(await changeRole(actor(), 'acct-2', 'member')).toMatchObject({ refused: 'forbidden' });

    mockMembers.removeMember.mockRejectedValueOnce(new ValidationError('Cannot remove the last owner'));
    expect(await removeMember(actor({ role: 'owner' }), 'acct-2')).toMatchObject({ refused: 'validation', message: 'Cannot remove the last owner' });

    mockMembers.getMembership.mockResolvedValueOnce(null);
    expect(await removeMember(actor(), 'nobody')).toMatchObject({ refused: 'not_found' });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a role change goes through the service as the person and audits the new role', async () => {
    mockMembers.getMembership.mockResolvedValue({ id: 'm-2', role: 'member' });
    mockMembers.updateMemberRole.mockResolvedValue({ id: 'm-2', role: 'admin' });
    expect(await changeRole(actor(), 'acct-2', 'admin')).toEqual({ changed: true, accountId: 'acct-2', previousRole: 'member', role: 'admin' });
    expect(mockMembers.updateMemberRole).toHaveBeenCalledWith(TENANT, 'm-2', 'admin', 'acct-1');
    expect(logAudit).toHaveBeenCalledWith('tenant_member.role_changed', expect.anything(), expect.objectContaining({ memberId: 'm-2', newRole: 'admin' }));
  });
});

describe('workspace', () => {
  it('rename writes the tenant.renamed audit with the prior name', async () => {
    mockTenant.getById.mockResolvedValue({ id: TENANT, name: 'Old' });
    mockTenant.updateName.mockResolvedValue({ id: TENANT, name: 'New' });
    expect(await renameWorkspace(actor(), '  New ')).toEqual({ renamed: true, previousName: 'Old', name: 'New' });
    expect(mockTenant.updateName).toHaveBeenCalledWith(TENANT, 'New');
    expect(logAudit).toHaveBeenCalledWith('tenant.renamed', expect.anything(), expect.objectContaining({ previousState: { name: 'Old' }, newState: { name: 'New' } }));
    expect(await renameWorkspace(actor(), '   ')).toMatchObject({ refused: 'validation' });
  });

  it('the AI vendor is validated against the one selection list and audited with the prior', async () => {
    mockRegistry.getWorkspaceVendor.mockResolvedValue('default');
    expect(await setAiVendor(actor(), 'anthropic')).toEqual({ changed: true, previousAiVendor: 'default', aiVendor: 'anthropic' });
    expect(mockRegistry.setWorkspaceVendor).toHaveBeenCalledWith(TENANT, 'anthropic');
    expect(logAudit).toHaveBeenCalledWith('tenant.workspace_ai_changed', expect.anything(), expect.objectContaining({ previousState: { workspaceAiVendor: 'default' }, newState: { workspaceAiVendor: 'anthropic' } }));
    expect(await setAiVendor(actor(), 'acme-ai')).toMatchObject({ refused: 'validation' });
    expect(mockRegistry.setWorkspaceVendor).toHaveBeenCalledTimes(1);
  });

  it('oversight goes through the service as the person', async () => {
    mockOversight.updateOversightSettings.mockResolvedValue({ currentVersion: 4, autonomy: 'controlled', escalation: 'important', sensitiveWork: {}, communication: 'review', updatedAt: new Date() });
    const r = await setOversight(actor(), { autonomy: 'controlled' });
    expect(r).toMatchObject({ updated: true, version: 4, autonomy: 'controlled' });
    expect(mockOversight.updateOversightSettings).toHaveBeenCalledWith(TENANT, { autonomy: 'controlled' }, 'acct-1');
    expect(logAudit).toHaveBeenCalledWith('oversight.updated', expect.anything(), expect.objectContaining({ version: 4 }));
  });

  it('the audit log is Enterprise-only, then paged through the service', async () => {
    mockAudit.isEnterprise.mockResolvedValueOnce(false);
    expect(await readAuditLog(actor(), {})).toMatchObject({ refused: 'enterprise_only' });
    expect(mockAudit.list).not.toHaveBeenCalled();

    mockAudit.isEnterprise.mockResolvedValueOnce(true);
    mockAudit.list.mockResolvedValueOnce({ entries: [{ id: 'e1' }], nextCursor: 'c2', hasMore: true });
    const r = await readAuditLog(actor(), { startDate: '2026-09-01T00:00:00Z', endDate: '2026-09-15T00:00:00Z', limit: 10 });
    expect(r).toMatchObject({ entries: [{ id: 'e1' }], nextCursor: 'c2', hasMore: true });
    expect(mockAudit.list).toHaveBeenCalledWith(TENANT, new Date('2026-09-01T00:00:00Z'), new Date('2026-09-15T00:00:00Z'), { cursor: undefined, limit: 10 });

    mockAudit.isEnterprise.mockResolvedValueOnce(true);
    mockAudit.list.mockRejectedValueOnce(new ValidationError('Date range cannot exceed 90 days'));
    expect(await readAuditLog(actor(), { startDate: '2026-01-01T00:00:00Z', endDate: '2026-09-15T00:00:00Z' })).toMatchObject({ refused: 'validation' });
  });
});

describe('knowledge', () => {
  it('adds one page by URL, as a manual url item, and audits it', async () => {
    mockKnowledge.createItem.mockResolvedValue({ id: 'k1', title: 'Pricing', contentType: 'url', sourceUrl: 'https://example.com/pricing', importMode: 'manual', syncStatus: 'pending', extractionStatus: 'pending', excerpt: null, connectorType: null, updatedAt: 'now' });
    const r = await addKnowledgeUrl(actor({ role: 'member' }), { title: ' Pricing ', sourceUrl: 'https://example.com/pricing' });
    expect(r).toMatchObject({ added: true, item: { id: 'k1', title: 'Pricing' } });
    expect(mockKnowledge.createItem).toHaveBeenCalledWith(TENANT, { title: 'Pricing', sourceUrl: 'https://example.com/pricing', contentType: 'url', importMode: 'manual' });
    expect(logAudit).toHaveBeenCalledWith('knowledge.item_added', expect.anything(), expect.objectContaining({ resourceType: 'knowledge_item', resourceId: 'k1' }));
    expect(await addKnowledgeUrl(actor(), { title: 'x', sourceUrl: 'ftp://example.com' })).toMatchObject({ refused: 'validation' });
    expect(await addKnowledgeUrl(actor(), { title: 'x', sourceUrl: 'not a url' })).toMatchObject({ refused: 'validation' });
  });
});

describe('assignments', () => {
  it('replaces the list through the service and relays its 404 / 400', async () => {
    mockAssignments.updateAssignmentsForPerson.mockResolvedValueOnce({ added: 1, removed: 0 });
    expect(await setAssignments(actor(), 'acct-2', [{ agentId: 'a1', agentType: 'internal' }])).toEqual({ accountId: 'acct-2', added: 1, removed: 0 });
    expect(mockAssignments.updateAssignmentsForPerson).toHaveBeenCalledWith(TENANT, 'acct-2', [{ agentId: 'a1', agentType: 'internal' }], 'acct-1');
    expect(logAudit).toHaveBeenCalledWith('person_assignment.updated', expect.anything(), expect.objectContaining({ accountId: 'acct-2', added: 1 }));
    mockAssignments.updateAssignmentsForPerson.mockRejectedValueOnce(Object.assign(new Error('Person not found in tenant'), { statusCode: 404 }));
    expect(await setAssignments(actor(), 'nobody', [])).toMatchObject({ refused: 'not_found' });
    mockAssignments.updateAssignmentsForPerson.mockRejectedValueOnce(Object.assign(new Error('Agent x is archived'), { statusCode: 400 }));
    expect(await setAssignments(actor(), 'acct-2', [{ agentId: 'x', agentType: 'internal' }])).toMatchObject({ refused: 'validation' });
  });
});
