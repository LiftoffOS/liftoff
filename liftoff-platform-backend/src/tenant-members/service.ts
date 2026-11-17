// Tenant Members Service
// Business logic: invite, accept, remove, transfer ownership

import { TenantMembersRepository, RemindableInvitation } from './repository';
import { AccountRepository } from '../accounts/repository';
import { TenantRepository } from '../tenants/repository';
import { generateInviteToken, hashToken } from './tokens';
import { sendTenantInviteEmail, sendEmail, buildEmail } from '../infrastructure/email';
import { log } from '../infrastructure/logging';
import { frontendUrl } from '../infrastructure/frontend-url';
import {
  TenantMember,
  TenantInvitation,
  TenantInvitationWithDetails,
  TenantMemberRole,
  InviteMemberInput,
  PaginatedMembersResponse,
  PaginatedInvitationsResponse,
  PendingOwnershipTransfer,
  ROLE_PERMISSIONS,
  Permission,
} from './types';

// Every person one inviter invited to one workspace whose invitation lapsed,
// aggregated for a single notification email. Produced by
// collectExpiredInvitationsForNotification.
export interface ExpiredInvitationGroup {
  inviterEmail: string;
  inviterFirstName: string | null;
  tenantId: string;
  tenantName: string;
  invitees: Array<{ email: string; invitedAt: Date }>;
}

// Custom error classes
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// Invitation expiry duration (7 days)
const INVITATION_EXPIRY_DAYS = 7;

export class TenantMembersService {
  private repository: TenantMembersRepository;
  private accountRepository: AccountRepository;
  private tenantRepository: TenantRepository;

  constructor() {
    this.repository = new TenantMembersRepository();
    this.accountRepository = new AccountRepository();
    this.tenantRepository = new TenantRepository();
  }

  // Permission check helper
  hasPermission(role: TenantMemberRole, permission: Permission): boolean {
    return ROLE_PERMISSIONS[role][permission];
  }

  // Get membership for actor
  async getMembership(tenantId: string, accountId: string): Promise<TenantMember | null> {
    return this.repository.findMembership(tenantId, accountId);
  }

  // [BE-006] List members with pagination
  async listMembers(
    tenantId: string,
    options?: { cursor?: string | null; limit?: number }
  ): Promise<PaginatedMembersResponse> {
    return this.repository.listMembers(tenantId, options);
  }

  // List invitations for a tenant
  async listInvitations(
    tenantId: string,
    options?: { cursor?: string | null; limit?: number }
  ): Promise<PaginatedInvitationsResponse> {
    return this.repository.listInvitations(tenantId, options);
  }

  // Get all tenants a user is a member of
  // Returns full tenant data with role for TenantWithRole interface
  async getMyMemberships(accountId: string) {
    return this.repository.findMembershipsByAccountId(accountId);
  }

  // Invite a new member
  async inviteMember(
    tenantId: string,
    input: InviteMemberInput,
    invitedBy: string
  ): Promise<{ invitation: TenantInvitation; token: string; inviteUrl: string; emailSent: boolean }> {
    // Note: InviteMemberInput.role type excludes 'owner' - enforced at compile time
    // To invite as owner, use transfer ownership instead

    // Check if email is already a member
    const existingAccount = await this.accountRepository.findByEmail(input.email);
    if (existingAccount) {
      const existingMember = await this.repository.findMembership(tenantId, existingAccount.id);
      if (existingMember) {
        throw new ConflictError('User is already a member of this tenant');
      }
    }

    // Check for pending invitation
    const pendingInvitation = await this.repository.findPendingInvitationByEmail(tenantId, input.email);
    if (pendingInvitation) {
      throw new ConflictError('A pending invitation already exists for this email');
    }

    // Generate secure token
    const token = generateInviteToken();
    const tokenHash = hashToken(token);

    // Calculate expiry
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + INVITATION_EXPIRY_DAYS);

