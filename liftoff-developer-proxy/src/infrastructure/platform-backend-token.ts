// The token platform-backend accepts in x-service-auth from this service
// (TENANT_RUNTIME_SERVICE_TOKEN_SECRET). Audit-log delivery (outbox/worker.ts)
// and the cost-ingest poke (usage/cost-ingest-poke.ts) both send it. Distinct
// from service-token.ts, which is the token platform-backend sends HERE.

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { loadConfig } from './config.js';

let platformBackendToken: string | null = null;

export async function resolvePlatformBackendToken(): Promise<string> {
  if (platformBackendToken) return platformBackendToken;
  const config = loadConfig();

  if (process.env.NODE_ENV === 'test') {
    platformBackendToken = process.env.TENANT_RUNTIME_SERVICE_TOKEN ?? 'test-token';
    return platformBackendToken;
  }

  const smClient = new SecretManagerServiceClient();
  const [version] = await smClient.accessSecretVersion({
    name: `projects/${config.GCP_PROJECT_ID}/secrets/${config.TENANT_RUNTIME_SERVICE_TOKEN_SECRET}/versions/latest`,
  });
  const raw = version.payload?.data;
  const token = raw
    ? (typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf-8'))
    : undefined;
  if (!token) {
    throw new Error(`Secret ${config.TENANT_RUNTIME_SERVICE_TOKEN_SECRET} is empty or missing`);
  }
  platformBackendToken = token;
  return platformBackendToken;
}
