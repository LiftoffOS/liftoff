// src/tenant-members/permissions.ts
//
// The single source of the role rule. Enforced INSIDE the shared workspace
// action functions (src/workspace-actions/), so every surface — the dashboard
// routes, the three assistants, Slack, Teams and a coding tool through them —
// tightens together. Teams (update, status, archive) are member and above;
// viewers read only; collaborators, connections, assignments, members,
// workspace settings, oversight and the audit log are owner/admin.
export type Permission =
  | 'hitl:approve_level_1'    // Admin+ can approve L1 (critical) actions
  | 'hitl:approve_level_2'    // Member+ can approve L2 (standard) actions
  | 'teams:create'
  | 'teams:update'
  | 'teams:status'
  | 'teams:delete'
  | 'collaborators:update'
  | 'connections:manage'
  | 'assignments:manage'
  | 'oversight:update'
  | 'members:invite'
  | 'members:change_role'
  | 'members:remove'
  | 'workspace:rename'
  | 'workspace:ai_vendor'
  | 'audit:read'
  | 'knowledge:write'
  | 'billing:manage'

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  owner: [
    'hitl:approve_level_1',
    'hitl:approve_level_2',
    'teams:create',
    'teams:update',
    'teams:status',
    'teams:delete',
    'collaborators:update',
    'connections:manage',
    'assignments:manage',
    'oversight:update',
    'members:invite',
    'members:change_role',
    'members:remove',
    'workspace:rename',
    'workspace:ai_vendor',
    'audit:read',
    'knowledge:write',
    'billing:manage',
  ],
  admin: [
    'hitl:approve_level_1',
    'hitl:approve_level_2',
    'teams:create',
    'teams:update',
    'teams:status',
    'teams:delete',
    'collaborators:update',
    'connections:manage',
    'assignments:manage',
    'oversight:update',
    'members:invite',
    'members:change_role',
    'members:remove',
    'workspace:rename',
    'workspace:ai_vendor',
    'audit:read',
    'knowledge:write',
  ],
  member: [
    'hitl:approve_level_2',
    'teams:create',
    'teams:update',
    'teams:status',
    'teams:delete',
    'knowledge:write',
  ],
  viewer: [],
}

export function hasPermission(role: string, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false
}

export function canApproveHitl(role: string, hitlLevel: 1 | 2): boolean {
  if (hitlLevel === 1) {
    return hasPermission(role, 'hitl:approve_level_1')
  }
  return hasPermission(role, 'hitl:approve_level_2')
}
