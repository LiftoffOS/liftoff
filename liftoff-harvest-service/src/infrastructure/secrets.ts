import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { log } from './logging';

let clientInstance: SecretManagerServiceClient | null = null;

function getClient(): SecretManagerServiceClient {
  if (!clientInstance) {
    clientInstance = new SecretManagerServiceClient();
  }
  return clientInstance;
}

/**
 * Fetch a secret value. In production reads from Secret Manager; in dev
 * reads from process.env directly (so contributors can use `.env` files
 * without needing GCP credentials).
 */
export async function getSecret(secretName: string): Promise<string> {
  if (process.env.NODE_ENV !== 'production') {
    return process.env[secretName] ?? '';
  }

  const projectId = process.env.GCP_PROJECT_ID;
  if (!projectId) {
    log.warn({ secretName }, 'GCP_PROJECT_ID not set, falling back to env var');
    return process.env[secretName] ?? '';
  }

  const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;
  try {
    const client = getClient();
    const [version] = await client.accessSecretVersion({ name });
    const payload = version.payload?.data?.toString();
    return payload ?? '';
  } catch (err) {
    log.error({ secretName, error: (err as Error).message }, 'failed to fetch secret');
    throw err;
  }
}
