// Secret Manager Integration
// Per Section 20: Secret Manager for credentials
// Per Phase 0.4: SE-012 - Add TTL to secret cache (5-minute refresh)

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { log } from './logging';

const client = new SecretManagerServiceClient();
const projectId = process.env.GCP_PROJECT_ID;

// Cache TTL in milliseconds (5 minutes per SE-012)
const CACHE_TTL_MS = 5 * 60 * 1000;

// Cache entry with timestamp for TTL tracking
interface CacheEntry {
  value: string;
  cachedAt: number;
}

// Cache for loaded secrets with TTL support
const secretCache = new Map<string, CacheEntry>();

// Check if a cache entry is still valid
function isCacheEntryValid(entry: CacheEntry): boolean {
  return Date.now() - entry.cachedAt < CACHE_TTL_MS;
}

// Per Section 20: Secret Manager for credentials
// Per SE-012: Cache entries expire after 5 minutes
export async function getSecret(secretName: string, version = 'latest'): Promise<string> {
  const cacheKey = `${secretName}:${version}`;

  // Return cached value if available and not expired
  const cached = secretCache.get(cacheKey);
  if (cached && isCacheEntryValid(cached)) {
    return cached.value;
  }

  const name = `projects/${projectId}/secrets/${secretName}/versions/${version}`;

  try {
    const [response] = await client.accessSecretVersion({ name });
    const secretValue = response.payload?.data?.toString() || '';

    // Cache the secret with timestamp
    secretCache.set(cacheKey, {
      value: secretValue,
      cachedAt: Date.now(),
    });

    log.info({ secret: secretName, version }, 'Secret loaded from Secret Manager');
    return secretValue;
  } catch (error) {
    const wrapped = new Error(`Failed to load secret: ${secretName}: ${(error as Error).message}`);
    // Preserve the gRPC status code (5 = NOT_FOUND, 7 = PERMISSION_DENIED) on the
    // wrapped error so callers — notably loadSecretsToEnv — can distinguish an
    // optional secret that was simply never provisioned (NOT_FOUND, benign) from
    // a genuine access failure (PERMISSION_DENIED, worth an ERROR + alert).
    const code = (error as { code?: number }).code;
    if (typeof code === 'number') {
      (wrapped as Error & { code?: number }).code = code;
    }
    throw wrapped;
  }
}

// Load multiple secrets at once
export async function loadSecrets(secretNames: string[]): Promise<Record<string, string>> {
  const results: Record<string, string> = {};

  await Promise.all(
    secretNames.map(async (name) => {
      results[name] = await getSecret(name);
    })
  );

  return results;
}

// Clear entire secret cache (for testing or rotation)
export function clearSecretCache(): void {
  secretCache.clear();
}

// Clear a single cached secret entry (e.g., after Anthropic key rotation)
export function clearSecretCacheEntry(secretName: string, version = 'latest'): void {
  const cacheKey = `${secretName}:${version}`;
  secretCache.delete(cacheKey);
}

// ──────────────────────────────────────────────────────────────────────────
// Startup secret hydration
//
// The platform backend owns its own secret loading. Cloud Run does NOT bind
// any of these as env vars (cloudbuild has no --set-secrets flag). At
// process startup loadSecretsToEnv() fetches each secret from Secret
// Manager and sets process.env[envVar] so the rest of the codebase can
// keep doing process.env.X synchronously without caring where the value
// came from.
//
// Why this exists: when Cloud Run secret bindings are managed by deploy
// tooling (cloudbuild --set-secrets) AND infrastructure tooling (Terraform
// google_cloud_run_v2_service template containers env value_source
// secret_key_ref), the two will eventually step on each other and one
// side will wipe the other's bindings: for example, a cloudbuild deploy
// without a secret in its --set-secrets list wipes the binding Terraform
// set, and the service loses that secret. Loading secrets in-process removes any reason for either tool
// to touch Cloud Run secret bindings, closing the entire class of "who
// owns this binding" bugs.
//
// To add a new secret: append to the manifest below. The Cloud Run service
// account already has secretmanager.secretAccessor on the platform-control
// project's Secret Manager, so any new secret created in that project is
// automatically readable.
// ──────────────────────────────────────────────────────────────────────────

