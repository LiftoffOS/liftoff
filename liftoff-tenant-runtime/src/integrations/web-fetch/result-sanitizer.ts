// The protected-data pass over an opaque vendor result.
//
// Anchor's in-session agent reports a task in its own shape, and the runtime
// hands that shape to the caller as it is: the model reads it, and the RPC
// carries it as `result_json`. Nothing in that path knew what a page said or
// what the loop typed, so a value the protected data policy would have
// omitted from the record could still cross the wire inside the result.
//
// This walk applies the browser text sanitizer to every string in the tree
// before the result crosses the RPC or enters a tool result. It is bounded
// in depth, keys per object, items per array and total nodes, so a
// malformed or excessive structure becomes a labelled truncation rather than
// raw JSON the caller has to trust. Numbers, booleans and null pass as they
// are; anything else (a function, a symbol, a bigint) is dropped.

import { sanitizeBrowserText } from '@liftoffos/redact';

export const RESULT_TREE_MAX_DEPTH = 8;
export const RESULT_TREE_MAX_KEYS = 200;
export const RESULT_TREE_MAX_ITEMS = 500;
export const RESULT_TREE_MAX_NODES = 5000;
export const RESULT_TREE_STRING_CAP = 8000;

/** The marker a cut or dropped part of the tree becomes. */
export const RESULT_TREE_TRUNCATED = '[truncated]';

export interface SanitizedTree {
  value: unknown;
  /** Some part of the tree was cut or dropped by a bound. */
  truncated: boolean;
  /** Some string had protected data removed. */
  protectedDataOmitted: boolean;
}

export function sanitizeResultTree(input: unknown): SanitizedTree {
  let nodes = 0;
  let truncated = false;
  let omitted = false;
  const seen = new WeakSet<object>();

  const walk = (value: unknown, depth: number): unknown => {
    nodes++;
    if (nodes > RESULT_TREE_MAX_NODES) { truncated = true; return RESULT_TREE_TRUNCATED; }
    if (value === null || value === undefined) return value ?? null;
    switch (typeof value) {
      case 'string': {
        const safe = sanitizeBrowserText(value, RESULT_TREE_STRING_CAP);
        if (safe.truncated) truncated = true;
        if (safe.protectedDataOmitted) omitted = true;
        return safe.text;
      }
      case 'number':
        return Number.isFinite(value) ? value : null;
      case 'boolean':
        return value;
      case 'object': {
        if (seen.has(value)) { truncated = true; return RESULT_TREE_TRUNCATED; }
        if (depth >= RESULT_TREE_MAX_DEPTH) { truncated = true; return RESULT_TREE_TRUNCATED; }
        seen.add(value);
        if (Array.isArray(value)) {
          const out: unknown[] = [];
          for (let i = 0; i < value.length; i++) {
            if (i >= RESULT_TREE_MAX_ITEMS) { truncated = true; out.push(RESULT_TREE_TRUNCATED); break; }
            out.push(walk(value[i], depth + 1));
          }
          return out;
        }
        if (value instanceof Date) return value.toISOString();
        const out: Record<string, unknown> = {};
        const keys = Object.keys(value);
        for (let i = 0; i < keys.length; i++) {
          if (i >= RESULT_TREE_MAX_KEYS) { truncated = true; out[RESULT_TREE_TRUNCATED] = true; break; }
          const key = keys[i];
          const safeKey = sanitizeBrowserText(key, 200);
          if (safeKey.protectedDataOmitted) omitted = true;
          out[safeKey.text] = walk((value as Record<string, unknown>)[key], depth + 1);
        }
        return out;
      }
      default:
        truncated = true;
        return RESULT_TREE_TRUNCATED;
    }
  };

  return { value: walk(input, 0), truncated, protectedDataOmitted: omitted };
}
