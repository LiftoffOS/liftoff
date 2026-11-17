// Native tool-forcing: the per-engine optimisation ON TOP of the grounding floor.
//
// The floor is prefetch, and it is what makes `groundsOn` a guarantee: the host
// runs the read and appends the result, so every engine behaves the same
// because none is asked to. Forcing is strictly an improvement where a vendor
// exposes it — the model authors the tool's arguments, so a composed search
// query beats the raw turn text as a corpus query.
//
// THE ORDERING IS THE DESIGN. Forcing must never be the mechanism a guarantee
// rests on. Four of the engines cannot force at all — the Claude Agent SDK owns
// its own loop, and `openai-codex`, `opencode` and `google-gemini-cli` are
// external processes with no per-turn control — so a grounding feature built
// on forcing would work on some engines and silently not on others, and which
// depends on what a tenant chose in a dropdown. That is INV-TR-019's failure
// with a different name.
//
// So this module answers ONE question per engine: given a matched rule, is
// there a native request field that names the tool, and what is it? An engine
// that answers `null` is not degraded — it has already been grounded by the
// prefetch, and its answer is built on the same bytes.
//
// The per-engine mechanisms, and the evidence for each:
//
//   openai-agents           modelSettings.toolChoice takes a TOOL NAME as a
//                           bare string. Our Agent already sets
//                           resetToolChoice:true, so it reverts to auto after
//                           the first call — exactly round-0 semantics.
//   openrouter-openai-wire  OpenAI-compatible tool_choice {type:'function'}.
//                           Gated per model, because OpenRouter routes to
//                           providers that vary in honouring it, and a rejected
//                           parameter is a 400 for the whole turn rather than a
//                           degraded one.
//   xai-openai-wire         floor only: api.x.ai rejected the specific-function
//                           shape the SDK sends (422), which fails the turn.
//   google-genai            toolConfig.functionCallingConfig with mode ANY and
//                           allowedFunctionNames. We hand-roll that loop, so it
//                           is one request field.
//   google-adk              its generate-content config, if exposed. Lazy-loaded
//                           and non-default: attempt and verify.
//   claude-agent-sdk        the SDK owns the loop; no per-turn forcing exists.
//   openai-codex, opencode, google-gemini-cli
//                           external processes; no per-turn control.

import type { ExecutionEngineId } from './types';
import { logger } from '../../infrastructure/logging';

/** What an adapter should put on its round-0 request, if anything. */
export type ForcingDirective =
  | { kind: 'openai_tool_choice'; toolName: string }
  | { kind: 'openai_wire_tool_choice'; toolName: string }
  | { kind: 'google_function_calling_config'; toolName: string }
  | null;

/** Engines with no per-turn forcing mechanism at all.
 *
 *  Named explicitly rather than falling out of a default, so adding an engine
 *  forces a decision about it instead of silently inheriting "no".
 *
 *  ENGINE_SUBSET_OK: a deliberate partition, not a list to keep current. The
 *  switch below carries the other half and is exhaustive over the union, so an
 *  engine missing from here is an engine the switch must answer for. */
export const ENGINES_WITHOUT_FORCING: readonly ExecutionEngineId[] = [
  'claude-agent-sdk',
  'openai-codex',
  'opencode',
  'google-gemini-cli',
  // Not for want of a mechanism: api.x.ai rejected the specific-function
  // shape with 422 and failed the turn. On the floor until the accepted shape
  // has been read from xAI's reference and tried (see the switch below).
  'xai-openai-wire',
] as const;

/**
 * The native forcing directive for an engine, or null for the prefetch floor.
 *
 * `null` is a complete answer, not a gap. The turn has already been grounded;
 * forcing would only have let the model word the query itself.
 */
/**
 * Whether this engine grounds by the floor alone.
 *
 * Exported and USED by the directive function below rather than being a comment
 * about it: the list is the statement of which engines cannot force, and having
 * the switch and the list disagree would mean one of them is wrong and neither
 * says so.
 */
export function groundsByPrefetchOnly(engine: ExecutionEngineId): boolean {
  return ENGINES_WITHOUT_FORCING.includes(engine);
}

