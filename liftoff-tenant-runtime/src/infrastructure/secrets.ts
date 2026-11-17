// Secret Manager Integration for Tenant Runtime
// Per Section 11: credentials in Secret Manager
// Per Section 20: Secret Manager for credentials

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { logger } from './logging';
import {
  ENV_BOUND_SECRETS,
  getManagedSecret,
  managedSecretNames,
  setManagedSecret,
} from './secret-store';

const client = new SecretManagerServiceClient();
const projectId = process.env.GCP_PROJECT_ID;

// IMPORTANT: there is intentionally NO in-process secret value cache here.
//
// We used to maintain a Map<secretName, value> with a 5-minute TTL. It was
// the source of a connector OAuth bug class: every refresh would write a
// new secret version, then the next reader would hit the cache, get the OLD
// value, and send a stale access token to the connector API. The cache had
// no invalidation path because the refresh code lived in a different module
// that didn't know about it.
//
// The cache also wasn't doing any useful work for static secrets. Static
// secrets (DB password, GOOGLE_CLIENT_ID/SECRET, OPENAI_API_KEY,
// TENANT_RUNTIME_SERVICE_TOKEN) are loaded ONCE at startup by
// loadSecretsToEnv() and written into process.env. Every consumer reads
// process.env.X directly, so the second getSecret() call never happens.
// The only secrets read after startup are connector OAuth credentials,
// which MUST always be fresh — caching them is actively harmful.
//
// If hot-path Secret Manager / Cloud SQL load becomes a problem, the fix is
// a SHORT-LIVED cache keyed on connectorId with a TTL strictly less than the
// access-token lifetime (e.g. 30s) AND with explicit invalidation on
// refresh/revoke. Do NOT reintroduce a long-lived value cache.

// Per Section 11: Get secret from Secret Manager
export async function getSecret(
  secretName: string,
  version = 'latest'
): Promise<string> {
  // Support fully-qualified resource paths (e.g. cross-project secrets like
  // "projects/YOUR_CONTROL_PROJECT_STAGING/secrets/connector-service-token").
  // If the caller passes a full path, use it directly; otherwise scope to
  // the tenant's own project (GCP_PROJECT_ID).
  const name = secretName.startsWith('projects/')
    ? `${secretName}/versions/${version}`
    : `projects/${projectId}/secrets/${secretName}/versions/${version}`;

  try {
    const [response] = await client.accessSecretVersion({ name });
    const secretValue = response.payload?.data?.toString() || '';

    logger.info('Secret loaded from Secret Manager', {
      secret: secretName,
      version,
    });

    return secretValue;
  } catch (error) {
    logger.error('Failed to load secret', {
      error,
      secret: secretName,
    });
    throw new Error(`Failed to load secret: ${secretName}`);
  }
}

// Get JSON secret (parsed)
export async function getJsonSecret<T>(
  secretName: string,
  version = 'latest'
): Promise<T> {
  const secretValue = await getSecret(secretName, version);
  try {
    return JSON.parse(secretValue) as T;
  } catch (error) {
    logger.error('Failed to parse JSON secret', {
      error,
      secret: secretName,
    });
    throw new Error(`Secret ${secretName} is not valid JSON`);
  }
}

// Per Section 11: Get connector credential from Secret Manager
// Secret naming convention: connector-{connectorId}-{tenantId}
export async function getConnectorCredential(
  connectorId: string,
  tenantId: string
): Promise<ConnectorSecretData> {
  const secretName = `connector-${connectorId}-${tenantId}`;
  return getJsonSecret<ConnectorSecretData>(secretName);
}

