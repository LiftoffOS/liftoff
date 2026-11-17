// `re2` is a native module; mock it for unit tests so we can verify the
// surrounding logic without requiring the binding at test time. The mock
// delegates to native RegExp, which is sufficient for these patterns
// (none of them exploit pathological backtracking).
jest.mock('re2', () => {
  return class RE2Mock {
    private re: RegExp;
    constructor(pattern: string) { this.re = new RegExp(pattern); }
    test(input: string): boolean { return this.re.test(input); }
  };
}, { virtual: true });

import { evaluate, MAX_PREDICATE_DEPTH, PredicateDepthExceededError } from '../predicate-evaluator';
import type { PredicateExpr } from '../../agent-lifecycle/types';

describe('predicate-evaluator', () => {
  const baseEvent = { data: { age_days: 42, status: 'open', tags: ['urgent', 'finance'] } };

  describe('comparators', () => {
    it('eq matches scalar equality', () => {
      expect(evaluate({ op: 'eq', path: 'status', value: 'open' }, baseEvent)).toBe(true);
      expect(evaluate({ op: 'eq', path: 'status', value: 'closed' }, baseEvent)).toBe(false);
    });

    it('ne is inverse of eq', () => {
      expect(evaluate({ op: 'ne', path: 'status', value: 'closed' }, baseEvent)).toBe(true);
    });

    it.each<[PredicateExpr['op'], number, boolean]>([
      ['gt', 40, true], ['gt', 42, false],
      ['gte', 42, true], ['gte', 43, false],
      ['lt', 50, true], ['lt', 42, false],
      ['lte', 42, true], ['lte', 41, false],
    ])('%s %s → %s', (op, value, expected) => {
      const expr = { op, path: 'age_days', value } as PredicateExpr;
      expect(evaluate(expr, baseEvent)).toBe(expected);
    });

    it('numeric comparators coerce numeric strings', () => {
      const evt = { data: { age_days: '42' } };
      expect(evaluate({ op: 'gt', path: 'age_days', value: 40 }, evt)).toBe(true);
    });
  });

  describe('in / nin / exists', () => {
    it('in matches scalar against a value list', () => {
      expect(evaluate({ op: 'in', path: 'status', values: ['open', 'pending'] }, baseEvent)).toBe(true);
      expect(evaluate({ op: 'in', path: 'status', values: ['closed'] }, baseEvent)).toBe(false);
    });

    it('exists / not_exists handles missing paths', () => {
      expect(evaluate({ op: 'exists', path: 'status' }, baseEvent)).toBe(true);
      expect(evaluate({ op: 'exists', path: 'missing' }, baseEvent)).toBe(false);
      expect(evaluate({ op: 'not_exists', path: 'missing' }, baseEvent)).toBe(true);
    });
  });

  describe('changed_to', () => {
    it('fires when prior value differs from new value matching expectation', () => {
      const evt = {
        data: { priority: 'urgent' },
        changes: { priority: { old: 'normal', new: 'urgent' } },
      };
      expect(evaluate({ op: 'changed_to', path: 'priority', value: 'urgent' }, evt)).toBe(true);
    });

    it('returns false when no change recorded (first-event-after-create case)', () => {
      const evt = { data: { priority: 'urgent' } };
      expect(evaluate({ op: 'changed_to', path: 'priority', value: 'urgent' }, evt)).toBe(false);
    });
  });

  describe('matches (RE2)', () => {
    it('matches the pattern against a string value', () => {
      const evt = { data: { subject: 'Invoice #1234' } };
      expect(evaluate({ op: 'matches', path: 'subject', value: '', pattern: 'Invoice #\\d+' } as PredicateExpr, evt))
        .toBe(true);
    });

    it('rejects regex patterns longer than 512 chars', () => {
      const longPattern = 'a'.repeat(513);
      const evt = { data: { v: 'aaa' } };
      expect(evaluate({ op: 'matches', path: 'v', value: '', pattern: longPattern } as PredicateExpr, evt)).toBe(false);
    });

    it('returns false when value at path is not a string', () => {
      expect(evaluate({ op: 'matches', path: 'age_days', value: '', pattern: '\\d+' } as PredicateExpr, baseEvent))
        .toBe(false);
    });
  });

  describe('boolean composition', () => {
    it('and/or/not compose correctly', () => {
      const expr: PredicateExpr = {
        op: 'and',
        operands: [
          { op: 'eq', path: 'status', value: 'open' },
          { op: 'or', operands: [
            { op: 'gt', path: 'age_days', value: 100 },
            { op: 'gte', path: 'age_days', value: 30 },
          ]},
        ],
      };
      expect(evaluate(expr, baseEvent)).toBe(true);

      const notExpr: PredicateExpr = { op: 'not', operand: { op: 'eq', path: 'status', value: 'open' } };
      expect(evaluate(notExpr, baseEvent)).toBe(false);
    });

    it('throws PredicateDepthExceededError beyond max depth', () => {
      let expr: PredicateExpr = { op: 'eq', path: 'status', value: 'open' };
      for (let i = 0; i < MAX_PREDICATE_DEPTH + 2; i++) {
        expr = { op: 'not', operand: expr };
      }
      expect(() => evaluate(expr, baseEvent)).toThrow(PredicateDepthExceededError);
    });
  });

  describe('path resolution', () => {
    it('walks nested dotted paths', () => {
      const evt = { data: { account: { owner: { email: 'a@b.c' } } } };
      expect(evaluate({ op: 'eq', path: 'account.owner.email', value: 'a@b.c' }, evt)).toBe(true);
      expect(evaluate({ op: 'exists', path: 'account.owner.email' }, evt)).toBe(true);
      expect(evaluate({ op: 'exists', path: 'account.owner.phone' }, evt)).toBe(false);
    });
  });
});
