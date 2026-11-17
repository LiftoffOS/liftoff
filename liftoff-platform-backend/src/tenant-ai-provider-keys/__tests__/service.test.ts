// The save path's three contract properties: a write is a merge, nothing
// unverified is stored, and the secret never reaches the database.

import type { StoredProviderKey, UpsertInput } from '../repository';
import type { KeyValidationResult } from '../validation';
import type { AiProviderKeyVendor } from '../types';

const stored = new Map<AiProviderKeyVendor, StoredProviderKey>();

const listKeys = jest.fn(async () => [...stored.values()]);
const getKey = jest.fn(async (_t: string, vendor: AiProviderKeyVendor) => stored.get(vendor) ?? null);
const upsertKeys = jest.fn(async (_t: string, inputs: readonly UpsertInput[]) => {
  for (const input of inputs) {
    stored.set(input.vendor, {
      vendor: input.vendor,
      secretName: input.secretName,
      hint: input.hint,
      status: 'valid',
      updatedAt: '2026-09-01T12:00:00.000Z',
      lastVerifiedAt: '2026-09-01T12:00:00.000Z',
    });
  }
  return [...stored.values()];
});
const markRevoked = jest.fn(async () => true);
const touchVerified = jest.fn(async () => undefined);
const deleteKeys = jest.fn(async (_t: string, vendors: readonly AiProviderKeyVendor[]) => {
  const gone: StoredProviderKey[] = [];
  for (const vendor of vendors) {
    const row = stored.get(vendor);
    if (!row) continue;
    gone.push(row);
    stored.delete(vendor);
  }
  return gone;
});

jest.mock('../repository', () => ({
  listKeys: (t: string) => listKeys(t),
  getKey: (t: string, v: AiProviderKeyVendor) => getKey(t, v),
  upsertKeys: (t: string, i: readonly UpsertInput[]) => upsertKeys(t, i),
  deleteKeys: (t: string, v: readonly AiProviderKeyVendor[]) => deleteKeys(t, v),
  markRevoked: () => markRevoked(),
  touchVerified: () => touchVerified(),
}));

const putProviderSecret = jest.fn(
  async (tenantId: string, vendor: string) => `ai-provider-key-${tenantId}-${vendor}`,
);
const invalidateProviderSecretCache = jest.fn();
const deleteProviderSecret = jest.fn(async (_name: string) => undefined);
jest.mock('../secret-storage', () => ({
  putProviderSecret: (t: string, v: string, k: string) => putProviderSecret(t, v, k),
  deleteProviderSecret: (n: string) => deleteProviderSecret(n),
  invalidateProviderSecretCache: (n?: string) => invalidateProviderSecretCache(n),
}));

const validateProviderCredential =
  jest.fn<Promise<KeyValidationResult>, [AiProviderKeyVendor, unknown]>();
jest.mock('../validation', () => ({
  validateProviderCredential: (v: AiProviderKeyVendor, c: unknown) =>
    validateProviderCredential(v, c),
}));

