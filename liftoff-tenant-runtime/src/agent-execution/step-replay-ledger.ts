// A step that runs twice must not write twice.
//
// THE FAILURE. A step creates a document and then fails its declared output,
// and `create_document_markdown` succeeds three times, leaving three distinct
// documents.
//
// The first is the step's own call. The other two are the recovery advisor's: a
// `continue` proposal carries corrected calls, they are dispatched, and when the
// value they produce still does not satisfy the step's `outputField` the cycle
// re-asks — so the advisor proposes the same create again, and it fires again.
// Nothing between the proposal and the dispatch consults what this step has
// already done.
//
// A STEP RUNS TWICE FOR TWO REASONS, AND THIS COVERS BOTH.
//
// RECOVERY, above: the advisor re-proposes a call, inside one invocation.
//
// A RESUME: a pause re-dispatches the step it paused on, so the step's whole turn,
// or every iteration of its loop, runs again in another process. That is the
// larger multiple — a loop restarts from item 0, so a pause on item seven repeats
// items one to six. See WHY IT RIDES THE PAUSE below.
//
// THE RULE IS THE EXACT CALL, BY THE STEP THAT ALREADY MADE IT.
//
// Not "a successful write already exists for this step": one step may
// legitimately make several distinct writes, and suppressing the second breaks
// working agents. Not "make `create_document_markdown` find-or-create" either:
// document titles are not unique, so that changes what the tool means for every
// caller.
//
// So: the same tool, the same canonical arguments, the same step — plus, inside a
// loop, the same ITERATION, because two passes of one loop can be the same call
// and differ only in what came back (`iterationSuffix`). That is the one case
// where a second call cannot be new work.
//
// THE RECORDED RESULT IS RETURNED, AND THAT IS PART OF THE REQUIREMENT.
//
// Suppressing the call and reporting success would be a fabricated success, which
// an explicit platform invariant forbids. It would also lose what the rest of the
// step needs: the document id the first call returned is what a step told "done"
// has to link. This is the same shape as `duplicateReplay` in
// `tool-gateway/duplicate-outward-action.ts`, which hands back the external
// response the first identical act recorded. That guard could not see this defect,
// and the reason is worth stating: it keys on `deriveTarget`, and a CREATE names
// no target at all, so there was nothing to key on.
//
// WHY THE LEDGER IS PER STEP, AND WHY IT RIDES THE PAUSE.
//
// The question is "has this step already made exactly this call", and a step's
// attempts belong to that step. The durable ledger that exists
// (`sideeffect-idempotency.ts`) answers a wider question, keyed on the trigger
// rather than the step, and deliberately does not narrow to a retry.
//
// It is NOT in-memory-only, and that is the difference between a fix and half of
// one. Every HITL pause site in the workflow loop writes
// `resumeAfterStepId: currentStepId` — "re-dispatch the gated step on approve" —
// and the resumed loop sets `currentStepId` from it. So a step that wrote a
// document and then hit a gate on a LATER call runs again, whole, in another
// process, and an in-memory ledger is empty exactly there: on the long,
// interrupted runs most likely to repeat themselves. That is the same reasoning
// `duplicate-outward-action.ts` records for reading a ledger rather than keeping
// an in-process map: "HITL pauses, clarification answers and wakes all resume a
// run in a different process, and Cloud Run does not pin an invocation to an
// instance."
//
// So it is carried on the pause payload, alongside `salvagedSteps`, through
// `carriedLoopState`. Serialised BOUNDED: a payload that cannot be stored fails
// the pause, which is far worse than a replay that degrades. A dropped entry
// leaves that one call dispatching as it did before, and says so in the log.
//
// FOUR WRITERS, EACH HOLDING EVIDENCE THE OTHERS DO NOT.
//
//   * the loop's CATCH, from the step's own MODEL-issued calls, which reach
//     `completedToolCalls` carrying their tool names;
//   * `executeToolStep` and `executeLoopStep`, from the dispatch REQUEST, because
//     the result they push carries no name at all and the catch would skip it;
//   * `executeRecoveryCalls`, from each proposal it dispatches, so a re-ask of the
//     same proposal replays rather than repeats.
//
// The catch's half is FAILURE-SCOPED on purpose, and that is what keeps the
// gateway's reader from firing inside a healthy turn: a model that legitimately
// makes the same write twice in one turn must have both calls happen. The
// dispatch-site halves carry an iteration where one exists, so they are safe to
// record as they go.
//
// An entry therefore exists only for a step that has already run, which is what
// makes "an attempt that already happened" a property of the data rather than a
// flag somebody has to remember.

import { callSignature } from './call-strike-ledger';
import { normalizeToolName } from '../hitl-enforcement/tool-name-resolution';
import { resolveToolDispatch } from './tool-dispatch-family';
import { isStandardTool } from '../tools/standard-tools';

