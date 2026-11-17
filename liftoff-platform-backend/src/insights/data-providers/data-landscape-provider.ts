// Data Landscape Provider
// Proxies to Tenant Runtime for the workspace's own data census.

import { tenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import { log } from '../../infrastructure/logging';
import { countTenantKnowledgeItems } from '../../internal-agents/knowledge-count';
import type { DataLandscapeSummary } from '../../internal-agents/distill-landscape-injection';

/**
 * What is in the systems this workspace is connected to: entity counts per
 * connector, how much content is already indexed, how far back the record
 * goes.
 *
 * Null when the runtime is unreachable. The advisor renders that as "not
 * available right now" rather than as an empty workspace — the two are
 * different answers and only one of them is ever true here.
 */
export async function getDataLandscape(tenantId: string): Promise<DataLandscapeSummary | null> {
  try {
    // The knowledge count is this service's own table, so it is resolved here
    // and passed down rather than asked back for. A failure leaves it
    // undefined, which the landscape reports as null — "not known", never
    // "none".
    const knowledgeItems = await countTenantKnowledgeItems(tenantId);
    return await tenantRuntimeClient.getDataLandscape(
      tenantId,
      knowledgeItems !== undefined ? { knowledgeItems } : undefined,
    );
  } catch (error) {
    log.error(
      { tenantId, error: (error as Error).message },
      'Failed to fetch data landscape from Tenant Runtime',
    );
    return null;
  }
}
