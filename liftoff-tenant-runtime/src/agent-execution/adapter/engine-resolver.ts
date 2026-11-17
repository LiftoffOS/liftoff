// Deterministic, PURE engine resolution. Both createAdapter() (for
// construction) and resolveAdapter() (for construction + recorded provenance)
// route through resolveExecutionEngine, so the adapter that actually runs and
// the engine id persisted on the invocation can never disagree.
//
// Kept free of adapter-class imports on purpose: provenance-writing code
// (invocation creation) can import this without pulling the ESM-only
// self-managing SDKs (@openai/codex-sdk, @google/adk, @opencode-ai/sdk) into a
// CommonJS path.

// The provider list is imported rather than restated. It used to be a second
// copy here, and the copy went stale: `xai` was added to the union and to every
// resolution path, and this file still listed five providers — so
// `isResolvedProvider('xai')` was false, invocation creation recorded a NULL
// engine, and a Grok run's provenance read `unknown-legacy`. A value import is
// safe for the constraint in the header above: types.ts imports only types, so
// nothing adapter-class or ESM-only comes with it.
import { isResolvedProvider } from './types';
import { VENDORS, UNKNOWN_ENGINE } from './vendors';
import type { VendorSpec } from './vendors';
import type { ResolvedProvider, ExecutionEngineId } from './types';

/** Narrow an arbitrary provider string (e.g. `invocations.provider`, typed
 * loosely as `string`) to a ResolvedProvider. Lets provenance-writing callers
 * resolve an engine only when the provider is one the resolver understands, and
 * record NULL otherwise — rather than throwing and breaking invocation creation
 * on an unexpected provider value.
 *
 * Re-exported from here because that is where its callers import it from; the
 * implementation lives beside the list it tests against. */
export { isResolvedProvider };

/** Route an engine's single `session_started` identifier to the
 * correct run-state field. Codex surfaces a THREAD id via session_started (see
 * the codex adapter), so thread-based engines populate `threadId`; every other
 * engine populates `sessionId`. Kept pure + centralized so the session-vs-thread
 * distinction is defined in one place. */
export function upstreamSessionIdsFor(engine: ExecutionEngineId, id: string): { sessionId?: string; threadId?: string } {
  return engine === 'openai-codex' ? { threadId: id } : { sessionId: id };
}

/**
 * Does this engine's adapter build the model's tool surface from
 * `catalog.tools`?
 *
 * It matters because the tool-tiering pass rewrites `catalog.tools` and NOTHING
 * else, so on an engine that does not read it, a collapse is computed, logged
 * and then ignored. That is not hypothetical: `claude-agent-sdk` gets
 * `catalog.servers` — the live in-process `McpServer` instance built from the
 * untiered tool list, plus the vendor servers by URL, which the SDK connects to
 * itself. An agent on that engine whose vendor server is logged as collapsed
 * keeps calling that server's tools by name, and the `search_*` / `call_*`
 * pair the collapse offers instead goes unused.
 *
 * Every other engine reads it: openai and openrouter through `mcp-bridge`,
 * gemini and google-adk by mapping it to function declarations, codex and
 * opencode through `exposeCatalogOverHttp`.
 *
 * Exported so the telemetry can say which case a run was in. A collapse counted
 * as a saving on an engine that never saw it is a measurement of nothing.
 */
export function engineReadsCatalogTools(engine: ExecutionEngineId): boolean {
  return engine !== 'claude-agent-sdk';
}

/** Bounded engine label for observability (metrics/structured logs).
 * Returns the resolved concrete engine, or 'unknown-legacy' for a provider the
 * resolver does not recognize — always one of ≤8 values, safe for metric-label
 * cardinality. Never throws. */
export function engineLabelFor(provider: string, env: NodeJS.ProcessEnv = process.env): ExecutionEngineId {
  return isResolvedProvider(provider) ? resolveExecutionEngine(provider, env) : UNKNOWN_ENGINE;
}

/** Resolve the concrete engine for a provider under a given environment. Mirrors
 * the selection in createAdapter(): each provider's default is its vendor's own
 * runtime (Codex for OpenAI, opencode for xAI and the open-weights families,
 * the Gen AI SDK for Google), and the OPENAI_ENGINE / XAI_ENGINE /
 * OPENROUTER_ENGINE / GOOGLE_ENGINE flags select the escape hatch — the wire
 * bridge, or ADK. Pure: `env` is injected for testability and never mutated.
 * Never returns 'unknown-legacy' — that value exists only for pre-migration
 * invocation rows. */
export function resolveExecutionEngine(
  provider: ResolvedProvider,
  env: NodeJS.ProcessEnv = process.env,
): ExecutionEngineId {
  // A lookup, not a switch. The switch was a second place every vendor had to
  // be written down, and the copy of the provider list beside it went stale the
  // moment `xai` was added — so a Grok invocation recorded a NULL engine and
  // read back as `unknown-legacy`.
  // Typed as the interface rather than the literal: `as const` gives each entry
  // its own shape, and only some of them have an env flag.
  const spec: VendorSpec | undefined = VENDORS[provider as keyof typeof VENDORS];
  if (!spec) {
    // Unreachable for a ResolvedProvider, since the type IS this record's keys.
    // Kept because this function is also called with values read from the
    // database, where a row can hold a provider retired since it was written.
    throw new Error(`Unknown provider: ${provider}`);
  }
  const { default: fallback, envVar, alternatives } = spec.engine;
  const selected = envVar ? alternatives?.[env[envVar] ?? ''] : undefined;
  return (selected ?? fallback) as ExecutionEngineId;
}
