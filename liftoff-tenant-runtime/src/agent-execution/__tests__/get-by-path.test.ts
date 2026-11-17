/**
 * Phase 3 — getByPath tests: prototype-pollution hardening, Unicode, array access.
 */

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { getByPath } from '../get-by-path';

describe('Phase 3 — getByPath', () => {
  describe('happy paths', () => {
    it('returns root object for empty path', () => {
      expect(getByPath({ a: 1 }, '')).toEqual({ a: 1 });
    });

    it('resolves a single-level path', () => {
      expect(getByPath({ name: 'Alice' }, 'name')).toBe('Alice');
    });

    it('resolves a nested path', () => {
      expect(getByPath({ customer: { id: 'c123', email: 'a@b.com' } }, 'customer.email')).toBe('a@b.com');
    });

    it('resolves deeply nested paths', () => {
      expect(getByPath({ a: { b: { c: { d: 42 } } } }, 'a.b.c.d')).toBe(42);
    });

    it('resolves array index via dot notation (items.0.id)', () => {
      expect(getByPath({ items: [{ id: 'first' }, { id: 'second' }] }, 'items.0.id')).toBe('first');
      expect(getByPath({ items: [{ id: 'first' }, { id: 'second' }] }, 'items.1.id')).toBe('second');
    });

    it('resolves array index via bracket notation (items[0].id)', () => {
      expect(getByPath({ items: [{ id: 'first' }] }, 'items[0].id')).toBe('first');
    });

    it('returns undefined for missing paths', () => {
      expect(getByPath({ a: 1 }, 'b')).toBeUndefined();
      expect(getByPath({ a: { b: 1 } }, 'a.c')).toBeUndefined();
    });

    it('returns undefined for null intermediate', () => {
      expect(getByPath({ a: null }, 'a.b')).toBeUndefined();
    });

    it('returns undefined for primitive intermediate', () => {
      expect(getByPath({ a: 42 }, 'a.b')).toBeUndefined();
    });

    it('handles Unicode keys', () => {
      expect(getByPath({ '日本語': { '名前': 'テスト' } }, '日本語.名前')).toBe('テスト');
    });
  });

  describe('prototype-pollution hardening', () => {
    it('rejects __proto__ path segment', () => {
      expect(getByPath({}, '__proto__.polluted')).toBeUndefined();
    });

    it('rejects constructor path segment', () => {
      expect(getByPath({}, 'constructor.constructor')).toBeUndefined();
    });

    it('rejects prototype path segment', () => {
      expect(getByPath({}, 'prototype.isAdmin')).toBeUndefined();
    });

    it('rejects any segment starting with __', () => {
      expect(getByPath({ __secret: 'x' }, '__secret')).toBeUndefined();
      expect(getByPath({ __internal: { x: 1 } }, '__internal.x')).toBeUndefined();
    });

    it('does NOT pollute Object.prototype', () => {
      const obj = JSON.parse('{"__proto__": {"polluted": true}}');
      getByPath(obj, '__proto__.polluted');
      expect((Object.prototype as any).polluted).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('returns undefined for undefined input', () => {
      expect(getByPath(undefined, 'a')).toBeUndefined();
    });

    it('returns undefined for null input', () => {
      expect(getByPath(null, 'a')).toBeUndefined();
    });

    it('handles boolean and number values', () => {
      expect(getByPath({ flag: true }, 'flag')).toBe(true);
      expect(getByPath({ count: 0 }, 'count')).toBe(0);
    });

    it('handles empty string value', () => {
      expect(getByPath({ name: '' }, 'name')).toBe('');
    });
  });
});
