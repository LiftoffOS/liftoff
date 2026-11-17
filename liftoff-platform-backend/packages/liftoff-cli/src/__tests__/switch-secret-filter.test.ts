// Security tests for the import secret filter.
//
// The property under test is blunt: known secret FORMATS never appear in an
// uploaded manifest or in a log line. These run against text shaped like the
// real thing, because a filter tested only against "SECRET123" passes while
// leaking every real credential it meets.

import {
  assertNoSecrets,
  isCredentialFile,
  isCredentialKey,
  isExcludedPath,
  redactConfigValue,
  redactText,
  REDACTION_PLACEHOLDER,
} from '../switch/secret-filter';

/** Format-realistic fakes, in the house style from
 *  src/common/__tests__/redact.test.ts: the real PREFIX as a plain literal,
 *  and the high-entropy body generated with .repeat().
 *
 *  The filter has to meet strings shaped like the real thing — a fixture full
 *  of "SECRET123" passes while leaking every actual credential it meets. But a
 *  complete credential-shaped literal in source trips push protection and,
 *  worse, pollutes secret scanning: a real leak later has to be found among our
 *  deliberate decoys. Generating the body solves both, and keeps the prefix
 *  readable so it is obvious at a glance which vendor each case covers.
 *
 *  AKIAIOSFODNN7EXAMPLE is AWS's own documentation example and is left literal,
 *  matching the existing test. */
const FAKE_SECRETS: Array<{ label: string; value: string }> = [
  { label: 'anthropic', value: 'sk-ant-api03-' + 'a'.repeat(64) },
  { label: 'openai', value: 'sk-' + 'b'.repeat(40) },
  { label: 'github pat', value: 'ghp_' + 'c'.repeat(36) },
  { label: 'github fine-grained', value: 'github_pat_' + 'd'.repeat(30) },
  { label: 'slack bot', value: 'xoxb-123456789-987654321-' + 'e'.repeat(30) },
  { label: 'slack webhook', value: 'https://hooks.slack.com/services/T00000000/B00000000/' + 'f'.repeat(24) },
  { label: 'google api key', value: 'AIza' + 'g'.repeat(35) },
  { label: 'aws access key', value: 'AKIAIOSFODNN7EXAMPLE' },
  { label: 'stripe live', value: 'sk_live_' + 'h'.repeat(30) },
  { label: 'jwt', value: `eyJ${'i'.repeat(20)}.eyJ${'j'.repeat(30)}.${'k'.repeat(30)}` },
  { label: 'postgres url', value: 'postgresql://appuser:hunter2SuperSecret@db.internal:5432/liftoff' },
];

describe('switch secret filter', () => {
  describe('known secret formats never survive redaction', () => {
    for (const { label, value } of FAKE_SECRETS) {
      it(`redacts a ${label} credential embedded in instruction text`, () => {
        const source = `Use this to authenticate:\n\n  ${value}\n\nThen run the report.`;
        const { text, summary } = redactText(source);

        expect(text).not.toContain(value);
        expect(text).toContain(REDACTION_PLACEHOLDER);
        expect(summary.total).toBeGreaterThan(0);
        // The summary is counts only — re-leaking a fragment through telemetry
        // would defeat the whole exercise.
        expect(JSON.stringify(summary)).not.toContain(value);
      });
    }

    it('redacts a private key block spanning many lines', () => {
      const pem = [
        '-----BEGIN RSA PRIVATE KEY-----',
        'MIIEowIBAAKCAQEA0123456789abcdefghijklmnop',
        'qrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
        '-----END RSA PRIVATE KEY-----',
      ].join('\n');
      const { text } = redactText(`Deploy key:\n${pem}\n`);
      expect(text).not.toContain('MIIEowIBAAKCAQEA');
      expect(text).toContain(REDACTION_PLACEHOLDER);
    });
  });

  describe('the final upload gate', () => {
    it('refuses an upload whose serialized bundle still carries a secret', () => {
      const bundle = JSON.stringify({
        agents: [{ role: 'Ops', responsibilities: `token ${FAKE_SECRETS[0].value}` }],
      });
      // An adapter defect, not a user error: refusing is correct, and quietly
      // cleaning it would hide the defect that produced it.
      expect(() => assertNoSecrets(bundle)).toThrow(/credential-shaped values/);
    });

    it('passes a bundle that carries only requirements', () => {
      const bundle = JSON.stringify({
        catalogConnectorRequirements: [{ connectorType: 'slack', authMethod: 'oauth' }],
        agents: [{ role: 'Ops', responsibilities: 'Reconnect Slack in Liftoff.' }],
      });
      expect(() => assertNoSecrets(bundle)).not.toThrow();
    });
  });

  describe('structural exclusion', () => {
    it.each([
      '.env',
      '.env.local',
      'credentials.json',
      'auth.db',
      'id_rsa',
      'server.pem',
      'client.key',
    ])('treats %s as credential material that is never read', (name) => {
      expect(isCredentialFile(`/home/u/.openclaw/${name}`)).toBe(true);
    });

    it('does not exclude ordinary instruction files', () => {
      expect(isCredentialFile('/home/u/.openclaw/AGENTS.md')).toBe(false);
      expect(isCredentialFile('/home/u/.hermes/SOUL.md')).toBe(false);
    });

    it.each(['auth', 'sessions', 'transcripts', 'plugins', 'node_modules'])(
      'excludes everything under a %s directory',
      (dir) => {
        expect(isExcludedPath(`agents/main/${dir}/thing.md`)).toBe(true);
      },
    );

    it('keeps ordinary skill paths', () => {
      expect(isExcludedPath('agents/main/skills/triage.md')).toBe(false);
    });
  });

  describe('config keys whose values are credentials', () => {
    it.each([
      'apiKey',
      'api_key',
      'client_secret',
      'refreshToken',
      'password',
      'privateKey',
      'headers.authorization_token',
    ])('redacts the value at key %s whatever its shape', (key) => {
      expect(isCredentialKey(key)).toBe(true);
    });

    it('replaces credential-keyed values wholesale, including short ones', () => {
      const { value, summary } = redactConfigValue({
        name: 'reporting',
        apiKey: 'abc',
        nested: { client_secret: 'x' },
      });
      const out = value as Record<string, unknown>;
      expect(out.apiKey).toBe(REDACTION_PLACEHOLDER);
      expect((out.nested as Record<string, unknown>).client_secret).toBe(REDACTION_PLACEHOLDER);
      // A non-credential field is left intact so the import stays useful.
      expect(out.name).toBe('reporting');
      expect(summary.total).toBe(2);
    });

    it('scrubs a secret hiding under an innocent key name', () => {
      const { value } = redactConfigValue({ note: `use ${FAKE_SECRETS[4].value} for slack` });
      expect(String((value as Record<string, unknown>).note)).not.toContain('xoxb-');
    });
  });
});
