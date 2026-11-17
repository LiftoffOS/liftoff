// Which tools END a run, derived from the graph rather than listed.
//
// A run that has posted the review and opened the thread is finished, and the
// loop still makes one more model call to say so. That call costs a request and
// a round-trip on every completed run, on every engine, and produces a sentence
// nobody needed — the delivery already happened, in the tool the model just
// called.
//
// DERIVED, NOT ENUMERATED. A step whose success path goes nowhere is a step the
// work ends at, and `onSuccess` already says so. A hand-kept list of "terminal
// tools" would be another per-connector artifact to maintain, wrong for any
// agent whose graph differs, and impossible for a workspace's own tools — the
// same shape this program has spent its last rounds removing.
//
// The derivation is per AGENT, because terminality is a property of the graph
// and not of the tool: `send_message` ends a reporting agent's work and sits in
// the middle of a triage agent's.

import type { WorkflowStep } from './types';
import type { ExecutionEngineId } from './adapter/types';
import { logger } from '../infrastructure/logging';

/** Engines that cannot end a turn early — the FLOOR.
 *
 *  An external process owns its loop and offers no per-round hook: Codex,
 *  opencode and the Gemini CLI run until they decide they are done, and the
 *  adapter reads what they emit. On these a terminal-only round costs the one
 *  extra model call every engine used to pay, and that is the whole floor: the
 *  work is still correct, only not shortened.
 *
 *  Named explicitly, the way the forcing floor is (grounding-forcing.ts), so
 *  adding an engine forces a decision about it rather than inheriting "no".
 *  Every engine NOT here has a mechanism, and the per-pair outcome test holds
 *  it to ending a terminal-only round.
 *
 *  ENGINE_SUBSET_OK: a deliberate partition, not a list to keep current. The
 *  per-pair outcome test enumerates every resolvable engine and asserts the
 *  other half CLOSES, so an engine missing from here is an engine that test
 *  must answer for.
 *
 *  Underscored because its only reader is that test: the adapters carry the
 *  mechanism themselves and consult no list at dispatch, so there is no
 *  production seam for this to plug into. It is the declared floor the test
 *  holds the partition to, not a switch. */
export const _ENGINES_WITHOUT_TURN_CLOSING: readonly ExecutionEngineId[] = [
  'openai-codex',
  'opencode',
  'google-gemini-cli',
] as const;

/**
 * Tools the graph ends at.
 *
 * A step with no `onSuccess` has nowhere to go when it succeeds, so the work is
 * over when it returns. `onFailure` is deliberately ignored: a failure path is
 * recovery, and a run that ends by failing is not a run that finished.
 *
 * Returns an empty set for an agent with no graph, which is the honest answer
 * rather than a guess — a conversational agent has no terminal step, so nothing
 * here can say when it is done, and the loop keeps today's behaviour.
 */
export function terminalToolNames(steps: readonly WorkflowStep[] | undefined): ReadonlySet<string> {
  if (!steps || steps.length === 0) return new Set();
  const out = new Set<string>();
  for (const step of steps) {
    if (step.onSuccess) continue;
    if (typeof step.toolName === 'string' && step.toolName.length > 0) out.add(step.toolName);
  }
  return out;
}

/**
 * Whether a completed round ended the work.
 *
 * EVERY call in the round has to be terminal, which is the whole guard. A round
 * that posted the review AND read another pull request is a round mid-plan, and
 * ending it there would truncate the run — the model asked for the next thing
 * and never got it.
 *
 * This is why the OpenAI SDK's `stopAtToolNames` is the wrong mechanism despite
 * naming the right idea: it stops on the FIRST listed tool called, whatever else
 * the round was doing, and makes that tool's raw output the run's final output.
 * The function form of `toolUseBehavior` sees the whole round, which is the only
 * place this question can be answered.
 */
export function roundIsTerminal(
  calledToolNames: readonly string[],
  terminal: ReadonlySet<string>,
): boolean {
  if (terminal.size === 0) return false;
  // A round that called nothing is not a round that finished the work; it is the
  // model talking, and the loop already knows how to end on that.
  if (calledToolNames.length === 0) return false;
  return calledToolNames.every((name) => terminal.has(name));
}

/**
 * One line when a terminal-only round ended the turn.
 *
 * The adapters end the turn by returning early, and the vendor never says
 * which model call was NOT made — so a traced run could not tell a turn the
 * mechanism closed from one the model happened to end. Same reason the
 * forcing directive leaves a line (grounding-forcing.ts).
 */
export function logTurnClosed(
  engine: ExecutionEngineId,
  calledToolNames: readonly string[],
  invocationId: string | undefined,
): void {
  logger.info(
    { event: 'turn_closed_on_terminal_round', execution_engine: engine, tool_names: [...calledToolNames], invocation_id: invocationId },
    'terminal-only round ended the turn; the closing model call was not made',
  );
}
