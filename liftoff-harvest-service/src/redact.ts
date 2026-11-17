/**
 * Re-exports the shared PII redaction module so existing call sites
 * (classifier.ts:135) keep working unchanged.
 *
 * Best-effort, pattern-based defense-in-depth before sending text to the
 * LLM gateway. NOT an anonymization or de-identification boundary —
 * names, addresses, unformatted custom IDs, free-text health/financial
 * content, and any PII that doesn't lexically match a pattern in the
 * shared module will pass through.
 *
 * Memory content downstream of this redaction is for LEARNINGS, NOT
 * source-of-truth lookups. Agents that need raw PII to act on must call
 * source-of-truth tools (HRIS, connector records, etc.), not
 * `memory_retrieve`. Users observe memory content via the
 * /dashboard/teams/update UI; there is no user-facing workflow that
 * depends on memory containing raw PII.
 *
 * Bump REDACTION_VERSION in the shared module (not here) when patterns
 * change.
 */

// NOTE: import path is `dist/redaction` (not the cleaner `/redaction` subpath)
// because this service's tsconfig uses classic node moduleResolution, which
// does not honor the proto package's `exports` map. The direct dist path
// resolves under every moduleResolution mode.
export { redactPii, REDACTION_VERSION } from '@liftoffos/proto-gen/dist/redaction';
