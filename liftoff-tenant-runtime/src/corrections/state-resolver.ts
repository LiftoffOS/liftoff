// State Resolver
// Per implementation plan: Resolve before/after state from Action Ledger

import { logger } from '../infrastructure/logging';
import { ActionRepository } from '../action-ledger/repository';
import { PreActionSnapshot } from './types';

const actionLedger = new ActionRepository();

/**
 * Get pre-action snapshot from Action Ledger
 */
export async function getPreActionSnapshot(
  tenantId: string,
  auditLogId: string
): Promise<PreActionSnapshot | null> {
  try {
    // Query Action Ledger for the snapshot captured before this action
    const ledgerEntry = await actionLedger.findByAuditLogId(tenantId, auditLogId);

    if (!ledgerEntry || !ledgerEntry.preActionState) {
      logger.warn('Pre-action snapshot not available', {
        tenantId,
        auditLogId,
      });
      return null;
    }

    return {
      resourceId: ledgerEntry.resourceId,
      resourceType: ledgerEntry.resourceType,
      data: ledgerEntry.preActionState,
      fetchedAt: ledgerEntry.createdAt,
    };
  } catch (error) {
    logger.error('Failed to get pre-action snapshot', {
      tenantId,
      auditLogId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Get pre-action snapshot with validation
 */
export async function getPreActionSnapshotWithValidation(
  tenantId: string,
  auditLogId: string,
  requiresPreviousState: boolean
): Promise<{ snapshot: PreActionSnapshot | null; available: boolean }> {
  // Check if Action Ledger has this capability enabled
  const ledgerCapabilities = await getActionLedgerCapabilities(tenantId);

  if (!ledgerCapabilities.preActionSnapshots) {
    if (requiresPreviousState) {
      // Cannot proceed - snapshot required but not available
      return { snapshot: null, available: false };
    }
    // Can proceed without snapshot (e.g., CREATE → ARCHIVE)
    return { snapshot: null, available: true };
  }

  const snapshot = await getPreActionSnapshot(tenantId, auditLogId);

  if (!snapshot) {
    if (requiresPreviousState) {
      return { snapshot: null, available: false };
    }
    return { snapshot: null, available: true };
  }

  return { snapshot, available: true };
}

/**
 * Get Action Ledger capabilities for a tenant
 */
async function getActionLedgerCapabilities(
  _tenantId: string
): Promise<{ preActionSnapshots: boolean }> {
  // For now, assume all tenants have snapshot capability
  // In production, this would check tenant configuration
  return { preActionSnapshots: true };
}