export function forcingDirectiveFor(
  engine: ExecutionEngineId,
  toolName: string,
  opts?: { modelSupportsToolChoice?: boolean },
): ForcingDirective {
  // Asked first, so the list and the switch cannot drift into disagreeing
  // about which engines have no mechanism.
  if (groundsByPrefetchOnly(engine)) return null;

  switch (engine) {
    case 'openai-agents':
      return { kind: 'openai_tool_choice', toolName };
    case 'openrouter-openai-wire':
      // Gated. OpenRouter fans out to providers that differ in whether they
      // honour tool_choice, and a rejected parameter fails the WHOLE turn with
      // a 400 rather than degrading it — so an unknown model falls back to the
      // floor, which costs nothing it was not already getting.
      if (opts?.modelSupportsToolChoice === false) return null;
      return { kind: 'openai_wire_tool_choice', toolName };
    case 'xai-openai-wire':
      // The floor, for now. api.x.ai answers the specific-function shape the
      // Agents SDK serialises with 422 "tool_choice: data did not match any
      // variant of untagged enum ModelToolChoice" — the whole turn, not a
      // degraded one. Forcing returns here
      // once the shape xAI accepts has been read from its reference and tried.
      return null;
    case 'google-genai':
    case 'google-adk':
      return { kind: 'google_function_calling_config', toolName };
    default:
      return null;
  }
}

/**
 * The tool a matched rule may force on THIS request: the rule's tool when the
 * catalog holds it, else nothing.
 *
 * A rule is authored per hire and names `corpus_search` whether or not the
 * tenant has a knowledge base bound. On a tenant that does not, the tool is
 * not in the catalog, and a directive naming it is a 400 for the whole turn on
 * Gemini ("allowed_function_names should be a subset of the provided
 * function_declarations") — the floor's prefetch has already answered, and the
 * turn must go on from there rather than die on the optimisation.
 */
export function forcibleToolFor(
  ruleToolName: string | undefined,
  catalogToolNames: Iterable<string>,
): string | undefined {
  if (!ruleToolName) return undefined;
  for (const name of catalogToolNames) if (name === ruleToolName) return ruleToolName;
  return undefined;
}

/**
 * The directive for a REQUEST, logged when there is one.
 *
 * `forcingDirectiveFor` is pure and stays so. This is what an adapter calls on
 * its round-0 request: the same answer, plus one structured line naming the
 * engine, the tool and the invocation whenever the answer is not the floor.
 * Nothing else records that forcing was applied — the request field is set
 * and the vendor never echoes it — so a traced run had no line to read to
 * know whether the round was forced or merely grounded by the prefetch.
 */
export function forcingDirectiveForRequest(
  engine: ExecutionEngineId,
  toolName: string,
  invocationId: string,
  opts?: { modelSupportsToolChoice?: boolean },
): ForcingDirective {
  const directive = forcingDirectiveFor(engine, toolName, opts);
  if (directive) {
    logger.info(
      {
        event: 'grounding_forcing_applied',
        execution_engine: engine,
        tool_name: toolName,
        invocation_id: invocationId,
        directive_kind: directive.kind,
      },
      'native tool forcing set on the round-0 request',
    );
  }
  return directive;
}

/** The `modelSettings` fragment for the OpenAI Agents SDK. */
export function openAiToolChoiceSettings(d: ForcingDirective): { toolChoice?: string } {
  return d?.kind === 'openai_tool_choice' ? { toolChoice: d.toolName } : {};
}

/** The OpenAI-compatible wire fragment, for the targets that carry it. */
export function openAiWireToolChoice(
  d: ForcingDirective,
): { tool_choice?: { type: 'function'; function: { name: string } } } {
  return d?.kind === 'openai_wire_tool_choice'
    ? { tool_choice: { type: 'function', function: { name: d.toolName } } }
    : {};
}

/**
 * The function names Gemini should be restricted to, or null.
 *
 * Returns NAMES rather than the SDK's `toolConfig`, and that is the rule rather
 * than a preference: this module is the engine-neutral declaration of what
 * forcing means, and importing `@google/genai` here would put a vendor SDK
 * above the adapter layer — which lint forbids for the same reason the layering
 * exists. The adapter owns the mapping to `FunctionCallingConfigMode.ANY`,
 * because the adapter is the thing allowed to know what Google calls it.
 */
export function googleAllowedFunctionNames(d: ForcingDirective): string[] | null {
  return d?.kind === 'google_function_calling_config' ? [d.toolName] : null;
}
