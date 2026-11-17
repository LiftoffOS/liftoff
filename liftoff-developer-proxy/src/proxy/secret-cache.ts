// Secret Manager LRU cache for resolved vendor API keys.
// Avoids hitting Secret Manager on every request — keys are stable within a
// session window. Eviction is simple LRU-via-insertion-order (Map preserves it).
//
// Ref-swap attack prevention: the caller must supply the expected credential
// context (tenantId, userId, vendor) and we verify the secretName stored in
// the DB matches the expected path prefix. This prevents an attacker from
// substituting a secretName that points to a different user's key.

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { loadConfig } from '../infrastructure/config.js';

const CACHE_MAX    = 500;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  apiKey:     string;
  fetchedAt:  number;
}

const cache = new Map<string, CacheEntry>();

// Resolve the vendor API key, with ref-swap validation.
// secretName must begin with "devproxy---{tenantId}---{userId}---{vendor}---"
// to prove the secret path is bound to the authenticated credential.
export async function resolveVendorApiKey(
  secretName: string,
  expectedTenantId: string,
  expectedUserId: string,
  expectedVendor: string,
): Promise<string> {
  validateSecretName(secretName, expectedTenantId, expectedUserId, expectedVendor);

  const now = Date.now();
  const cached = cache.get(secretName);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.apiKey;

  const apiKey = await fetchFromSecretManager(secretName);

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(secretName, { apiKey, fetchedAt: now });
  return apiKey;
}

export function invalidateSecretCache(secretName: string): void {
  cache.delete(secretName);
}

// Verify the secret name encodes the expected (tenant, user, vendor) triple.
// Secret names use '---' as delimiter: devproxy---{tenantId}---{userId}---{vendor}---{credentialId}
// Old-style names (byok-{uuid} or byok---...) are rejected — they cannot be validated.
function validateSecretName(
  secretName: string,
  tenantId: string,
  userId: string,
  vendor: string,
): void {
  const expectedPrefix = `devproxy---${tenantId}---${userId}---${vendor}---`;
  if (!secretName.startsWith(expectedPrefix)) {
    throw Object.assign(
      new Error(
        `Secret path mismatch: expected prefix devproxy---{tenant}---{user}---{vendor}---, ` +
        `got: ${secretName.slice(0, 40)}…`,
      ),
      { code: 'SECRET_REF_MISMATCH', statusCode: 403 },
    );
  }
}

async function fetchFromSecretManager(secretName: string): Promise<string> {
  const config = loadConfig();
  const client = new SecretManagerServiceClient();

  const [version] = await client.accessSecretVersion({
    name: `projects/${config.GCP_PROJECT_ID}/secrets/${secretName}/versions/latest`,
  });

  const raw = version.payload?.data;
  const payload = raw
    ? typeof raw === 'string'
      ? raw
      : Buffer.from(raw as Uint8Array).toString('utf-8')
    : '';

  if (!payload) throw new Error(`Secret ${secretName} is empty`);

  // Payload is JSON: { anthropicApiKey: "sk-ant-..." }
  // Falls back to treating the entire payload as the raw key.
  try {
    const parsed = JSON.parse(payload) as { anthropicApiKey?: string; apiKey?: string };
    const resolved = parsed.anthropicApiKey ?? parsed.apiKey;
    if (resolved) return resolved;
  } catch {
    // Not JSON
  }

  return payload;
}
