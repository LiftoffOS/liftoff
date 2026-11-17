// Handing the rest of a turn to a colleague: the one rail, for every surface.
//
// This is Liftoff's delegated segment, lifted out of src/liftoff/chat-service.ts
// so the Insights Manager and the Chief AI Officer can hand a turn over the
// same way. Everything from the bring-in tool call to the colleague's last word
// happens here: who is speaking is said FIRST, the colleague's own thread is
// opened (or reused) and paired with this conversation, the person's words and
// the asker's background note travel to it separately, the colleague's events
// are relayed, and a stop pressed on the asker's surface reaches the colleague
// through the colleague's own control plane. The caller persists what comes
// back, attributed to the colleague, and ends its turn: the colleague has the
// floor, and looping back to the asker's model would have it summarise what
// the person just read.
//
// The asker is described, not assumed. Liftoff, the Insights Manager and the
// Chief AI Officer differ in three things only: where the pairing is recorded,
// how a stop pressed on their surface is claimed, and the label that goes on
// the background note. Each hands those in; the rail is otherwise identical,
// which is the point — one behaviour to reason about, one set of tests.
//
// TWO CONTROL PLANES, RECONCILED HERE. The asker and every colleague have
// their own lock, their own stop and their own ceiling, and none of them can
// see each other's:
//
//   - The asker's lock stays held for the whole hand-over. It is what keeps a
//     second turn off the asker's thread, and therefore off the colleague's
//     paired one.
//   - A stop is claimed on the ASKER's side only, by the same watcher its
//     model call uses. The claim aborts the shared controller, and the abort
//     delivers the stop through the COLLEAGUE'S OWN control plane: a stop RPC
//     for the Chief AI Officer, an abort signal row for the Insights Manager
//     or Liftoff, a runtime stop RPC for a team. Nothing here abandons the
//     stream to stop it, because on every surface abandoning it stops
//     nothing: each treats a lost reader as "the person walked away, finish
//     the work and persist it", which is the rule the asker applies to itself.
//   - Having asked, this keeps relaying until the colleague's own terminal
//     event. That is what makes a stop keep the half-written answer instead
//     of truncating it, and it is bounded on every surface: workforce caps its
//     stream at ten minutes, the runtime client aborts at 870 seconds, and
//     the Insights and Liftoff loops are capped at ten iterations and 100K
//     tokens.
//   - Losing the lock is NOT a stop and is not treated like one. The thread
//     now belongs to another turn, so this one stops reading at the next
//     event and persists nothing, having already asked the colleague to stop
//     through the same abort listener.
//   - A colleague that reports itself busy cannot deadlock: `busy` is terminal
//     like any other event and ends the segment immediately.

import { log } from '../infrastructure/logging';
import {
  createDelegateRuntime,
  type DelegateRuntime,
  type DelegationCaller,
} from '../liftoff/delegation-runtimes';
import type { DelegationTarget } from '../liftoff/delegation-targets';
import { forwardedContextForModel } from '../liftoff/forwarded-context';
import { briefEchoReader } from '../liftoff/brief-echo';
import { GuardedOutput } from '../common/guarded-stream';
import type { TenantMemberRole } from '../liftoff/chat-repository';
import type { ActorOrigin } from '../workspace-actions/actor';

/** What a hand-over yields while it runs. Every asker's event union is a
 *  superset of this, so the segment can be `yield*`-ed from any of them. */
export type HandoverEvent =
  | { type: 'thinking' }
  | { type: 'tool_call'; tool: string }
  | { type: 'text_delta'; text: string }
  | { type: 'content_block'; block: unknown }
  /** Who is speaking from here on: the colleague's id and the name the
   *  person sees. The same payload the stored reply's contributors carry. */
  | { type: 'delegation_started'; author: string; authorLabel: string }
  | { type: 'error'; code: 'DELEGATION_ERROR' | 'INTERNAL'; message: string };

