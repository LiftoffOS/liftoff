// Centralized accessor for the URL prefix the UI hands operators when they
// view an agent's webhook page. Mirrors src/infrastructure/control-plane-url.ts
// — same prod-poisoning guard, same fail-loud-on-unset, same caching pattern.
//
// Why a dedicated env var (rather than reusing BACKEND_URL): the webhook
// receiver lives on its own hostname (webhooks.example.com), separate from
// the api host. BACKEND_URL is the OIDC audience claim for Cloud Scheduler
// tokens and the canonical control-plane URL; rotating it for unrelated
// reasons risks silently re-aiming OIDC verification. WEBHOOK_BASE_URL is
// a single-purpose value: the public prefix appended with `/<token>` to
// produce the URL operators paste into their external systems.
//
// Convention: WEBHOOK_BASE_URL is set per environment by Terraform on
// Cloud Run, INCLUDING the path version segment:
//   dev  → https://webhooks-dev.example.com/v1
//   prod → https://webhooks.example.com/v1
// Including /v1 means `inboundUrl(token)` becomes a trivial concat.
//
// `getWebhookBaseUrl()` throws if WEBHOOK_BASE_URL is unset and refuses to
// start when the prod alias is in use under a non-prod ENVIRONMENT (same
// trust-boundary rationale as getBackendUrl).

const PROD_WEBHOOK_BASE_URL = 'https://webhooks.example.com/v1';

let cachedWebhookBaseUrl: string | null = null;

/**
 * Public prefix the UI displays for an agent's webhook URL. Append
 * `/<token>` to produce the full URL operators paste into senders.
 *
 * Throws if unset. Does NOT silently fall back — see the file header for
 * the trust-boundary rationale.
 */
export function getWebhookBaseUrl(): string {
  if (cachedWebhookBaseUrl !== null) return cachedWebhookBaseUrl;
  const raw = process.env.WEBHOOK_BASE_URL;
  if (!raw) {
    throw new Error(
      'WEBHOOK_BASE_URL is unset. Cloud Run deploys set this via terraform; ' +
      'local dev should export WEBHOOK_BASE_URL=http://localhost:8080/v1 (or whatever ' +
      'the local listener path is). No silent prod-URL fallback is allowed — see ' +
      'src/infrastructure/webhook-base-url.ts.',
    );
  }
  // Cross-environment trust guard. Refuses to start if the prod alias is in
  // use under a non-prod ENVIRONMENT. Catches:
  //   - A dev Cloud Run that accidentally inherits the prod env value
  //   - A test that hasn't overridden WEBHOOK_BASE_URL after env was set to prod
  //   - Local dev where the developer copy-pasted the prod URL
  // ENVIRONMENT (not NODE_ENV) is the correct check because NODE_ENV='production'
  // is set in BOTH dev and prod Cloud Run deploys.
  const envName = process.env.ENVIRONMENT;
  if (raw.replace(/\/+$/, '') === PROD_WEBHOOK_BASE_URL && envName !== 'prod') {
    throw new Error(
      `WEBHOOK_BASE_URL is set to the prod alias (${PROD_WEBHOOK_BASE_URL}) but ` +
      `ENVIRONMENT is "${envName ?? 'unset'}" — refusing to start. ` +
      'Set WEBHOOK_BASE_URL to the correct env-specific value: ' +
      'dev=https://webhooks-dev.example.com/v1, staging=https://webhooks-staging.example.com/v1, ' +
      'or http://localhost:8080/v1 for local dev.',
    );
  }
  cachedWebhookBaseUrl = raw.replace(/\/+$/, ''); // strip trailing slashes
  return cachedWebhookBaseUrl;
}

/** Test-only: reset the cache so tests can mutate process.env between cases. */
export function _resetWebhookBaseUrlCacheForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('_resetWebhookBaseUrlCacheForTests called outside tests');
  }
  cachedWebhookBaseUrl = null;
}
