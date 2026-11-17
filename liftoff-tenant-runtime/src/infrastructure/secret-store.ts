// Where this process keeps its secrets.
//
// `loadSecretsToEnv` used to put all of them on `process.env`, which made every
// secret readable by anything that could reach the process environment:
// a spawned child (closed separately by child-process-env.ts), a crash
// reporter, an error serializer, a debug dump, or any library that walks
// `process.env` looking for its own configuration. None of those are attacks —
// they are ordinary code doing ordinary things with an object that happened to
// hold the Cloud SQL password.
//
// The store is a module-private Map. Nothing enumerates it, nothing serializes
// it, and a value only leaves through a named read at the point of use.
//
// ── What this is NOT ───────────────────────────────────────────────────────
//
// This is not the fix for `/proc/1/environ`. That was closed by removing the
// `--set-secrets` bindings from every Cloud Run service, because an exec-time
// variable cannot be deleted by any process (measured on Linux: `delete
// process.env.X` unsets the pointer glibc reads while /proc keeps serving the
// original stack region). Nor is it the fix for the metadata server, which no
// environment handling can touch.
//
// What it buys is that `childProcessEnv()` stops being the single load-bearing
// control: a new spawn site is safe because there is nothing in the environment
// to inherit, rather than because its author remembered an allow-list.
//
// ── The env fallback, and why it is not a loophole ─────────────────────────
//
// A read falls back to `process.env` when the store has no entry. In production
// that fallback finds nothing — `loadSecretsToEnv` populates the store and
// writes the environment for nothing at all — so it changes no security
// property there. It exists so a developer exporting a variable in a shell, and
// a test setting one in `setup.ts`, both keep working.
//
// The consequence to be aware of: a reader that was NOT migrated keeps working
// locally and returns undefined in production. That is the worst shape of bug,
// so completeness is enforced by lint (`r5/no-process-env-secret`) rather than
// by hoping the fallback catches the stragglers.

/** Every secret name the runtime manages. Kept as a value, not a type, because
 *  the eslint rule and the fitness tests read it. */
export const MANAGED_SECRET_NAMES = [
  'DB_PASSWORD',
  'TENANT_RUNTIME_SERVICE_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'OPENAI_API_KEY',
  'OPENAI_API_KEY_AGENT_EXECUTION',
  'OPENAI_API_KEY_BACKGROUND_SERVICES',
  'OPENAI_API_KEY_PLATFORM_ANALYTICS',
  'OPENAI_API_KEY_REFLECTIVE_SERVICES',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AGENT_SLACK_SERVICE_TOKEN',
  'AGENT_TEAMS_SERVICE_TOKEN',
  'COMPOSIO_API_KEY',
  'PLATFORM_CALLBACK_TOKEN',
  'CONNECTOR_SERVICE_TOKEN',
  'GOVERNANCE_SERVICE_TOKEN',
] as const;

export type ManagedSecretName = (typeof MANAGED_SECRET_NAMES)[number];

/**
 * Secrets that must ALSO be written to `process.env`.
 *
 * EMPTY, and the empty list is the point: no managed secret is in this
 * process's environment. Nothing to inherit into a child, nothing for a crash
 * reporter or an error serializer to pick up, nothing for a library walking
 * `process.env` to find.
 *
 * It exists as a list rather than as a deleted feature because it is the seam
 * something would reach for. `@liftoffos/service-client` nearly forced two
 * entries here: it sends the shared bearer from `process.env[serviceAuthEnvVar]`
 * (`dist/service-client.js:123`) and takes a variable NAME, so there is no way
 * to hand it a value. The way out was its `fetchImpl` seam rather than an
 * exception here — see `service-client-auth.ts`.
 *
 * **Adding a name is a fitness-function failure**
 * (`__tests__/secret-store.test.ts`). If one is genuinely unavoidable, the test
 * is where the reason gets written down.
 */
export const ENV_BOUND_SECRETS: readonly ManagedSecretName[] = [];

const store = new Map<string, string>();

/** Put a secret in the store. Called by `loadSecretsToEnv` and by nothing else
 *  in production. */
export function setManagedSecret(name: string, value: string): void {
  store.set(name, value);
}

/**
 * Read a secret at the point of use.
 *
 * Point of use, never module load: `loadSecretsToEnv` runs during boot, well
 * after imports are resolved, so a module-level `const KEY = getManagedSecret(…)`
 * captures undefined and holds it forever. Several modules here carry a comment
 * about exactly that hazard from the `process.env` era; it is unchanged.
 */
export function getManagedSecret(name: string): string | undefined {
  const held = store.get(name);
  if (held !== undefined && held !== '') return held;
  // See the header: finds nothing in production, keeps local dev and tests
  // working, and is not what enforces the migration.
  const fromEnv = process.env[name];
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined;
}

/** Names currently held, for the boot diagnostic. NEVER the values. */
export function managedSecretNames(): string[] {
  return [...store.keys()].sort();
}

/** Test-only: underscore-prefixed so the reachability ratchet reads it as such. */
export function _clearManagedSecrets(): void {
  store.clear();
}
