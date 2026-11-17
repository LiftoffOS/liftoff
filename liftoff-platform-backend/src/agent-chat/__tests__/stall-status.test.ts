// C4 — dead-air notices on messaging surfaces.

import { withStallStatus, stallNoticeText } from '../stall-status';

jest.useFakeTimers();

type Ev = { type: string; tool?: string };

/** A stream the test drives by hand, so silence is controllable. */
function controllable() {
  const queue: Ev[] = [];
  let notify: (() => void) | null = null;
  let done = false;

  const stream = (async function* (): AsyncGenerator<Ev> {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) return;
      await new Promise<void>((resolve) => { notify = resolve; });
    }
  })();

  return {
    stream,
    push(event: Ev) {
      queue.push(event);
      notify?.();
      notify = null;
    },
    end() {
      done = true;
      notify?.();
      notify = null;
    },
  };
}

/** Let queued microtasks settle without advancing fake timers.
 *
 *  Several ticks, not one: a value handed to the wrapper travels through the
 *  source generator, the wrapper's own yield, and the consumer's loop before
 *  the wrapper re-arms its timer. Advancing timers before that has happened
 *  would test a state the wrapper is never actually in. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('withStallStatus', () => {
  it('says nothing while events keep arriving', async () => {
    const onStall = jest.fn();
    const src = controllable();
    const out = withStallStatus(src.stream, { onStall, thresholdMs: 1000 });

    const reader = (async () => {
      const seen: Ev[] = [];
      for await (const e of out) seen.push(e);
      return seen;
    })();

    for (let i = 0; i < 3; i++) {
      src.push({ type: 'text_delta' });
      await flush();
      jest.advanceTimersByTime(900); // always short of the threshold
      await flush();
    }
    src.end();
    await flush();

    await expect(reader).resolves.toHaveLength(3);
    expect(onStall).not.toHaveBeenCalled();
  });

  it('speaks up once after the threshold of silence', async () => {
    const onStall = jest.fn();
    const src = controllable();
    const out = withStallStatus(src.stream, { onStall, thresholdMs: 1000 });
    const reader = (async () => { for await (const _e of out) { /* drain */ } })();

    await flush();
    jest.advanceTimersByTime(1000);
    await flush();

    expect(onStall).toHaveBeenCalledTimes(1);
    src.end();
    await flush();
    await reader;
  });

  it('names the last tool it saw', async () => {
    const onStall = jest.fn();
    const src = controllable();
    const out = withStallStatus(src.stream, { onStall, thresholdMs: 1000 });
    const reader = (async () => { for await (const _e of out) { /* drain */ } })();

    src.push({ type: 'tool_call', tool: 'hubspot__search_deals' });
    await flush();
    jest.advanceTimersByTime(1000);
    await flush();

    expect(onStall).toHaveBeenCalledWith('hubspot__search_deals');
    src.end();
    await flush();
    await reader;
  });

  it('never exceeds the notice cap, however long the silence', async () => {
    const onStall = jest.fn();
    const src = controllable();
    const out = withStallStatus(src.stream, { onStall, thresholdMs: 1000, maxNotices: 2 });
    const reader = (async () => { for await (const _e of out) { /* drain */ } })();

    await flush();
    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(1000);
      await flush();
    }

    expect(onStall).toHaveBeenCalledTimes(2);
    src.end();
    await flush();
    await reader;
  });

  it('stops the timer when the consumer breaks out early', async () => {
    const onStall = jest.fn();
    const src = controllable();
    const out = withStallStatus(src.stream, { onStall, thresholdMs: 1000 });

    const reader = (async () => {
      for await (const _e of out) break; // the interrupt/stop branches do this
    })();

    src.push({ type: 'interrupt_delivered' });
    await flush();
    await reader;

    jest.advanceTimersByTime(60_000);
    await flush();
    expect(onStall).not.toHaveBeenCalled();
  });

  it('does not let a throwing callback break the turn', async () => {
    const src = controllable();
    const out = withStallStatus(src.stream, {
      onStall: () => { throw new Error('slack is down'); },
      thresholdMs: 1000,
    });
    const reader = (async () => {
      const seen: Ev[] = [];
      for await (const e of out) seen.push(e);
      return seen;
    })();

    await flush();
    jest.advanceTimersByTime(1000);
    await flush();
    src.push({ type: 'text_delta' });
    await flush();
    src.end();
    await flush();

    await expect(reader).resolves.toHaveLength(1);
  });
});

describe('stallNoticeText', () => {
  it('names the tool when there is one', () => {
    expect(stallNoticeText('gmail__search')).toContain('gmail__search');
  });

  it('still says something useful before any tool has run', () => {
    expect(stallNoticeText(null)).toContain('Still working');
  });

  it('uses no contractions', () => {
    for (const text of [stallNoticeText(null), stallNoticeText('x')]) {
      expect(text).not.toMatch(/\b\w+'(s|t|re|ve|ll|d|m)\b/);
    }
  });
});
