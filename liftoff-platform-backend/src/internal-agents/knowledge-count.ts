// How many knowledge items a tenant has, for the data landscape.
//
// The landscape is assembled in the tenant runtime, but the knowledge base is
// a control-plane table. Rather than have the runtime call back for a number
// this service already holds — nesting a network call inside one we are
// already waiting on — the count is resolved here and passed down.
//
// Returns `undefined`, never 0, when it cannot be established. The landscape
// carries `knowledgeItems: number | null` for exactly this reason: a failed
// lookup reported as zero tells an agent its knowledge base is empty, and it
// would say so with the same confidence it says anything else.

import { countAllByTenant } from '../knowledge/repository';
import { log } from '../infrastructure/logging';

/**
 * Every synced knowledge item in the workspace.
 *
 * Tenant-wide rather than scoped to an agent's connector bindings: the
 * landscape describes what the workspace HAS, and a manually-uploaded document
 * is as searchable as a synced one. Scoping it to bindings would report a
 * smaller number and present it as the total.
 */
export async function countTenantKnowledgeItems(tenantId: string): Promise<number | undefined> {
  try {
    return await countAllByTenant(tenantId);
  } catch (err) {
    log.warn(
      { err: (err as Error).message, tenantId },
      'knowledge count for data landscape failed — the landscape will report it as unknown',
    );
    return undefined;
  }
}