const invalidateResolutionCache = jest.fn();
jest.mock('../resolution-service', () => ({
  invalidateResolutionCache: (t?: string) => invalidateResolutionCache(t),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  getProviderKeys,
  parseKeyUpdateBody,
  recordProviderKeyRevoked,
  updateProviderKeys,
} from '../service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ANTHROPIC_KEY = 'sk-ant-api03-not-a-real-key-3f2x';
const OPENAI_KEY = 'sk-proj-not-a-real-key-9qLm';

beforeEach(() => {
  stored.clear();
  jest.clearAllMocks();
  validateProviderCredential.mockResolvedValue({ ok: true });
});

describe('a write is a merge, not a replace', () => {
  it('leaves the other providers alone when one key is rotated', async () => {
    await updateProviderKeys(TENANT, { anthropic: ANTHROPIC_KEY, openai: OPENAI_KEY });
    await updateProviderKeys(TENANT, { openai: 'sk-proj-rotated-key-7ttZ' });

    const keys = await getProviderKeys(TENANT);
    expect(keys.find((k) => k.vendor === 'anthropic')?.hint).toBe('sk-ant••••••••3f2x');
    expect(keys.find((k) => k.vendor === 'openai')?.hint).toBe('sk-pro••••••••7ttZ');
  });

  it('treats an empty string as untouched rather than as a clear', async () => {
    await updateProviderKeys(TENANT, { anthropic: ANTHROPIC_KEY });
    const result = await updateProviderKeys(TENANT, { anthropic: '   ' });

    expect(result.ok).toBe(true);
    expect((await getProviderKeys(TENANT)).find((k) => k.vendor === 'anthropic')?.hint)
      .toBe('sk-ant••••••••3f2x');
  });

  it('answers with the unchanged list when nothing was submitted', async () => {
    const result = await updateProviderKeys(TENANT, {});
    expect(result).toEqual({ ok: true, keys: [], changes: [] });
    expect(putProviderSecret).not.toHaveBeenCalled();
  });
});

describe('nothing unverified is stored', () => {
  it('rejects the WHOLE write when one provider declines the key', async () => {
    validateProviderCredential.mockImplementation(async (vendor) =>
      vendor === 'openai'
        ? { ok: false, code: 'invalid_key', message: 'OpenAI did not accept this key.' }
        : { ok: true },
    );

    const result = await updateProviderKeys(TENANT, {
      anthropic: ANTHROPIC_KEY,
      openai: OPENAI_KEY,
    });

    expect(result.ok).toBe(false);
    // A partial write leaves the user with no way to tell what happened, so the
    // passing key is not stored either.
    expect(putProviderSecret).not.toHaveBeenCalled();
    expect(upsertKeys).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
  });

  it('rejects a provider outage rather than silently storing something unchecked', async () => {
    validateProviderCredential.mockResolvedValue({
      ok: false,
      code: 'unreachable',
      message: 'Could not reach Anthropic to verify this key. Try again in a moment.',
    });

    const result = await updateProviderKeys(TENANT, { anthropic: ANTHROPIC_KEY });

    expect(result).toEqual({
      ok: false,
      errors: { anthropic: 'Could not reach Anthropic to verify this key. Try again in a moment.' },
    });
    expect(putProviderSecret).not.toHaveBeenCalled();
  });

  it('reports every failing field at once rather than one per save', async () => {
    validateProviderCredential.mockResolvedValue({
      ok: false, code: 'invalid_key', message: 'declined',
    });
    const result = await updateProviderKeys(TENANT, {
      anthropic: ANTHROPIC_KEY,
      openai: OPENAI_KEY,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(Object.keys(result.errors).sort()).toEqual(['anthropic', 'openai']);
  });
});

describe('local checks, before any network call', () => {
  it('refuses a hint coming back as a key', async () => {
    // Storing a hint destroys the real credential and the customer cannot tell.
    const result = await updateProviderKeys(TENANT, { anthropic: 'sk-ant••••••••3f2x' });
    expect(result.ok).toBe(false);
    expect(validateProviderCredential).not.toHaveBeenCalled();
  });

  it('refuses a string too short to be any vendor key', async () => {
    const result = await updateProviderKeys(TENANT, { anthropic: 'sk-short-1' });
    expect(result.ok).toBe(false);
    expect(validateProviderCredential).not.toHaveBeenCalled();
  });

  it('refuses a Google value that is not a service account, before any round trip', async () => {
    // Google is the one vendor whose credential is not an opaque key. An API
    // key pasted into that field cannot be exchanged for anything, and saying
    // so here is cheaper and clearer than a provider round trip that 401s.
    const result = await updateProviderKeys(TENANT, { google: 'AIzaSyD-not-a-service-account' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.google).toMatch(/service account/i);
    expect(validateProviderCredential).not.toHaveBeenCalled();
  });
});

describe('what leaves the server', () => {
  it('returns hints and never the Secret Manager pointer', async () => {
    await updateProviderKeys(TENANT, { anthropic: ANTHROPIC_KEY });
    const keys = await getProviderKeys(TENANT);
    expect(keys[0]).toEqual({
      vendor: 'anthropic',
      hint: 'sk-ant••••••••3f2x',
      status: 'valid',
      updatedAt: '2026-09-01T12:00:00.000Z',
      lastVerifiedAt: '2026-09-01T12:00:00.000Z',
    });
    expect(JSON.stringify(keys)).not.toContain('ai-provider-key-');
    expect(JSON.stringify(keys)).not.toContain(ANTHROPIC_KEY);
  });

  it('hands the audit row the previous and new hint, never the key', async () => {
    await updateProviderKeys(TENANT, { anthropic: ANTHROPIC_KEY });
    const result = await updateProviderKeys(TENANT, { anthropic: 'sk-ant-api03-rotated-9zZz' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changes).toEqual([
      { vendor: 'anthropic', previousHint: 'sk-ant••••••••3f2x', newHint: 'sk-ant••••••••9zZz' },
    ]);
  });

  it('records a first save with a null previous hint', async () => {
    const result = await updateProviderKeys(TENANT, { anthropic: ANTHROPIC_KEY });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.changes[0].previousHint).toBeNull();
  });
});

describe('caches', () => {
  it('drops both caches on a write, so a rotated key is used on the next call', async () => {
    await updateProviderKeys(TENANT, { anthropic: ANTHROPIC_KEY });
    expect(invalidateProviderSecretCache).toHaveBeenCalledWith(
      `ai-provider-key-${TENANT}-anthropic`,
    );
    expect(invalidateResolutionCache).toHaveBeenCalledWith(TENANT);
  });

  it('drops both caches on a revocation, so the dead key is not served again', async () => {
    await updateProviderKeys(TENANT, { anthropic: ANTHROPIC_KEY });
    invalidateResolutionCache.mockClear();
    invalidateProviderSecretCache.mockClear();

    await recordProviderKeyRevoked(TENANT, 'anthropic');

    expect(markRevoked).toHaveBeenCalled();
    expect(invalidateProviderSecretCache).toHaveBeenCalled();
    expect(invalidateResolutionCache).toHaveBeenCalledWith(TENANT);
  });
});

describe('parseKeyUpdateBody', () => {
  it('accepts the shape the card sends', () => {
    expect(parseKeyUpdateBody({ keys: { openai: 'sk-proj-x' } })).toEqual({ openai: 'sk-proj-x' });
  });

  it('refuses a vendor the card does not offer', () => {
    // `grok` names a model brand routed through OpenRouter, not an account a
    // key belongs to. The two vocabularies are deliberately not merged.
    expect(parseKeyUpdateBody({ keys: { grok: 'x' } })).toBeNull();
  });

  it('refuses a non-string value and a missing keys object', () => {
    expect(parseKeyUpdateBody({ keys: { openai: 42 } })).toBeNull();
    expect(parseKeyUpdateBody({})).toBeNull();
    expect(parseKeyUpdateBody(null)).toBeNull();
  });

  it('accepts null as the clear button\'s remove', () => {
    expect(parseKeyUpdateBody({ keys: { openai: null } })).toEqual({ openai: null });
  });
});

// The clear button. Removal is the one write that is destructive, so what it
// does and what it refuses to do both matter.
describe('removing a key', () => {
  beforeEach(async () => {
    validateProviderCredential.mockResolvedValue({ ok: true });
    await updateProviderKeys(TENANT, { anthropic: ANTHROPIC_KEY, openai: OPENAI_KEY });
    jest.clearAllMocks();
    validateProviderCredential.mockResolvedValue({ ok: true });
  });

  it('drops the row and destroys the secret', async () => {
    const result = await updateProviderKeys(TENANT, { anthropic: null });

    expect(result.ok).toBe(true);
    expect(deleteKeys).toHaveBeenCalledWith(TENANT, ['anthropic']);
    expect(deleteProviderSecret).toHaveBeenCalledWith(`ai-provider-key-${TENANT}-anthropic`);

    const keys = await getProviderKeys(TENANT);
    expect(keys.find((k) => k.vendor === 'anthropic')).toBeUndefined();
  });

  it('leaves every other provider alone', async () => {
    await updateProviderKeys(TENANT, { anthropic: null });
    const keys = await getProviderKeys(TENANT);
    expect(keys.find((k) => k.vendor === 'openai')?.hint).toBeTruthy();
  });

  it('audits the removal with a null new hint', async () => {
    const result = await updateProviderKeys(TENANT, { anthropic: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const change = result.changes.find((c) => c.vendor === 'anthropic');
    expect(change?.previousHint).toBeTruthy();
    expect(change?.newHint).toBeNull();
  });

  it('never calls the provider to remove a key', async () => {
    // Refusing to remove a credential because the provider is unreachable would
    // trap a customer who has already revoked it upstream.
    await updateProviderKeys(TENANT, { anthropic: null });
    expect(validateProviderCredential).not.toHaveBeenCalled();
  });

  it('removes and rotates in one write', async () => {
    const result = await updateProviderKeys(TENANT, {
      anthropic: null,
      openai: 'sk-proj-rotated-key-7ttZ',
    });
    expect(result.ok).toBe(true);

    const keys = await getProviderKeys(TENANT);
    expect(keys.find((k) => k.vendor === 'anthropic')).toBeUndefined();
    expect(keys.find((k) => k.vendor === 'openai')?.hint).toBe('sk-pro••••••••7ttZ');
  });

  it('applies nothing when a co-submitted key fails validation', async () => {
    // The write is all-or-nothing. A removal that went through while its
    // companion was rejected would be an unrecoverable half-save.
    validateProviderCredential.mockResolvedValue({ ok: false, reason: 'invalid_key', message: 'nope' });

    const result = await updateProviderKeys(TENANT, {
      anthropic: null,
      openai: 'sk-proj-rejected-key-0000',
    });

    expect(result.ok).toBe(false);
    expect(deleteKeys).not.toHaveBeenCalled();
    expect(deleteProviderSecret).not.toHaveBeenCalled();
  });

  it('drops the resolver cache so the removed key stops serving', async () => {
    await updateProviderKeys(TENANT, { anthropic: null });
    expect(invalidateResolutionCache).toHaveBeenCalledWith(TENANT);
    expect(invalidateProviderSecretCache).toHaveBeenCalledWith(
      `ai-provider-key-${TENANT}-anthropic`,
    );
  });

  it('an empty string is still not a removal', async () => {
    // A field the user focused and left submits ''. Treating that as a delete
    // would make a stray click destructive.
    const result = await updateProviderKeys(TENANT, { anthropic: '' });
    expect(result.ok).toBe(true);
    expect(deleteKeys).not.toHaveBeenCalled();
    const keys = await getProviderKeys(TENANT);
    expect(keys.find((k) => k.vendor === 'anthropic')?.hint).toBeTruthy();
  });
});
