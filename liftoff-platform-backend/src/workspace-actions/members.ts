// Members: the People page's member list, an invitation, a role change and a
// removal. The owner rules (only an owner touches an owner, never the last
// owner) live in tenant-members/service.ts and are relayed here as refusals;
// the permissions members:invite / members:change_role / members:remove are
// owner/admin.

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  tenantMembersService,
} from '../tenant-members/service';
import type { TenantMemberRole } from '../tenant-members/types';
import { requirePermission, type Actor } from './actor';
import { writeAudit } from './audit';

export type MembersRefusal = {
  refused: 'not_found' | 'conflict' | 'forbidden' | 'validation';
  message: string;
};

export type InviteRole = 'admin' | 'member' | 'viewer';

function relay(err: unknown): MembersRefusal {
  if (err instanceof NotFoundError) return { refused: 'not_found', message: err.message };
  if (err instanceof ConflictError) return { refused: 'conflict', message: err.message };
  if (err instanceof ForbiddenError) return { refused: 'forbidden', message: err.message };
  if (err instanceof ValidationError) return { refused: 'validation', message: err.message };
  throw err;
}

export async function listMembers(actor: Actor, opts: { cursor?: string | null; limit?: number } = {}) {
  const page = await tenantMembersService.listMembers(actor.tenantId, opts);
  return {
    members: page.members.map((m) => ({
      accountId: m.accountId,
      name: [m.account.firstName, m.account.lastName].filter(Boolean).join(' ') || m.account.email,
      email: m.account.email,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

export async function listInvitations(actor: Actor, opts: { cursor?: string | null; limit?: number } = {}) {
  const page = await tenantMembersService.listInvitations(actor.tenantId, opts);
  return {
    invitations: page.invitations.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      status: i.status,
      expiresAt: i.expiresAt,
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  };
}

/** Invite by email. The invitation mail goes out from the service; the
 *  token never comes back here. */
export async function inviteMember(actor: Actor, email: string, role: InviteRole) {
  requirePermission(actor, 'members:invite');
  try {
    const { invitation } = await tenantMembersService.inviteMember(actor.tenantId, { email, role }, actor.accountId);
    writeAudit(actor, 'tenant_member.invited', {
      invitationId: invitation.id,
      email: invitation.email,
      role: invitation.role,
    });
    return { invited: true, invitation: { id: invitation.id, email: invitation.email, role: invitation.role, expiresAt: invitation.expiresAt } };
  } catch (err) {
    return relay(err);
  }
}

export async function changeRole(actor: Actor, accountId: string, role: TenantMemberRole) {
  requirePermission(actor, 'members:change_role');
  const membership = await tenantMembersService.getMembership(actor.tenantId, accountId);
  if (!membership) return { refused: 'not_found', message: 'That person is not a member of this workspace.' } as MembersRefusal;
  try {
    const member = await tenantMembersService.updateMemberRole(actor.tenantId, membership.id, role, actor.accountId);
    writeAudit(actor, 'tenant_member.role_changed', { memberId: member.id, accountId, newRole: member.role });
    return { changed: true, accountId, previousRole: membership.role, role: member.role };
  } catch (err) {
    return relay(err);
  }
}

export async function removeMember(actor: Actor, accountId: string) {
  requirePermission(actor, 'members:remove');
  const membership = await tenantMembersService.getMembership(actor.tenantId, accountId);
  if (!membership) return { refused: 'not_found', message: 'That person is not a member of this workspace.' } as MembersRefusal;
  try {
    await tenantMembersService.removeMember(actor.tenantId, membership.id, actor.accountId);
    writeAudit(actor, 'tenant_member.removed', { accountId, selfRemoval: accountId === actor.accountId });
    return { removed: true, accountId, role: membership.role };
  } catch (err) {
    return relay(err);
  }
}
