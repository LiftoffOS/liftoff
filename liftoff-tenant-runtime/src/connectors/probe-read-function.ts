// Which function a liveness probe may call, and with what.
//
// A probe asks the vendor a question with no side effects, and the only
// honest question is one the function's own schema says it can answer with
// no input: a fabricated value ('' for a required string, 0 for a required
// number) is a malformed request, and a vendor's rejection of it says
// nothing about whether the binding works. So the probe only calls a read
// function that requires nothing, sends `{}`, and prefers a function that
// declares no inputs at all over one whose inputs are merely optional.

export interface ProbeCandidateFunction {
  name: string;
  categories?: readonly string[];
  inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
}

/** Categories that mark a function as something a probe must never run. */
export const PROBE_FORBIDDEN_CATEGORIES: ReadonlySet<string> = new Set([
  'write', 'destructive', 'outbound', 'sensitive',
]);

function isReadOnly(fn: ProbeCandidateFunction): boolean {
  const cats = new Set(fn.categories ?? []);
  if (!cats.has('read')) return false;
  for (const f of PROBE_FORBIDDEN_CATEGORIES) {
    if (cats.has(f)) return false;
  }
  return true;
}

function requiresNothing(fn: ProbeCandidateFunction): boolean {
  return (fn.inputSchema?.required ?? []).length === 0;
}

function declaresNoInputs(fn: ProbeCandidateFunction): boolean {
  return requiresNothing(fn) && Object.keys(fn.inputSchema?.properties ?? {}).length === 0;
}

/**
 * The read-only function a probe can call with an empty payload, or null
 * when the connector has none — the caller then has no vendor-side check
 * and says so, rather than inventing arguments.
 */
export function pickProbeReadFunction<T extends ProbeCandidateFunction>(
  fns: ReadonlyArray<T> | null | undefined,
): T | null {
  if (!fns || fns.length === 0) return null;
  const callable = fns.filter((fn) => isReadOnly(fn) && requiresNothing(fn));
  return callable.find(declaresNoInputs) ?? callable[0] ?? null;
}

/**
 * Whether a vendor's answer says the request was malformed rather than
 * refused. A schema can leave a requirement unstated (one of several fields
 * must be present), and the vendor's complaint about that is about the
 * probe's question, not about the binding.
 */
export function isPayloadRejection(message: string): boolean {
  return /\b(missing|required|invalid|malformed|unprocessable|bad request)\b|\bparam(?:eter)?s?\b|\b4(?:00|22)\b/i.test(message);
}