interface SecretManifestEntry {
  envVar: string;
  secretName: string;
  /** If true, startup fails when this secret can't be loaded. */
  required: boolean;
}

function buildAnthropicGroupManifestEntries(): SecretManifestEntry[] {
  // WS-7.2 — per-group Anthropic keys. Loaded eagerly so an IAM-denial is
  // caught at boot, not at the first LLM completion. `secretName` is computed
  // from deriveEnvSuffix() so dev/prod each look up the right secret.
  const envSuffix = (() => {
    const projectId = process.env.GCP_PROJECT_ID ?? '';
    if (projectId.endsWith('-dev')) return '-dev';
    if (projectId.endsWith('-prod')) return '-prod';
    return '';
  })();
  if (!envSuffix) {
    // Local dev / unknown environment — leave the lookup to the on-demand
    // path. The legacy unsuffixed `anthropic-api-key` entry below acts as
    // the fallback in this case.
    return [];
  }
  const groups: Array<{ envVar: string; group: string }> = [
    { envVar: 'ANTHROPIC_API_KEY_AGENT_EXECUTION', group: 'agent-execution' },
    { envVar: 'ANTHROPIC_API_KEY_BACKGROUND_SERVICES', group: 'background-services' },
    { envVar: 'ANTHROPIC_API_KEY_PLATFORM_ANALYTICS', group: 'platform-analytics' },
    { envVar: 'ANTHROPIC_API_KEY_REFLECTIVE_SERVICES', group: 'reflective-services' },
  ];
  return groups.map((g) => ({
    envVar: g.envVar,
    secretName: `anthropic-api-key-${g.group}${envSuffix}`,
    required: true,
  }));
}

const SECRET_MANIFEST: readonly SecretManifestEntry[] = [
  { envVar: 'DB_PASSWORD', secretName: 'db-password', required: true },
  { envVar: 'STRIPE_SECRET_KEY', secretName: 'stripe-secret-key', required: true },
  { envVar: 'STRIPE_WEBHOOK_SECRET', secretName: 'stripe-webhook-secret', required: true },
  { envVar: 'TENANT_RUNTIME_SERVICE_TOKEN', secretName: 'tenant-runtime-service-token', required: true },
  // FIREBASE_SERVICE_ACCOUNT intentionally NOT in the manifest. Prod + dev
  // Cloud Run init the Firebase Admin SDK via Application Default Credentials —
  // the runtime SA has roles/firebase.admin on YOUR_WEB_PROJECT (where the
  // Firebase Auth users live). Local dev: set FIREBASE_SERVICE_ACCOUNT in
  // .env.local with explicit JSON if you want to override ADC. There is no
  // `firebase-service-account` Secret Manager entry in either env; previously
  // attempting to load it caused noisy 5 NOT_FOUND log lines on every startup.
  { envVar: 'RESEND_API_KEY', secretName: 'resend-api-key', required: false },
  { envVar: 'OPENAI_API_KEY', secretName: 'openai-api-key', required: false },
  { envVar: 'ANTHROPIC_API_KEY', secretName: 'anthropic-api-key', required: false },
  // Organisation admin credential for the billing reconciler's usage and cost
  // reports. Optional: without it the reconciler records our own side and
  // reports the vendor side as missing, rather than failing the boot.
  { envVar: 'ANTHROPIC_ADMIN_KEY', secretName: 'anthropic-admin-key', required: false },
  ...buildAnthropicGroupManifestEntries(),
  { envVar: 'SLACK_CONFIG_REFRESH_TOKEN', secretName: 'slack-config-refresh-token', required: false },
  { envVar: 'WORKFORCE_SERVICE_TOKEN', secretName: 'workforce-service-token', required: false },
  { envVar: 'GOVERNANCE_EVAL_SERVICE_TOKEN', secretName: 'governance-eval-service-token', required: false },
  { envVar: 'HARVEST_SERVICE_TOKEN', secretName: 'harvest-service-token', required: false },
  // X-Service-Auth header value Cloud Scheduler sends to the /api/internal/maintenance/*
  // endpoints (expire-agent-messages, cleanup-slack-event-dedup, etc.) AND the
  // shared secret the tenant runtime presents on every platform-tools callback
  // (find-teammates / send-agent-message / enqueue-agent-task / skill-feedback /
  // composio-tool-calls). Without it hydrated, serviceAuth() returns 500 and the entire
  // A2A-collaboration + billing-callback + notifications + skills surface breaks. required:true
  // so PB fails fast at boot instead of silently 500ing every callback (hydration is skipped
  // when GCP_PROJECT_ID is unset, so local/CI are unaffected).
  { envVar: 'PLATFORM_CALLBACK_TOKEN', secretName: 'platform-callback-token', required: true },
  // HMAC key for signing unsubscribe URLs in notification emails. Read by
  // src/notifications/unsubscribe.ts. Optional so dev environments without
  // notification email delivery don't fail startup — NOTIFICATION_DELIVERY_ENABLED
  // is the runtime gate. Flip to required:true when notifications go GA.
  { envVar: 'UNSUBSCRIBE_SECRET', secretName: 'unsubscribe-secret', required: false },
  // HMAC key for signing signup Approve/Waitlist action links (the emails sent
  // to signups@example.com). Read by src/accounts/signup-approval-tokens.ts.
  // Optional so environments without the secret provisioned don't fail startup;
  // buildSignupApprovalToken refuses to issue unsigned tokens when it is unset.
  { envVar: 'SIGNUP_APPROVAL_SECRET', secretName: 'signup-approval-secret', required: false },
  // AES-256-GCM master key for per-source webhook signing-secret encryption
  // (event_sources.signing_secret_ciphertext). 32 random bytes hex-encoded.
  // Required: the event-sources module fails fast when missing rather than
  // falling back to plaintext, so missing key = immediate boot failure
  // rather than a runtime 500 when someone provisions a webhook. Use
  // distinct keys per environment.
  { envVar: 'EVENT_SOURCE_ENCRYPTION_KEY', secretName: 'event-source-encryption-key', required: true },
];

