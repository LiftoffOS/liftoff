// Centralized accessors for the public URL of THIS platform-backend deployment.
//
// Why this exists: the prior pattern of
//
//   const url = process.env.BACKEND_URL || 'https://api.example.com'
//
// repeated across ~7 files was a cross-environment trust bug. A dev backend
// missing BACKEND_URL silently used the prod alias — meaning OIDC verification,
// outbound URLs in Slack OAuth callbacks, A2A agent card URLs, and proxy setup
// instructions all silently pointed at prod, creating both:
//   - operational risk (dev → prod data leaks)
//   - security risk (cross-env OIDC token replay)
//
// Convention: BACKEND_URL is set per environment by Terraform on Cloud Run:
//   dev  → https://api-dev.example.com
//   prod → https://api.example.com
// Local dev sets BACKEND_URL=http://localhost:8080 via .env.example.
//
// `getBackendUrl()` throws if BACKEND_URL is unset. It ALSO throws if
// BACKEND_URL equals the prod alias while the deployment environment is not
// 'prod' (catches the prior silent-fallback pattern leaking back in).
//
// IMPORTANT — env-name source: we use ENVIRONMENT, not NODE_ENV.
// NODE_ENV is set to 'production' in BOTH dev and prod Cloud Run deploys (it
// controls runtime mode like log levels and source-map stripping). ENVIRONMENT
// is the actual environment name: 'dev', 'staging', or 'prod' — set by
// terraform.

const PROD_BACKEND_URL = 'https://api.example.com';

let cachedBackendUrl: string | null = null;

/**
 * Public URL of this platform-backend deployment.
 *
 * - Cloud Run: terraform sets BACKEND_URL to the env-specific alias.
 * - Local dev: developer sets BACKEND_URL=http://localhost:8080 in .env
 *   (see .env.example).
 *
 * Throws if unset. Does NOT silently fall back to the prod URL — see the
 * file header for the trust-boundary rationale.
 */
export function getBackendUrl(): string {
  if (cachedBackendUrl !== null) return cachedBackendUrl;
  const raw = process.env.BACKEND_URL;
  if (!raw) {
    throw new Error(
      'BACKEND_URL is unset. Cloud Run deploys set this via terraform; ' +
      'local dev should export BACKEND_URL=http://localhost:8080 (see .env.example). ' +
      'No silent prod-URL fallback is allowed — see src/infrastructure/control-plane-url.ts.',
    );
  }
  // Cross-environment trust guard. If BACKEND_URL is the prod alias but
  // ENVIRONMENT is something other than 'prod' (e.g. 'dev', 'staging', 'test',
  // or the unset local-dev case), refuse to start. This catches:
  //   - A dev Cloud Run that accidentally inherits the prod env value
  //   - A test that hasn't overridden BACKEND_URL after env was set to prod
  //   - Local dev where the developer copy-pasted the prod URL
  // ENVIRONMENT (not NODE_ENV) is the correct check because NODE_ENV='production'
  // is set in BOTH dev and prod Cloud Run deploys.
  const envName = process.env.ENVIRONMENT;
  if (raw === PROD_BACKEND_URL && envName !== 'prod') {
    throw new Error(
      `BACKEND_URL is set to the prod alias (${PROD_BACKEND_URL}) but ENVIRONMENT ` +
      `is "${envName ?? 'unset'}" — refusing to start. ` +
      'Set BACKEND_URL to the correct env-specific value: ' +
      'dev=https://api-dev.example.com, staging=https://api-staging.example.com, ' +
      'or http://localhost:8080 for local dev.',
    );
  }
  cachedBackendUrl = raw.replace(/\/+$/, ''); // strip trailing slashes
  return cachedBackendUrl;
}

/**
 * Returns BACKEND_URL or null if unset. Use only when the caller can degrade
 * gracefully (e.g. emit a non-fatal warning). All hot-path URL construction
 * MUST use `getBackendUrl()` which throws.
 */
export function getBackendUrlOrNull(): string | null {
  try {
    return getBackendUrl();
  } catch {
    return null;
  }
}

/**
 * Public proxy URL (developer-proxy path on the same host). Used in setup
 * instructions shown to users. Falls through to getBackendUrl() and appends
 * /proxy, so all the same guarantees apply.
 */
export function getProxyBaseUrl(): string {
  // Allow an explicit override (rare — e.g. proxy mounted on a different
  // host) but reject the prior silent-prod-fallback for the same reason.
  const override = process.env.PROXY_BASE_URL;
  if (override) {
    const envName = process.env.ENVIRONMENT;
    if (override === `${PROD_BACKEND_URL}/proxy` && envName !== 'prod') {
      throw new Error(
        `PROXY_BASE_URL is set to the prod alias but ENVIRONMENT is ` +
        `"${envName ?? 'unset'}" — refusing to start.`,
      );
    }
    return override.replace(/\/+$/, '');
  }
  return `${getBackendUrl()}/proxy`;
}

/** Test-only: reset the cache so tests can mutate process.env between cases. */
export function _resetBackendUrlCacheForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetBackendUrlCacheForTests called outside tests');
  }
  cachedBackendUrl = null;
}
