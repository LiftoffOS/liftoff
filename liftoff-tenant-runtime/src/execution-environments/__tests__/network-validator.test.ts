import { validateEgressConfig } from '../network-validator';
import { ValidationError } from '../path-validator';

describe('validateEgressConfig', () => {
  describe('block mode', () => {
    it('accepts block with no domains', () => {
      expect(() => validateEgressConfig('block')).not.toThrow();
      expect(() => validateEgressConfig('block', [])).not.toThrow();
      expect(() => validateEgressConfig('block', undefined)).not.toThrow();
    });

    it('rejects block with domains specified', () => {
      expect(() => validateEgressConfig('block', ['example.com'])).toThrow(ValidationError);
    });
  });

  describe('allow-list mode', () => {
    it('accepts valid domains', () => {
      expect(() => validateEgressConfig('allow-list', ['github.com'])).not.toThrow();
      expect(() => validateEgressConfig('allow-list', ['npm.registry.org', 'pypi.org'])).not.toThrow();
    });

    it('rejects empty allowedDomains', () => {
      expect(() => validateEgressConfig('allow-list', [])).toThrow(ValidationError);
      expect(() => validateEgressConfig('allow-list', undefined)).toThrow(ValidationError);
    });

    // The 20-domain cap was removed for browser parity with agent-infra
    // (see packages/sandbox-validators/src/network-validator.ts comment).
    // Allow-list now accepts arbitrarily many domains.
    it('accepts more than 20 domains (no cap)', () => {
      const domains = Array.from({ length: 50 }, (_, i) => `domain${i}.com`);
      expect(() => validateEgressConfig('allow-list', domains)).not.toThrow();
    });

    it('rejects invalid domain format', () => {
      expect(() => validateEgressConfig('allow-list', ['not a domain'])).toThrow(ValidationError);
      expect(() => validateEgressConfig('allow-list', [''])).toThrow(ValidationError);
      expect(() => validateEgressConfig('allow-list', ['http://github.com'])).toThrow(ValidationError);
    });

    it('blocks cloud metadata endpoints', () => {
      expect(() => validateEgressConfig('allow-list', ['metadata.google.internal'])).toThrow(ValidationError);
      expect(() => validateEgressConfig('allow-list', ['169.254.169.254'])).toThrow(ValidationError);
    });

    it('blocks metadata endpoints case-insensitively', () => {
      expect(() => validateEgressConfig('allow-list', ['METADATA.GOOGLE.INTERNAL'])).toThrow(ValidationError);
    });
  });
});