/**
 * Load every secret in the manifest from Secret Manager and write it to
 * process.env. Idempotent: if an env var is already set (local dev,
 * override, test), the existing value is kept and Secret Manager is not
 * called for that entry.
 *
 * Throws if any required secret cannot be loaded — fail-fast at startup
 * is better than silently running with missing credentials and 500ing on
 * the first request.
 */
export async function loadSecretsToEnv(): Promise<void> {
  if (!projectId) {
    log.warn('GCP_PROJECT_ID not set, skipping Secret Manager hydration');
    return;
  }

  const errors: Array<{ envVar: string; error: string }> = [];

  await Promise.all(
    SECRET_MANIFEST.map(async (entry) => {
      if (process.env[entry.envVar]) {
        // Already set — local override or test stub, leave alone.
        return;
      }
      try {
        const value = await getSecret(entry.secretName);
        process.env[entry.envVar] = value;
      } catch (error) {
        const message = (error as Error).message;
        const code = (error as { code?: number }).code;
        // An optional secret that has simply never been provisioned surfaces as
        // NOT_FOUND. That is an expected, benign state — the feature relying on
        // it is gated off (e.g. unsubscribe-secret is unused while
        // NOTIFICATION_DELIVERY_ENABLED=false). Emitting ERROR for it pollutes error dashboards
        // and false-fires the WS-1.5 IAM-denial metric on every boot. So only
        // emit the `secret_load_failed` ERROR (WS-7.2(b) structured event that
        // drives that metric) when the failure is actionable: a required secret
        // that failed for any reason, or an optional secret that failed for a
        // reason other than NOT_FOUND (e.g. PERMISSION_DENIED — a real IAM
        // misconfiguration). Benign optional NOT_FOUND is surfaced once below as
        // a warn ("feature relying on it will be disabled").
        const isNotFound = code === 5 || /\bNOT_FOUND\b/.test(message);
        if (entry.required || !isNotFound) {
          log.error(
            {
              event: 'secret_load_failed',
              secret_name: entry.secretName,
              required: entry.required,
              error: message,
            },
            'Secret Manager hydration failed for entry',
          );
        }
        errors.push({ envVar: entry.envVar, error: message });
      }
    }),
  );

  // Required secrets that failed are fatal; optional failures are logged.
  const fatalErrors: Array<{ envVar: string; error: string }> = [];
  for (const failure of errors) {
    const entry = SECRET_MANIFEST.find((e) => e.envVar === failure.envVar);
    if (entry?.required) {
      fatalErrors.push(failure);
    } else {
      log.warn(failure, 'Optional secret not loaded; feature relying on it will be disabled');
    }
  }

  if (fatalErrors.length > 0) {
    log.error({ failures: fatalErrors }, 'Failed to load required secrets at startup');
    throw new Error(
      `Failed to load required secrets: ${fatalErrors.map((e) => e.envVar).join(', ')}`,
    );
  }

  log.info(
    {
      loaded: SECRET_MANIFEST.filter((e) => process.env[e.envVar]).length,
      total: SECRET_MANIFEST.length,
    },
    'Secret Manager hydration complete',
  );
}

