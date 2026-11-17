// The recorder is where this feature's cost and its ordering guarantees live,
// so those are what these pin: it writes nothing without an audience, it
// coalesces tokens instead of writing one row each, and a tool call never
// appears before the text that introduced it.

const appendTurnEventsMock = jest.fn().mockResolvedValue(undefined);
const pruneTurnEventsMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../turn-events-repository', () => ({
  appendTurnEvents: (...a: unknown[]) => appendTurnEventsMock(...a),
  pruneTurnEvents: (...a: unknown[]) => pruneTurnEventsMock(...a),
}));

const countOtherViewersMock = jest.fn();
jest.mock('../presence-repository', () => ({
  countOtherViewers: (...a: unknown[]) => countOtherViewersMock(...a),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { TurnEventRecorder } from '../turn-event-recorder';

const TENANT = '00000000-0000-0000-0000-000000000001';
const THREAD = '00000000-0000-0000-0000-000000000002';
const TURN = '00000000-0000-0000-0000-000000000003';
const SENDER = '00000000-0000-0000-0000-000000000004';

const recorder = () => new TurnEventRecorder(TENANT, THREAD, TURN, SENDER);

/** All events written across every flush, in order. */
function written() {
  return appendTurnEventsMock.mock.calls.flatMap((c) => c[3] as Array<Record<string, unknown>>);
}

beforeEach(() => {
  jest.clearAllMocks();
  countOtherViewersMock.mockResolvedValue(1);
});

describe('agent-chat / turn-event-recorder', () => {
  // The cost control: a turn nobody is watching is the common case and must be
  // free. Presence already knows, so the recorder asks rather than guessing.
  it('writes nothing when the sender is alone on the thread', async () => {
    countOtherViewersMock.mockResolvedValue(0);
    const r = recorder();

    await r.record({ type: 'text_delta', text: 'hello ' });
    await r.record({ type: 'tool_call', tool: 'web_search' });
    await r.finish();

    expect(appendTurnEventsMock).not.toHaveBeenCalled();
  });

  it('excludes the sender when counting the audience', async () => {
    const r = recorder();
    await r.record({ type: 'thinking' });
    expect(countOtherViewersMock).toHaveBeenCalledWith(TENANT, THREAD, SENDER);
  });

  // Coalescing is the difference between a couple of writes a second and fifty.
  it('coalesces token deltas into one chunk rather than a row each', async () => {
    const r = recorder();
    for (const t of ['The ', 'payroll ', 'run ', 'is ', 'ready']) {
      await r.record({ type: 'text_delta', text: t });
    }
    await r.finish();

    const text = written().filter((e) => e.kind === 'text');
    expect(text).toHaveLength(1);
    expect(text[0].payload).toEqual({ text: 'The payroll run is ready' });
  });

  it('orders a tool call after the text that introduced it', async () => {
    const r = recorder();
    await r.record({ type: 'text_delta', text: 'Let me search. ' });
    await r.record({ type: 'tool_call', tool: 'web_search' });
    await r.record({ type: 'text_delta', text: 'Found it.' });
    await r.finish();

    const kinds = written().map((e) => e.kind);
    expect(kinds).toEqual(['text', 'tool_call', 'text', 'done']);
    // Gap-free and strictly increasing: a follower cannot tell a gap from a
    // lost event, so the producer assigns the sequence itself.
    expect(written().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('marks the turn done last, after the final text', async () => {
    const r = recorder();
    await r.record({ type: 'text_delta', text: 'done thinking' });
    await r.finish();

    const all = written();
    expect(all[all.length - 1].kind).toBe('done');
    expect(all[all.length - 2].kind).toBe('text');
  });

  // 'complete' is the sender's SSE terminator; recording it would let a
  // follower stop before the last flush of text landed.
  it('does not record the stream terminator as an event', async () => {
    const r = recorder();
    await r.record({ type: 'text_delta', text: 'hi' });
    await r.record({ type: 'complete', message: { id: 'm1' } });
    await r.finish();

    expect(written().filter((e) => e.kind === 'complete')).toHaveLength(0);
  });

  // Recording is a nicety; the turn is not.
  it('gives up quietly and never throws when writes fail', async () => {
    appendTurnEventsMock.mockRejectedValue(new Error('db down'));
    const r = recorder();

    await expect(r.record({ type: 'text_delta', text: 'x' })).resolves.toBeUndefined();
    await expect(r.finish()).resolves.toBeUndefined();
  });

  it('stops writing after a failure instead of retrying every event', async () => {
    appendTurnEventsMock.mockRejectedValueOnce(new Error('db down'));
    const r = recorder();

    // finish() forces the flush that fails; deltas alone only flush once the
    // coalescing window elapses.
    await r.record({ type: 'tool_call', tool: 'a' });
    await r.finish();
    expect(appendTurnEventsMock).toHaveBeenCalled();

    appendTurnEventsMock.mockClear();
    await r.record({ type: 'tool_call', tool: 'b' });
    await r.finish();
    expect(appendTurnEventsMock).not.toHaveBeenCalled();
  });
});

// A second viewer sees the hand-over as the sender does: the chip and the
// "Working with <name>" line arrive live, not only once the reply lands.
describe('agent-chat / turn-event-recorder / delegation_started', () => {
  it('records the hand-over with its attribution payload, after the text that introduced it', async () => {
    const r = recorder();
    await r.record({ type: 'text_delta', text: 'Let me check with the team. ' });
    await r.record({ type: 'delegation_started', author: 'agent-7', authorLabel: 'Security Review' });
    await r.finish();

    const events = written();
    expect(events.map((e) => e.kind)).toEqual(['text', 'delegation_started', 'done']);
    expect(events[1].payload).toEqual({ author: 'agent-7', authorLabel: 'Security Review' });
  });
});
