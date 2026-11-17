// Custody of the raw customer key.
//
// The database never holds it. One Secret Manager secret per tenant + vendor,
// in the project this tenant's hosting mode resolves to — the same custody and
// the same project resolution the per-connector credentials already use, so
// there is one IAM story rather than two.
//
// Reads are cached in-process because the gateway resolves a key on every
// outbound request and a Secret Manager round trip per request would be the
// dominant latency of a proxied turn. The cache is keyed by secret name and
// invalidated explicitly on write and on revocation, so a rotated key takes
// effect on the NEXT request on the instance that handled the rotation.
//
// It also expires, and the TTL is not belt-and-braces: explicit invalidation is
// in-process, and this service runs on many Cloud Run instances. A key rotated
// through instance A is still cached on instance B, which would keep presenting
// the old secret to the vendor until that instance recycled — days, on a warm
// service. The TTL is what bounds that to minutes. Same reasoning, and the same
// five minutes, as the platform's own secret cache in infrastructure/secrets.ts.

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { log } from '../infrastructure/logging';
import { resolveSecretProjectId } from '../connectors/canonical-secret-storage';
import type { AiProviderKeyVendor, StoredCredential } from './types';

const secretManagerClient = new SecretManagerServiceClient();

/** Canonical secret name for a tenant's credential with one provider.
 *
 *  Distinct prefix from `connector-{tenantId}-{connectorId}` on purpose: these
 *  are not connectors, they are not addressable by a connector id, and a shared
 *  prefix would make a wildcard IAM grant over one class silently cover the
 *  other. */
export function getAiProviderSecretName(
  tenantId: string,
  vendor: AiProviderKeyVendor,
): string {
  return `ai-provider-key-${tenantId}-${vendor}`;
}

interface CacheEntry {
  value: StoredCredential;
  cachedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, CacheEntry>();

/** Write (or rotate) the credential. Returns the secret name to record on the row.
 *
 *  Stored as a self-describing JSON envelope rather than a bare string, because
 *  the four vendors do not all issue the same KIND of credential: three hand out
 *  an opaque key, and Google hands out a Vertex service account — a project, a
 *  location and a key pair. A reader that had to guess which it was holding from
 *  the vendor column would be one rename away from parsing the wrong thing.
 *
 *  A rotation adds a version rather than replacing one: Secret Manager keeps
 *  the history, and `latest` is what every read asks for. */
export async function putProviderSecret(
  tenantId: string,
  vendor: AiProviderKeyVendor,
  credential: StoredCredential,
): Promise<string> {
  const secretName = getAiProviderSecretName(tenantId, vendor);
  const projectId = resolveSecretProjectId(tenantId);

  try {
    await secretManagerClient.createSecret({
      parent: `projects/${projectId}`,
      secretId: secretName,
      secret: { replication: { automatic: {} } },
    });
  } catch (error) {
    if (!(error as Error).message?.includes('ALREADY_EXISTS')) throw error;
  }

  const payload = JSON.stringify(credential);
  await secretManagerClient.addSecretVersion({
    parent: `projects/${projectId}/secrets/${secretName}`,
    payload: { data: Buffer.from(payload, 'utf8') },
  });

  cache.set(secretName, { value: credential, cachedAt: Date.now() });
  return secretName;
}

/** Destroy the credential outright. Used only by the clear button's removal
 *  path: a customer who takes their key back expects it gone, not shelved.
 *
 *  Deletes the SECRET, not just its latest version, so no history survives that
 *  a later `latest` read could resurrect. Idempotent: a secret that is already
 *  gone is the state the caller wanted, so NOT_FOUND is success. The row is
 *  dropped either way, and a leaked secret with no row pointing at it is
 *  unreachable rather than dangerous, which is why this never blocks the
 *  removal it belongs to. */
export async function deleteProviderSecret(secretName: string): Promise<void> {
  const tenantId = tenantIdFromSecretName(secretName);
  const projectId = resolveSecretProjectId(tenantId ?? '');
  cache.delete(secretName);
  try {
    await secretManagerClient.deleteSecret({
      name: `projects/${projectId}/secrets/${secretName}`,
    });
  } catch (error) {
    const message = (error as Error).message ?? '';
    if (message.includes('NOT_FOUND')) return;
    throw error;
  }
}

/** Read the credential back. Null when the secret is gone — which is a real
 *  state (a tenant deleted, a secret cleaned up out of band) and not an error
 *  the caller should crash on: the resolver treats it as "no key", which falls
 *  back to the managed pool. */
export async function readProviderSecret(secretName: string): Promise<StoredCredential | null> {
  const cached = cache.get(secretName);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.value;

  const tenantId = tenantIdFromSecretName(secretName);
  const projectId = resolveSecretProjectId(tenantId ?? '');

  try {
    const [version] = await secretManagerClient.accessSecretVersion({
      name: `projects/${projectId}/secrets/${secretName}/versions/latest`,
    });
    const payload = version.payload?.data?.toString();
    if (!payload) return null;
    const credential = JSON.parse(payload) as StoredCredential;
    if (credential.kind !== 'api_key' && credential.kind !== 'vertex_service_account') {
      // A payload we cannot classify is not a credential we can send. Treated as
      // absent rather than guessed at: falling back to managed costs Liftoff one
      // call, and guessing wrong sends malformed auth to a customer's provider.
      log.error({ secretName }, 'Stored AI provider credential has an unrecognised kind');
      return null;
    }
    cache.set(secretName, { value: credential, cachedAt: Date.now() });
    return credential;
  } catch (error) {
    // Never log the secret name's tenant alongside the error body: the body can
    // carry the resource path, which is fine, but this is the one place a
    // careless addition would start printing credential material.
    log.error(
      { error: (error as Error).message, secretName },
      'Failed to read tenant AI provider secret',
    );
    return null;
  }
}

/** Drop a cached key. Called on rotation and on revocation, so the next request
 *  re-reads rather than serving a key we already know is dead. */
export function invalidateProviderSecretCache(secretName?: string): void {
  if (secretName) cache.delete(secretName);
  else cache.clear();
}

/** Recover the tenant id a secret name was minted for, so a read can resolve
 *  the same project the write used. Returns null for a name that does not match
 *  the convention, in which case the caller falls back to the default project. */
function tenantIdFromSecretName(secretName: string): string | null {
  const match = /^ai-provider-key-(.+)-(?:anthropic|google|openai|xai)$/.exec(secretName);
  return match ? match[1] : null;
}
