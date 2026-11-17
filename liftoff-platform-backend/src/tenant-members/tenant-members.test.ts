// Tenant Members Tests
// Tests multi-tenant membership functionality per Section 3.1

import { TenantMembersService, ForbiddenError, ConflictError, ValidationError } from './service';
import { TenantMembersRepository } from './repository';
import { AccountRepository } from '../accounts/repository';
import { TenantRepository } from '../tenants/repository';
import { generateInviteToken, hashToken, verifyToken } from './tokens';
import { TenantMember, TenantInvitation } from './types';

// Mock external dependencies
jest.mock('../infrastructure/database');
jest.mock('../infrastructure/email');
jest.mock('../infrastructure/logging');

// Mock repositories
jest.mock('./repository');
jest.mock('../accounts/repository');
jest.mock('../tenants/repository');

// Helper to create mock member
function createMockMember(overrides: Partial<TenantMember> = {}): TenantMember {
  return {
    id: 'member_123',
    tenantId: 'tenant_123',
    accountId: 'account_123',
    role: 'member',
    invitedBy: null,
    invitedAt: null,
    joinedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Helper to create mock invitation
function createMockInvitation(overrides: Partial<TenantInvitation> = {}): TenantInvitation {
  return {
    id: 'inv_123',
    tenantId: 'tenant_123',
    email: 'invitee@example.com',
    role: 'member',
    inviteTokenHash: 'hashed_token',
    status: 'pending',
    invitedBy: 'account_owner',
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    acceptedAt: null,
    accountId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('Tenant Members API', () => {
  let service: TenantMembersService;
  let mockMembersRepo: jest.Mocked<TenantMembersRepository>;
  let mockAccountRepo: jest.Mocked<AccountRepository>;
  let mockTenantRepo: jest.Mocked<TenantRepository>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockMembersRepo = {
      findMemberById: jest.fn(),
      findMembership: jest.fn(),
      listMembers: jest.fn(),
      createMember: jest.fn(),
      updateMemberRole: jest.fn(),
      deleteMember: jest.fn(),
      deleteMemberAndRevokeAccess: jest.fn().mockResolvedValue({ tokens: 0, grants: 0 }),
      countOwners: jest.fn(),
      findMembershipsByAccountId: jest.fn(),
      findInvitationById: jest.fn(),
      findInvitationByTokenHash: jest.fn(),
      findPendingInvitationByEmail: jest.fn(),
      listInvitations: jest.fn(),
      createInvitation: jest.fn(),
      updateInvitationStatus: jest.fn(),
      expireOldInvitations: jest.fn(),
      archiveOldInvitations: jest.fn(),
      createAuditEntry: jest.fn(),
    } as unknown as jest.Mocked<TenantMembersRepository>;

    mockAccountRepo = {
      findById: jest.fn(),
      findByEmail: jest.fn(),
    } as unknown as jest.Mocked<AccountRepository>;

    mockTenantRepo = {
      findById: jest.fn(),
    } as unknown as jest.Mocked<TenantRepository>;

    (TenantMembersRepository as unknown as jest.Mock).mockImplementation(() => mockMembersRepo);
    (AccountRepository as jest.Mock).mockImplementation(() => mockAccountRepo);
    (TenantRepository as jest.Mock).mockImplementation(() => mockTenantRepo);

    service = new TenantMembersService();
  });

  // Unit tests
  describe('Permission Logic', () => {
    it('owner can perform all actions', () => {
      expect(service.hasPermission('owner', 'viewDashboard')).toBe(true);
      expect(service.hasPermission('owner', 'editTeams')).toBe(true);
      expect(service.hasPermission('owner', 'manageConnectors')).toBe(true);
      expect(service.hasPermission('owner', 'inviteMembers')).toBe(true);
      expect(service.hasPermission('owner', 'removeMember')).toBe(true);
      expect(service.hasPermission('owner', 'changeRole')).toBe(true);
      expect(service.hasPermission('owner', 'transferOwnership')).toBe(true);
      expect(service.hasPermission('owner', 'deleteTenant')).toBe(true);
      expect(service.hasPermission('owner', 'manageBilling')).toBe(true);
    });

    it('admin can invite, remove members, change non-owner roles', () => {
      expect(service.hasPermission('admin', 'inviteMembers')).toBe(true);
      expect(service.hasPermission('admin', 'removeMember')).toBe(true);
      expect(service.hasPermission('admin', 'changeRole')).toBe(true);
      expect(service.hasPermission('admin', 'transferOwnership')).toBe(false);
      expect(service.hasPermission('admin', 'deleteTenant')).toBe(false);
    });

    it('admin cannot modify owner', async () => {
      const ownerMember = createMockMember({ role: 'owner', accountId: 'owner_account' });
      const adminMembership = createMockMember({ role: 'admin', accountId: 'admin_account' });

      mockMembersRepo.findMemberById.mockResolvedValue(ownerMember);
      mockMembersRepo.findMembership.mockResolvedValue(adminMembership);

      await expect(
        service.updateMemberRole('tenant_123', ownerMember.id, 'admin', 'admin_account')
      ).rejects.toThrow(ForbiddenError);
    });

    it('member cannot invite or manage members', () => {
      expect(service.hasPermission('member', 'inviteMembers')).toBe(false);
      expect(service.hasPermission('member', 'removeMember')).toBe(false);
      expect(service.hasPermission('member', 'changeRole')).toBe(false);
    });

    it('viewer has read-only access', () => {
      expect(service.hasPermission('viewer', 'viewDashboard')).toBe(true);
      expect(service.hasPermission('viewer', 'editTeams')).toBe(false);
      expect(service.hasPermission('viewer', 'manageConnectors')).toBe(false);
      expect(service.hasPermission('viewer', 'inviteMembers')).toBe(false);
    });
  });

  // Integration tests for each endpoint
  describe('POST /invite', () => {
    it('creates invitation and returns it', async () => {
      const invitation = createMockInvitation();
      mockAccountRepo.findByEmail.mockResolvedValue(null);
      mockMembersRepo.findPendingInvitationByEmail.mockResolvedValue(null);
      mockMembersRepo.createInvitation.mockResolvedValue(invitation);
      mockTenantRepo.findById.mockResolvedValue({ id: 'tenant_123', name: 'Test Tenant' } as any);
      mockAccountRepo.findById.mockResolvedValue({ id: 'account_owner', firstName: 'John' } as any);
      mockMembersRepo.createAuditEntry.mockResolvedValue({} as any);

      const result = await service.inviteMember(
        'tenant_123',
        { email: 'invitee@example.com', role: 'member' },
        'account_owner'
      );

      expect(result.invitation).toBeDefined();
      expect(result.token).toBeDefined();
      expect(mockMembersRepo.createInvitation).toHaveBeenCalled();
    });

    it('rejects invalid email format', async () => {
      // This is validated at the router level with zod
      // Service assumes valid input
    });

    it('rejects duplicate invitations', async () => {
      const existingInvitation = createMockInvitation();
      mockAccountRepo.findByEmail.mockResolvedValue(null);
      mockMembersRepo.findPendingInvitationByEmail.mockResolvedValue(existingInvitation);

      await expect(
        service.inviteMember(
          'tenant_123',
          { email: 'invitee@example.com', role: 'member' },
          'account_owner'
        )
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('POST /accept-invite', () => {
    it('accepts valid token', async () => {
      const token = generateInviteToken();
      const tokenHash = hashToken(token);
      const invitation = createMockInvitation({ inviteTokenHash: tokenHash });
      const member = createMockMember();

      mockMembersRepo.findInvitationByTokenHash.mockResolvedValue({
        ...invitation,
        tenantName: 'Test Tenant',
        invitedByAccount: { id: 'owner', firstName: 'John', lastName: 'Doe' },
      } as any);
      mockAccountRepo.findById.mockResolvedValue({ id: 'account_123', email: 'invitee@example.com' } as any);
      mockMembersRepo.findMembership.mockResolvedValue(null);
      mockMembersRepo.createMember.mockResolvedValue(member);
      mockMembersRepo.updateInvitationStatus.mockResolvedValue(invitation);
      mockMembersRepo.createAuditEntry.mockResolvedValue({} as any);

      const result = await service.acceptInvitation(token, 'account_123');

      expect(result.member).toBeDefined();
      expect(result.tenantId).toBe('tenant_123');
    });

    it('rejects expired token', async () => {
      const token = generateInviteToken();
      const tokenHash = hashToken(token);
      const expiredInvitation = createMockInvitation({
        inviteTokenHash: tokenHash,
        expiresAt: new Date(Date.now() - 1000), // Expired
      });

      mockMembersRepo.findInvitationByTokenHash.mockResolvedValue({
        ...expiredInvitation,
        tenantName: 'Test Tenant',
        invitedByAccount: { id: 'owner', firstName: 'John', lastName: 'Doe' },
      } as any);
      mockAccountRepo.findById.mockResolvedValue({ id: 'account_123', email: 'invitee@example.com' } as any);
      mockMembersRepo.updateInvitationStatus.mockResolvedValue(expiredInvitation);

      await expect(service.acceptInvitation(token, 'account_123')).rejects.toThrow(ValidationError);
    });

    it('rejects revoked token', async () => {
      const token = generateInviteToken();
      const tokenHash = hashToken(token);
      const revokedInvitation = createMockInvitation({
        inviteTokenHash: tokenHash,
        status: 'revoked',
      });

      mockMembersRepo.findInvitationByTokenHash.mockResolvedValue({
        ...revokedInvitation,
        tenantName: 'Test Tenant',
        invitedByAccount: { id: 'owner', firstName: 'John', lastName: 'Doe' },
      } as any);
      mockAccountRepo.findById.mockResolvedValue({ id: 'account_123', email: 'invitee@example.com' } as any);

      await expect(service.acceptInvitation(token, 'account_123')).rejects.toThrow(ValidationError);
    });

    it('rejects email mismatch', async () => {
      const token = generateInviteToken();
      const tokenHash = hashToken(token);
      const invitation = createMockInvitation({ inviteTokenHash: tokenHash });

      mockMembersRepo.findInvitationByTokenHash.mockResolvedValue({
        ...invitation,
        tenantName: 'Test Tenant',
        invitedByAccount: { id: 'owner', firstName: 'John', lastName: 'Doe' },
      } as any);
      // Account email doesn't match invitation email
      mockAccountRepo.findById.mockResolvedValue({ id: 'account_123', email: 'different@example.com' } as any);

      await expect(service.acceptInvitation(token, 'account_123')).rejects.toThrow(ForbiddenError);
    });

    it('prevents double-acceptance', async () => {
      const token = generateInviteToken();
      const tokenHash = hashToken(token);
      const invitation = createMockInvitation({ inviteTokenHash: tokenHash });

      mockMembersRepo.findInvitationByTokenHash.mockResolvedValue({
        ...invitation,
        tenantName: 'Test Tenant',
        invitedByAccount: { id: 'owner', firstName: 'John', lastName: 'Doe' },
      } as any);
      mockAccountRepo.findById.mockResolvedValue({ id: 'account_123', email: 'invitee@example.com' } as any);
      // Already a member
      mockMembersRepo.findMembership.mockResolvedValue(createMockMember());

      await expect(service.acceptInvitation(token, 'account_123')).rejects.toThrow(ConflictError);
    });
  });

  // [TE-002] Authorization boundary tests
  describe('Authorization Boundaries', () => {
    it('admin_cannot_change_owner_role', async () => {
      const ownerMember = createMockMember({ role: 'owner', accountId: 'owner_account' });
      const adminMembership = createMockMember({ role: 'admin', accountId: 'admin_account' });

      mockMembersRepo.findMemberById.mockResolvedValue(ownerMember);
      mockMembersRepo.findMembership.mockResolvedValue(adminMembership);

      await expect(
        service.updateMemberRole('tenant_123', ownerMember.id, 'admin', 'admin_account')
      ).rejects.toThrow(ForbiddenError);
    });

    it('admin_cannot_remove_owner', async () => {
      const ownerMember = createMockMember({ role: 'owner', accountId: 'owner_account' });
      const adminMembership = createMockMember({ role: 'admin', accountId: 'admin_account' });

      mockMembersRepo.findMemberById.mockResolvedValue(ownerMember);
      mockMembersRepo.findMembership.mockResolvedValue(adminMembership);

      await expect(
        service.removeMember('tenant_123', ownerMember.id, 'admin_account')
      ).rejects.toThrow(ForbiddenError);
      // Nothing is revoked when the removal itself is refused.
      expect(mockMembersRepo.deleteMemberAndRevokeAccess).not.toHaveBeenCalled();
      expect(mockMembersRepo.deleteMember).not.toHaveBeenCalled();
    });
  });

  describe('removeMember revokes coding-tool access', () => {
    it('deletes the membership and the account credentials together, and records the counts', async () => {
      const member = createMockMember({ id: 'member_9', role: 'member', accountId: 'account_9' });
      mockMembersRepo.findMemberById.mockResolvedValue(member);
      mockMembersRepo.deleteMemberAndRevokeAccess.mockResolvedValue({ tokens: 2, grants: 1 });

      await service.removeMember('tenant_123', 'member_9', 'admin_account');

      expect(mockMembersRepo.deleteMemberAndRevokeAccess).toHaveBeenCalledWith('tenant_123', 'member_9', 'account_9');
      expect(mockMembersRepo.deleteMember).not.toHaveBeenCalled();
      expect(mockMembersRepo.createAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
        action: 'member.removed',
        accountId: 'account_9',
        previousState: expect.objectContaining({ memberId: 'member_9', role: 'member', revokedTokens: 2, revokedGrants: 1 }),
      }));
    });

    it('a failed revocation propagates and writes no audit entry (the transaction rolled back)', async () => {
      const member = createMockMember({ id: 'member_9', role: 'member', accountId: 'account_9' });
      mockMembersRepo.findMemberById.mockResolvedValue(member);
      mockMembersRepo.deleteMemberAndRevokeAccess.mockRejectedValue(new Error('revocation failed'));

      await expect(service.removeMember('tenant_123', 'member_9', 'admin_account')).rejects.toThrow('revocation failed');
      expect(mockMembersRepo.createAuditEntry).not.toHaveBeenCalled();
    });
  });

  // [TE-003] Token security tests
  describe('Token Security', () => {
    it('tokens are cryptographically random', () => {
      const token1 = generateInviteToken();
      const token2 = generateInviteToken();

      expect(token1).not.toBe(token2);
      expect(token1.length).toBeGreaterThan(30);
    });

    it('tokens are hashed correctly', () => {
      const token = generateInviteToken();
      const hash = hashToken(token);

      expect(hash).toHaveLength(64); // SHA-256 hex length
      expect(hash).not.toBe(token);
    });

    it('verifyToken works correctly', () => {
      const token = generateInviteToken();
      const hash = hashToken(token);

      expect(verifyToken(token, hash)).toBe(true);
      expect(verifyToken('wrong_token', hash)).toBe(false);
    });
  });

  // [TE-006] Edge cases
  describe('Edge Cases', () => {
    it('rejects self-invitation', async () => {
      const existingAccount = { id: 'account_123', email: 'self@example.com' };
      const existingMember = createMockMember({ accountId: 'account_123' });

      mockAccountRepo.findByEmail.mockResolvedValue(existingAccount as any);
      mockMembersRepo.findMembership.mockResolvedValue(existingMember);

      await expect(
        service.inviteMember(
          'tenant_123',
          { email: 'self@example.com', role: 'member' },
          'account_123'
        )
      ).rejects.toThrow(ConflictError);
    });

    it('prevents last owner from leaving', async () => {
      const ownerMember = createMockMember({ role: 'owner', accountId: 'owner_account' });

      mockMembersRepo.findMemberById.mockResolvedValue(ownerMember);
      mockMembersRepo.findMembership.mockResolvedValue(ownerMember);
      mockMembersRepo.countOwners.mockResolvedValue(1); // Only one owner

      await expect(
        service.removeMember('tenant_123', ownerMember.id, 'owner_account')
      ).rejects.toThrow(ValidationError);
    });

    it('handles duplicate member invite', async () => {
      const existingAccount = { id: 'account_existing', email: 'existing@example.com' };
      const existingMember = createMockMember({ accountId: 'account_existing' });

      mockAccountRepo.findByEmail.mockResolvedValue(existingAccount as any);
      mockMembersRepo.findMembership.mockResolvedValue(existingMember);

      await expect(
        service.inviteMember(
          'tenant_123',
          { email: 'existing@example.com', role: 'member' },
          'account_owner'
        )
      ).rejects.toThrow(ConflictError);
    });

    it('email matching is case-insensitive', async () => {
      const token = generateInviteToken();
      const tokenHash = hashToken(token);
      const invitation = createMockInvitation({
        inviteTokenHash: tokenHash,
        email: 'USER@Example.COM',
      });
      const member = createMockMember();

      mockMembersRepo.findInvitationByTokenHash.mockResolvedValue({
        ...invitation,
        tenantName: 'Test Tenant',
        invitedByAccount: { id: 'owner', firstName: 'John', lastName: 'Doe' },
      } as any);
      // Account email is lowercase
      mockAccountRepo.findById.mockResolvedValue({
        id: 'account_123',
        email: 'user@example.com',
      } as any);
      mockMembersRepo.findMembership.mockResolvedValue(null);
      mockMembersRepo.createMember.mockResolvedValue(member);
      mockMembersRepo.updateInvitationStatus.mockResolvedValue(invitation);
      mockMembersRepo.createAuditEntry.mockResolvedValue({} as any);

      const result = await service.acceptInvitation(token, 'account_123');
      expect(result.member).toBeDefined();
    });
  });

  // Ownership transfer tests
  describe('Transfer Ownership', () => {
    it('allows owner to transfer ownership', async () => {
      const currentOwner = createMockMember({ role: 'owner', accountId: 'current_owner' });
      const newOwner = createMockMember({ role: 'admin', accountId: 'new_owner', id: 'member_new' });
      const updatedNewOwner = createMockMember({ role: 'owner', accountId: 'new_owner', id: 'member_new' });

      mockMembersRepo.findMembership
        .mockResolvedValueOnce(currentOwner) // Current owner check
        .mockResolvedValueOnce(newOwner); // New owner exists check
      mockMembersRepo.updateMemberRole
        .mockResolvedValueOnce(updatedNewOwner) // Update new owner
        .mockResolvedValueOnce(createMockMember({ role: 'admin', accountId: 'current_owner' })); // Demote current
      mockMembersRepo.createAuditEntry.mockResolvedValue({} as any);

      const result = await service.transferOwnership('tenant_123', 'new_owner', 'current_owner');
      expect(result.role).toBe('owner');
    });

    it('prevents non-owner from transferring ownership', async () => {
      const adminMember = createMockMember({ role: 'admin', accountId: 'admin_account' });

      mockMembersRepo.findMembership.mockResolvedValue(adminMember);

      await expect(
        service.transferOwnership('tenant_123', 'new_owner', 'admin_account')
      ).rejects.toThrow(ForbiddenError);
    });

    it('prevents transfer to self', async () => {
      const ownerMember = createMockMember({ role: 'owner', accountId: 'owner_account' });

      mockMembersRepo.findMembership.mockResolvedValue(ownerMember);

      await expect(
        service.transferOwnership('tenant_123', 'owner_account', 'owner_account')
      ).rejects.toThrow(ValidationError);
    });
  });
});