// Per Section 11: Store connector credential in Secret Manager
export async function storeConnectorCredential(
  connectorId: string,
  tenantId: string,
  credential: ConnectorSecretData
): Promise<string> {
  const secretName = `connector-${connectorId}-${tenantId}`;
  const secretPath = `projects/${projectId}/secrets/${secretName}`;

  try {
    // Try to add a new version to existing secret
    const [version] = await client.addSecretVersion({
      parent: secretPath,
      payload: {
        data: Buffer.from(JSON.stringify(credential)),
      },
    });

    logger.info('Connector credential stored', {
      connectorId,
      tenantId,
      version: version.name,
    });

    return version.name || secretName;
  } catch (error) {
    // If secret doesn't exist, create it first
    if ((error as any).code === 5) {
      // NOT_FOUND
      await client.createSecret({
        parent: `projects/${projectId}`,
        secretId: secretName,
        secret: {
          replication: {
            automatic: {},
          },
        },
      });

      // Now add the version
      const [version] = await client.addSecretVersion({
        parent: secretPath,
        payload: {
          data: Buffer.from(JSON.stringify(credential)),
        },
      });

      logger.info('Connector credential created and stored', {
        connectorId,
        tenantId,
        version: version.name,
      });

      return version.name || secretName;
    }

    logger.error('Failed to store connector credential', {
      error,
      connectorId,
      tenantId,
    });
    throw error;
  }
}

// Create-or-add-version helper for arbitrary secret names. Mirrors the
// pattern used in storeConnectorCredential (handles NOT_FOUND by creating
// the secret first). Used by customer hooks for HMAC secret management.
export async function createOrAddSecretVersion(
  secretName: string,
  value: string,
): Promise<string> {
  const secretPath = `projects/${projectId}/secrets/${secretName}`;

  try {
    const [version] = await client.addSecretVersion({
      parent: secretPath,
      payload: { data: Buffer.from(value) },
    });
    logger.info('Secret version added', { secret: secretName, version: version.name });
    return version.name || secretName;
  } catch (error) {
    if ((error as any).code === 5) {
      // NOT_FOUND — create the secret then add the version.
      await client.createSecret({
        parent: `projects/${projectId}`,
        secretId: secretName,
        secret: { replication: { automatic: {} } },
      });
      const [version] = await client.addSecretVersion({
        parent: secretPath,
        payload: { data: Buffer.from(value) },
      });
      logger.info('Secret created and version added', { secret: secretName, version: version.name });
      return version.name || secretName;
    }
    logger.error('Failed to store secret', { error, secret: secretName });
    throw error;
  }
}

// Delete a secret entirely (used when a customer hook is deleted).
export async function deleteSecret(secretName: string): Promise<void> {
  const name = `projects/${projectId}/secrets/${secretName}`;
  try {
    await client.deleteSecret({ name });
    logger.info('Secret deleted', { secret: secretName });
  } catch (error) {
    if ((error as any).code === 5) {
      // Already gone — treat as success.
      logger.info('Secret already absent', { secret: secretName });
      return;
    }
    logger.error('Failed to delete secret', { error, secret: secretName });
    throw error;
  }
}