    // Create invitation
    const invitation = await this.repository.createInvitation({
      tenantId,
      email: input.email,
      role: input.role as TenantMemberRole,
      inviteTokenHash: tokenHash,
      invitedBy,
      expiresAt,
    });

    // Get tenant and inviter details for email
    const tenant = await this.tenantRepository.findById(tenantId);
    const inviter = await this.accountRepository.findById(invitedBy);

    // The invitation URL is built whether or not it can be mailed, and it is
    // RETURNED. Sending it was the only way out of here, so a deployment with
    // no mail provider configured could create invitations that reached
    // nobody — and inviting people into a workspace is the whole point of
    // deploying one. The caller already holds `inviteMembers` on this tenant,
    // so handing them the link they just minted grants nothing they could not
    // obtain by inviting an address they control.
    //
    // FRONTEND_URL has no default. It used to fall back to a raw Cloud Run
    // hostname, which mails somebody else's application to the person being
    // invited.
    const inviteUrl = `${frontendUrl()}/invitation/${token}`;
    let emailSent = false;

    if (tenant && inviter) {
      try {
        await sendTenantInviteEmail(
          input.email,
          inviteUrl,
          tenant.name,
          { firstName: inviter.firstName ?? '', lastName: inviter.lastName ?? '', email: inviter.email }
        );
        emailSent = true;
      } catch (error) {
        // Not fatal: the link comes back in the response, so the inviter can
        // deliver it themselves. This is the normal path when no mail provider
        // is configured, not only an outage.
        log.warn({ error, email: input.email }, 'Invitation email not sent; returning the link to the inviter');
      }
    }

    // Audit log
    await this.repository.createAuditEntry({
      tenantId,
      action: 'member.invited',
      actorId: invitedBy,
      newState: {
        email: input.email,
        role: input.role,
        invitationId: invitation.id,
      },
    });

