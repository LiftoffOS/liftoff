// Shared resolver for the platform-backend <-> developer-proxy service token
// (DEVELOPER_PROXY_SERVICE_TOKEN_SECRET). Used to authenticate trusted
// service-to-service callers on both the usage ingestion feed and the
// credential-management routes, in addition to Cloud Run IAM (OIDC).

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { loadConfig } from './config.js';

let cachedServiceToken: string | null = null;

export async function resolveServiceToken(): Promise<string> {
  if (cachedServiceToken) return cachedServiceToken;

  if (process.env.NODE_ENV === 'test') {
    cachedServiceToken = process.env.DEVELOPER_PROXY_SERVICE_TOKEN ?? 'test-service-token';
    return cachedServiceToken;
  }

  const config = loadConfig();
  const client = new SecretManagerServiceClient();
  const [version] = await client.accessSecretVersion({
    name: `projects/${config.GCP_PROJECT_ID}/secrets/${config.DEVELOPER_PROXY_SERVICE_TOKEN_SECRET}/versions/latest`,
  });
  const raw = version.payload?.data;
  const value = raw
    ? typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf-8')
    : undefined;
  if (!value) throw new Error(`Secret ${config.DEVELOPER_PROXY_SERVICE_TOKEN_SECRET} is empty`);
  cachedServiceToken = value.trim();
  return cachedServiceToken;
}