// Backwards-compatible alias for the existing initSecrets() call site in index.ts.
export const initSecrets = loadSecretsToEnv;

// Retained for any code that imported the old constant.
export const REQUIRED_SECRETS = SECRET_MANIFEST.filter((e) => e.required).map(
  (e) => e.secretName,
);

// Get Stripe secret key
export async function getStripeSecretKey(): Promise<string> {
  if (process.env.STRIPE_SECRET_KEY) {
    return process.env.STRIPE_SECRET_KEY;
  }
  return getSecret('stripe-secret-key');
}

// Get database password
export async function getDbPassword(): Promise<string> {
  if (process.env.DB_PASSWORD) {
    return process.env.DB_PASSWORD;
  }
  return getSecret('db-password');
}

// Get Stripe webhook secret
export async function getStripeWebhookSecret(): Promise<string> {
  if (process.env.STRIPE_WEBHOOK_SECRET) {
    return process.env.STRIPE_WEBHOOK_SECRET;
  }
  return getSecret('stripe-webhook-secret');
}

// Get Resend API key
export async function getResendApiKey(): Promise<string> {
  if (process.env.RESEND_API_KEY) {
    return process.env.RESEND_API_KEY;
  }
  return getSecret('resend-api-key');
}

// Get Anthropic API key (optional - returns null if not configured)
export async function getAnthropicApiKey(): Promise<string | null> {
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }
  try {
    return await getSecret('anthropic-api-key');
  } catch {
    return null;
  }
}

export type AnthropicPurposeGroup =
  | 'agent-execution'
  | 'reflective-services'
  | 'platform-analytics'
  | 'background-services';

/** Derive the environment suffix from GCP_PROJECT_ID.
 *  Secrets are provisioned as `anthropic-api-key-{group}-dev` / `-prod`
 *  because each secret is created in the shared control project (not per-env
 *  projects), so the env suffix is part of the name, not the project path. */
function deriveEnvSuffix(): string {
  const projectId = process.env.GCP_PROJECT_ID ?? '';
  if (projectId.endsWith('-dev'))  return '-dev';
  if (projectId.endsWith('-prod')) return '-prod';
  return '';
}

/** Fetches the purpose-scoped Anthropic key for the given group, falling back
 *  to the legacy single key if the group-specific secret is not yet configured.
 *  Returns null only if neither the group key nor the fallback key is set.
 *
 *  Lookup order:
 *    1. env var  ANTHROPIC_API_KEY_{GROUP} (local dev / test override)
 *    2. Secret Manager `anthropic-api-key-{group}-{env}` (actual secret name)
 *    3. Secret Manager `anthropic-api-key-{group}`       (future: env-suffix-free name)
 *    4. Legacy `anthropic-api-key` fallback (pre-pool era) */
export async function getAnthropicApiKeyForGroup(
  group: AnthropicPurposeGroup,
): Promise<string | null> {
  const envVar = `ANTHROPIC_API_KEY_${group.toUpperCase().replace(/-/g, '_')}`;
  if (process.env[envVar]) return process.env[envVar]!;

  const envSuffix = deriveEnvSuffix();

  // Try the environment-suffixed name (e.g. anthropic-api-key-agent-execution-dev).
  // This is the naming convention used when the secrets were created.
  if (envSuffix) {
    try {
      return await getSecret(`anthropic-api-key-${group}${envSuffix}`);
    } catch {
      // Not found with env suffix — try without suffix below.
    }
  }

  try {
    return await getSecret(`anthropic-api-key-${group}`);
  } catch {
    // Group-specific key not configured — fall back to the legacy key.
    return getAnthropicApiKey();
  }
}

