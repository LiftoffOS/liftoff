// The save path for BYO provider keys.
//
// Three properties the endpoint depends on, all decided here:
//
//   1. A write is a MERGE. A vendor absent from the request body keeps whatever
//      is stored. The card only submits fields the user typed into, so a
//      replace would silently drop the other three keys every time somebody
//      rotated one.
//   2. Nothing unverified is stored. Every submitted key is checked against its
//      provider first and the whole write is rejected if any check fails, with
//      per-provider errors so the card can mark the offending field.
//   3. The secret never touches the database and never comes back out. What is
//      persisted is a Secret Manager pointer and a redaction.

import { log } from '../infrastructure/logging';
import { invalidateResolutionCache } from './resolution-service';
import {
  deleteKeys,
  getKey,
  listKeys,
  markRevoked,
  touchVerified,
  upsertKeys,
  type UpsertInput,
} from './repository';
import {
  deleteProviderSecret,
  invalidateProviderSecretCache,
  putProviderSecret,
} from './secret-storage';
import { validateProviderCredential, type KeyValidationFailure } from './validation';
import {
  AI_PROVIDER_KEY_VENDORS,
  isAiProviderKeyVendor,
  parseSubmittedCredential,
  type AiProviderKey,
  type AiProviderKeyUpdate,
  type AiProviderKeyVendor,
  type StoredCredential,
} from './types';

/** Why one vendor's submitted key was refused. `malformed` is the local check
 *  (too short to be a real key, or one of our own hints coming back); the other
 *  two come from the provider. */
export type KeyWriteRejection = KeyValidationFailure | 'malformed';

export interface KeyWriteRejected {
  ok: false;
  /** Vendor → message the card shows beside that field. */
  errors: Partial<Record<AiProviderKeyVendor, string>>;
}

export interface KeyWriteAccepted {
  ok: true;
  /** The full post-write list, so the card can put the new hints straight into
   *  its query cache instead of paying for a refetch. */
  keys: AiProviderKey[];
  /** What changed, for the audit row. Previous hint is null for a first save;
   *  new hint is null for a removal. */
  changes: Array<{
    vendor: AiProviderKeyVendor;
    previousHint: string | null;
    newHint: string | null;
  }>;
}

export type KeyWriteResult = KeyWriteAccepted | KeyWriteRejected;

/** Strip the Secret Manager pointer before anything leaves the server. */
function toWire(key: { vendor: AiProviderKeyVendor; hint: string | null;
  status: 'valid' | 'revoked'; updatedAt: string | null; lastVerifiedAt: string | null }): AiProviderKey {
  return {
    vendor: key.vendor,
    hint: key.hint,
    status: key.status,
    updatedAt: key.updatedAt,
    lastVerifiedAt: key.lastVerifiedAt,
  };
}

/** Providers with no stored key are omitted; the card renders those fields
 *  empty and prompts for a key. */
export async function getProviderKeys(tenantId: string): Promise<AiProviderKey[]> {
  const stored = await listKeys(tenantId);
  return stored.map(toWire);
}

/**
 * Apply a set of keys.
 *
 * Ordering is load-bearing: every key is validated BEFORE any secret is written
 * and before any row is touched. Validating and storing one vendor at a time
 * would leave a partial write behind the first failure, which is the exact
 * outcome the contract forbids.
 */
