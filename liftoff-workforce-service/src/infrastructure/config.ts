import { z } from 'zod';

const ConfigSchema = z.object({
  ENVIRONMENT: z.enum(['dev', 'prod']).default('dev'),
  GCP_PROJECT_ID: z.string().min(1),
  GCP_REGION: z.string().default('us-west1'),
  PORT: z.coerce.number().default(8080),

  DB_INSTANCE_CONNECTION_NAME: z.string().min(1),
  DB_NAME: z.string().default('workforce'),
  DB_USER: z.string().default('workforce_app'),
  DB_APP_PASSWORD_SECRET: z.string().default('workforce-app-password'),

  WORKFORCE_EVENTS_TOPIC: z.string().default('workforce-events'),

  // Service token for cross-service calls back to platform-backend
  PLATFORM_BACKEND_URL: z.string().url(),
  PLATFORM_BACKEND_SERVICE_TOKEN_SECRET: z.string().default('workforce-service-token'),

  // Anthropic — direct key for the CAIO chat LLM
  ANTHROPIC_API_KEY_SECRET: z.string().default('workforce-anthropic-key'),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),

  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().default(100),

  // One-use capability tokens minted on plan approval.
  // Required in prod; defaults to a test sentinel in dev so local runs don't crash.
  CAPABILITY_TOKEN_SECRET: z.string().default('dev-capability-token-secret'),

  // Pub/Sub subscription for governance kill-switch events.
  // Empty string = kill-switch disabled (safe default).
  GOVERNANCE_EVENTS_SUBSCRIPTION: z.string().default(''),

  // Shared secret sent as X-Service-Auth on calls to platform-backend, and
  // checked on the service-only routes platform-backend calls here (the
  // driver-presence read in presence-router.ts). Sourced from the
  // `workforce-service-token` secret in Secret Manager; platform-backend
  // recognises the same value as its WORKFORCE_SERVICE_TOKEN env var (set via
  // cloudbuild --set-secrets). One token, two views. A missing token fails
  // the inbound check closed; in prod it fails startup instead, so a deploy
  // without it cannot serve.
  WORKFORCE_SERVICE_TOKEN: z.string().default(''),
}).superRefine((config, ctx) => {
  if (config.ENVIRONMENT === 'prod' && config.WORKFORCE_SERVICE_TOKEN.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WORKFORCE_SERVICE_TOKEN'],
      message: 'WORKFORCE_SERVICE_TOKEN is required in prod: the service-only routes check it and fail closed without it',
    });
  }
});

export type Config = z.infer<typeof ConfigSchema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;
  cached = ConfigSchema.parse(env);
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
