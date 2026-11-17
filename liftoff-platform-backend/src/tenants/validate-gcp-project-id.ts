// Guards every write to tenants.gcp_project_id so we can never persist a
// cross-environment value (e.g. prod platform-backend setting a *-dev project,
// or vice versa).
//
// Motivation: a tenant row such as
//   gcp_project_id = 'tenant-acme-dev'   ← dev-suffixed
//   runtime_url    = 'https://agent-service-abc123xyz-uw.a.run.app'  (prod)
// has fields that disagree on which environment owns the tenant, which
// (a) makes the ADR-018 validator fire runtime_url_invalid every 15 min,
// (b) would route external-agent Secret Manager secrets into the wrong
//     project on next provisioning.
//
// Two naming conventions coexist for tenant projects:
//   * Provisioned (src/infrastructure/provisioning.ts:267): `tenant-<id>-runtime`
//     in prod, `tenant-<id>-runtime-<env>` in non-prod.
//   * Manual / legacy: `tenant-<slug>-<env>` in every env including prod
//     (e.g., tenant-acme-dev, tenant-acme-prod).
//
// We accept both shapes and derive the env unambiguously.

const KNOWN_ENVS = ['dev', 'prod', 'staging'] as const;
export type KnownEnv = typeof KNOWN_ENVS[number];

export class CrossEnvironmentGcpProjectError extends Error {
  constructor(
    public readonly attempted: string,
    public readonly currentEnv: string,
    public readonly derivedEnv: string | null,
  ) {
    super(
      `Refusing to persist tenants.gcp_project_id=${attempted} from ${currentEnv} platform-backend ` +
        `(derived env: ${derivedEnv ?? 'unrecognized shape'}). ` +
        `Tenant project names must end in -runtime[-<env>] (provisioned) or -<env> (manual). ` +
        `Cross-environment writes are rejected at the repository layer.`,
    );
    this.name = 'CrossEnvironmentGcpProjectError';
  }
}

/**
 * Derive the environment a tenant project belongs to from its name.
 * Returns null if the shape is unrecognized.
 *
 * Decision tree (in order):
 *   1. Must start with `tenant-` (rejects platform infra projects like
 *      platform-control-prod that happen to end in -prod).
 *   2. If it ends in `-runtime-dev` or `-runtime-staging`, env is that suffix
 *      (matches the provisioning service's non-prod output).
 *   3. If it ends in `-runtime` (no env suffix), env is prod (matches the
 *      provisioning service's prod output).
 *   4. If it ends in `-dev`, `-prod`, or `-staging`, env is that suffix
 *      (matches the manual / legacy shape).
 *   5. Anything else → null.
 */
export function deriveTenantProjectEnv(gcpProjectId: string): KnownEnv | null {
  if (!gcpProjectId.startsWith('tenant-')) return null;

  for (const env of KNOWN_ENVS) {
    if (env === 'prod') continue; // handled by -runtime branch below
    if (gcpProjectId.endsWith(`-runtime-${env}`)) return env;
  }
  if (gcpProjectId.endsWith('-runtime')) return 'prod';

  for (const env of KNOWN_ENVS) {
    if (gcpProjectId.endsWith(`-${env}`)) return env;
  }
  return null;
}

/**
 * Assert that the gcp_project_id about to be written matches the current
 * runtime environment. Throws CrossEnvironmentGcpProjectError if not.
 *
 * Callers MUST handle the null case themselves (some writers legitimately
 * persist NULL for shared-hosted tenants). This function only validates
 * non-null inputs.
 *
 * Test bypass: when process.env.ENVIRONMENT === 'test' (set by jest's
 * setup file at src/test-utils/setup.ts:17), the assertion is a no-op.
 * Existing test fixtures use mock values like 'gcp-project-xyz' that
 * don't satisfy the production naming convention, and downstream tests
 * shouldn't have to thread real fixture values through every concurrency,
 * audit, and route test. Dedicated unit tests for THIS function (see
 * validate-gcp-project-id.test.ts) override ENVIRONMENT explicitly to a
 * real env value so they exercise the full logic regardless of the bypass.
 */
export function assertGcpProjectIdMatchesEnv(gcpProjectId: string): void {
  if (process.env.ENVIRONMENT === 'test') return;

  const currentEnv = process.env.ENVIRONMENT;
  if (!currentEnv) {
    // Fail closed: a writer without ENVIRONMENT set should not be persisting
    // an env-bearing project name. This is what protects local dev testing
    // from accidentally writing prod values.
    throw new CrossEnvironmentGcpProjectError(gcpProjectId, '(unset)', null);
  }

  const derivedEnv = deriveTenantProjectEnv(gcpProjectId);
  if (derivedEnv === null) {
    // Unrecognized shape — either a typo or a non-tenant project.
    throw new CrossEnvironmentGcpProjectError(gcpProjectId, currentEnv, null);
  }

  if (derivedEnv !== currentEnv) {
    throw new CrossEnvironmentGcpProjectError(gcpProjectId, currentEnv, derivedEnv);
  }
}
