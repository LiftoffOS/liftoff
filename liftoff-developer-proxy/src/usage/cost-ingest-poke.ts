// Tell platform-backend that usage was recorded here.
//
// Its cost pass reads this service's usage over the ingestion feed, and it no
// longer runs on an hourly clock: it is armed by spend signals. Nothing in
// platform-backend sees spend that happens here, so after recording usage this
// service pokes it, and the pass (which also drains this service's audit
// outbox, see usage/routes.ts) is armed exactly as for spend seen there.
//
// Once per 10-minute bucket per instance: platform-backend arms one pass per
// bucket anyway, so a second poke inside the same bucket buys nothing. Never
// throws and gives up after a short timeout — a usage record must not wait on
// platform-backend; a poke that is lost costs latency, and the daily
// housekeeping pass still runs the cost pass.

import { loadConfig } from '../infrastructure/config.js';
import { resolvePlatformBackendToken } from '../infrastructure/platform-backend-token.js';

export const POKE_BUCKET_MS = 10 * 60 * 1000;
export const POKE_TIMEOUT_MS = 3_000;

let lastPokedBucket = -1;

export async function pokeCostIngest(now: number = Date.now()): Promise<void> {
  const bucket = Math.floor(now / POKE_BUCKET_MS);
  if (bucket === lastPokedBucket) return;
  const config = loadConfig();
  if (!config.CONTROL_PLANE_API_URL) return;
  lastPokedBucket = bucket;
  try {
    const token = await resolvePlatformBackendToken();
    const res = await fetch(`${config.CONTROL_PLANE_API_URL}/api/internal/jobs/cost-attribution-ingest/soon`, {
      method: 'POST',
      headers: { 'x-service-auth': token },
      signal: AbortSignal.timeout(POKE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    lastPokedBucket = -1;
    console.warn('[cost-ingest-poke] platform-backend not poked; the daily pass will ingest', {
      error: (err as Error).message,
    });
  }
}

/** Test seam. */
export function _resetPokeMemo(): void {
  lastPokedBucket = -1;
}