/** What the delegated segment leaves for the persist path that follows it. */
export interface HandoverOutcome {
  /** Everything the colleague said, as the person saw it. */
  text: string;
  blocks: unknown[];
  inputTokens: number;
  outputTokens: number;
  /** The colleague could not answer. An `error` event has already been
   *  yielded, so the caller persists nothing and ends. */
  failed: boolean;
  /** The person pressed Stop during the hand-over. */
  stopped: boolean;
  /** The colleague stopped and is waiting on a person. Not a failure:
   *  whatever it said is kept, and this sentence is shown after it. */
  paused: string | null;
  /** The colleague's own thread for this conversation, once it is open. Null
   *  only when opening it failed, which is already a `failed` outcome.
   *  Carried out of the segment because a pause has to say where the
   *  decision is waiting, and the pairing is resolved in here. */
  delegateThreadId: string | null;
}

/** The three things that differ between askers. */
export interface HandoverAsker {
  /** The asker as a contributor on the colleague's side: the same id
   *  vocabulary every surface stores ('liftoff', 'caio', 'insights'), and
   *  the name the person sees, which also labels the background note and
   *  names the asker in the logs. */
  id: 'liftoff' | 'caio' | 'insights';
  label: string;
  tenantId: string;
  accountId: string;
  /** The caller's REAL role, exactly as the surface resolved it. Every
   *  colleague makes its own permission decisions from it, so it is
   *  forwarded rather than defaulted or widened. */
  role: TenantMemberRole;
  displayName: string;
  origin?: ActorOrigin;
  threadId: string;
  /** The turn's id on the asker's surface, for claiming a stop; absent for
   *  a turn that runs without a lock, which then cannot be stopped. */
  turnId?: string;
  abortController?: AbortController;
  /** The person's own words this turn. */
  userMessage: string;
  /** Where this surface records the colleague's paired thread. */
  pairing: {
    get(target: DelegationTarget): Promise<string | null>;
    pair(target: DelegationTarget, delegateThreadId: string): Promise<string>;
  };
  /** How a stop pressed on this surface is claimed while the colleague
   *  streams: the same poll the surface's own model call uses. Returns null
   *  when the turn cannot be stopped. */
  startAbortWatcher(
    abortController: AbortController,
    onClaimed: () => void,
  ): { stop: () => void } | null;
}

/**
 * The thread this conversation uses with this colleague, creating it the
 * first time.
 *
 * Reused on every later hand-over, and that is the whole point: the
 * colleague's plan, its drafts and its own history live in that thread, so a
 * second one would mean starting from nothing halfway through a conversation
 * about the same piece of work. For the Chief AI Officer it is also where the
 * preview it made last time keeps the handle the next "yes" applies.
 */
async function ensurePairedDelegateThread(
  asker: HandoverAsker,
  target: DelegationTarget,
  runtime: Pick<DelegateRuntime, 'createThread'>,
): Promise<string> {
  const existing = await asker.pairing.get(target);
  if (existing) return existing;
  const created = await runtime.createThread();
  return asker.pairing.pair(target, created);
}

/**
 * Run the delegated part of the turn: everything from the tool call to the
 * colleague's last word. See the file header for the control-plane rules.
 */
