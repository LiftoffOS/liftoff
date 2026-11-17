// The datasets a job already holds, as the block a turn is shown at its
// start.
//
// A fetch whose result is larger than one message is parked as a dataset for
// the job (a conversation, or a run) and read back through the dataset tools.
// The store is the control plane's; until now nothing told the next turn the
// datasets existed unless the model happened to call dataset_list, and a turn
// that started blind fetched again. The control plane renders the inventory
// (newest first, budgeted, with the same words its own assistants read) and
// serves it through dataset_list with `inventory: true`; this asks once per
// turn and keeps the answer for the turn, so a run's system prompt and each
// of its step prompts read one call rather than one each.
//
// Never throws, never delays a turn by more than its short timeout: an
// inventory that could not be read is an empty block, and the model still has
// dataset_list.

import { runDatasetToolViaBackend } from '../clients/platform-backend-client';
import { logger } from '../infrastructure/logging';

/** How long one turn's answer is kept. A turn is bounded well under this,
 *  and a later turn on the same job asks again. */
const TURN_CACHE_MS = 60_000;

const cache = new Map<string, { at: number; block: string; pending?: Promise<string> }>();

function keyOf(tenantId: string, scopeId: string): string {
  return `${tenantId}:${scopeId}`;
}

/**
 * The inventory block for a job, or '' when the job holds no datasets.
 *
 * `scopeId` is the job the datasets were parked for: the conversation when
 * there is one, else the run (the same rule the dataset tools scope by,
 * standard-tool-handler.ts datasetScopeId).
 */
export async function datasetInventoryBlock(tenantId: string, scopeId: string | undefined): Promise<string> {
  if (!scopeId) return '';
  const key = keyOf(tenantId, scopeId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TURN_CACHE_MS) {
    return hit.pending ? hit.pending : hit.block;
  }
  const pending = runDatasetToolViaBackend(tenantId, 'dataset_list', { inventory: true }, scopeId)
    .then((text) => {
      const block = text.trim();
      cache.set(key, { at: Date.now(), block });
      return block;
    })
    .catch((err: unknown) => {
      logger.warn({ tenantId, scopeId, err: (err as Error).message }, 'dataset inventory could not be read; the turn starts without it');
      cache.set(key, { at: Date.now(), block: '' });
      return '';
    });
  cache.set(key, { at: Date.now(), block: '', pending });
  return pending;
}

/** Forget a job's cached inventory, so the next turn asks again. */
export function forgetDatasetInventory(tenantId: string, scopeId: string | undefined): void {
  if (scopeId) cache.delete(keyOf(tenantId, scopeId));
}

/** Tests only. */
export function _clearDatasetInventoryCacheForTests(): void {
  cache.clear();
}
