/**
 * Safe dot-path lookup with prototype-pollution hardening.
 *
 * Used by template.ts (for {{output.customer.id}} substitution) and
 * condition.ts (for $.field.nested evaluation). Both operate on LLM output
 * and tool-call results, which are untrusted data that could contain
 * adversarial keys.
 *
 * Security hardening:
 *   - Rejects path segments: __proto__, constructor, prototype, and
 *     any segment starting with __ (double underscore).
 *   - Uses Object.hasOwn for every hop — never walks the prototype chain.
 *   - Unicode-safe (no ASCII assumptions on key names).
 *
 * Supports:
 *   - Dot-path: "customer.id", "data.records"
 *   - Array index via dot: "items.0.name" (numeric segment = array index)
 *   - Array index via bracket: "items[0].name" (normalized to dot before walk)
 *   - Empty path returns the root object.
 */

import { logger } from '../infrastructure/logging';

/** Segments that would walk the prototype chain — always rejected. */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Check if a path segment is safe to traverse.
 */
function isSegmentSafe(segment: string): boolean {
  if (FORBIDDEN_SEGMENTS.has(segment)) return false;
  if (segment.startsWith('__')) return false;
  return true;
}

/**
 * Normalize bracket notation to dot notation: "items[0].name" → "items.0.name"
 */
function normalizePath(path: string): string {
  return path.replace(/\[(\d+)\]/g, '.$1');
}

/**
 * Walk a dot-path into an object, returning the value at the leaf.
 *
 * Returns `undefined` if any hop is missing or the path is invalid.
 * Logs a warning on missing paths (useful for debugging template failures).
 *
 * @param obj  — the root object to walk
 * @param path — dot-separated path, e.g. "customer.id" or "items.0.name"
 * @returns the value at the path, or `undefined` if not found
 */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path || path.length === 0) return obj;

  const normalized = normalizePath(path);
  const segments = normalized.split('.');
  let current: unknown = obj;

  for (const segment of segments) {
    if (!isSegmentSafe(segment)) {
      logger.warn('getByPath: forbidden path segment rejected', { path, segment });
      return undefined;
    }

    if (current === null || current === undefined) {
      return undefined;
    }

    if (typeof current !== 'object') {
      return undefined;
    }

    // Use Object.hasOwn to avoid prototype chain walks.
    if (!Object.hasOwn(current as Record<string, unknown>, segment)) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}
