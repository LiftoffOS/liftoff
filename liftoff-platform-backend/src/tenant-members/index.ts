// Tenant Members Module
// Manages multi-tenant membership

export { tenantMembersRouter } from './router';
export { tenantMembersService, ForbiddenError, NotFoundError, ConflictError, ValidationError } from './service';
export { tenantMembersRepository } from './repository';
export { generateInviteToken, hashToken, verifyToken } from './tokens';
export type {
  TenantMember,
  TenantMemberWithAccount,
  TenantInvitation,
  TenantInvitationWithDetails,
  TenantMemberRole,
  TenantInviteStatus,
  TenantMemberAudit,
  Permission,
  InviteMemberInput,
  UpdateMemberRoleInput,
  PaginatedMembersResponse,
  PaginatedInvitationsResponse,
} from './types';
export { ROLE_PERMISSIONS, ROLE_HIERARCHY } from './types';