export async function updateProviderKeys(
  tenantId: string,
  update: AiProviderKeyUpdate,
): Promise<KeyWriteResult> {
  const submitted: Array<{ vendor: AiProviderKeyVendor; rawKey: string }> = [];
  const removals: AiProviderKeyVendor[] = [];
  const errors: Partial<Record<AiProviderKeyVendor, string>> = {};

  for (const vendor of AI_PROVIDER_KEY_VENDORS) {
    const raw = update[vendor];
    if (raw === undefined) continue;          // absent: keep what is stored
    if (raw === null) {                       // explicit clear
      removals.push(vendor);
      continue;
    }
    const trimmed = String(raw).trim();
    if (trimmed === '') continue;             // an empty field is untouched, not a clear
    submitted.push({ vendor, rawKey: trimmed });
  }

  if (submitted.length === 0 && removals.length === 0) {
    // Nothing to do. Answer with the current state rather than an error: the
    // card disables Save in this case, so reaching here means a client we did
    // not write, and the honest answer to "apply nothing" is the unchanged list.
    return { ok: true, keys: await getProviderKeys(tenantId), changes: [] };
  }

  // ── Local checks first. A hint coming back as a key would destroy the real
  // credential, a string too short to redact is not a key any of the three
  // key-issuing vendors hands out, and a Google value that is not a service
  // account cannot be exchanged for anything. None is worth a round trip.
  //
  // Removals are not validated: there is nothing to check about a key the
  // customer is taking away, and refusing to remove one because the provider
  // is unreachable would trap them with a credential they have already revoked
  // upstream.
  const parsed = new Map<AiProviderKeyVendor, { credential: StoredCredential; hint: string }>();
  for (const { vendor, rawKey } of submitted) {
    const result = parseSubmittedCredential(vendor, rawKey);
    if (!result.ok) {
      errors[vendor] = result.message;
      continue;
    }
    parsed.set(vendor, { credential: result.credential, hint: result.hint });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // ── One live call per submitted key, in parallel. Every result is collected
  // before any of them is acted on, so the customer sees every field that is
  // wrong at once rather than one per save.
  const validations = await Promise.all(
    submitted.map(async ({ vendor }) => ({
      vendor,
      result: await validateProviderCredential(vendor, parsed.get(vendor)!.credential),
    })),
  );
  for (const { vendor, result } of validations) {
    if (!result.ok) errors[vendor] = result.message;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // ── Everything checks out. Capture the prior hints for the audit row before
  // the rows move.
  const previous = await listKeys(tenantId);
  const previousHintByVendor = new Map(previous.map((k) => [k.vendor, k.hint]));

  // Secret Manager FIRST, the row second, and the order is the lesser of two
  // evils rather than an accident. Two stores cannot be written atomically, so
  // one of them can be ahead of the other after a failure:
  //   this order  — the new version exists and the row still describes the old
  //                 key. The card shows a stale hint while the NEW key (which
  //                 was verified) serves. Cosmetic, and self-correcting on the
  //                 next save.
  //   the reverse — the row points at a version that does not exist yet, so
  //                 reads fall back to the OLD key while the card claims the
  //                 new one. That is the same confusion pointed the wrong way,
  //                 with a dead credential at the end of it.
  const upserts: UpsertInput[] = [];
  for (const { vendor } of submitted) {
    const entry = parsed.get(vendor)!;
    const secretName = await putProviderSecret(tenantId, vendor, entry.credential);
    upserts.push({ vendor, secretName, hint: entry.hint });
  }

  // Removals run row-first, the opposite order to a write, and for the same
  // reason: whichever store is ahead after a failure, the survivable state is
  // the one where nothing serves the customer's key. A dropped row with a
  // surviving secret is unreachable (nothing points at it). A destroyed secret
  // with a surviving row would leave the resolver handing out a credential that
  // no longer exists, failing every call for that provider until the next save.
  const removed = await deleteKeys(tenantId, removals);
  for (const row of removed) {
    await deleteProviderSecret(row.secretName);
  }

  const stored = await upsertKeys(tenantId, upserts);

  // A rotated key must not keep serving the old value out of the resolver's
  // cache. Both caches are dropped for this tenant, not just the rows that
  // changed, because the resolver caches the whole per-tenant set.
  for (const upsert of upserts) invalidateProviderSecretCache(upsert.secretName);
  for (const row of removed) invalidateProviderSecretCache(row.secretName);
  invalidateResolutionCache(tenantId);

  return {
    ok: true,
    keys: stored.map(toWire),
    changes: [
      ...submitted.map(({ vendor }) => ({
        vendor,
        previousHint: previousHintByVendor.get(vendor) ?? null,
        newHint: parsed.get(vendor)!.hint,
      })),
      // A removal is as audit-worthy as a rotation: newHint null is the record
      // that the workspace went back to Liftoff's managed pool for that vendor.
      ...removed.map((row) => ({
        vendor: row.vendor,
        previousHint: previousHintByVendor.get(row.vendor) ?? row.hint,
        newHint: null,
      })),
    ],
  };
}

/**
 * The revocation path (work breakdown step 9).
 *
 * The gateway is the only caller: it is the one place that sees the provider's
 * 401, and it sees it for every BYOK-funded call regardless of which service
 * made it. Marking the row from anywhere else would mean every call site
 * growing its own error interpretation, which is one of the two reasons the
 * gateway exists at all.
 */
export async function recordProviderKeyRevoked(
  tenantId: string,
  vendor: AiProviderKeyVendor,
): Promise<void> {
  const key = await getKey(tenantId, vendor);
  const flipped = await markRevoked(tenantId, vendor);
  if (key) invalidateProviderSecretCache(key.secretName);
  invalidateResolutionCache(tenantId);
  if (flipped) {
    log.warn(
      { event: 'byok_key_revoked', tenantId, vendor },
      'Provider declined a customer AI provider key; marked revoked',
    );
  }
}

/** Record that a provider honoured the key on a real call. */
export async function recordProviderKeyVerified(
  tenantId: string,
  vendor: AiProviderKeyVendor,
): Promise<void> {
  await touchVerified(tenantId, vendor);
}

export function parseKeyUpdateBody(body: unknown): AiProviderKeyUpdate | null {
  if (typeof body !== 'object' || body === null) return null;
  const keys = (body as { keys?: unknown }).keys;
  if (typeof keys !== 'object' || keys === null) return null;
  const out: AiProviderKeyUpdate = {};
  for (const [vendor, value] of Object.entries(keys as Record<string, unknown>)) {
    if (!isAiProviderKeyVendor(vendor)) return null;
    // null is the clear button: remove this vendor's key. Anything that is
    // neither a string nor null is a client we did not write.
    if (value !== null && typeof value !== 'string') return null;
    out[vendor] = value;
  }
  return out;
}
