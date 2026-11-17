// Required-env accessors. Each throws on first call when the env is unset or
// malformed. The throw escapes whatever code path tried to use it — a coordinator
// event handler nacks the message (visible in subscriber logs + DLQ); a request
// handler returns 500. EITHER outcome surfaces fast in monitoring rather than
// silently producing a downstream HTTP 401 / Cloud Scheduler INVALID_ARGUMENT
// / Cloud Tasks DEADLINE_EXCEEDED.
//
// Two-phase deploy compat: these are call-time (NOT module-load-time) throws.
// Importing this module is safe; calling getXxx() during the wire-peer-urls
// window before the env arrives is the only thing that throws.
//
// Example: TENANT_RUNTIME_URL missing on coordinator-service makes the Cloud
// Scheduler API reject the agent-activation HTTP target with INVALID_ARGUMENT;
// the handler nacks, and every subsequent internal_agent.created poisons the
// queue.

const cache = new Map<string, string>();

function requireEnv(name: string, validator?: (v: string) => string | null): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const raw = process.env[name];
  if (!raw) {
    throw new Error(
      `Required env ${name} is unset on this service. This is a deploy ` +
      `misconfiguration — check cloudbuild.yaml step \`patch-split-service-urls\`.`,
    );
  }
  const err = validator?.(raw);
  if (err) throw new Error(`Required env ${name} is malformed: ${err}`);
  cache.set(name, raw);
  return raw;
}

// Sentinel value used by cloudbuild.yaml's resolve-peer-urls step on the
// first-ever deploy of a tenant project (when peer Cloud Run services don't
// exist yet to describe). The patch-split-service-urls step replaces this
// sentinel with the real URLs after all services become Ready. Treated as a
// distinct state (`placeholder`) by envState so the startup guard can boot
// (so the deploy step succeeds → Ready → patch step fires) while still
// throwing if anything tries to USE the URL at runtime.
export const TENANT_RUNTIME_URL_PLACEHOLDER = 'placeholder://awaiting-cloudbuild-patch';

const httpsUrlValidator = (v: string): string | null => {
  if (v === TENANT_RUNTIME_URL_PLACEHOLDER) return null; // placeholder; envState reports separately
  return v.startsWith('https://') ? null : `expected https:// URL, got ${JSON.stringify(v.slice(0, 60))}`;
};

function requirePresent(v: string, name: string): string {
  if (v === TENANT_RUNTIME_URL_PLACEHOLDER) {
    throw new Error(
      `${name} is the first-deploy sentinel (${TENANT_RUNTIME_URL_PLACEHOLDER}). ` +
      `The patch-split-service-urls cloudbuild step has not yet completed. ` +
      `Retry shortly or check cloudbuild logs for that step's status.`,
    );
  }
  return v;
}

export const getTenantRuntimeUrl       = (): string => requirePresent(requireEnv('TENANT_RUNTIME_URL', httpsUrlValidator), 'TENANT_RUNTIME_URL');
export const getGcpProjectId           = (): string => requireEnv('GCP_PROJECT_ID');
export const getCloudSchedulerSAEmail  = (): string => requireEnv('CLOUD_SCHEDULER_SERVICE_ACCOUNT');
export const getPlatformBackendUrl     = (): string => requireEnv('PLATFORM_BACKEND_URL', httpsUrlValidator);

// Diagnostic — never throws. Use ONLY in log payloads, never in code that
// computes a value passed to an external API.
export type EnvState = 'set' | 'missing' | 'malformed' | 'placeholder';
export function envState(name: string, validator?: (v: string) => string | null): EnvState {
  const raw = process.env[name];
  if (!raw) return 'missing';
  if (raw === TENANT_RUNTIME_URL_PLACEHOLDER) return 'placeholder';
  if (validator && validator(raw)) return 'malformed';
  return 'set';
}
export const tenantRuntimeUrlState = (): EnvState => envState('TENANT_RUNTIME_URL', httpsUrlValidator);

// Test-only: reset the cache so tests can mutate process.env between cases.
export function _resetEnvCacheForTests(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('_resetEnvCacheForTests called outside tests');
  cache.clear();
}