    return { invitation, token, inviteUrl, emailSent };
  }

  // Get invitation by token (for accept page)
  async getInvitationByToken(token: string): Promise<TenantInvitationWithDetails | null> {
    const tokenHash = hashToken(token);
    const invitation = await this.repository.findInvitationByTokenHash(tokenHash);

    if (!invitation) {
      return null;
    }

    // Check if expired
    if (invitation.status === 'pending' && new Date() > invitation.expiresAt) {
      // Mark as expired
      await this.repository.updateInvitationStatus(invitation.id, 'expired');
      return {
        ...invitation,
        status: 'expired',
      };
    }

    return invitation;
  }

  // [SE-005] Accept invitation with email verification
  async acceptInvitation(
    token: string,
    accountId: string
  ): Promise<{ member: TenantMember; tenantId: string }> {
    const tokenHash = hashToken(token);
    const invitation = await this.repository.findInvitationByTokenHash(tokenHash);

    if (!invitation) {
      throw new NotFoundError('Invitation not found');
    }

    // Check status
    if (invitation.status !== 'pending') {
      throw new ValidationError(`Invitation is ${invitation.status}`);
    }

    // Check expiry
    if (new Date() > invitation.expiresAt) {
      await this.repository.updateInvitationStatus(invitation.id, 'expired');
      throw new ValidationError('Invitation has expired');
    }

    // [SE-005] Verify email matches
    const account = await this.accountRepository.findById(accountId);
    if (!account) {
      throw new NotFoundError('Account not found');
    }

    if (account.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new ForbiddenError('This invitation was sent to a different email address');
    }

    // Check if already a member
    const existingMember = await this.repository.findMembership(invitation.tenantId, accountId);
    if (existingMember) {
      throw new ConflictError('Already a member of this tenant');
    }

    // Create membership
    const member = await this.repository.createMember({
      tenantId: invitation.tenantId,
      accountId,
      role: invitation.role,
      invitedBy: invitation.invitedBy,
      invitedAt: invitation.createdAt,
    });

    // Update invitation status
    await this.repository.updateInvitationStatus(invitation.id, 'accepted', accountId);

    // Audit log
    await this.repository.createAuditEntry({
      tenantId: invitation.tenantId,
      accountId,
      action: 'member.joined',
      actorId: accountId,
      newState: {
        memberId: member.id,
        role: member.role,
        invitationId: invitation.id,
      },
    });

    return { member, tenantId: invitation.tenantId };
  }

  // Revoke invitation
  async revokeInvitation(
    tenantId: string,
    invitationId: string,
    actorId: string
  ): Promise<void> {
    console.log('[revokeInvitation] Starting', { tenantId, invitationId, actorId });

    const invitation = await this.repository.findInvitationById(invitationId);
    console.log('[revokeInvitation] Found invitation', { found: !!invitation, status: invitation?.status });

    if (!invitation || invitation.tenantId !== tenantId) {
      throw new NotFoundError('Invitation not found');
    }

    if (invitation.status !== 'pending') {
      throw new ValidationError(`Cannot revoke ${invitation.status} invitation`);
    }

    console.log('[revokeInvitation] Updating status to revoked');
    await this.repository.updateInvitationStatus(invitationId, 'revoked');

    // Audit log
    console.log('[revokeInvitation] Creating audit entry');
    await this.repository.createAuditEntry({
      tenantId,
      action: 'invitation.revoked',
      actorId,
      previousState: {
        invitationId,
        email: invitation.email,
        role: invitation.role,
      },
    });
    console.log('[revokeInvitation] Complete');
  }

  // Update invitation role
  async updateInvitationRole(
    tenantId: string,
    invitationId: string,
    newRole: TenantMemberRole,
    actorId: string
  ): Promise<TenantInvitation> {
    const invitation = await this.repository.findInvitationById(invitationId);

    if (!invitation || invitation.tenantId !== tenantId) {
      throw new NotFoundError('Invitation not found');
    }

    if (invitation.status !== 'pending') {
      throw new ValidationError(`Cannot update ${invitation.status} invitation`);
    }

    const previousRole = invitation.role;
    const updated = await this.repository.updateInvitationRole(invitationId, newRole);

    // Audit log
    await this.repository.createAuditEntry({
      tenantId,
      action: 'invitation.role_updated',
      actorId,
      previousState: { invitationId, role: previousRole },
      newState: { invitationId, role: newRole },
    });

    return updated;
  }

  // Update member role
  async updateMemberRole(
    tenantId: string,
    memberId: string,
    newRole: TenantMemberRole,
    actorId: string
  ): Promise<TenantMember> {
    const member = await this.repository.findMemberById(memberId, tenantId);

    if (!member) {
      throw new NotFoundError('Member not found');
    }

    const previousRole = member.role;

    // [SE-001] Cannot demote owner unless actor is also owner
    if (member.role === 'owner') {
      const actor = await this.repository.findMembership(tenantId, actorId);
      if (!actor || actor.role !== 'owner') {
        throw new ForbiddenError('Only owners can modify owner roles');
      }

      // Cannot demote the last owner
      if (newRole !== 'owner') {
        const ownerCount = await this.repository.countOwners(tenantId);
        if (ownerCount <= 1) {
          throw new ValidationError('Cannot demote the last owner. Transfer ownership first.');
        }
      }
    }

    const updatedMember = await this.repository.updateMemberRole(memberId, newRole);

    // Audit log
    await this.repository.createAuditEntry({
      tenantId,
      accountId: member.accountId,
      action: 'member.role_changed',
      actorId,
      previousState: { role: previousRole },
      newState: { role: newRole },
    });

    return updatedMember;
  }

  // Remove member
  async removeMember(
    tenantId: string,
    memberId: string,
    actorId: string
  ): Promise<void> {
    const member = await this.repository.findMemberById(memberId, tenantId);

    if (!member) {
      throw new NotFoundError('Member not found');
    }

    // [SE-001] Cannot remove owner unless actor is owner
    if (member.role === 'owner') {
      const actor = await this.repository.findMembership(tenantId, actorId);
      if (!actor || actor.role !== 'owner') {
        throw new ForbiddenError('Only owners can remove owners');
      }

      // Cannot remove the last owner (DB trigger will catch this too)
      const ownerCount = await this.repository.countOwners(tenantId);
      if (ownerCount <= 1) {
        throw new ValidationError('Cannot remove the last owner');
      }
    }

    // Allow self-removal for non-owners
    const isSelfRemoval = member.accountId === actorId;

    // The membership and the account's coding-tool credentials in this
    // workspace go together: a removed person must not keep the MCP tools
    // their token still unlocks.
    const revoked = await this.repository.deleteMemberAndRevokeAccess(tenantId, memberId, member.accountId);

    // Audit log, written after the commit.
    await this.repository.createAuditEntry({
      tenantId,
      accountId: member.accountId,
      action: isSelfRemoval ? 'member.left' : 'member.removed',
      actorId,
      previousState: {
        memberId,
        role: member.role,
        revokedTokens: revoked.tokens,
        revokedGrants: revoked.grants,
      },
    });
  }

  // [SE-007] Step 1: Initiate ownership transfer (creates pending transfer, sends confirmation email)
  async initiateOwnershipTransfer(
    tenantId: string,
    newOwnerId: string,
    currentOwnerId: string
  ): Promise<PendingOwnershipTransfer> {
    // Verify current user is owner
    const currentOwner = await this.repository.findMembership(tenantId, currentOwnerId);
    if (!currentOwner || currentOwner.role !== 'owner') {
      throw new ForbiddenError('Only owners can transfer ownership');
    }

    // Verify new owner is a member
    const newOwnerMembership = await this.repository.findMembership(tenantId, newOwnerId);
    if (!newOwnerMembership) {
      throw new NotFoundError('Target member not found');
    }

    // Cannot transfer to self
    if (newOwnerId === currentOwnerId) {
      throw new ValidationError('Cannot transfer ownership to yourself');
    }

    // Generate confirmation token
    const token = generateInviteToken();
    const tokenHash = hashToken(token);

    // Set 24-hour expiry
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    // Create pending transfer
    const pendingTransfer = await this.repository.createPendingTransfer({
      tenantId,
      currentOwnerId,
      newOwnerId,
      confirmationTokenHash: tokenHash,
      expiresAt,
    });

    // Get details for email
    const tenant = await this.tenantRepository.findById(tenantId);
    const currentOwnerAccount = await this.accountRepository.findById(currentOwnerId);
    const newOwnerAccount = await this.accountRepository.findById(newOwnerId);

    if (tenant && currentOwnerAccount && newOwnerAccount) {
      // Send confirmation email to current owner
      const frontendUrl = process.env.FRONTEND_URL || 'https://liftoff-react-YOUR_PROJECT_HASH-uw.a.run.app';
      const confirmUrl = `${frontendUrl}/transfer-ownership/confirm?token=${token}&tenantId=${tenantId}`;

      try {
        // Build and send ownership transfer confirmation email
        const { subject, html } = buildEmail('ownership-transfer', {
          firstName: currentOwnerAccount.firstName || 'Owner',
          tenantName: tenant.name,
          newOwnerName: `${newOwnerAccount.firstName || ''} ${newOwnerAccount.lastName || ''}`.trim() || newOwnerAccount.email,
          newOwnerEmail: newOwnerAccount.email,
          confirmUrl,
          expiresIn: '24 hours',
        });

        await sendEmail({
          to: currentOwnerAccount.email,
          subject,
          html,
          emailType: 'ownership-transfer-confirmation',
        });

        log.info({
          tenantId,
          currentOwnerId,
          newOwnerId,
          email: currentOwnerAccount.email,
        }, 'Ownership transfer confirmation email sent');
      } catch (error) {
        log.error({ error, tenantId }, 'Failed to send ownership transfer confirmation email');
        // Don't fail the initiation if email fails
      }

      // Notify all admins
      try {
        const members = await this.repository.listMembers(tenantId, { limit: 100 });
        const admins = members.members.filter(m => m.role === 'admin');

        for (const admin of admins) {
          const { subject: adminSubject, html: adminHtml } = buildEmail('ownership-transfer-notification', {
            firstName: admin.account.firstName || 'Admin',
            tenantName: tenant.name,
            currentOwnerName: `${currentOwnerAccount.firstName || ''} ${currentOwnerAccount.lastName || ''}`.trim() || currentOwnerAccount.email,
            newOwnerName: `${newOwnerAccount.firstName || ''} ${newOwnerAccount.lastName || ''}`.trim() || newOwnerAccount.email,
          });

          await sendEmail({
            to: admin.account.email,
            subject: adminSubject,
            html: adminHtml,
            emailType: 'ownership-transfer-notification',
          });
        }
      } catch (error) {
        log.error({ error, tenantId }, 'Failed to notify admins about ownership transfer');
      }
    }

    // Audit log
    await this.repository.createAuditEntry({
      tenantId,
      action: 'ownership.transfer_initiated',
      actorId: currentOwnerId,
      newState: {
        transferId: pendingTransfer.id,
        currentOwnerId,
        newOwnerId,
        expiresAt,
      },
    });

    log.info({
      tenantId,
      transferId: pendingTransfer.id,
      currentOwnerId,
      newOwnerId,
    }, 'Ownership transfer initiated');

    return pendingTransfer;
  }

  // [SE-007] Step 2: Confirm ownership transfer (from email link)
  async confirmOwnershipTransfer(
    tenantId: string,
    confirmationToken: string,
    actorAccountId: string
  ): Promise<{ newOwner: TenantMember; previousOwnerId: string }> {
    const tokenHash = hashToken(confirmationToken);
    const pendingTransfer = await this.repository.findPendingTransferByToken(tokenHash);

    if (!pendingTransfer) {
      throw new NotFoundError('Transfer request not found or already processed');
    }

    // Verify tenant matches
    if (pendingTransfer.tenantId !== tenantId) {
      throw new ValidationError('Invalid transfer request');
    }

    // Verify actor is the current owner
    if (pendingTransfer.currentOwnerId !== actorAccountId) {
      throw new ForbiddenError('Only the current owner can confirm the transfer');
    }

    // Check expiry
    if (new Date() > pendingTransfer.expiresAt) {
      await this.repository.updatePendingTransferStatus(pendingTransfer.id, 'expired');
      throw new ValidationError('Transfer request has expired');
    }

    // Execute the transfer
    const currentOwner = await this.repository.findMembership(tenantId, pendingTransfer.currentOwnerId);
    const newOwner = await this.repository.findMembership(tenantId, pendingTransfer.newOwnerId);

    if (!currentOwner || !newOwner) {
      throw new NotFoundError('Owner or new owner membership not found');
    }

    // Update new owner to owner role
    const updatedNewOwner = await this.repository.updateMemberRole(newOwner.id, 'owner');

    // Demote current owner to admin
    await this.repository.updateMemberRole(currentOwner.id, 'admin');

    // Mark transfer as confirmed
    await this.repository.updatePendingTransferStatus(pendingTransfer.id, 'confirmed');

    // Audit log with high visibility
    await this.repository.createAuditEntry({
      tenantId,
      action: 'ownership.transferred',
      actorId: actorAccountId,
      previousState: {
        ownerId: pendingTransfer.currentOwnerId,
        transferId: pendingTransfer.id,
      },
      newState: {
        ownerId: pendingTransfer.newOwnerId,
      },
    });

    log.warn({
      tenantId,
      transferId: pendingTransfer.id,
      previousOwnerId: pendingTransfer.currentOwnerId,
      newOwnerId: pendingTransfer.newOwnerId,
    }, 'OWNERSHIP TRANSFERRED - High visibility alert');

    return {
      newOwner: updatedNewOwner,
      previousOwnerId: pendingTransfer.currentOwnerId,
    };
  }

  // Legacy method kept for internal use - direct transfer without confirmation
  // Should only be used for migrations or admin operations
  async transferOwnership(
    tenantId: string,
    newOwnerId: string,
    currentOwnerId: string
  ): Promise<TenantMember> {
    // Verify current user is owner
    const currentOwner = await this.repository.findMembership(tenantId, currentOwnerId);
    if (!currentOwner || currentOwner.role !== 'owner') {
      throw new ForbiddenError('Only owners can transfer ownership');
    }

    // Verify new owner is a member
    const newOwner = await this.repository.findMembership(tenantId, newOwnerId);
    if (!newOwner) {
      throw new NotFoundError('Target member not found');
    }

    // Cannot transfer to self
    if (newOwnerId === currentOwnerId) {
      throw new ValidationError('Cannot transfer ownership to yourself');
    }

    // Update new owner to owner role
    const updatedNewOwner = await this.repository.updateMemberRole(newOwner.id, 'owner');

    // Demote current owner to admin
    await this.repository.updateMemberRole(currentOwner.id, 'admin');

    // Audit log with high visibility
    await this.repository.createAuditEntry({
      tenantId,
      action: 'ownership.transferred',
      actorId: currentOwnerId,
      previousState: {
        ownerId: currentOwnerId,
      },
      newState: {
        ownerId: newOwnerId,
      },
    });

    log.info({
      tenantId,
      previousOwnerId: currentOwnerId,
      newOwnerId,
    }, 'Ownership transferred');

    return updatedNewOwner;
  }

  // [BE-007] Cleanup expired invitations
  async cleanupExpiredInvitations(): Promise<{ expired: number; archived: number }> {
    const expired = await this.repository.expireOldInvitations();
    const archived = await this.repository.archiveOldInvitations(90);

    log.info({ expired, archived }, 'Cleaned up invitations');

    return { expired, archived };
  }

  // Flip newly-expired invitations and aggregate them per inviter+workspace for
  // the daily notification (jobs/invite-expiry-sweep.ts). One group becomes one
  // email, so several people whose invitations lapse on the same day land in a
  // single message to the inviter rather than one email each. The repository
  // does the flip; grouping is business logic and lives here.
  async collectExpiredInvitationsForNotification(): Promise<ExpiredInvitationGroup[]> {
    const rows = await this.repository.expireAndReturnPendingInvitations();
    const groups = new Map<string, ExpiredInvitationGroup>();
    for (const r of rows) {
      const key = `${r.invitedBy}::${r.tenantId}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          inviterEmail: r.inviterEmail,
          inviterFirstName: r.inviterFirstName,
          tenantId: r.tenantId,
          tenantName: r.tenantName,
          invitees: [],
        };
        groups.set(key, group);
      }
      group.invitees.push({ email: r.inviteeEmail, invitedAt: r.invitedAt });
    }
    return Array.from(groups.values());
  }

  // Invitations to remind (day-5 sweep). Thin pass-through so the job never
  // touches the repository directly.
  async findRemindableInvitations(): Promise<RemindableInvitation[]> {
    return this.repository.findRemindableInvitations();
  }

  // Mint the reminder's own accept token for one invitation and claim it. Returns
  // the plaintext token to put in the reminder link, or null if another run
  // already reminded this invitation (so the caller skips the send). The original
  // invite_token_hash is untouched — both links validate (see findInvitationByTokenHash).
  async mintReminderToken(invitationId: string): Promise<string | null> {
    const token = generateInviteToken();
    const claimed = await this.repository.claimReminder(invitationId, hashToken(token));
    return claimed ? token : null;
  }

}

export const tenantMembersService = new TenantMembersService();