export async function* runHandover(
  asker: HandoverAsker,
  target: DelegationTarget,
  taskSummary: string,
): AsyncGenerator<HandoverEvent, HandoverOutcome> {
  const outcome: HandoverOutcome = {
    text: '',
    blocks: [],
    inputTokens: 0,
    outputTokens: 0,
    failed: false,
    stopped: false,
    paused: null,
    delegateThreadId: null,
  };

  // Who is speaking, said FIRST: before the paired thread is opened and
  // before anything the colleague itself emits. The target is already
  // resolved by the time this runs, and opening that thread is a round trip
  // to another service, so waiting for it would leave the reply unattributed
  // for exactly the stretch this frame exists to cover.
  yield { type: 'delegation_started', author: target.id, authorLabel: target.label };

  const caller: DelegationCaller = {
    tenantId: asker.tenantId,
    accountId: asker.accountId,
    role: asker.role,
    displayName: asker.displayName.trim() || 'A teammate',
    ...(asker.origin ? { origin: asker.origin } : {}),
    // A colleague brought in never brings in a colleague of its own: depth
    // is one, on every surface, whoever asks.
    asColleague: true,
  };
  const runtime = createDelegateRuntime(target, caller);

  let delegateThreadId: string;
  try {
    delegateThreadId = await ensurePairedDelegateThread(asker, target, runtime);
    outcome.delegateThreadId = delegateThreadId;
  } catch (err) {
    log.error(
      { threadId: asker.threadId, tenantId: asker.tenantId, asker: asker.label, target: target.id, error: (err as Error).message },
      'could not open a thread with a colleague',
    );
    outcome.failed = true;
    yield {
      type: 'error',
      code: 'DELEGATION_ERROR',
      message: `${target.label} could not be reached just now. Please try again in a moment.`,
    };
    return outcome;
  }

  // One controller drives the hand-over. When the turn runs without a lock
  // there is nothing to abort it, and a controller nobody aborts behaves
  // exactly like no controller at all.
  const abortController = asker.abortController ?? new AbortController();

  // A stop claimed at a loop boundary before the hand-over started: no turn
  // exists on the colleague's side yet, so there is nothing to stop or relay.
  if (abortController.signal.aborted) {
    outcome.stopped = true;
    return outcome;
  }

  let stopDelivery: Promise<void> | null = null;
  const stopTheColleague = (): void => {
    if (stopDelivery) return;
    stopDelivery = runtime.requestStop({ delegateThreadId }).catch((err: Error) => {
      log.warn(
        { threadId: asker.threadId, asker: asker.label, target: target.id, error: err.message },
        'hand-over: the stop could not be delivered',
      );
    });
  };
  abortController.signal.addEventListener('abort', stopTheColleague, { once: true });

  // Stops are claimed on the asker's side while the colleague streams, on the
  // same spacing the model call uses. Without this, Stop during a hand-over
  // would sit unread until the colleague finished, which is the whole thing
  // it exists to prevent.
  const watcher = asker.startAbortWatcher(abortController, () => {
    outcome.stopped = true;
  });

  // The brief, built once: the relay compares the colleague's words against the
  // same string its model is about to be given.
  //
  // A PARAGRAPH is the unit, because the paraphrase reader cannot judge half a
  // sentence, and because that is already the unit every non-delegated turn on
  // this platform streams in (common/guarded-stream.ts). A delegated turn was
  // the one exception. Two consequences are handled rather than accepted: a
  // content block FLUSHES the paragraph before it, so a chart never arrives
  // above the sentence that introduces it; and whatever is still held when the
  // stream ends is released, whatever ended it.
  const brief = forwardedContextForModel(asker.userMessage, taskSummary, asker.label);
  const echoContext = {
    tenantId: asker.tenantId,
    speaker: target.id,
    threadId: asker.threadId,
    // The turn's own signal: a stop, or a caller that closed the stream,
    // abandons the read rather than holding the last paragraph for its
    // deadline. Declared after the controller for that reason.
    abortSignal: abortController.signal,
  };
  const echo = briefEchoReader(brief, asker.userMessage, echoContext);
  /** Cut on paragraphs, read, delivered in order; fenced blocks pass through
   *  unread. The reader in the model's place here is the brief comparison. */
  const released: string[] = [];
  const relay = echo
    ? new GuardedOutput(echoContext, {
        onText: (t) => released.push(t),
        guard: async (text) => {
          const { text: kept, removed } = await echo.readFully(text);
          return { text: kept, changed: removed > 0, kinds: removed > 0 ? ['mechanics'] : [] };
        },
      })
    : null;
  /** Everything the colleague said as the person saw it, replaced at `complete`
   *  by what the colleague persisted when it sends that. */
  let streamed = '';
  let persisted: string | null = null;
  /** Hand over what the paragraph machine has released, in order. */
  const drain = function* (): Generator<HandoverEvent> {
    while (released.length > 0) {
      const text = released.shift()!;
      streamed += text;
      yield { type: 'text_delta', text };
    }
  };

  let sawTerminal = false;
  let lockLost = false;
  try {
    for await (const event of runtime.runTurn({
      delegateThreadId,
      // The person's words travel alone. The brief the asker wrote for this
      // colleague travels beside them, for the colleague's model only: the
      // colleague reads it this turn and keeps one status row naming the
      // asker. See forwarded-context.ts.
      content: asker.userMessage,
      forwardedContext: brief,
      forwardedBy: { id: asker.id, label: asker.label },
    })) {
      // Aborted without a claim means the lock went, not that somebody
      // pressed Stop. Another turn owns this thread now, so stop reading
      // rather than writing a reply into a conversation that has moved on.
      if (abortController.signal.aborted && !outcome.stopped) {
        lockLost = true;
        break;
      }

      switch (event.type) {
        case 'thinking':
          yield { type: 'thinking' };
          break;
        case 'tool_call':
          yield { type: 'tool_call', tool: event.tool };
          break;
        case 'text_delta':
          if (relay) {
            relay.feed(event.text);
            yield* drain();
          } else {
            streamed += event.text;
            yield { type: 'text_delta', text: event.text };
          }
          break;
        case 'content_block':
          // The paragraph above a chart is released BEFORE the chart, which is
          // the whole reason this is a flush and not a queue: a block that
          // overtook its own introduction would be a worse defect than the one
          // the paragraph machine is here for.
          if (relay) {
            await relay.flush();
            yield* drain();
          }
          outcome.blocks.push(event.block);
          yield { type: 'content_block', block: event.block };
          break;
        case 'complete':
          sawTerminal = true;
          // Prefer what the colleague persisted: the same reply with any
          // visualization fences already lifted out, which is exactly the
          // text that belongs in a transcript.
          if (event.text) {
            persisted = echo ? (await echo.readFully(event.text)).text : event.text;
          }
          if (event.blocks?.length) outcome.blocks = event.blocks;
          outcome.inputTokens = event.inputTokens;
          outcome.outputTokens = event.outputTokens;
          break;
        case 'paused':
          sawTerminal = true;
          outcome.paused = event.reason;
          break;
        case 'busy':
          // The message was folded into a turn already running on the paired
          // thread, so nothing comes back here. Only reachable when an
          // earlier delegated turn outlived the request that started it, or
          // when somebody is talking to that colleague on its own surface.
          sawTerminal = true;
          outcome.failed = true;
          log.warn(
            { threadId: asker.threadId, tenantId: asker.tenantId, asker: asker.label, target: target.id },
            'hand-over landed in a colleague turn that was already running',
          );
          yield {
            type: 'error',
            code: 'DELEGATION_ERROR',
            message: `${target.label} is still finishing something else. Please try again in a moment.`,
          };
          break;
        case 'error':
          sawTerminal = true;
          outcome.failed = true;
          log.error(
            { threadId: asker.threadId, tenantId: asker.tenantId, asker: asker.label, target: target.id },
            'a colleague reported an error on a delegated turn',
          );
          yield { type: 'error', code: 'DELEGATION_ERROR', message: event.message };
          break;
      }
      if (sawTerminal) break;
    }
  } finally {
    watcher?.stop();
    abortController.signal.removeEventListener('abort', stopTheColleague);
    // Awaited, not detached: the process may be moments from being scaled
    // away, and a stop that never left the container is a colleague left
    // running.
    if (stopDelivery) await stopDelivery;
  }

  // The last paragraph the machine is holding belongs to the person, on every
  // path that KEEPS the reply: a clean finish, a pause, a stop. Not on one that
  // does not. A hand-over that failed, was told the colleague is busy, lost its
  // lock, or ended with no terminal event at all yields an error and persists
  // nothing, and half a paragraph arriving after that error is not a partial
  // answer, it is a contradiction of the one the person just read.
  if (relay && sawTerminal && !outcome.failed) {
    await relay.flush();
    yield* drain();
  }
  outcome.text = persisted ?? streamed;

  if (lockLost) {
    log.warn(
      { threadId: asker.threadId, tenantId: asker.tenantId, asker: asker.label, turnId: asker.turnId },
      'delegated turn lost its lock; ending the hand-over',
    );
    outcome.failed = true;
    yield {
      type: 'error',
      code: 'INTERNAL',
      message: 'The response was interrupted. Please try again.',
    };
    return outcome;
  }

  if (sawTerminal) return outcome;

  // The stream ended without saying how. No colleague does that deliberately,
  // so this is a connection or a loop that went away mid-reply.
  log.error(
    { threadId: asker.threadId, tenantId: asker.tenantId, asker: asker.label, target: target.id },
    'a colleague stream ended without a terminal event',
  );
  outcome.failed = true;
  yield {
    type: 'error',
    code: 'DELEGATION_ERROR',
    message: `${target.label} stopped responding. Please try again.`,
  };
  return outcome;
}
