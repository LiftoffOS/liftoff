// Phase 4D: Sidecar Shared-Secret Auth tests

import { SIDECAR_SECRET, SIDECAR_AUTH_HEADER, validateSidecarAuth } from '../sidecar-secret';

describe('sidecar-secret', () => {
  describe('SIDECAR_SECRET', () => {
    it('is a 64-character hex string (32 bytes)', () => {
      expect(typeof SIDECAR_SECRET).toBe('string');
      expect(SIDECAR_SECRET).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(SIDECAR_SECRET)).toBe(true);
    });

    it('returns the same value on repeated imports (singleton)', async () => {
      // Re-importing the same module returns the same module instance in Node.
      // Jest module cache ensures this is the same object reference.
      const mod = await import('../sidecar-secret');
      expect(mod.SIDECAR_SECRET).toBe(SIDECAR_SECRET);
    });
  });

  describe('SIDECAR_AUTH_HEADER', () => {
    it('is the expected header name', () => {
      expect(SIDECAR_AUTH_HEADER).toBe('X-Sidecar-Auth');
    });
  });

  describe('validateSidecarAuth', () => {
    it('returns true when header matches the secret', () => {
      expect(validateSidecarAuth(SIDECAR_SECRET)).toBe(true);
    });

    it('returns false when header is missing (undefined)', () => {
      expect(validateSidecarAuth(undefined)).toBe(false);
    });

    it('returns false when header is an empty string', () => {
      expect(validateSidecarAuth('')).toBe(false);
    });

    it('returns false when header has wrong value', () => {
      const wrongSecret = 'a'.repeat(64);
      // Make sure it is actually wrong (SIDECAR_SECRET is random 64-char hex)
      // If by extreme chance they collide the test would still pass because
      // that case means the correct secret is all-'a's — an improbable 1/16^64
      // chance. We accept this theoretical non-determinism.
      expect(validateSidecarAuth(wrongSecret)).toBe(SIDECAR_SECRET === wrongSecret);
    });

    it('returns false when header is an array (multi-value)', () => {
      expect(validateSidecarAuth([SIDECAR_SECRET])).toBe(false);
    });

    it('returns false when header is wrong length (timing-safe length check)', () => {
      // A shorter value must not match, and must not throw.
      expect(validateSidecarAuth(SIDECAR_SECRET.slice(0, 32))).toBe(false);
    });

    it('returns false when header is longer than the secret', () => {
      expect(validateSidecarAuth(SIDECAR_SECRET + 'extra')).toBe(false);
    });
  });
});
