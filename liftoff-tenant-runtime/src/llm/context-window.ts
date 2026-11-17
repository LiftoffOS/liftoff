// How many tokens the model running this invocation can actually hold.
//
// Before this existed, the only window knowledge in the runtime was
// `PROVIDER_WINDOW_TOKENS` in context-pressure.ts — four provider-family entries
// that describe themselves as "floors, not exact model specs" — read by one
// function. That is fine for the nudge it was written for and dangerous for
// anything that acts destructively on the answer.
//
// WHY THE FLOOR CANNOT STAND IN. Anthropic's floor is 200,000. We run
// claude-opus-5[1m], whose window is 1,000,000. A healthy 300k-token run on that
// model measured against the floor reads as an overflow — and wired to a session
// retirement, that abandons a perfectly good conversation. A data-losing false
// positive, produced by the check meant to prevent data loss.
//
// So every reading is labelled with where it came from, and the label is part of
// the contract rather than advisory:
//
//   source: 'registry'       — the model's own recorded window. May drive a
//                              destructive decision.
//   source: 'provider_floor' — a family-wide lower bound. Good enough to log a
//                              ratio, good enough to nudge. NEVER good enough to
//                              retire a session.
//
// The overlay is installed from the same platform-backend snapshot that already
// carries pricing and branding, so a model onboarded via a registry row is
// priced, branded AND sized with no per-repo edit.

import { normalizeModelId } from './pricing';
import { windowTokensForProvider } from '../agent-execution/context-pressure';

export type ContextWindowSource = 'registry' | 'provider_floor';

export interface ContextWindowReading {
  tokens: number;
  source: ContextWindowSource;
}

/** provider:normalizedModelId → window tokens. Null until the first successful
 *  registry load; every lookup falls back to the provider floor until then. */
let registryWindows: Map<string, number> | null = null;

/** Install (or clear, with null) the registry-sourced window overlay. Called by
 *  the model-registry loader, alongside the pricing and branding overlays. */
export function setModelContextWindows(windows: Map<string, number> | null): void {
  registryWindows = windows;
}

/** The recorded window for a model, or undefined when none was recorded.
 *  Undefined is a real answer and callers must handle it as one — it is what
 *  separates "we know this model holds 1M" from "we are guessing". */
export function getModelContextWindow(provider: string, modelId: string): number | undefined {
  return registryWindows?.get(`${provider}:${normalizeModelId(modelId)}`);
}

/** The window for a (provider, model), labelled with its provenance.
 *
 *  Always returns a reading: a provider floor is better than nothing for
 *  measurement, and the `source` field is what stops a caller acting on it as
 *  though it were exact. */
export function contextWindowForModel(
  provider: string | undefined,
  modelId: string | undefined,
): ContextWindowReading {
  if (provider && modelId) {
    const recorded = getModelContextWindow(provider, modelId);
    if (recorded && recorded > 0) return { tokens: recorded, source: 'registry' };
  }
  return { tokens: windowTokensForProvider(provider), source: 'provider_floor' };
}

/** True when this reading may drive a destructive decision — retiring a session,
 *  declaring a run context-exhausted. Deliberately a named predicate rather than
 *  an inline `=== 'registry'` at each call site: the rule is the point, and a
 *  reader should not have to reconstruct it from a string comparison. */
export function mayDriveRetirement(reading: ContextWindowReading | undefined): boolean {
  return reading?.source === 'registry';
}