// Connector secret data structure
export interface ConnectorSecretData {
  accessToken: string;
  refreshToken?: string;
  instanceUrl?: string;
  expiresAt?: string;
  tokenType?: string;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

// Get database password
export async function getDbPassword(): Promise<string> {
  const held = getManagedSecret('DB_PASSWORD');
  if (held) return held;
  return getSecret('tenant-db-password');
}

// ──────────────────────────────────────────────────────────────────────────
// Anthropic purpose-keyed API pool helpers
//
// Each AnthropicPurposeGroup maps to a dedicated Anthropic API key, enabling
// independent billing visibility and blast-radius isolation per function
// category. Falls back to the legacy single key for any group whose
// purpose-specific secret is not yet provisioned.
// ──────────────────────────────────────────────────────────────────────────

export type AnthropicPurposeGroup =
  | 'agent-execution'
  | 'reflective-services'
  | 'platform-analytics'
  | 'background-services';

// Get Anthropic API key (optional — returns null if not configured)
export async function getAnthropicApiKey(): Promise<string | null> {
  const held = getManagedSecret('ANTHROPIC_API_KEY');
  if (held) return held;
  const env = process.env.ENVIRONMENT || 'dev';
  try {
    return await getSecret(`projects/YOUR_GCP_PROJECT/secrets/anthropic-api-key-${env}`);
  } catch {
    return null;
  }
}

/** Fetches the purpose-scoped Anthropic key for the given group, falling back
 *  to the legacy single key if the group-specific secret is not yet configured.
 *  Returns null only if neither the group key nor the fallback key is set.
 *
 *  Lookup order:
 *    1. env var  ANTHROPIC_API_KEY_{GROUP}           (local dev / test override)
 *    2. Secret Manager `anthropic-api-key-{group}-{env}` (actual secret name)
 *    3. Secret Manager `anthropic-api-key-{group}`       (env-suffix-free name)
 *    4. Legacy `anthropic-api-key` fallback             (pre-pool era) */
export async function getAnthropicApiKeyForGroup(
  group: AnthropicPurposeGroup,
): Promise<string | null> {
  const envVar = `ANTHROPIC_API_KEY_${group.toUpperCase().replace(/-/g, '_')}`;
  if (process.env[envVar]) return process.env[envVar]!;

  const env = process.env.ENVIRONMENT || 'dev';
  const controlProject = `YOUR_GCP_PROJECT`;

  // Try the environment-suffixed name (e.g. anthropic-api-key-agent-execution-dev)
  // in the control plane project where all LLM provider keys live.
  try {
    return await getSecret(`projects/${controlProject}/secrets/anthropic-api-key-${group}-${env}`);
  } catch {
    // Not found with env suffix — try without suffix below.
  }

  try {
    return await getSecret(`projects/${controlProject}/secrets/anthropic-api-key-${group}`);
  } catch {
    // Group-specific key not configured — fall back to the legacy key.
    return getAnthropicApiKey();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// OpenAI purpose-keyed API pool helpers
//
// Mirrors AnthropicPurposeGroup. OpenAI is lenient — missing per-group keys
// fall back to the legacy single OPENAI_API_KEY (Anthropic groups are
// required; OpenAI is secondary, so a missing group key is not fatal).
// ──────────────────────────────────────────────────────────────────────────

export type OpenAIPurposeGroup =
  | 'agent-execution'
  | 'reflective-services'
  | 'platform-analytics'
  | 'background-services';

// Get the legacy single OpenAI key (hydrated store first, then Secret Manager).
// Used as fallback by getOpenAIApiKeyForGroup when a group key is not set.
export async function getOpenAIApiKey(): Promise<string | null> {
  const held = getManagedSecret('OPENAI_API_KEY');
  if (held) return held;
  const env = process.env.ENVIRONMENT || 'dev';
  try {
    return await getSecret(`projects/YOUR_GCP_PROJECT/secrets/openai-api-key`);
  } catch {
    return null;
  }
}

/** Liftoff's own xAI key, for MANAGED Grok.
 *
 *  Never a customer's: a BYOK Grok turn is served the gateway's short-lived
 *  token instead, and the customer's key stays in the control plane. */
export async function getXaiApiKey(): Promise<string | null> {
  const held = getManagedSecret('XAI_API_KEY');
  if (held) return held;
  const env = process.env.ENVIRONMENT || 'dev';
  try {
    return await getSecret(`projects/YOUR_GCP_PROJECT/secrets/xai-api-key`);
  } catch {
    return null;
  }
}

// OpenRouter API key (optional) — the `openrouter` provider's OpenRouter transport.
// Mirrors getOpenAIApiKey: hydrated store first, else the control-project secret.
export async function getOpenRouterApiKey(): Promise<string | null> {
  const held = getManagedSecret('OPENROUTER_API_KEY');
  if (held) return held;
  const env = process.env.ENVIRONMENT || 'dev';
  try {
    return await getSecret(`projects/YOUR_GCP_PROJECT/secrets/openrouter-api-key`);
  } catch {
    return null;
  }
}

/** Fetches the purpose-scoped OpenAI key for the given group, falling back
 *  to the legacy single key if the group-specific secret is not yet
 *  configured. Returns null only if neither the group key nor the fallback
 *  key is set.
 *
 *  Lookup order:
 *    1. env var  OPENAI_API_KEY_{GROUP}                 (local dev / test override)
 *    2. Secret Manager `openai-api-key-{group}-{env}`  (actual secret name)
 *    3. Secret Manager `openai-api-key-{group}`        (env-suffix-free name)
 *    4. Legacy `openai-api-key` fallback                (pre-pool era) */
export async function getOpenAIApiKeyForGroup(
  group: OpenAIPurposeGroup,
): Promise<string | null> {
  const envVar = `OPENAI_API_KEY_${group.toUpperCase().replace(/-/g, '_')}`;
  if (process.env[envVar]) return process.env[envVar]!;

  const env = process.env.ENVIRONMENT || 'dev';
  const controlProject = `YOUR_GCP_PROJECT`;

  // Try the environment-suffixed name first.
  try {
    return await getSecret(`projects/${controlProject}/secrets/openai-api-key-${group}-${env}`);
  } catch {
    // Fall through to env-suffix-free variant.
  }

  try {
    return await getSecret(`projects/${controlProject}/secrets/openai-api-key-${group}`);
  } catch {
    // Group-specific key not configured — fall back to the legacy single key.
    return getOpenAIApiKey();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Startup secret hydration
//
// The tenant runtime owns its own secret loading. Cloud Run does NOT bind
// any of these as env vars (see liftoff-infrastructure-gcp's
// tenant_runtime_secrets local — empty). At process startup we call
// loadSecretsToEnv() once, which fetches each secret from Secret Manager
// and sets process.env[envVar] so the rest of the codebase can keep doing
// process.env.X synchronously without caring where the value came from.
//
// Why this exists: when Cloud Run secret bindings are managed by deploy
// tooling (cloudbuild --set-secrets) AND infrastructure tooling (Terraform
// google_cloud_run_v2_service.template.containers.env.value_source.secret_key_ref),
// the two will eventually step on each other and one side will wipe the
// other's bindings. For example, a cloudbuild deploy without
// TENANT_RUNTIME_SERVICE_TOKEN in its --set-secrets list wipes the binding
// Terraform set, taking the service down. Loading secrets in-process
// removes any reason for either tool to touch Cloud Run secret bindings,
// closing the entire class of "who owns this binding" bugs.
//
// To add a new secret: append to the manifest below and add it to
// terraform/projects/tenant-runtime-template's Secret Manager grants if it
// isn't already in that project. No cloudbuild change required.
// ──────────────────────────────────────────────────────────────────────────

interface SecretManifestEntry {
  envVar: string;
  secretName: string | (() => string);
  /** If true, startup fails when this secret can't be loaded. */
  required: boolean;
}

/** Resolve the environment suffix used in Secret Manager names. Returns
 *  `null` when ENVIRONMENT is unset so callers can skip wiring manifest
 *  entries that would otherwise point at a nonsense secret path during
 *  local boot. */
function deriveEnvSuffix(): string | null {
  const env = process.env.ENVIRONMENT;
  return env && env.length > 0 ? env : null;
}

/** Build SECRET_MANIFEST entries for the four OpenAI purpose-group keys.
 *  All entries are `required: false` — OpenAI is lenient, missing per-group
 *  keys fall back to the legacy single OPENAI_API_KEY. (Anthropic groups are
 *  `required: true` because they are load-bearing for billing visibility on
 *  the primary LLM provider; OpenAI is secondary.)
 *  Returns [] when ENVIRONMENT is unset — local boots without the env-var
 *  shouldn't try (and fail) to fetch group-suffixed secrets. */
function buildOpenAIGroupManifestEntries(): SecretManifestEntry[] {
  const envSuffix = deriveEnvSuffix();
  if (!envSuffix) return [];
  const groups: Array<{ envVar: string; group: string }> = [
    { envVar: 'OPENAI_API_KEY_AGENT_EXECUTION', group: 'agent-execution' },
    { envVar: 'OPENAI_API_KEY_BACKGROUND_SERVICES', group: 'background-services' },
    { envVar: 'OPENAI_API_KEY_PLATFORM_ANALYTICS', group: 'platform-analytics' },
    { envVar: 'OPENAI_API_KEY_REFLECTIVE_SERVICES', group: 'reflective-services' },
  ];
  return groups.map((g) => ({
    envVar: g.envVar,
    secretName: `projects/YOUR_GCP_PROJECT/secrets/openai-api-key-${g.group}-${envSuffix}`,
    required: false,
  }));
}

const SECRET_MANIFEST: readonly SecretManifestEntry[] = [
  {
    envVar: 'DB_PASSWORD',
    secretName: 'tenant-db-password',
    required: true,
  },
  {
    envVar: 'TENANT_RUNTIME_SERVICE_TOKEN',
    secretName: 'tenant-runtime-service-token',
    required: true,
  },
  {
    envVar: 'GOOGLE_CLIENT_ID',
    secretName: () => `google-oauth-client-id-${process.env.ENVIRONMENT || 'dev'}`,
    required: false,
  },
  {
    envVar: 'GOOGLE_CLIENT_SECRET',
    secretName: () => `google-oauth-client-secret-${process.env.ENVIRONMENT || 'dev'}`,
    required: false,
  },
  {
    envVar: 'OPENAI_API_KEY',
    // Cross-project secret: lives in YOUR_GCP_PROJECT, not the tenant
    // project — single source of truth, env-isolated by the control project, no
    // per-tenant copy to drift. The runtime SA already has secretAccessor on it via
    // tenant-runtime-template's runtime_web_tool_keys IAM grant (same control-plane
    // openai-api-key that getWebToolSecret reads for deep research). Read here at
    // runtime by loadSecretsToEnv, exactly like CONNECTOR_SERVICE_TOKEN below.
    // The tenant-project `OPENAI_API_KEY=openai-api-key-{env}` --set-secrets binding
    // was removed from cloudbuild.yaml so this read is authoritative (a binding
    // would pre-set the env var and loadSecretsToEnv would skip it).
    secretName: () =>
      `projects/YOUR_GCP_PROJECT${process.env.ENVIRONMENT || 'dev'}/secrets/openai-api-key`,
    required: false,
  },
  {
    envVar: 'OPENROUTER_API_KEY',
    // Cross-project secret (same pattern as OPENAI_API_KEY above): lives in
    // YOUR_GCP_PROJECT. Needed by the openrouter agent engine
    // (adapter/opencode) so the spawned opencode server can reach OpenRouter.
    // The runtime SA needs secretAccessor on this secret (granted alongside
    // openai-api-key in tenant-runtime-template's runtime_web_tool_keys). Without
    // this entry getOpenRouterApiKey's per-invocation fallback still works once
    // the grant exists, but hydrating here matches OPENAI and avoids a
    // Secret Manager round-trip on every openrouter invocation.
    secretName: () =>
      `projects/YOUR_GCP_PROJECT${process.env.ENVIRONMENT || 'dev'}/secrets/openrouter-api-key`,
    required: false,
  },
  {
    envVar: 'XAI_API_KEY',
    // Liftoff's OWN xAI account, for MANAGED Grok. Same cross-project pattern as
    // OPENROUTER_API_KEY above.
    //
    // Distinct from a customer's xAI key, which never reaches this process:
    // that one stays in the control plane and the gateway attaches it. This is
    // the key Liftoff pays with when a workspace picks Grok without supplying
    // one of its own.
    //
    // Optional, like its siblings. Absent, managed Grok turns fail loudly at
    // the first model call rather than silently running on someone else's
    // account — which is the same contract every other unset provider key has.
    secretName: () =>
      `projects/YOUR_GCP_PROJECT${process.env.ENVIRONMENT || 'dev'}/secrets/xai-api-key`,
    required: false,
  },
  {
    envVar: 'ANTHROPIC_API_KEY',
    // The TENANT project, not the control project.
    //
    // `projects/YOUR_GCP_PROJECT/secrets/anthropic-api-key-{env}` does not
    // exist: the control project holds `anthropic-api-key` (unsuffixed) and the
    // four per-group keys, while `anthropic-api-key-{env}` lives in
    // `tenant-{id}-{env}`.
    //
    // A wrong entry here can go unnoticed: while `cloudbuild.yaml`'s
    // agent-service deploy binds ANTHROPIC_API_KEY with --set-secrets,
    // hydration short-circuits on "already set" and this path does not run. It
    // would run for the first time on the day somebody removed that binding, and
    // fail silently because this entry is optional. A bare name resolves against
    // GCP_PROJECT_ID, which is the tenant project.
    secretName: () => `anthropic-api-key-${process.env.ENVIRONMENT || 'dev'}`,
    required: false, // Not required — only needed when SDK engine is active
  },
  // The three secrets the agent-service binds at exec that had no manifest entry
  // at all. Added so every exec-bound secret has a hydration path, which is the
  // precondition for taking it off --set-secrets: an exec-bound variable sits in
  // /proc/1/environ where no process can remove it, and only moving it to
  // runtime hydration takes it out of reach of an in-container child.
  // All three live in the tenant project.
  {
    envVar: 'AGENT_SLACK_SERVICE_TOKEN',
    secretName: 'agent-slack-service-token',
    required: false,
  },
  {
    envVar: 'AGENT_TEAMS_SERVICE_TOKEN',
    secretName: 'agent-teams-service-token',
    required: false,
  },
  {
    envVar: 'COMPOSIO_API_KEY',
    secretName: 'composio-api-key',
    required: false,
  },
  {
    envVar: 'PLATFORM_CALLBACK_TOKEN',
    secretName: 'platform-callback-token',
    required: false, // Not required — only needed for interactive chat SDK mode (find_teammates callback)
  },
  {
    envVar: 'CONNECTOR_SERVICE_TOKEN',
    // Cross-project secret: lives in YOUR_GCP_PROJECT, not the tenant project.
    // The connector-iam Terraform module grants this SA secretmanager.secretAccessor on it.
    secretName: () =>
      `projects/YOUR_GCP_PROJECT${process.env.ENVIRONMENT || 'dev'}/secrets/connector-service-token`,
    required: false, // Optional — agents can still run, but won't have connector tools until set
  },
  {
    // Env-var name is GOVERNANCE_SERVICE_TOKEN (plan convention). The Secret
    // Manager resource is still named `governance-engine-token` for historical
    // reasons and shared across the governance-iam Terraform module.
    envVar: 'GOVERNANCE_SERVICE_TOKEN',
    // Cross-project secret: lives in YOUR_GCP_PROJECT, not the tenant project.
    // The governance-iam Terraform module grants this SA secretmanager.secretAccessor on it.
    // Satisfies verifyServiceAuth on the governance-engine Connect-RPC endpoints.
    secretName: () =>
      `projects/YOUR_GCP_PROJECT${process.env.ENVIRONMENT || 'dev'}/secrets/governance-engine-token`,
    required: false, // Optional — only consumed when GOVERNANCE_SERVICE_ENABLED !== 'off'
  },
  // OpenAI 4-pool group keys — one per purpose group (agent-execution,
  // reflective-services, platform-analytics, background-services). Lenient
  // fallback to legacy OPENAI_API_KEY for any group not yet seeded; see
  // getOpenAIApiKeyForGroup and buildOpenAIGroupManifestEntries above.
  ...buildOpenAIGroupManifestEntries(),
];

/**
 * Load every secret in the manifest from Secret Manager and write it to
 * process.env. Idempotent: if an env var is already set (local dev,
 * override, test), the existing value is kept and Secret Manager is not
 * called for that entry.
 *
 * Throws if any required secret cannot be loaded — fail-fast at startup is
 * better than silently running with missing credentials and 500ing on the
 * first request.
 */
export async function loadSecretsToEnv(): Promise<void> {
  if (!projectId) {
    logger.warn('GCP_PROJECT_ID not set, skipping Secret Manager hydration');
    return;
  }

  const errors: Array<{ envVar: string; error: string }> = [];
  /** Entries whose hydration path never ran because the variable was already
   *  set. See the log line at the end of this function for why that is worth
   *  reporting rather than passing over. */
  const preset: string[] = [];

  await Promise.all(
    SECRET_MANIFEST.map(async (entry) => {
      if (process.env[entry.envVar]) {
        // Already set — a local override, a test stub, or a Cloud Run
        // --set-secrets binding. Left alone, but RECORDED: see below.
        //
        // Copied into the store as well, so a preset value and a fetched one
        // are read the same way. Without this, every reader would have to know
        // which of the two supplied it.
        preset.push(entry.envVar);
        setManagedSecret(entry.envVar, process.env[entry.envVar] as string);
        return;
      }
      const secretName =
        typeof entry.secretName === 'function' ? entry.secretName() : entry.secretName;
      try {
        const value = await getSecret(secretName);
        // The store is where secrets live. `process.env` gets a copy ONLY for
        // the entries something outside this repo reads from there — today,
        // the two that `@liftoffos/service-client` looks up by variable name.
        // See ENV_BOUND_SECRETS for why that list exists and how it shrinks.
        setManagedSecret(entry.envVar, value);
        if ((ENV_BOUND_SECRETS as readonly string[]).includes(entry.envVar)) {
          process.env[entry.envVar] = value;
        }
      } catch (error) {
        errors.push({
          envVar: entry.envVar,
          error: (error as Error).message,
        });
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
      logger.warn('Optional secret not loaded; feature relying on it will be disabled', failure);
    }
  }

  if (fatalErrors.length > 0) {
    logger.error('Failed to load required secrets at startup', { failures: fatalErrors });
    throw new Error(
      `Failed to load required secrets: ${fatalErrors.map((e) => e.envVar).join(', ')}`,
    );
  }

  // Which entries never exercised their hydration path.
  //
  // Silence here is how a broken manifest entry survives indefinitely: a
  // variable bound at exec by --set-secrets short-circuits its own fetch, so a
  // wrong project or a renamed secret is invisible until the day the binding is
  // removed — at which point an OPTIONAL entry fails without a word and the
  // feature behind it stops. ANTHROPIC_API_KEY sat that way, pointed at a
  // secret in the wrong project.
  //
  // It is also the list that has to empty before an exec binding can safely be
  // dropped, which is the only way to get a secret out of /proc/1/environ,
  // where no process can delete it and any in-container child can read it.
  if (preset.length > 0) {
    logger.info('Secret Manager hydration skipped for pre-set variables', {
      event: 'secret_hydration_skipped',
      envVars: preset,
      note:
        'these were already in the environment (Cloud Run --set-secrets, or a local override), '
        + 'so their Secret Manager path was NOT exercised and is unverified',
    });
  }

  // Counted off the STORE. Counting `process.env` would report only the two
  // env-bound entries and read as fifteen silent failures.
  const held = new Set(managedSecretNames());
  logger.info('Secret Manager hydration complete', {
    loaded: SECRET_MANIFEST.filter((e) => held.has(e.envVar)).length,
    total: SECRET_MANIFEST.length,
    envBound: ENV_BOUND_SECRETS.length,
  });
}

// Backwards-compatible alias for the old initSecrets() call site.
export const initSecrets = loadSecretsToEnv;
