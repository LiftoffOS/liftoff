// Account profile lookup for presence facepiles.
//
// `accounts` is a platform-backend table and this service runs against its own
// database, so presence cannot join names and avatars the way agent chat does.
// It fetches them instead, from POST /api/internal/account-profiles/profiles.
//
// The tenant id goes with the request: platform-backend joins tenant_members
// and only returns people who share that workspace, so this can never be used
// to read an account outside the thread it is rendering.
//
// Cached for a minute per account. A facepile poll runs every few seconds per
// viewer, and a display name does not change on that timescale; without the
// cache a three-person thread would put an extra request on platform-backend
// every second for as long as the tab is open.
//
// Fails soft. If the lookup is unavailable the viewer still appears, just
// without a name or avatar — a degraded facepile is much better than a
// presence poll that 500s and takes the whole chat header down with it.

import { loadConfig } from '../infrastructure/config.js';
import { getServiceAuthHeaders } from '../infrastructure/service-auth.js';
import { log } from '../infrastructure/logging.js';

export interface AccountProfile {
  accountId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  avatarUrl: string | null;
  /** The person's tenant role, read live by platform-backend from
   *  tenant_members. Absent from a platform-backend older than the field. */
  role?: string;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  profile: AccountProfile;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Resolve profiles for the given account ids. Returns a map keyed by account
 * id; ids that could not be resolved are simply absent.
 */
export async function getAccountProfiles(
  tenantId: string,
  accountIds: string[],
): Promise<Map<string, AccountProfile>> {
  const out = new Map<string, AccountProfile>();
  const now = Date.now();
  const missing: string[] = [];

  for (const id of new Set(accountIds)) {
    const cached = cache.get(id);
    if (cached && cached.expiresAt > now) {
      out.set(id, cached.profile);
    } else {
      missing.push(id);
    }
  }

  if (missing.length === 0) return out;

  try {
    const config = loadConfig();
    const baseUrl = config.PLATFORM_BACKEND_URL.replace(/\/$/, '');
    const headers = await getServiceAuthHeaders(baseUrl, config.WORKFORCE_SERVICE_TOKEN);
    const response = await fetch(`${baseUrl}/api/internal/account-profiles/profiles`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId, accountIds: missing }),
    });

    if (!response.ok) {
      log.warn(
        { status: response.status, count: missing.length },
        'account profile lookup failed - presence will render without names',
      );
      return out;
    }

    const body = (await response.json()) as { profiles?: AccountProfile[] };
    for (const profile of body.profiles ?? []) {
      cache.set(profile.accountId, { profile, expiresAt: now + CACHE_TTL_MS });
      out.set(profile.accountId, profile);
    }
  } catch (err) {
    log.warn(
      { error: (err as Error).message },
      'account profile lookup threw - presence will render without names',
    );
  }

  return out;
}

/** For tests only. Clears the in-process cache. */
export function _resetAccountProfileCache(): void {
  cache.clear();
}
