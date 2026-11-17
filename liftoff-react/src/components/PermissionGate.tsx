import { useAuth } from '../contexts/AuthContext';
import type { TenantRole } from '../services/tenants';

type Permission = 'manage_members' | 'invite_members' | 'manage_settings' | 'edit_teams'
  | 'view_teams' | 'manage_billing' | 'submit_corrections' | 'manage_connections';

const PERMISSION_ROLES: Record<Permission, TenantRole[]> = {
  manage_members: ['owner', 'admin'],
  invite_members: ['owner', 'admin'],
  manage_settings: ['owner', 'admin'],
  edit_teams: ['owner', 'admin', 'member'],
  view_teams: ['owner', 'admin', 'member', 'viewer'],
  manage_billing: ['owner', 'admin'],
  // Correcting an action an agent took. Member and above, matching the
  // submitCorrections permission the API checks: a member owns the work done for
  // them and corrects it; a view-only seat does not.
  submit_corrections: ['owner', 'admin', 'member'],
  // Connecting an app, or managing a connection. Owner and admin, matching the
  // manageConnectors permission the API checks on every connector write.
  manage_connections: ['owner', 'admin'],
};

interface PermissionGateProps {
  permission: Permission;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

export function PermissionGate({ permission, fallback = null, children }: PermissionGateProps) {
  const { currentRole } = useAuth();

  if (!currentRole) return fallback;

  const allowedRoles = PERMISSION_ROLES[permission];
  if (!allowedRoles.includes(currentRole)) return fallback;

  return <>{children}</>;
}
