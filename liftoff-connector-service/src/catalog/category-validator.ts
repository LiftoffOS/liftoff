// Boot-time category validator.
//
// Walks every registered connector function and asserts that each one declares
// at least one category, and that every category it declares is one this estate
// knows. If any function is undeclared the process is intended to refuse to
// start, exactly as the work-pair validator beside it does.
//
// WHY A BOOT ASSERTION AND NOT A LINT. `categories` is the read/write axis the
// rest of the platform decides with: the tenant-runtime oversight filter reads
// it to decide whether a call needs human review, and the distiller reads it to
// decide whether a graph writes anything. An absent category is not neutral in
// either place — it is an unknown, and both consumers have to guess. The
// distiller's fallback is a verb heuristic over the tool NAME, which is the
// weaker signal by construction and has already shipped a mislabelled write.
//
// The axis is either complete or it is not a fact anybody can rely on, and
// "mostly declared" is the state in which every consumer keeps its fallback
// forever. Asserting at module load is what makes it complete: a connector
// added without categories cannot reach production, so the fallbacks stay for
// the entries that genuinely have no declaration (a custom MCP server's tools)
// rather than for entries somebody forgot.
//
// Validation is a pure function for testability: callers supply the registry
// view and decide what to do with violations. The production caller
// (connector-functions-registry.ts module load) calls `assertNoViolations`,
// which logs each violation and `process.exit(1)`.

import type { ConnectorFunction } from '../types.js';

/** The axis. Kept as a value so the validator can check membership, and
 *  deliberately NOT re-derived from the type: a widened union that nobody
 *  taught this list about should fail here rather than pass silently. */
export const KNOWN_CATEGORIES: ReadonlySet<string> = new Set([
  'read',
  'write',
  'destructive',
  'outbound',
  'sensitive',
  // A message into the workspace's own collaboration surface. Read by the
  // control plane's capability gate (never held) and by the runtime, whose
  // outbound set does not include it, so it is never a hold on either.
  'internalCollaboration',
]);

export type CategoryViolationReason = 'no_category' | 'unknown_category';

export interface CategoryViolation {
  connectorType: string;
  toolName: string;
  reason: CategoryViolationReason;
  detail: string;
}

/**
 * Validate the category axis over a registry view.
 *
 * Takes the FULL view — what `getConnectorFunctions` returns per connector,
 * not the private map. The two differ: history tools are synthesized per
 * connector at read time and never live in the map, so a validator walking the
 * map alone would pass a registry whose synthesized reads declare nothing.
 *
 * Pure function: no logging, no exit. O(total functions).
 */
export function validateCategories(
  registry: Record<string, readonly ConnectorFunction[]>,
): CategoryViolation[] {
  const violations: CategoryViolation[] = [];

  for (const [connectorType, fns] of Object.entries(registry)) {
    for (const fn of fns) {
      const categories = fn.categories ?? [];

      if (categories.length === 0) {
        violations.push({
          connectorType,
          toolName: fn.name,
          reason: 'no_category',
          detail:
            `${connectorType}.${fn.name} declares no categories. Every function needs at `
            + `least one of ${[...KNOWN_CATEGORIES].join(', ')} — the runtime oversight `
            + `filter and the distiller both decide from this field, and an absent value `
            + `sends them to a name heuristic instead.`,
        });
        continue;
      }

      for (const category of categories) {
        if (KNOWN_CATEGORIES.has(category)) continue;
        violations.push({
          connectorType,
          toolName: fn.name,
          reason: 'unknown_category',
          detail:
            `${connectorType}.${fn.name} declares category '${category}', which no consumer `
            + `matches on. Add it to KNOWN_CATEGORIES here and to every reader, or correct `
            + `the declaration.`,
        });
      }
    }
  }

  return violations;
}

/**
 * Production caller: log every violation to stderr and exit non-zero if any are
 * present. Used at connector-functions-registry.ts module load so a
 * half-declared axis refuses to deploy.
 *
 * A separate function from `validateCategories` so tests can assert on the pure
 * validator without intercepting process.exit.
 */
export function assertNoCategoryViolations(violations: readonly CategoryViolation[]): void {
  if (violations.length === 0) return;
  // eslint-disable-next-line no-console
  console.error(
    `[connector-service] FATAL: category validation failed with ${violations.length} violation(s):`,
  );
  for (const v of violations) {
    // eslint-disable-next-line no-console
    console.error(`  ${v.connectorType}.${v.toolName} → ${v.reason}: ${v.detail}`);
  }
  process.exit(1);
}