// Get OpenAI API key (optional - returns null if not configured)
export async function getOpenAIApiKey(): Promise<string | null> {
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }
  try {
    return await getSecret('openai-api-key');
  } catch {
    return null;
  }
}

// Get the TypeSafe API key (optional) — the Jev classifier's vendor (src/typesafe/).
// Missing means no request is sent and no usage row is written; callers take
// today's path.
export async function getTypeSafeApiKey(): Promise<string | null> {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try { return await getSecret('typesafe-api-key'); } catch { return null; }
}

// Get OpenRouter API key (optional) — the `openrouter` LLM provider's OpenRouter transport.
export async function getOpenRouterApiKey(): Promise<string | null> {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try { return await getSecret('openrouter-api-key'); } catch { return null; }
}

export type OpenAIPurposeGroup = AnthropicPurposeGroup; // same four groups

/** Fetches the purpose-scoped OpenAI key for the given group, falling back
 *  to the legacy single key if the group-specific secret is not yet configured.
 *
 *  Lookup order:
 *    1. env var  OPENAI_API_KEY_{GROUP} (local dev / test override)
 *    2. Secret Manager `openai-api-key-{group}-{env}`
 *    3. Secret Manager `openai-api-key-{group}`
 *    4. Legacy `openai-api-key` fallback */
export async function getOpenAIApiKeyForGroup(
  group: OpenAIPurposeGroup,
): Promise<string | null> {
  const envVar = `OPENAI_API_KEY_${group.toUpperCase().replace(/-/g, '_')}`;
  if (process.env[envVar]) return process.env[envVar]!;

  const envSuffix = deriveEnvSuffix();

  if (envSuffix) {
    try {
      return await getSecret(`openai-api-key-${group}${envSuffix}`);
    } catch {
      // Not found with env suffix — try without suffix below.
    }
  }

  try {
    return await getSecret(`openai-api-key-${group}`);
  } catch {
    return getOpenAIApiKey();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Phase 2: Tenant-aware secret operations for shared/dedicated hosting modes
// ──────────────────────────────────────────────────────────────────────────

import type { Tenant } from '../tenants/types';

/**
 * Get the GCP project that holds a tenant's secrets.
 * Shared-tier tenants use the shared runtime project.
 * Dedicated-tier tenants use their own GCP project.
 */
export function getSecretProject(tenant: Tenant): string {
  if (tenant.hostingMode === 'shared') {
    const sharedProject = process.env.SHARED_RUNTIME_PROJECT;
    if (!sharedProject) {
      throw new Error('SHARED_RUNTIME_PROJECT env var required for shared-tier tenants');
    }
    return sharedProject;
  }
  if (!tenant.gcpProjectId) {
    throw new Error(`Tenant ${tenant.id} (dedicated) does not have a GCP project configured`);
  }
  return tenant.gcpProjectId;
}

/**
 * Get the secret name for a connector credential.
 * Shared-tier: tenant-prefixed to prevent collisions in the shared project.
 * Dedicated-tier: uses the existing naming pattern.
 */
export function getSecretName(tenantId: string, connectorId: string, hostingMode: string): string {
  if (hostingMode === 'shared') {
    return `tenant-${tenantId}-connector-${connectorId}`;
  }
  // Existing pattern for dedicated tenants
  return `connector-${connectorId}-${tenantId}`;
}

/**
 * Access a tenant's secret with enforced naming convention.
 * For shared-tier tenants, the secret name MUST start with `tenant-{tenantId}-`.
 * This prevents tenants from accessing each other's secrets.
 */
export async function getTenantSecret(
  tenant: Tenant,
  secretName: string,
  version = 'latest',
): Promise<string> {
  if (tenant.hostingMode === 'shared') {
    const prefix = `tenant-${tenant.id}-`;
    if (!secretName.startsWith(prefix)) {
      throw new Error(`Shared-tier secret name must start with "${prefix}", got: ${secretName}`);
    }
  }

  const project = getSecretProject(tenant);
  const name = `projects/${project}/secrets/${secretName}/versions/${version}`;

  try {
    const [response] = await client.accessSecretVersion({ name });

    return response.payload?.data?.toString() || '';
  } catch (error) {
    log.error({ error, secret: secretName, project }, 'Failed to load tenant secret');
    throw new Error(`Failed to load tenant secret: ${secretName}`);
  }
}

