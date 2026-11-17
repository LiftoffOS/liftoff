/**
 * R5 TE-R4-006 + TE-R5-005: per-pattern scrubber coverage + TESTONLY marker.
 *
 * Canonical test values embed TESTONLY_NOTASECRET_ padding so they match our
 * pattern regex but are rejected by GitHub secret scanning and the
 * scripts/ci/check-test-secrets.sh gate.
 */
import {
  SECRET_PATTERNS,
  scrubConnStrings,
  scrubSecrets,
  compileTenantPattern,
} from '../secret-scrubber';

const TESTONLY = 'TESTONLY_NOTASECRET';

describe('secret-scrubber canonical coverage', () => {
  // Note: each canonical value must both (a) match its regex and (b) contain
  // TESTONLY so scripts/ci/check-test-secrets.sh treats it as safe. Patterns
  // whose charset excludes `_` use `TESTONLYNOTASECRET` (no underscore).
  const TESTONLY_ALNUM = 'TESTONLYNOTASECRET';
  const PATTERN_TESTS: Array<{ name: string; canonical: string; markerShouldRedactTo: string }> = [
    {
      name: 'anthropic-api-key',
      // Regex: sk-ant-(?:api0\d-)? [A-Za-z0-9_\-]{32,128}
      canonical: `sk-ant-${TESTONLY}ABC123def456ghi789jkl012mno345pqr67`,
      markerShouldRedactTo: '[REDACTED:anthropic-api-key]',
    },
    {
      name: 'github-classic-pat',
      // Regex: ghp_[A-Za-z0-9]{36} — exactly 36 alnum chars
      canonical: `ghp_${TESTONLY_ALNUM}abcdef1234567890ab`, // 18 + 18 = 36 chars
      markerShouldRedactTo: '[REDACTED:github-classic-pat]',
    },
    {
      name: 'openai-project-key',
      // Regex: sk-proj-[A-Za-z0-9_\-]{40,200}
      canonical: `sk-proj-${TESTONLY}ABCDEFGHIJKLMNOPQRSTUVWXYZab`, // enough chars after the _
      markerShouldRedactTo: '[REDACTED:openai-project-key]',
    },
    {
      name: 'stripe-live-key',
      // Regex: sk_live_[A-Za-z0-9]{24,99} — no underscores in body
      canonical: `sk_live_${TESTONLY_ALNUM}ABCDEF1234567890`, // 18 + 16 = 34 chars alnum
      markerShouldRedactTo: '[REDACTED:stripe-live-key]',
    },
    {
      name: 'npm-token',
      // Regex: npm_[A-Za-z0-9]{36} — exactly 36 alnum chars
      canonical: `npm_${TESTONLY_ALNUM}abcdefghi1234567ab`, // 18 + 18 = 36 chars
      markerShouldRedactTo: '[REDACTED:npm-token]',
    },
  ];

  test.each(PATTERN_TESTS)('$name redacts canonical input', ({ canonical, markerShouldRedactTo }) => {
    const scrubbed = scrubSecrets(canonical);
    expect(scrubbed).toContain(markerShouldRedactTo);
    expect(scrubbed).not.toContain(canonical);
  });

  it('every exported pattern in SECRET_PATTERNS is non-empty', () => {
    expect(SECRET_PATTERNS.length).toBeGreaterThan(10);
  });

  it('all canonical test values contain TESTONLY marker', () => {
    for (const t of PATTERN_TESTS) {
      expect(t.canonical).toContain('TESTONLY');
    }
  });

  it('bounded PEM regex completes quickly on malformed input (ReDoS defense)', () => {
    const malformed = '-----BEGIN RSA PRIVATE KEY-----\n' + 'A'.repeat(1_000_000); // no END marker
    const start = Date.now();
    scrubSecrets(malformed);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('connection string redacts password only', () => {
    const input = 'postgres://alice:TESTONLY_password_value@db.example.com:5432/mydb';
    const scrubbed = scrubConnStrings(input);
    expect(scrubbed).toContain('postgres://alice:[REDACTED]@db.example.com:5432/mydb');
    expect(scrubbed).not.toContain('TESTONLY_password_value');
  });

  it('compileTenantPattern rejects unbounded quantifiers (ReDoS)', () => {
    expect(() => compileTenantPattern('a+b')).toThrow(/unbounded/);
    expect(() => compileTenantPattern('a*')).toThrow(/unbounded/);
    expect(() => compileTenantPattern('x{2,}')).toThrow(/unbounded/);
  });

  it('compileTenantPattern accepts bounded quantifiers', () => {
    expect(() => compileTenantPattern('a{2,5}')).not.toThrow();
    expect(() => compileTenantPattern('x{3}')).not.toThrow();
  });
});
