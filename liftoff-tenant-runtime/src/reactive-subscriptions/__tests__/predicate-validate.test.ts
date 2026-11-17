// Self-wake predicate validation. Pure-logic; runs without a DB.
import { validatePredicate, PredicateValidationError, MAX_PREDICATE_DEPTH, MAX_PREDICATE_OPERANDS } from '../predicate-evaluator';
import type { PredicateExpr } from '../../agent-lifecycle/types';

describe('validatePredicate (self-wake filter/until)', () => {
  it('accepts a valid exact-handle predicate', () => {
    expect(() => validatePredicate({ op: 'eq', path: 'deploy.id', value: '123' } as PredicateExpr)).not.toThrow();
  });

  it('accepts a composed and/or/not predicate', () => {
    const expr = { op: 'and', operands: [
      { op: 'eq', path: 'state', value: 'success' },
      { op: 'or', operands: [
        { op: 'gt', path: 'attempts', value: 2 },
        { op: 'not', operand: { op: 'exists', path: 'error' } },
      ] },
    ] } as unknown as PredicateExpr;
    expect(() => validatePredicate(expr)).not.toThrow();
  });

  it('rejects an unsafe path segment (prototype pollution)', () => {
    expect(() => validatePredicate({ op: 'eq', path: '__proto__.polluted', value: 1 } as unknown as PredicateExpr))
      .toThrow(PredicateValidationError);
  });

  it('rejects an empty path segment', () => {
    expect(() => validatePredicate({ op: 'eq', path: 'a..b', value: 1 } as unknown as PredicateExpr))
      .toThrow(PredicateValidationError);
  });

  it('enforces max depth', () => {
    let expr: PredicateExpr = { op: 'eq', path: 'x', value: 1 } as PredicateExpr;
    for (let i = 0; i <= MAX_PREDICATE_DEPTH + 1; i++) expr = { op: 'not', operand: expr } as unknown as PredicateExpr;
    expect(() => validatePredicate(expr)).toThrow(/max depth/);
  });

  it('enforces max operands (which evaluate() does not)', () => {
    const operands = Array.from({ length: MAX_PREDICATE_OPERANDS + 1 }, (_, i) => ({ op: 'eq', path: `f${i}`, value: i }));
    expect(() => validatePredicate({ op: 'and', operands } as unknown as PredicateExpr)).toThrow(/max operands/);
  });

  it('rejects a matches pattern that is missing or too long', () => {
    expect(() => validatePredicate({ op: 'matches', path: 'name', pattern: 'x'.repeat(513) } as unknown as PredicateExpr))
      .toThrow(PredicateValidationError);
  });

  it('rejects an empty and/or operands array', () => {
    expect(() => validatePredicate({ op: 'and', operands: [] } as unknown as PredicateExpr)).toThrow(PredicateValidationError);
  });
});
