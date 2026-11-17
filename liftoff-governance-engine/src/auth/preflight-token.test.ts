// Unit tests for preflight-token sign / verify / extract.
//
// Keep these deterministic: pin the signing key via env var in beforeAll
// and restore it in afterAll so other suites that rely on the default
// `GOVERNANCE_SERVICE_TOKEN` / `GOVERNANCE_ENGINE_TOKEN` (legacy) fallback
// behaviour aren't affected.

import {
  signPreflightToken,
  verifyPreflightToken,
  extractPreflightClaims,
  deriveVersionTag,
  PREFLIGHT_TOKEN_TTL_MS,
  type PreflightClaims,
} from './preflight-token';

const SIGNING_KEY = 'test-preflight-signing-key';

function baseClaims(): Omit<PreflightClaims, 'issuedAt' | 'expiresAt'> {
  return {
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    invocationId: 'inv-1',
    capabilityTier: 'standard',
    executionEnvironment: 'managed',
    hitlLevel: 3,
    admissionStatus: 'ADMITTED',
    preflightVersion: 'abc123',
  };
}

describe('preflight-token', () => {
  let origKey: string | undefined;
  let origServiceToken: string | undefined;
  let origLegacyToken: string | undefined;

  beforeAll(() => {
    origKey = process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY;
    origServiceToken = process.env.GOVERNANCE_SERVICE_TOKEN;
    origLegacyToken = process.env.GOVERNANCE_ENGINE_TOKEN;
    process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY = SIGNING_KEY;
  });

  afterAll(() => {
    if (origKey === undefined)
      delete process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY;
    else process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY = origKey;
    if (origServiceToken === undefined)
      delete process.env.GOVERNANCE_SERVICE_TOKEN;
    else process.env.GOVERNANCE_SERVICE_TOKEN = origServiceToken;
    if (origLegacyToken === undefined)
      delete process.env.GOVERNANCE_ENGINE_TOKEN;
    else process.env.GOVERNANCE_ENGINE_TOKEN = origLegacyToken;
  });

  it('round-trips: sign → verify → recover claims', () => {
    const token = signPreflightToken(baseClaims());
    const result = verifyPreflightToken(token);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.claims.tenantId).toBe('tenant-1');
    expect(result.claims.agentId).toBe('agent-1');
    expect(result.claims.invocationId).toBe('inv-1');
    expect(result.claims.capabilityTier).toBe('standard');
    expect(result.claims.executionEnvironment).toBe('managed');
    expect(result.claims.hitlLevel).toBe(3);
    expect(result.claims.admissionStatus).toBe('ADMITTED');
    expect(result.claims.preflightVersion).toBe('abc123');
    expect(typeof result.claims.issuedAt).toBe('number');
    expect(typeof result.claims.expiresAt).toBe('number');
  });

  it('populates issuedAt + expiresAt with a 30s TTL by default', () => {
    const before = Date.now();
    const token = signPreflightToken(baseClaims());
    const after = Date.now();
    const result = verifyPreflightToken(token);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.claims.issuedAt).toBeGreaterThanOrEqual(before);
    expect(result.claims.issuedAt).toBeLessThanOrEqual(after);
    expect(result.claims.expiresAt - result.claims.issuedAt).toBe(
      PREFLIGHT_TOKEN_TTL_MS,
    );
  });

  it('rejects an expired token', () => {
    const now = Date.now();
    const token = signPreflightToken({
      ...baseClaims(),
      issuedAt: now - 60_000,
      expiresAt: now - 30_000,
    });
    const result = verifyPreflightToken(token, now);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toBe('expired');
  });

  it('rejects a token with a bad signature', () => {
    const token = signPreflightToken(baseClaims());
    const tampered = token.slice(0, -3) + 'AAA'; // clobber last 3 chars of sig
    const result = verifyPreflightToken(tampered);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(['bad-signature', 'malformed']).toContain(result.reason);
  });

  it('rejects a token signed with a different key', () => {
    process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY = 'other-key';
    const token = signPreflightToken(baseClaims());
    process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY = SIGNING_KEY;
    const result = verifyPreflightToken(token);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.reason).toBe('bad-signature');
  });

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'no-dot', '.', 'a.', '.b', 'not a token']) {
      const result = verifyPreflightToken(bad);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(['malformed', 'bad-signature']).toContain(result.reason);
      }
    }
  });

  it('rejects tampered payload even if signature recomputed against bogus header', () => {
    // Flip a char in the payload portion — sig will no longer match.
    const token = signPreflightToken(baseClaims());
    const [payload, sig] = token.split('.');
    const tamperedPayload = payload.slice(0, -1) + (payload.endsWith('A') ? 'B' : 'A');
    const result = verifyPreflightToken(`${tamperedPayload}.${sig}`);
    expect(result.valid).toBe(false);
  });

  it('extractPreflightClaims works without verifying signature', () => {
    const token = signPreflightToken(baseClaims());
    const tampered = token.slice(0, -5) + 'XXXXX';
    const claims = extractPreflightClaims(tampered);
    expect(claims).not.toBeNull();
    expect(claims?.tenantId).toBe('tenant-1');
  });

  it('extractPreflightClaims returns null for garbage', () => {
    expect(extractPreflightClaims('')).toBeNull();
    expect(extractPreflightClaims('garbage')).toBeNull();
    expect(extractPreflightClaims('aaaa.bbbb')).toBeNull();
  });

  it('deriveVersionTag is deterministic + 16 chars', () => {
    const a = deriveVersionTag('hello');
    const b = deriveVersionTag('hello');
    const c = deriveVersionTag('hello!');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(16);
  });

  it('throws at sign time when no signing key is set', () => {
    delete process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY;
    delete process.env.GOVERNANCE_SERVICE_TOKEN;
    delete process.env.GOVERNANCE_ENGINE_TOKEN;
    try {
      expect(() => signPreflightToken(baseClaims())).toThrow(
        /GOVERNANCE_PREFLIGHT_SIGNING_KEY/,
      );
    } finally {
      process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY = SIGNING_KEY;
    }
  });

  it('falls back to GOVERNANCE_SERVICE_TOKEN when signing key is absent', () => {
    delete process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY;
    delete process.env.GOVERNANCE_ENGINE_TOKEN;
    process.env.GOVERNANCE_SERVICE_TOKEN = 'svc-token-abc';
    try {
      const token = signPreflightToken(baseClaims());
      const result = verifyPreflightToken(token);
      expect(result.valid).toBe(true);
    } finally {
      delete process.env.GOVERNANCE_SERVICE_TOKEN;
      process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY = SIGNING_KEY;
    }
  });

  it('falls back to legacy GOVERNANCE_ENGINE_TOKEN when newer names are absent', () => {
    delete process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY;
    delete process.env.GOVERNANCE_SERVICE_TOKEN;
    process.env.GOVERNANCE_ENGINE_TOKEN = 'legacy-token-xyz';
    try {
      const token = signPreflightToken(baseClaims());
      const result = verifyPreflightToken(token);
      expect(result.valid).toBe(true);
    } finally {
      delete process.env.GOVERNANCE_ENGINE_TOKEN;
      process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY = SIGNING_KEY;
    }
  });
});
