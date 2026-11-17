/**
 * R5 TE-R5-003: test path helper with per-test UUID isolation.
 *
 * Each call generates a fresh UUID — callers MUST assign to a variable and
 * reuse it within the test (NOT call createIsolatedPath twice). The ESLint
 * rule `r5/no-unassigned-isolated-path` enforces this at lint time.
 *
 * Rename from R4's `getTestPath` makes create-vs-get semantics explicit.
 */
import crypto from 'crypto';

export function createIsolatedPath(testName: string): string {
  const workerId = process.env.JEST_WORKER_ID ?? '0';
  const testUuid = crypto.randomUUID();
  return `/tmp/test-${workerId}-${testUuid}-${testName.replace(/[^a-zA-Z0-9]/g, '_')}`;
}
