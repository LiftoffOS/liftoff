// Reads `platform_vendor_policy` into the synchronous policy the LLM client
// consults, and keeps it current.
//
// Same shape as workspace-ai-vendor-loader and model-pricing-loader, for the
// same reason: the policy is read on a request path, so the lookup must stay
// synchronous and in-process. A per-call database read would put network I/O in
// front of every platform LLM call.
//
// NEVER THROWS past the caller's choice. A failed load leaves whatever was last
// installed — and before the first load, the code fallback. So a database blip
// degrades to today's behaviour rather than to no routing at all, which is the
// property that makes a runtime-mutable routing decision safe to ship.

import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import {
  PLATFORM_VENDOR_AREAS,
  setPlatformVendorPolicy,
  type PlatformVendorArea,
} from './platform-vendor-policy';
import { isWorkspaceAiSelection, type WorkspaceAiSelection } from './workspace-ai-vendors';

/** 60 seconds, not the 15 minutes the registry snapshot uses.
 *
 *  This is the BACKSTOP, not the delivery mechanism — an admin write publishes
 *  `platform.vendor_policy.updated` and the planes refresh on arrival. The poll
 *  exists because a Pub/Sub message can be lost, which is not hypothetical
 *  here: model-config-reconciler.ts exists because one was, and it names the
 *  tenant it caught. A minute bounds how long a lost push can leave a lever
 *  stale; fifteen would not be worth calling fast. */
const REFRESH_MS = 60_000;

let timer: NodeJS.Timeout | null = null;

/** Read the four rows and install them. Returns how many areas were applied. */
export async function refreshPlatformVendorPolicy(): Promise<number> {
  const { rows } = await getPool().query<{ area: string; vendor: string }>(
    `SELECT area, vendor FROM platform_vendor_policy`,
  );
  const next: Partial<Record<PlatformVendorArea, WorkspaceAiSelection>> = {};
  let applied = 0;
  for (const row of rows) {
    if (!(PLATFORM_VENDOR_AREAS as readonly string[]).includes(row.area)) {
      // An area this build does not know. Skipped loudly rather than dropped:
      // it means the table is ahead of the code, which is a deploy ordering
      // question somebody needs to see.
      log.warn({ area: row.area }, 'platform vendor policy: unknown area in the table, skipped');
      continue;
    }
    if (!isWorkspaceAiSelection(row.vendor)) {
      log.error(
        { area: row.area, vendor: row.vendor },
        'platform vendor policy: unrecognised vendor, area left on its fallback',
      );
      continue;
    }
    next[row.area as PlatformVendorArea] = row.vendor;
    applied++;
  }
  setPlatformVendorPolicy(next);
  return applied;
}

/** Start the backstop poll. Immediate best-effort load, then periodic. */
export function startPlatformVendorPolicyRefresh(ms: number = REFRESH_MS): void {
  refreshPlatformVendorPolicy().then(
    (applied) => log.info({ applied }, 'platform vendor policy loaded'),
    (err) => log.warn({ err }, 'platform vendor policy load failed; using the code fallback'),
  );
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    refreshPlatformVendorPolicy()
      .then((applied) => log.debug({ applied }, 'platform vendor policy refreshed'))
      .catch((err) =>
        log.warn({ err }, 'platform vendor policy refresh failed; keeping the last-known map'),
      );
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Stop the poll. TEST-ONLY — the process exits with the timer unref'd, so
 *  nothing in production needs to stop it. */
export function _stopPlatformVendorPolicyRefresh(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
