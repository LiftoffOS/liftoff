// Allowed Domains Configuration
// Uses Firebase Remote Config for domain whitelist management
// Editable via Firebase console (project: YOUR_WEB_PROJECT) — no deploy needed
// Set ALLOWED_DOMAINS env var (comma-separated) to bypass Remote Config entirely.
//
// The list is the SERVER template (`getServerTemplate`), namespace
// `firebase-server`, not the client template the console shows first.
//
// The entry `*` opens signup to every domain: the gate stays in place, and
// every account it sees is granted the way an allow-listed domain is. It is
// the one switch for open signup, flipped in Remote Config without a deploy
// and reverted by removing it; the named domains beside it are kept so the
// earlier allow-list is restored exactly when it goes.

import { getRemoteConfig } from 'firebase-admin/remote-config';
import { log } from '../infrastructure/logging';

/** The entry that means "any domain". */
export const OPEN_SIGNUP_ENTRY = '*';

// Open, and the direction this fails in is the whole point.
//
// This is what every caller sees when Remote Config cannot be read — which is
// the normal state of a deployment that has no Remote Config template. A
// fallback that named a fixed domain would lock every other account out of the
// install: 403 on every route, from `accessGate`, with
// nothing in the logs naming the cause, and the person being refused is the
// operator who has just deployed it.
//
// Narrow it with ALLOWED_DOMAINS (comma-separated), which overrides both this
// and Remote Config. '*' is the open-signup entry `isSignupOpen` looks for.
const FALLBACK_DOMAINS = [OPEN_SIGNUP_ENTRY];
const REMOTE_CONFIG_KEY = 'allowed_domains';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

let cachedDomains: string[] = [...FALLBACK_DOMAINS];
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function parseDomainsString(value: string): string[] {
  return value
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(d => d.length > 0);
}

function getEnvOverrideDomains(): string[] | null {
  const envVal = process.env.ALLOWED_DOMAINS;
  if (!envVal) return null;
  const domains = parseDomainsString(envVal);
  return domains.length > 0 ? domains : null;
}

async function loadDomainsFromRemoteConfig(): Promise<string[]> {
  const override = getEnvOverrideDomains();
  if (override) return override;

  try {
    const remoteConfig = getRemoteConfig();
    const template = await remoteConfig.getServerTemplate({
      defaultConfig: {
        [REMOTE_CONFIG_KEY]: FALLBACK_DOMAINS.join(','),
      },
    });
    const config = template.evaluate();
    const domainsString = config.getString(REMOTE_CONFIG_KEY);
    const domains = parseDomainsString(domainsString);
    if (domains.length === 0) {
      log.warn('Remote Config returned empty allowed_domains, using fallback');
      return [...FALLBACK_DOMAINS];
    }
    return domains;
  } catch (error) {
    log.warn({ error }, 'Failed to load allowed domains from Remote Config, using fallback');
    return [...FALLBACK_DOMAINS];
  }
}

export async function initAllowedDomains(): Promise<void> {
  const override = getEnvOverrideDomains();
  if (override) {
    cachedDomains = override;
    log.info({ domains: cachedDomains, source: 'env' }, 'Loaded allowed domains from ALLOWED_DOMAINS env var');
    return;
  }

  cachedDomains = await loadDomainsFromRemoteConfig();
  log.info({ domains: cachedDomains }, 'Loaded allowed domains from Remote Config');

  // Refresh on interval
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  refreshTimer = setInterval(async () => {
    cachedDomains = await loadDomainsFromRemoteConfig();
    log.debug({ domains: cachedDomains }, 'Refreshed allowed domains from Remote Config');
  }, REFRESH_INTERVAL_MS);
}

/** Whether signup is open to every domain (the `*` entry is present). */
export function isSignupOpen(): boolean {
  return cachedDomains.includes(OPEN_SIGNUP_ENTRY);
}

export function isEmailDomainAllowed(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return isSignupOpen() || cachedDomains.includes(domain);
}

// For testing
export function _setCachedDomains(domains: string[]): void {
  cachedDomains = domains;
}

export function _stopRefreshTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
