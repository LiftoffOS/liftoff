/**
 * Condition evaluator for WorkflowStep.condition fields.
 *
 * Supports:
 *   - Simple predicates: $.field == 'value', $.count > 0, $.status != null
 *   - Nested paths: $.customer.email == 'x@y.com'
 *   - Null checks: $.field is null, $.field is not null
 *   - Compound: $.a == 1 && $.b == 2, $.x > 0 || $.y > 0
 *   - Operators: ==, !=, >, <, >=, <=, is null, is not null
 *
 * Operator precedence: left-to-right for && and ||. No parens in v1.
 * Unparseable conditions THROW (not silent true — that was the legacy bug).
 *
 * Security:
 *   - Prototype-pollution hardening via getByPath (rejects __proto__ etc.).
 *   - No eval, no Function(), no dynamic code execution.
 *   - Values from stepOutput are treated as untrusted; comparison is always
 *     type-safe (String() coercion for ==, Number() for relational).
 */

import { getByPath } from './get-by-path';

/** A single predicate: $.field OP value */
interface Predicate {
  field: string;       // dot-path after $. (e.g. "customer.email")
  operator: string;    // ==, !=, >, <, >=, <=, 'is null', 'is not null'
  expected?: string;   // right-hand value (absent for is null / is not null)
}

/**
 * Parse a single predicate from a string like "$.status == 'open'" or
 * "$.count > 0" or "$.field is null".
 */
function parsePredicate(expr: string): Predicate {
  const trimmed = expr.trim();

  // is not null
  const isNotNullMatch = trimmed.match(/^\$\.(.+?)\s+is\s+not\s+null$/i);
  if (isNotNullMatch) {
    return { field: isNotNullMatch[1], operator: 'is not null' };
  }

  // is null
  const isNullMatch = trimmed.match(/^\$\.(.+?)\s+is\s+null$/i);
  if (isNullMatch) {
    return { field: isNullMatch[1], operator: 'is null' };
  }

  // Comparison operators: ==, !=, >=, <=, >, <
  const compMatch = trimmed.match(
    /^\$\.([\w.]+)\s*(==|!=|>=|<=|>|<)\s*'?([^']*?)'?$/
  );
  if (compMatch) {
    return {
      field: compMatch[1],
      operator: compMatch[2],
      expected: compMatch[3],
    };
  }

  throw new Error(`Unparseable condition predicate: "${trimmed}"`);
}

/**
 * Evaluate a single predicate against a data object.
 */
function evalPredicate(predicate: Predicate, data: unknown): boolean {
  const actual = getByPath(data, predicate.field);

  switch (predicate.operator) {
    case 'is null':
      return actual === null || actual === undefined;
    case 'is not null':
      return actual !== null && actual !== undefined;
    case '==':
      return String(actual) === predicate.expected;
    case '!=':
      return String(actual) !== predicate.expected;
    case '>':
      return Number(actual) > Number(predicate.expected);
    case '<':
      return Number(actual) < Number(predicate.expected);
    case '>=':
      return Number(actual) >= Number(predicate.expected);
    case '<=':
      return Number(actual) <= Number(predicate.expected);
    default:
      throw new Error(`Unknown operator: "${predicate.operator}"`);
  }
}

/**
 * Evaluate a condition string against a data object.
 *
 * Supports && (AND) and || (OR) between predicates, evaluated left-to-right
 * (no operator precedence — && and || have the same priority).
 *
 * @throws Error if the condition string is unparseable
 */
/** Every field path a condition reads, in source order.
 *
 *  Exported so validation can check what a condition ADDRESSES without
 *  re-deriving the grammar with a second regex. That duplication is the exact
 *  defect this closes: `validateWorkflowGraph` used to approximate the grammar
 *  with `/\$\.\w/`, which accepts `$.output.foo` — a path that parses, reads
 *  nothing, and evaluates false forever, because the runtime context has only
 *  `input`, `steps` and `item`. One grammar, used by both, cannot drift.
 *
 *  Throws the same error `evaluateCondition` would on unparseable input, so a
 *  caller learns about bad syntax here rather than at execution time. */
export function conditionFieldPaths(condition: string): string[] {
  const paths: string[] = [];
  for (const orClause of condition.split('||')) {
    for (const predicateStr of orClause.split('&&')) {
      paths.push(parsePredicate(predicateStr.trim()).field);
    }
  }
  return paths;
}

export function evaluateCondition(condition: string, data: unknown): boolean {
  // Split on || first (lower precedence in our left-to-right model)
  const orClauses = condition.split('||').map(s => s.trim());

  for (const orClause of orClauses) {
    // Each OR clause is a conjunction of && predicates
    const andPredicates = orClause.split('&&').map(s => s.trim());
    let allTrue = true;

    for (const predicateStr of andPredicates) {
      const predicate = parsePredicate(predicateStr);
      if (!evalPredicate(predicate, data)) {
        allTrue = false;
        break;
      }
    }

    if (allTrue) return true; // Short-circuit: one OR clause is true
  }

  return false;
}

/** Field paths this condition COMPARES that the data does not carry.
 *
 *  `evalPredicate` coerces with `String(actual)`, so a path the run never
 *  produced becomes the string "undefined" and compares like any other value.
 *  The predicate is then false for want of data, and indistinguishable from one
 *  the author meant to be false. Those two need different handling and only the
 *  parser can tell them apart, which is why this lives beside the grammar
 *  rather than being re-derived at the call site.
 *
 *  `is null` / `is not null` are excluded: absence is the question those
 *  predicates ask, so an unresolved path is their input, not a defect.
 *
 *  Resolution is `undefined` only. A path resolving to `null` is a value the
 *  step produced and a legitimate thing to compare.
 *
 *  Throws on unparseable input, exactly as `evaluateCondition` does. */
export function unresolvedComparisonPaths(condition: string, data: unknown): string[] {
  const unresolved: string[] = [];
  for (const orClause of condition.split('||')) {
    for (const predicateStr of orClause.split('&&')) {
      const predicate = parsePredicate(predicateStr.trim());
      if (predicate.operator === 'is null' || predicate.operator === 'is not null') continue;
      if (getByPath(data, predicate.field) === undefined) unresolved.push(predicate.field);
    }
  }
  return unresolved;
}
