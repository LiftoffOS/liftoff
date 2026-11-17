import { z } from 'zod';

const ConfigSchema = z.object({
  ENVIRONMENT: z.enum(['dev', 'prod']).default('dev'),
  GCP_PROJECT_ID: z.string().min(1),
  GCP_REGION: z.string().default('us-west1'),
  PORT: z.coerce.number().default(8080),

  // Postgres (developer_proxy database)
  DB_INSTANCE_CONNECTION_NAME: z.string().min(1),
  DB_NAME: z.string().default('developer_proxy'),
  DB_USER: z.string().default('developer_proxy_app'),
  DB_APP_PASSWORD_SECRET: z.string().default('developer-proxy-app-password'),

  // Anthropic vendor
  ANTHROPIC_BASE_URL: z.string().default('https://api.anthropic.com'),

  // Proxy base URL (returned to CLI during setup and used in generated Codex
  // profiles). environment-specific, NO production fallback in
  // non-production — when unset it is DERIVED from the canonical per-env
  // backend URL pattern in loadConfig() below.
  PROXY_BASE_URL: z.string().default(''),

  // Cross-service auth
  DEVELOPER_PROXY_SERVICE_TOKEN_SECRET: z.string().default('developer-proxy-service-token'),

  // Firebase project for verifying user JWTs on credential management routes
  FIREBASE_PROJECT_ID: z.string().default(''),

  // Platform-backend webhook for syncing external_agent_integrations shadow table
  PLATFORM_BACKEND_URL: z.string().default(''),
  BYOK_WEBHOOK_TOKEN_SECRET: z.string().default('byok-webhook-token'),

  // Control-plane audit log delivery
  // CONTROL_PLANE_API_URL: base URL of the platform-backend (e.g. https://api.example.com)
  // TENANT_RUNTIME_SERVICE_TOKEN_SECRET: Secret Manager secret name that holds the shared service token
  // accepted by platform-backend's serviceAuthMiddleware (x-service-auth header).
  CONTROL_PLANE_API_URL: z.string().default(''),
  TENANT_RUNTIME_SERVICE_TOKEN_SECRET: z.string().default('tenant-runtime-service-token'),

  // Allowed browser origins for CORS (comma-separated)
  CORS_ALLOWED_ORIGINS: z.string().default(''),

  // Pub/Sub — Terraform-managed analytics topic base name.
  DEVELOPER_PROXY_EVENTS_TOPIC: z.string().default('developer-proxy-usage'),


  // Vendor/config-driven request-rate safeguards. Reviewed values,
  // overridable per environment without a code change.
  RATE_LIMIT_RPM_ANTHROPIC: z.coerce.number().default(4000),
  RATE_LIMIT_RPM_OPENAI: z.coerce.number().default(4000),

  // Upstream timeouts: connect = time to response headers,
  // overall = total request duration; both map to lifecycle `timed_out`.
  UPSTREAM_CONNECT_TIMEOUT_MS: z.coerce.number().default(15_000),
  UPSTREAM_OVERALL_TIMEOUT_MS: z.coerce.number().default(600_000),


  // Outbox worker
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().default(100),
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | null = null;

const PROD_PLATFORM_BACKEND_URL = 'https://api.example.com';
const PROD_PROXY_BASE_URL = `${PROD_PLATFORM_BACKEND_URL}/proxy`;

/** The public platform-backend hostname for an environment: api.example.com in prod, api-<env>.example.com elsewhere. */
function canonicalPlatformBackendUrl(environment: string): string {
  return environment === 'prod' ? PROD_PLATFORM_BACKEND_URL : `https://api-${environment}.example.com`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  const parsed = ConfigSchema.parse(env);

  // Derive the environment-specific canonical URLs when unset. Both are
  // public-hostname URLs (the load balancer path; platform-backend's run.app
  // URL no longer answers), and both are derived rather than defaulted in
  // cloudbuild so a trigger that forgets to override can only ever deploy the
  // right environment's URL. An empty PLATFORM_BACKEND_URL would otherwise
  // switch the credential hook off without a word.
  if (!parsed.PLATFORM_BACKEND_URL) {
    parsed.PLATFORM_BACKEND_URL = canonicalPlatformBackendUrl(parsed.ENVIRONMENT);
  }
  if (!parsed.PROXY_BASE_URL) {
    parsed.PROXY_BASE_URL = `${canonicalPlatformBackendUrl(parsed.ENVIRONMENT)}/proxy`;
  }
  // Hard-fail when a NON-PROD environment resolves to a prod public URL —
  // a dev credential must never advertise the production proxy — and when
  // PROD resolves to any other environment's URL, which is how prod once
  // advertised https://api-dev.example.com/proxy.
  if (parsed.ENVIRONMENT !== 'prod' && parsed.PROXY_BASE_URL === PROD_PROXY_BASE_URL) {
    throw new Error(
      `PROXY_BASE_URL resolves to the production URL in a non-production environment (${parsed.ENVIRONMENT})`,
    );
  }
  if (parsed.ENVIRONMENT === 'prod' && parsed.PROXY_BASE_URL !== PROD_PROXY_BASE_URL) {
    throw new Error(
      `PROXY_BASE_URL is ${parsed.PROXY_BASE_URL} in production; it must be ${PROD_PROXY_BASE_URL}`,
    );
  }

  cached = parsed;
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