/** One call an earlier attempt of this step completed successfully. */
export interface ReplayableCall {
  /** The name as its recorder held it, for the log line. */
  name: string;
  /** What that call returned. Handed back verbatim. */
  result: unknown;
}

/** What a dispatch seam consults. An interface rather than the class so the tool
 *  gateway depends on the question and not on the store. */
export interface StepReplayLookup {
  /** The step these calls belong to. A ledger is per step by construction, and
   *  the gateway's log line names it. */
  readonly stepId: string;
  /** The recorded result for this exact call, named the way the model names it. */
  lookupByToolName(toolName: string, args: unknown): ReplayableCall | undefined;
}

/** One call as the run's record holds it. */
export interface RecordedToolCall {
  success?: boolean;
  name?: string;
  input?: unknown;
  result?: unknown;
}

/**
 * One key per (tool, arguments), from the two DIFFERENT shapes a call arrives in.
 *
 * A step's own call reaches the record as the model-facing NAME
 * (`google-docs-8fd9fc68__create_document_markdown`, or the SDK-prefixed
 * `mcp__liftoff-tool-gateway__…` form). A recovery proposal reaches the
 * dispatcher as a `ToolCallRequest`, already split into `connector` +
 * `actionType` by `resolveToolDispatch`. Keying on either shape alone would make
 * the two sides of this ledger unable to see each other's calls, so both are
 * reduced through the SAME resolver the request builders use.
 */
function dispatchKey(connector: string, actionType: string): string {
  return connector ? `${connector}|${actionType}` : actionType;
}

/** The key for a call named the way the run's record names it.
 *
 *  Exported alongside its sibling because the AGREEMENT between the two is the
 *  load-bearing property of this module and the one a test can assert directly:
 *  a ledger whose two writers key differently is present, green, and never hits. */
export function replayKeyForToolName(toolName: string): string {
  const bare = normalizeToolName(toolName);
  const dispatch = resolveToolDispatch(bare, isStandardTool);
  return dispatchKey(dispatch.kind === 'unresolved' ? '' : dispatch.connector, dispatch.actionType);
}

/** The key for a call already split into a dispatch request. */
export function replayKeyForRequest(req: { connector: string; actionType: string }): string {
  return dispatchKey(req.connector, req.actionType);
}

/** ONE ITERATION of a loop is not identified by its arguments.
 *
 *  Two iterations of the same loop can be the SAME call: a body whose arguments
 *  carry no item — "call list_next until it returns nothing", a static call whose
 *  answer differs per invocation — dispatches identical arguments N times and
 *  differs only in what comes back. Keyed on the call alone, iteration two would
 *  be answered with iteration one's result, and a loop that collects would
 *  collect the first item N times. `workflow-loop.test.ts` has exactly that
 *  shape, which is how this was caught.
 *
 *  So a loop's entries carry the INDEX, which is stable across a re-dispatch for
 *  the reason the replay works at all: the collection is re-resolved from
 *  `inputData` and `stepOutputs`, both of which the pause payload carries, so it
 *  is the same array in the same order.
 *
 *  A call outside a loop passes no index and is keyed as before. */
function iterationSuffix(iteration: number | undefined): string {
  return iteration === undefined ? '' : `|iter:${iteration}`;
}

/** One entry as a pause payload carries it. Keys are carried verbatim: the
 *  derivation is deterministic, and a release that changed it would simply stop
 *  matching, which degrades to the behaviour before this existed. */
export interface SerialisedReplayEntry {
  key: string;
  name: string;
  result: unknown;
}

/** Every step's ledger, keyed by step id, as a pause payload carries it. */
export type SerialisedStepReplay = Record<string, SerialisedReplayEntry[]>;

/** No single carried result is larger than this. A create's response is a few
 *  hundred bytes; anything approaching this is a read that was recorded by
 *  mistake, and carrying it would crowd out the pause. */
const MAX_CARRIED_RESULT_CHARS = 8_000;
/** Nor is the whole carried ledger. The pause payload has a hard ceiling
 *  (`MAX_DEFER_PAYLOAD_BYTES`) and losing the pause is worse than losing a
 *  replay. */
const MAX_CARRIED_LEDGER_CHARS = 64_000;

/**
 * The mutating calls one step's earlier attempts already completed.
 *
 * `callSignature` is the same (tool, canonical arguments) pair the strike ledger
 * keys on, so "the same call" means one thing in this runtime.
 */
export class StepReplayLedger implements StepReplayLookup {
  private readonly calls = new Map<string, ReplayableCall>();

  constructor(readonly stepId: string) {}

  /** How many distinct calls are held. */
  get size(): number {
    return this.calls.size;
  }

