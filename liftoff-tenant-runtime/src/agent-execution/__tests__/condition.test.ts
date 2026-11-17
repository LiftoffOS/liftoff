/**
 * Phase 3 — condition.ts tests: operator matrix, nested paths, null handling,
 * compound predicates, prototype-pollution rejection, parse errors.
 */

import { evaluateCondition } from '../condition';

describe('Phase 3 — evaluateCondition', () => {
  describe('simple predicates', () => {
    it('== matches string values', () => {
      expect(evaluateCondition("$.status == 'open'", { status: 'open' })).toBe(true);
      expect(evaluateCondition("$.status == 'open'", { status: 'closed' })).toBe(false);
    });

    it('!= rejects matching values', () => {
      expect(evaluateCondition("$.status != 'closed'", { status: 'open' })).toBe(true);
      expect(evaluateCondition("$.status != 'open'", { status: 'open' })).toBe(false);
    });

    it('> compares numbers', () => {
      expect(evaluateCondition('$.count > 0', { count: 5 })).toBe(true);
      expect(evaluateCondition('$.count > 0', { count: 0 })).toBe(false);
      expect(evaluateCondition('$.count > 0', { count: -1 })).toBe(false);
    });

    it('< compares numbers', () => {
      expect(evaluateCondition('$.count < 10', { count: 5 })).toBe(true);
      expect(evaluateCondition('$.count < 10', { count: 10 })).toBe(false);
    });

    it('>= compares numbers', () => {
      expect(evaluateCondition('$.count >= 5', { count: 5 })).toBe(true);
      expect(evaluateCondition('$.count >= 5', { count: 4 })).toBe(false);
    });

    it('<= compares numbers', () => {
      expect(evaluateCondition('$.count <= 5', { count: 5 })).toBe(true);
      expect(evaluateCondition('$.count <= 5', { count: 6 })).toBe(false);
    });
  });

  describe('null checks', () => {
    it('is null matches null value', () => {
      expect(evaluateCondition('$.field is null', { field: null })).toBe(true);
    });

    it('is null matches undefined value', () => {
      expect(evaluateCondition('$.field is null', {})).toBe(true);
    });

    it('is null rejects non-null', () => {
      expect(evaluateCondition('$.field is null', { field: 'x' })).toBe(false);
    });

    it('is not null matches non-null', () => {
      expect(evaluateCondition('$.field is not null', { field: 'x' })).toBe(true);
    });

    it('is not null rejects null', () => {
      expect(evaluateCondition('$.field is not null', { field: null })).toBe(false);
    });

    it('is not null rejects missing', () => {
      expect(evaluateCondition('$.field is not null', {})).toBe(false);
    });
  });

  describe('nested paths', () => {
    it('resolves nested dot-path fields', () => {
      expect(evaluateCondition(
        "$.customer.status == 'active'",
        { customer: { status: 'active' } },
      )).toBe(true);
    });

    it('resolves deeply nested paths', () => {
      expect(evaluateCondition(
        '$.a.b.c > 0',
        { a: { b: { c: 42 } } },
      )).toBe(true);
    });

    it('returns false (not throws) for missing nested path', () => {
      // Missing path resolves to undefined, which becomes NaN for > comparison
      expect(evaluateCondition('$.a.b.c > 0', { a: {} })).toBe(false);
    });
  });

  describe('compound predicates (&&, ||)', () => {
    it('&& requires both sides true', () => {
      expect(evaluateCondition(
        "$.status == 'open' && $.count > 0",
        { status: 'open', count: 5 },
      )).toBe(true);

      expect(evaluateCondition(
        "$.status == 'open' && $.count > 0",
        { status: 'open', count: 0 },
      )).toBe(false);
    });

    it('|| requires at least one side true', () => {
      expect(evaluateCondition(
        "$.a == '1' || $.b == '2'",
        { a: '1', b: '0' },
      )).toBe(true);

      expect(evaluateCondition(
        "$.a == '1' || $.b == '2'",
        { a: '0', b: '0' },
      )).toBe(false);
    });

    it('mixed && and || (left-to-right precedence)', () => {
      // (a == 1 && b == 2) || c == 3
      // Left-to-right: first split on ||, then on &&
      expect(evaluateCondition(
        "$.a == '1' && $.b == '2' || $.c == '3'",
        { a: '0', b: '0', c: '3' },
      )).toBe(true); // c == 3 satisfies the || branch
    });
  });

  describe('prototype-pollution hardening (via getByPath)', () => {
    it('rejects __proto__ in field path', () => {
      // __proto__.polluted should resolve to undefined, making any comparison false
      expect(evaluateCondition("$.__proto__.polluted == 'true'", {})).toBe(false);
    });

    it('rejects constructor in field path', () => {
      expect(evaluateCondition("$.constructor.name == 'Object'", {})).toBe(false);
    });
  });

  describe('parse errors (throw, not silent true)', () => {
    it('throws on completely unparseable condition', () => {
      expect(() => evaluateCondition('garbage', {})).toThrow(/unparseable/i);
    });

    it('throws on missing $. prefix', () => {
      expect(() => evaluateCondition("status == 'open'", {})).toThrow(/unparseable/i);
    });

    it('throws on empty string', () => {
      expect(() => evaluateCondition('', {})).toThrow(/unparseable/i);
    });
  });

  describe('type coercion edge cases', () => {
    it('== uses String() coercion', () => {
      expect(evaluateCondition('$.val == 42', { val: 42 })).toBe(true);
      expect(evaluateCondition("$.val == 'true'", { val: true })).toBe(true);
    });

    it('> uses Number() coercion', () => {
      expect(evaluateCondition("$.val > 5", { val: '10' })).toBe(true);
      expect(evaluateCondition("$.val > 5", { val: '3' })).toBe(false);
    });
  });
});
