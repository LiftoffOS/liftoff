// Predicate AST evaluator.
//
// Pure function. RE2 used for `matches` regex op so pathological patterns
// can't ReDoS. Path resolution is dot-notation only; no embedded JS.

import RE2 from 're2';
import type { PredicateExpr } from '../agent-lifecycle/types';

export interface NormalizedEvent {
  /** Full entity record from the connector or system event payload. */
  data: Record<string, unknown>;
  /** Map of paths to {old, new} for fields the entity-state diff detected as changed. */
  changes?: Record<string, { old: unknown; new: unknown }>;
}

export const MAX_PREDICATE_DEPTH = 10;
export const MAX_PREDICATE_OPERANDS = 50;

export class PredicateDepthExceededError extends Error {
  constructor() { super(`Predicate exceeds max depth ${MAX_PREDICATE_DEPTH}`); }
}

export function evaluate(expr: PredicateExpr, event: NormalizedEvent, depth = 0): boolean {
  if (depth > MAX_PREDICATE_DEPTH) throw new PredicateDepthExceededError();

  switch (expr.op) {
    case 'and': return expr.operands.every(o => evaluate(o, event, depth + 1));
    case 'or':  return expr.operands.some(o => evaluate(o, event, depth + 1));
    case 'not': return !evaluate(expr.operand, event, depth + 1);
    case 'eq':  return resolve(event.data, expr.path) === expr.value;
    case 'ne':  return resolve(event.data, expr.path) !== expr.value;
    case 'gt':  return numeric(resolve(event.data, expr.path)) > (expr.value as number);
    case 'gte': return numeric(resolve(event.data, expr.path)) >= (expr.value as number);
    case 'lt':  return numeric(resolve(event.data, expr.path)) < (expr.value as number);
    case 'lte': return numeric(resolve(event.data, expr.path)) <= (expr.value as number);
    case 'in':  return expr.values.includes(resolve(event.data, expr.path) as string | number);
    case 'nin': return !expr.values.includes(resolve(event.data, expr.path) as string | number);
    case 'exists':     return resolve(event.data, expr.path) !== undefined;
    case 'not_exists': return resolve(event.data, expr.path) === undefined;
    case 'changed_to': {
      const change = event.changes?.[expr.path];
      if (!change) return false;
      return change.new === expr.value;
    }
    case 'matches': {
      const value = resolve(event.data, expr.path);
      if (typeof value !== 'string') return false;
      if (expr.pattern.length > 512) return false;
      try { return new RE2(expr.pattern).test(value); } catch { return false; }
    }
  }
}

function resolve(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function numeric(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.length > 0 && !isNaN(Number(v))) return Number(v);
  return Number.NaN;
}

export class PredicateValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'PredicateValidationError'; }
}

// Path segments that could enable prototype pollution via dot-notation resolve().
const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_PATH_LENGTH = 256;

/**
 * Creation-time validation for a self-wake filter/until predicate. `evaluate()` enforces
 * ONLY depth at runtime; this additionally COUNTS operands (MAX_PREDICATE_OPERANDS — the constant
 * existed but was never enforced) and rejects unsafe/oversized paths + patterns. Throws on violation.
 * Interpretation: an "operand" is a leaf comparison; and/or subtrees are walked and their leaves counted.
 */
export function validatePredicate(expr: PredicateExpr): void {
  let operands = 0;
  const walk = (e: PredicateExpr, depth: number): void => {
    if (depth > MAX_PREDICATE_DEPTH) {
      throw new PredicateValidationError(`predicate exceeds max depth ${MAX_PREDICATE_DEPTH}`);
    }
    switch (e.op) {
      case 'and':
      case 'or':
        if (!Array.isArray(e.operands) || e.operands.length === 0) {
          throw new PredicateValidationError(`${e.op} requires a non-empty operands array`);
        }
        for (const o of e.operands) walk(o, depth + 1);
        return;
      case 'not':
        walk(e.operand, depth + 1);
        return;
      default: {
        operands += 1;
        if (operands > MAX_PREDICATE_OPERANDS) {
          throw new PredicateValidationError(`predicate exceeds max operands ${MAX_PREDICATE_OPERANDS}`);
        }
        const path = (e as { path?: string }).path;
        if (path !== undefined) validatePredicatePath(path);
        if (e.op === 'matches') {
          const pattern = (e as { pattern?: string }).pattern;
          if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 512) {
            throw new PredicateValidationError('matches pattern missing or too long (>512)');
          }
        }
        return;
      }
    }
  };
  walk(expr, 0);
}

function validatePredicatePath(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw new PredicateValidationError('predicate path missing or too long');
  }
  for (const seg of path.split('.')) {
    if (seg.length === 0 || UNSAFE_PATH_SEGMENTS.has(seg)) {
      throw new PredicateValidationError(`unsafe predicate path segment: ${seg || '(empty)'}`);
    }
  }
}
