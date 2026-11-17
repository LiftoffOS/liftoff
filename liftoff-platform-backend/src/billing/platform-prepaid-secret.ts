// Custody of a prepaid vendor token the platform bought.
//
// The token is a credential (an Apify bearer that runs Actors) and money (a
// balance the vendor caps it at), so it gets the custody every other
// credential here gets: Secret Manager in the control project, the row in
// platform_prepaid_tokens holding only the secret's NAME. Same client, same
// envelope discipline and the same five-minute read cache as the per-tenant
// provider keys (tenant-ai-provider-keys/secret-storage.ts), with a distinct
// prefix so a wildcard IAM grant over one class never silently covers the
// other.
//
// One secret per PURCHASE, not per vendor: a purchase is the unit the ledger
// reconciles, and a retired purchase's secret is destroyed outright so no
// `latest` read can resurrect a token whose money is gone.

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { log } from '../infrastructure/logging';

const secretManagerClient = new SecretManagerServiceClient();

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { token: string; cachedAt: number }>();

function controlProjectId(): string {
  const env = process.env.ENVIRONMENT ?? 'dev';
  return process.env.GCP_PROJECT_ID ?? `YOUR_GCP_PROJECT`;
}

export function platformPrepaidSecretName(vendor: string, purchaseId: string): string {
  return `platform-prepaid-${vendor}-${purchaseId}`;
}

/** Write the token under a fresh secret and return its name for the row. */
export async function putPlatformPrepaidSecret(vendor: string, purchaseId: string, token: string): Promise<string> {
  const secretName = platformPrepaidSecretName(vendor, purchaseId);
  const projectId = controlProjectId();
  try {
    await secretManagerClient.createSecret({
      parent: `projects/${projectId}`,
      secretId: secretName,
      secret: { replication: { automatic: {} } },
    });
  } catch (error) {
    if (!(error as Error).message?.includes('ALREADY_EXISTS')) throw error;
  }
  await secretManagerClient.addSecretVersion({
    parent: `projects/${projectId}/secrets/${secretName}`,
    payload: { data: Buffer.from(token, 'utf8') },
  });
  cache.set(secretName, { token, cachedAt: Date.now() });
  return secretName;
}

export async function readPlatformPrepaidSecret(secretName: string): Promise<string | null> {
  const cached = cache.get(secretName);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.token;
  try {
    const [version] = await secretManagerClient.accessSecretVersion({
      name: `projects/${controlProjectId()}/secrets/${secretName}/versions/latest`,
    });
    const token = version.payload?.data?.toString();
    if (!token) return null;
    cache.set(secretName, { token, cachedAt: Date.now() });
    return token;
  } catch (error) {
    log.warn({ secretName, error: (error as Error).message }, 'platform prepaid secret could not be read');
    return null;
  }
}

/** Destroy the secret with the purchase it belonged to. Idempotent: a secret
 *  that is already gone is the state the caller wanted. */
export async function destroyPlatformPrepaidSecret(secretName: string): Promise<void> {
  cache.delete(secretName);
  try {
    await secretManagerClient.deleteSecret({ name: `projects/${controlProjectId()}/secrets/${secretName}` });
  } catch (error) {
    if (!(error as Error).message?.includes('NOT_FOUND')) throw error;
  }
}

/** Test seam. */
export function _resetPlatformPrepaidSecretCache(): void {
  cache.clear();
}
