// Correction Permissions
// Per implementation plan: Permission checks for correction actions

import { tenantMembersService } from '../tenant-members/service';
import { correctionRepository } from './repository';
import { AgentAuditLog } from '../agent-audit-logs/types';
import { log } from '../infrastructure/logging';

interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check if a user can perform a correction action
 *
 * Checks:
 * 1. User is a tenant member
 * 2. User's role can perform actions in the correction tool's categories
 * 3. (Optional) User is the original actor (if require_original_actor is set)
 */
export async function checkCorrectionPermissions(
  tenantId: string,
  userId: string,
  originalAction: AgentAuditLog,
  _correctionToolName: string
): Promise<PermissionCheckResult> {
  // 1. Get user's role in tenant
  const membership = await tenantMembersService.getMembership(tenantId, userId);
  if (!membership) {
    return { allowed: false, reason: 'Not a tenant member' };
  }

  // 2. Correcting is its own permission, not a side effect of being allowed to
  //    read the audit log. Borrowing `viewAuditLogs` here made correcting
  //    owner/admin because that is who may open the Audit Logs section, which is
  //    a different question: a member owns the work an agent does for them and
  //    corrects it, while a viewer is read-only and cannot. The narrower rule for
  //    financial corrections is unchanged and applies below.
  if (!tenantMembersService.hasPermission(membership.role, 'submitCorrections')) {
    return {
      allowed: false,
      reason: 'A viewer cannot correct an action.',
    };
  }

  // 3. For certain correction types, require higher permissions
  const registryEntry = await correctionRepository.getRegistryEntryByToolName(originalAction.action);
  if (registryEntry) {
    // Financial corrections (refund, credit, void) require admin or owner
    if (['refund', 'credit', 'void'].includes(registryEntry.correctionType)) {
      const hasManageBilling = tenantMembersService.hasPermission(membership.role, 'manageBilling');
      // Admins can manage corrections but not billing - owners have full access
      const isAdmin = membership.role === 'admin';
      if (!hasManageBilling && !isAdmin && membership.role !== 'owner') {
        return {
          allowed: false,
          reason: 'Financial corrections require admin or owner role',
        };
      }
    }
  }

  // 4. Check if tenant requires original actor
  const correctionConfig = await correctionRepository.getCorrectionConfig(tenantId);
  if (correctionConfig?.requireOriginalActor) {
    const originalUserId = extractUserId(originalAction.triggeredBy);
    if (originalUserId !== userId) {
      // Allow owners and admins to override this restriction
      if (membership.role !== 'owner' && membership.role !== 'admin') {
        return {
          allowed: false,
          reason: 'Only the original actor can correct this action',
        };
      }

      log.info({
        tenantId,
        userId,
        originalUserId,
        role: membership.role,
      }, 'Admin/owner overriding original actor requirement for correction');
    }
  }

  return { allowed: true };
}

// [SE-P2-002] Valid triggered_by prefixes pattern
const TRIGGERED_BY_PATTERN = /^(human|agent|cron|event):(.+)$/;

/**
 * [SE-P2-002] Strict extractUserId with fail-closed logic
 * Extract user ID from triggered_by field
 * Format: "human:{userId}", "agent:{agentId}", "cron:{jobId}", "event:{eventType}"
 * Returns null for non-human triggers or invalid format
 */
export function extractUserId(triggeredBy: string): string | null {
  const match = triggeredBy.match(TRIGGERED_BY_PATTERN);
  if (!match) return null;

  const [, prefix, identifier] = match;
  if (prefix === 'human') return identifier;

  // Non-human triggers don't have user IDs
  return null;
}

/**
 * [SE-P2-002] Check if triggered_by matches a valid format
 */
export function isValidTriggeredBy(triggeredBy: string): boolean {
  return TRIGGERED_BY_PATTERN.test(triggeredBy);
}

/**
 * [SE-P2-002] Get the prefix from a triggered_by string
 */
export function getTriggeredByPrefix(triggeredBy: string): string | null {
  const match = triggeredBy.match(TRIGGERED_BY_PATTERN);
  return match ? match[1] : null;
}

/**
 * [BE-P2-004] Check if the requesting user is the original actor for auto-approve
 */
export function checkRequireOriginalActor(
  triggeredBy: string,
  requestingUserId: string
): { allowed: boolean; reason?: string } {
  const originalUserId = extractUserId(triggeredBy);

  // [SE-P2-002] Fail closed: if we can't extract user ID, deny
  if (originalUserId === null) {
    return {
      allowed: false,
      reason: 'Cannot identify original actor for this action type',
    };
  }

  if (originalUserId !== requestingUserId) {
    return {
      allowed: false,
      reason: 'Only the original actor can correct this action',
    };
  }

  return { allowed: true };
}

/**
 * Check if a user can modify correction config
 * Only owners can modify correction configuration
 */
export async function checkCorrectionConfigPermissions(
  tenantId: string,
  userId: string
): Promise<PermissionCheckResult> {
  const membership = await tenantMembersService.getMembership(tenantId, userId);
  if (!membership) {
    return { allowed: false, reason: 'Not a tenant member' };
  }

  if (membership.role !== 'owner' && membership.role !== 'admin') {
    return {
      allowed: false,
      reason: 'Only owners and admins can modify correction configuration',
    };
  }

  return { allowed: true };
}

