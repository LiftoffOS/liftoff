// Environment-variable configuration. Parsed once at boot; never
// re-read. Every field is required unless explicitly defaulted.

import { z } from 'zod';

const ConfigSchema = z.object({
  ENVIRONMENT: z.enum(['dev', 'prod']).default('dev'),
  GCP_PROJECT_ID: z.string().min(1),
  GCP_REGION: z.string().default('us-west1'),
  PORT: z.coerce.number().default(8080),

  // Postgres
  DB_INSTANCE_CONNECTION_NAME: z.string().min(1),
  DB_NAME: z.string().default('billing'),
  DB_USER: z.string().default('billing_app'),
  DB_APP_PASSWORD_SECRET: z.string().default('billing-app-password'),

  // Pub/Sub
  BILLING_EVENTS_TOPIC: z.string().default('billing-events'),

  // Stripe
  STRIPE_API_KEY_SECRET: z.string().default('billing-stripe-api-key'),
  STRIPE_WEBHOOK_SECRET: z.string().default('billing-stripe-webhook-secret'),
  STRIPE_WEBHOOK_SECRET_PREVIOUS: z.string().default('billing-stripe-webhook-secret-previous'),
  STRIPE_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().default(60),

  // Stripe usage billing (OU metered pricing)
  STRIPE_OU_PRICE_ID: z.string().default(''),

  // Cross-service auth
  BILLING_SERVICE_TOKEN_SECRET: z.string().default('billing-service-token'),
  ALLOWED_CALLER_SERVICE_ACCOUNTS: z.string().default(''),

  // Platform-backend integration
  PLATFORM_BACKEND_URL: z.string().default(''),

  // Feature flags
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().default(100),
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
