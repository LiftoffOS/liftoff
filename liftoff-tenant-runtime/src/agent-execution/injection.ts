// One contract for putting a message into a run that is already going.
//
// We have three kinds of injection, built at three different times, with the
// ordering rules living in comments rather than in code:
//
//   steer        — a user message arriving mid-run (`cron_jobs` delivery mode
//                  'steer'). checkUserInterruptSignal → adapter.injectMessage,
//                  consumed ONLY at tool_call_finished "because that is the only
//                  boundary where another model turn is guaranteed", with a cap
//                  of MAX_INJECTION_CONTINUATIONS.
//   follow_up    — `cron_jobs` delivery mode 'follow_up'.
//   continuation — autonomous, goal, runVerifyContinuation, runWakeContinuation.
//
// NO BEHAVIOUR CHANGE IS INTENDED. The win is that the ordering becomes
// testable and the accounting stops being three ad-hoc counters: today
// `pendingInjections` is an integer incremented in one place, decremented in
// another, and capped in a third, so "how many are outstanding, of what kind"
// is not a question the code can answer.
//
// The boundary rule is the load-bearing part and it is not arbitrary. The
// engines drain injected messages BETWEEN model turns, so a message consumed at
// the end of an assistant message is marked delivered and then dropped when the
// turn ends with nothing left to drain the queue. `tool_call_finished` is the
// only boundary where another model turn is guaranteed.

export type InjectionKind = 'steer' | 'follow_up' | 'continuation';

export type InjectionSource =
  | 'user' | 'heartbeat' | 'cron' | 'autonomous' | 'goal' | 'verify' | 'wake' | 'recovery';

export type InjectionBoundary = 'tool_call_finished' | 'assistant_message' | 'completion';

export interface SessionInjection {
  kind: InjectionKind;
  source: InjectionSource;
  text: string;
  /** 'all' drains every queued item at the boundary; 'one-at-a-time' takes the head. */
  drain: 'all' | 'one-at-a-time';
  /** Coalesce: a second injection with the same key replaces the first. */
  queueKey?: string;
}

/** Where each kind may be delivered.
 *
 *  A steer is drained one at a time at `tool_call_finished` and nowhere else —
 *  see the header. Continuations and follow-ups are decided at a terminal, where
 *  the run is choosing whether to keep going at all. */
const BOUNDARY_FOR: Record<InjectionKind, InjectionBoundary> = {
  steer: 'tool_call_finished',
  follow_up: 'completion',
  continuation: 'completion',
};

/** How many of a kind may be outstanding.
 *
 *  Each steer buys exactly one extra turn, and three is the existing
 *  MAX_INJECTION_CONTINUATIONS — a bound on how far a run can be extended by
 *  someone typing at it, not a guess. */
const MAX_PENDING: Record<InjectionKind, number> = {
  steer: 3,
  follow_up: 1,
  continuation: 1,
};

export const MAX_INJECTION_CONTINUATIONS = MAX_PENDING.steer;

export class InjectionQueue {
  private readonly items: SessionInjection[] = [];
  /** Counts what has been HANDED TO THE ENGINE and not yet answered, which is a
   *  different question from what is still queued — an injection leaves the
   *  queue the moment it is drained, but the run still owes it a turn. */
  private readonly inFlight: Record<InjectionKind, number> = {
    steer: 0, follow_up: 0, continuation: 0,
  };

  /** Queue an injection, or replace one already queued under the same key.
   *  Returns false when the kind is already at its cap, so the caller can tell
   *  "queued" from "dropped" rather than assuming. */
  enqueue(i: SessionInjection): boolean {
    if (i.queueKey) {
      const existing = this.items.findIndex((q) => q.queueKey === i.queueKey);
      if (existing >= 0) {
        // Coalesce. The newer text supersedes the older one: two steers about
        // the same thing are one instruction that changed its mind, and
        // delivering both would have the model act on the stale one first.
        this.items[existing] = i;
        return true;
      }
    }
    const outstanding = this.pendingCount(i.kind) + this.inFlight[i.kind];
    if (outstanding >= MAX_PENDING[i.kind]) return false;
    this.items.push(i);
    return true;
  }

  /** Take what may be delivered at this boundary, in queue order.
   *
   *  An injection is only ever offered at ITS boundary. A steer queued while the
   *  run is between assistant messages waits for the next tool result rather
   *  than being handed over somewhere it would be silently dropped. */
  drainAt(boundary: InjectionBoundary): SessionInjection[] {
    const eligible: SessionInjection[] = [];
    for (let i = 0; i < this.items.length;) {
      const item = this.items[i];
      if (BOUNDARY_FOR[item.kind] !== boundary) { i++; continue; }
      eligible.push(item);
      this.items.splice(i, 1);
      if (item.drain === 'one-at-a-time') break;
    }
    for (const item of eligible) this.inFlight[item.kind] += 1;
    return eligible;
  }

  /** Outstanding but not yet handed to the engine. */
  pendingCount(kind?: InjectionKind): number {
    return kind ? this.items.filter((i) => i.kind === kind).length : this.items.length;
  }

  /** Handed to the engine and still owed a turn. This is what decides whether a
   *  terminal completion should end the run or let it continue: an engine that
   *  answers an injected message and closes the session without a second
   *  completion has done the work, and ending there would discard the reply. */
  inFlightCount(kind?: InjectionKind): number {
    if (kind) return this.inFlight[kind];
    return this.inFlight.steer + this.inFlight.follow_up + this.inFlight.continuation;
  }

  /** Mark one in-flight injection as answered. */
  settleOne(kind: InjectionKind): void {
    if (this.inFlight[kind] > 0) this.inFlight[kind] -= 1;
  }
}
