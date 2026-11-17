// The role rule as the workspace actions see it.
//
// src/tenant-members/permissions.ts is the single source; this module is the
// one door the shared action functions and their tool registries import it
// through, so the surface that enforces the rule is easy to find. Nothing is
// redefined here.

export {
  ROLE_PERMISSIONS,
  canApproveHitl,
  hasPermission,
  type Permission,
} from '../tenant-members/permissions';
