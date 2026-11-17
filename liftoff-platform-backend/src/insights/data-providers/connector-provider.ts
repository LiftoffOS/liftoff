// Connector Health Data Provider
// Proxies to Tenant Runtime for action ledger data (connector, status, duration)

import { tenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import { log } from '../../infrastructure/logging';
import type { TimeRange, ConnectorHealthEntry } from '../types';

/**
 * Get connector health data aggregated from Tenant Runtime actions table.
 * Groups actions by connector, calculates success/failure/error rates.
 */
export async function getConnectorHealth(
  tenantId: string,
  range: TimeRange,
): Promise<ConnectorHealthEntry[] | null> {
  try {
    return await tenantRuntimeClient.getActionsByConnector(
      tenantId,
      range.start.toISOString(),
      range.end.toISOString(),
    );
  } catch (error) {
    log.error({ tenantId, error: (error as Error).message }, 'Failed to fetch connector health from Tenant Runtime');
    return null;
  }
}
