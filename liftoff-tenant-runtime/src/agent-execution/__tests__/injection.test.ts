// The injection contract.
//
// The ordering rules used to live in comments spread across the event loop, and
// the accounting was an integer incremented in one place, decremented in
// another, and capped in a third — so "how many are outstanding, of what kind"
// was not a question the code could answer. These assertions are that question.

import { InjectionQueue, MAX_INJECTION_CONTINUATIONS, type SessionInjection } from '../injection';

const steer = (text: string, queueKey?: string): SessionInjection => ({
  kind: 'steer', source: 'user', text, drain: 'one-at-a-time', ...(queueKey ? { queueKey } : {}),
});
const continuation = (text: string): SessionInjection => ({
  kind: 'continuation', source: 'verify', text, drain: 'all',
});

describe('boundaries', () => {
  // The load-bearing rule. Engines drain injected messages BETWEEN model turns,
  // so a steer handed over at the end of an assistant message is marked
  // delivered and then dropped when the turn ends with nothing to drain it.
  it('offers a steer only at tool_call_finished', () => {
    const q = new InjectionQueue();
    q.enqueue(steer('do this instead'));
    expect(q.drainAt('assistant_message')).toEqual([]);
    expect(q.drainAt('completion')).toEqual([]);
    expect(q.drainAt('tool_call_finished')).toHaveLength(1);
  });

  it('keeps a steer queued until its boundary comes round', () => {
    const q = new InjectionQueue();
    q.enqueue(steer('later'));
    q.drainAt('assistant_message');
    expect(q.pendingCount('steer')).toBe(1);
  });

  it('offers a continuation only at completion', () => {
    const q = new InjectionQueue();
    q.enqueue(continuation('keep going'));
    expect(q.drainAt('tool_call_finished')).toEqual([]);
    expect(q.drainAt('completion')).toHaveLength(1);
  });
});

describe('drain modes', () => {
  it('one-at-a-time takes the head and leaves the rest', () => {
    const q = new InjectionQueue();
    q.enqueue(steer('first'));
    q.enqueue(steer('second'));
    const drained = q.drainAt('tool_call_finished');
    expect(drained.map((i) => i.text)).toEqual(['first']);
    expect(q.pendingCount('steer')).toBe(1);
  });

  it('all takes everything eligible at that boundary', () => {
    const q = new InjectionQueue();
    q.enqueue(continuation('a'));
    // A second continuation is over the cap, so only one is ever queued.
    expect(q.enqueue(continuation('b'))).toBe(false);
    expect(q.drainAt('completion')).toHaveLength(1);
  });

  it('does not take another kind while draining one', () => {
    const q = new InjectionQueue();
    q.enqueue(steer('steer'));
    q.enqueue(continuation('continue'));
    expect(q.drainAt('tool_call_finished').map((i) => i.kind)).toEqual(['steer']);
    expect(q.drainAt('completion').map((i) => i.kind)).toEqual(['continuation']);
  });
});

describe('coalescing', () => {
  // Two steers about the same thing are one instruction that changed its mind.
  // Delivering both would have the model act on the stale one first.
  it('a second injection with the same key replaces the first', () => {
    const q = new InjectionQueue();
    q.enqueue(steer('use the staging bucket', 'target-bucket'));
    q.enqueue(steer('actually use production', 'target-bucket'));
    expect(q.pendingCount('steer')).toBe(1);
    expect(q.drainAt('tool_call_finished')[0].text).toBe('actually use production');
  });

  it('leaves differently-keyed injections alone', () => {
    const q = new InjectionQueue();
    q.enqueue(steer('one', 'a'));
    q.enqueue(steer('two', 'b'));
    expect(q.pendingCount('steer')).toBe(2);
  });

  // Coalescing must not be a way around the cap: replacing an entry does not
  // add one.
  it('a coalesced replacement does not consume cap headroom', () => {
    const q = new InjectionQueue();
    for (let i = 0; i < 10; i++) q.enqueue(steer(`v${i}`, 'same'));
    expect(q.pendingCount('steer')).toBe(1);
  });
});

describe('the cap', () => {
  it('is the existing three continuations', () => {
    expect(MAX_INJECTION_CONTINUATIONS).toBe(3);
  });

  it('refuses a steer past the cap, and says so', () => {
    const q = new InjectionQueue();
    for (let i = 0; i < MAX_INJECTION_CONTINUATIONS; i++) {
      expect(q.enqueue(steer(`s${i}`))).toBe(true);
    }
    expect(q.enqueue(steer('one too many'))).toBe(false);
    expect(q.pendingCount('steer')).toBe(MAX_INJECTION_CONTINUATIONS);
  });

  // In-flight counts toward the cap. Otherwise a run could be extended
  // indefinitely by draining one and queueing another each turn, which is
  // exactly what the cap exists to prevent.
  it('counts in-flight injections against the cap', () => {
    const q = new InjectionQueue();
    for (let i = 0; i < MAX_INJECTION_CONTINUATIONS; i++) q.enqueue(steer(`s${i}`));
    q.drainAt('tool_call_finished');
    expect(q.enqueue(steer('after a drain'))).toBe(false);
  });

  it('frees headroom once an injection is answered', () => {
    const q = new InjectionQueue();
    for (let i = 0; i < MAX_INJECTION_CONTINUATIONS; i++) q.enqueue(steer(`s${i}`));
    q.drainAt('tool_call_finished');
    q.settleOne('steer');
    expect(q.enqueue(steer('now there is room'))).toBe(true);
  });
});

describe('accounting', () => {
  // Queued and in-flight are different questions. An injection leaves the queue
  // the moment it is drained, but the run still owes it a turn — and that is
  // what decides whether a terminal completion ends the run or lets it continue.
  it('separates queued from in-flight', () => {
    const q = new InjectionQueue();
    q.enqueue(steer('a'));
    expect(q.pendingCount('steer')).toBe(1);
    expect(q.inFlightCount('steer')).toBe(0);

    q.drainAt('tool_call_finished');
    expect(q.pendingCount('steer')).toBe(0);
    expect(q.inFlightCount('steer')).toBe(1);

    q.settleOne('steer');
    expect(q.inFlightCount('steer')).toBe(0);
  });

  it('reports totals across kinds', () => {
    const q = new InjectionQueue();
    q.enqueue(steer('a'));
    q.enqueue(continuation('b'));
    expect(q.pendingCount()).toBe(2);
    q.drainAt('tool_call_finished');
    q.drainAt('completion');
    expect(q.inFlightCount()).toBe(2);
  });

  it('settling below zero is a no-op rather than a negative count', () => {
    const q = new InjectionQueue();
    q.settleOne('steer');
    q.settleOne('steer');
    expect(q.inFlightCount('steer')).toBe(0);
  });
});
