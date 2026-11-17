import { SandboxOutputSanitizer } from '../output-sanitizer';

describe('SandboxOutputSanitizer', () => {
  let sanitizer: SandboxOutputSanitizer;

  beforeEach(() => {
    sanitizer = new SandboxOutputSanitizer({
      maxOutputBytes: 1000,
      injectedCredentialValues: ['super-secret-token-12345'],
    });
  });

  describe('secret pattern redaction', () => {
    it('redacts AWS access keys', () => {
      const { stdout } = sanitizer.sanitize('key=AKIAIOSFODNN7EXAMPLE', '');
      expect(stdout).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(stdout).toContain('[REDACTED]');
    });

    it('redacts GitHub PATs', () => {
      // TESTONLY_NOTASECRET: synthetic 36-char PAT for regex match
      const { stdout } = sanitizer.sanitize('token: ghp_TESTONLYNOTASECRETabcdef1234567890ab', '');
      expect(stdout).not.toContain('ghp_');
      expect(stdout).toContain('[REDACTED]');
    });

    it('redacts JWTs', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const { stdout } = sanitizer.sanitize(`Bearer ${jwt}`, '');
      expect(stdout).not.toContain('eyJ');
      expect(stdout).toContain('[REDACTED]');
    });

    it('redacts Anthropic API keys', () => {
      const { stdout } = sanitizer.sanitize('ANTHROPIC_API_KEY=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTuvwxyz', '');
      expect(stdout).not.toContain('sk-ant-');
      expect(stdout).toContain('[REDACTED]');
    });

    it('redacts connection strings with passwords', () => {
      const { stdout } = sanitizer.sanitize('postgres://user:p4ssw0rd@host:5432/db', '');
      expect(stdout).not.toContain('p4ssw0rd');
      expect(stdout).toContain('[REDACTED]');
    });

    it('redacts Slack tokens', () => {
      const { stdout } = sanitizer.sanitize('token: xoxb-123-456-abcdefgh', '');
      expect(stdout).not.toContain('xoxb-');
      expect(stdout).toContain('[REDACTED]');
    });

    it('redacts private key markers', () => {
      const { stdout } = sanitizer.sanitize('-----BEGIN RSA PRIVATE KEY-----\nMIIEo...', '');
      expect(stdout).toContain('[REDACTED]');
    });

    it('redacts generic API key patterns', () => {
      const { stdout } = sanitizer.sanitize('api_key=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234567890', '');
      expect(stdout).toContain('[REDACTED]');
    });
  });

  describe('injected credential redaction', () => {
    it('redacts injected credential values', () => {
      const { stdout } = sanitizer.sanitize('Using token: super-secret-token-12345', '');
      expect(stdout).not.toContain('super-secret-token-12345');
      expect(stdout).toContain('[REDACTED]');
    });

    it('does not redact short credential values (< 8 chars)', () => {
      const shortSanitizer = new SandboxOutputSanitizer({
        injectedCredentialValues: ['abc'],
      });
      const { stdout } = shortSanitizer.sanitize('abc is common', '');
      expect(stdout).toContain('abc');
    });
  });

  describe('ANSI stripping', () => {
    it('strips ANSI color codes', () => {
      const { stdout } = sanitizer.sanitize('\x1B[31mError\x1B[0m: something failed', '');
      expect(stdout).toBe('Error: something failed');
    });

    it('strips cursor movement codes', () => {
      const { stdout } = sanitizer.sanitize('\x1B[2Jhello\x1B[1;1H', '');
      expect(stdout).toBe('hello');
    });
  });

  describe('truncation', () => {
    it('truncates stdout exceeding maxOutputBytes', () => {
      const longOutput = 'x'.repeat(2000);
      const { stdout } = sanitizer.sanitize(longOutput, '');
      expect(stdout.length).toBeLessThanOrEqual(1000 + '\n[OUTPUT TRUNCATED]'.length);
      expect(stdout).toContain('[OUTPUT TRUNCATED]');
    });

    it('truncates stderr independently', () => {
      const { stderr } = sanitizer.sanitize('', 'y'.repeat(2000));
      expect(stderr).toContain('[OUTPUT TRUNCATED]');
    });

    it('does not truncate output under limit', () => {
      const { stdout } = sanitizer.sanitize('short output', '');
      expect(stdout).toBe('short output');
      expect(stdout).not.toContain('TRUNCATED');
    });
  });

  describe('combined sanitization', () => {
    it('applies all sanitization steps in order', () => {
      const input = '\x1B[31mAPI_KEY=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTuvwxyz\x1B[0m and super-secret-token-12345';
      const { stdout } = sanitizer.sanitize(input, '');
      expect(stdout).not.toContain('sk-ant-');
      expect(stdout).not.toContain('super-secret-token-12345');
      expect(stdout).not.toContain('\x1B');
    });

    it('returns clean output for non-secret content', () => {
      const { stdout } = sanitizer.sanitize('npm test: 42 tests passed', '');
      expect(stdout).toBe('npm test: 42 tests passed');
    });
  });
});