  /**
   * Remember every call that succeeded and that `isMutating` says changes
   * something. Returns how many were remembered, which can exceed `size` when
   * one call was recorded twice.
   *
   * A READ is deliberately not recorded. Replaying one buys nothing — it is
   * cheap and repeatable by definition — and it would serve the retry stale data
   * at exactly the moment fresh data is most likely to be what makes it work.
   *
   * A FAILED call is not recorded either: it performed nothing, so repeating it
   * is the retry doing its job.
   *
   * An existing entry is overwritten, so the LATEST successful result of a
   * repeated call is the one replayed.
   */
  record(
    calls: readonly RecordedToolCall[],
    isMutating: (toolName: string) => boolean,
  ): number {
    let added = 0;
    for (const call of calls) {
      if (call.success !== true) continue;
      const name = call.name;
      // A record with no name cannot be matched against a later dispatch, and
      // guessing which tool it was is how a replay answers the wrong call.
      if (!name) continue;
      if (!isMutating(name)) continue;
      this.calls.set(
        callSignature(replayKeyForToolName(name), call.input ?? {}),
        { name, result: call.result },
      );
      added++;
    }
    return added;
  }

  /** Remember one call a dispatch request performed, under the request's key.
   *  `iteration` distinguishes one pass of a loop from another; see
   *  `iterationSuffix`. */
  recordRequest(
    req: { connector: string; actionType: string; payload?: Record<string, unknown> },
    result: unknown,
    iteration?: number,
  ): void {
    this.calls.set(
      callSignature(replayKeyForRequest(req), req.payload ?? {}) + iterationSuffix(iteration),
      { name: dispatchKey(req.connector, req.actionType), result },
    );
  }

  /** The recorded result for this exact request, or undefined to dispatch it. */
  lookup(
    req: { connector: string; actionType: string; payload?: Record<string, unknown> },
    iteration?: number,
  ): ReplayableCall | undefined {
    return this.calls.get(
      callSignature(replayKeyForRequest(req), req.payload ?? {}) + iterationSuffix(iteration),
    );
  }

  /** The same question asked with a MODEL-FACING tool name and its arguments,
   *  which is the only shape the gateway's tool wrapper has: it is handed the
   *  registered name and the model's own args, never a dispatch request. */
  lookupByToolName(toolName: string, args: unknown): ReplayableCall | undefined {
    return this.calls.get(callSignature(replayKeyForToolName(toolName), args ?? {}));
  }

  /** Entries this ledger holds, bounded for a pause payload. Anything dropped is
   *  named so a replay that degraded is visible rather than inferred. */
  serialise(): { entries: SerialisedReplayEntry[]; dropped: string[] } {
    const entries: SerialisedReplayEntry[] = [];
    const dropped: string[] = [];
    let budget = MAX_CARRIED_LEDGER_CHARS;
    for (const [key, call] of this.calls) {
      const json = JSON.stringify(call.result ?? null);
      if (json.length > MAX_CARRIED_RESULT_CHARS || json.length > budget) {
        dropped.push(call.name);
        continue;
      }
      budget -= json.length;
      entries.push({ key, name: call.name, result: call.result });
    }
    return { entries, dropped };
  }

  /** A ledger rebuilt from a pause payload. Keys are taken as they were
   *  carried; an entry with no key or no name is skipped rather than rebuilt
   *  under a guess, because a wrong key answers the wrong call. */
  static hydrate(stepId: string, entries: readonly SerialisedReplayEntry[] | undefined): StepReplayLedger {
    const ledger = new StepReplayLedger(stepId);
    for (const e of entries ?? []) {
      if (!e?.key || !e?.name) continue;
      ledger.calls.set(e.key, { name: e.name, result: e.result });
    }
    return ledger;
  }
}

/** Every step's ledger, as a pause payload carries it. Empty ledgers are left
 *  out so a run that replayed nothing carries nothing. */
export function serialiseStepReplay(
  ledgers: Map<string, StepReplayLedger> | undefined,
): { payload: SerialisedStepReplay; dropped: string[] } {
  const payload: SerialisedStepReplay = {};
  const dropped: string[] = [];
  for (const [stepId, ledger] of ledgers ?? []) {
    const { entries, dropped: lost } = ledger.serialise();
    dropped.push(...lost);
    if (entries.length > 0) payload[stepId] = entries;
  }
  return { payload, dropped };
}

/** The ledgers a resumed loop starts from. */
export function hydrateStepReplay(
  payload: SerialisedStepReplay | undefined,
): Map<string, StepReplayLedger> {
  const out = new Map<string, StepReplayLedger>();
  for (const [stepId, entries] of Object.entries(payload ?? {})) {
    const ledger = StepReplayLedger.hydrate(stepId, entries);
    if (ledger.size > 0) out.set(stepId, ledger);
  }
  return out;
}
