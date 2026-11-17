// Usage Data Provider
// Proxies to Tenant Runtime for burn state and usage dashboard data

import { tenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import { log } from '../../infrastructure/logging';
import type { UsageDashboard } from '../types';

/**
 * Get usage dashboard data (burn state) for a tenant.
 * Proxies to Tenant Runtime GET /api/usage-ledger/burn/:tenantId
 */
export async function getUsageDashboard(
  tenantId: string,
): Promise<UsageDashboard | null> {
  try {
    return await tenantRuntimeClient.getBurnState(tenantId);
  } catch (error) {
    log.error({ tenantId, error: (error as Error).message }, 'Failed to fetch usage dashboard from Tenant Runtime');
    return null;
  }
}
