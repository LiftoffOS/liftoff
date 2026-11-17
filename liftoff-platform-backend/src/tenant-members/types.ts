// Tenant Members Types
// Per Section 1.2: Types for multi-tenant membership

export type TenantMemberRole = 'owner' | 'admin' | 'member' | 'viewer';
export type TenantInviteStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'revoked';

// Role hierarchy for permission checks
export const ROLE_HIERARCHY = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
} as const;

// Permission types
export type Permission =
  | 'viewDashboard'
  | 'editTeams'
  | 'manageConnectors'
  | 'inviteMembers'
  | 'removeMember'
  | 'changeRole'
  | 'transferOwnership'
  | 'deleteTenant'
  | 'manageBilling'
  | 'viewAuditLogs'  // NEW - dedicated audit permission
  | 'manageAssignments'  // Owner/admin only: assign people to agents
  | 'manageClaudeCodeProxy'  // Admin/owner: manage all proxy keys in tenant
  | 'exportWorkspaceData'  // Owner/admin: download a copy of the workspace (Settings → Workspace)
  | 'converseWithAgents'  // Member+: send a message to an agent or a platform
                          // assistant. A viewer reads every conversation and
                          // starts no turn, because answering one performs
                          // workspace actions and spends the workspace's money.
  | 'submitCorrections';  // Member+: correct an action an agent took (Activity). A viewer
                          // is read-only and cannot; financial corrections are narrower
                          // still and stay owner/admin (corrections/permissions.ts).

// Role permissions matrix per plan
export const ROLE_PERMISSIONS: Record<TenantMemberRole, Record<Permission, boolean>> = {
  owner: {
    viewDashboard: true,
    editTeams: true,
    manageConnectors: true,
    inviteMembers: true,
    removeMember: true,
    changeRole: true,
    transferOwnership: true,
    deleteTenant: true,
    manageBilling: true,
    viewAuditLogs: true,
    manageAssignments: true,
    manageClaudeCodeProxy: true,
    exportWorkspaceData: true,
    submitCorrections: true,
    converseWithAgents: true,
  },
  admin: {
    viewDashboard: true,
    editTeams: true,
    manageConnectors: true,
    inviteMembers: true,
    removeMember: true, // Cannot remove owners (enforced in middleware)
    changeRole: true,   // Cannot change owner role (enforced in middleware)
    transferOwnership: false,
    deleteTenant: false,
    manageBilling: false,
    viewAuditLogs: true,
    manageAssignments: true,
    manageClaudeCodeProxy: true,
    exportWorkspaceData: true,
    submitCorrections: true,
    converseWithAgents: true,
  },
  member: {
    viewDashboard: true,
    editTeams: true,
    manageConnectors: false,
    inviteMembers: false,
    removeMember: false,
    changeRole: false,
    transferOwnership: false,
    deleteTenant: false,
    manageBilling: false,
    viewAuditLogs: false,
    manageAssignments: false,
    manageClaudeCodeProxy: false,
    exportWorkspaceData: false,
    submitCorrections: true,
    converseWithAgents: true,
  },
  viewer: {
    viewDashboard: true,
    editTeams: false,
    manageConnectors: false,
    inviteMembers: false,
    removeMember: false,
    changeRole: false,
    transferOwnership: false,
    deleteTenant: false,
    manageBilling: false,
    viewAuditLogs: false,
    manageAssignments: false,
    manageClaudeCodeProxy: false,
    exportWorkspaceData: false,
    submitCorrections: false,
    converseWithAgents: false,
  },
};

export interface TenantMember {
  id: string;
  tenantId: string;
  accountId: string;
  role: TenantMemberRole;
  invitedBy: string | null;
  invitedAt: Date | null;
  joinedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantMemberWithAccount extends TenantMember {
  account: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
    avatarUrl: string | null;
  };
}

export interface TenantInvitation {
  id: string;
  tenantId: string;
  email: string;
  role: TenantMemberRole;
  inviteTokenHash: string;
  status: TenantInviteStatus;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  accountId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantInvitationWithDetails extends TenantInvitation {
  tenantName: string;
  invitedByAccount: {
    id: string;
    firstName: string | null;
    lastName: string | null;
  };
}

export interface TenantMemberAudit {
  id: string;
  tenantId: string;
  accountId: string | null;
  action: string;
  changes: Record<string, unknown> | null;
  actorId: string | null;
  previousState: Record<string, unknown> | null;
  newState: Record<string, unknown> | null;
  createdAt: Date;
}

// Input types
export interface InviteMemberInput {
  email: string;
  role: 'admin' | 'member' | 'viewer'; // Cannot invite as owner
}

export interface UpdateMemberRoleInput {
  role: TenantMemberRole;
}

// Paginated response
export interface PaginatedMembersResponse {
  members: TenantMemberWithAccount[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PaginatedInvitationsResponse {
  invitations: TenantInvitationWithDetails[];
  nextCursor: string | null;
  hasMore: boolean;
}

// [SE-007] Pending ownership transfer for two-step confirmation
export type OwnershipTransferStatus = 'pending' | 'confirmed' | 'expired' | 'canceled';

export interface PendingOwnershipTransfer {
  id: string;
  tenantId: string;
  currentOwnerId: string;
  newOwnerId: string;
  confirmationTokenHash: string;
  status: OwnershipTransferStatus;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PendingOwnershipTransferWithDetails extends PendingOwnershipTransfer {
  tenantName: string;
  currentOwner: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
  };
  newOwner: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string;
  };
}

// Audit query types
export interface AuditQueryParams {
  startDate: string;  // ISO 8601
  endDate: string;    // ISO 8601
  cursor?: string;
  limit?: number;
}

