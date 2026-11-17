// A claimed browser event, verified against the runtime's record before a
// row is written or a turn run: the hold must be this thread's, of the
// claimed kind, released (a hand-back) or just made (a point), and within
// the window. The status lines and the agent-chat row's idempotency key are
// pinned beside it.

import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  ListTakeoverActivityResponseSchema,
  TakeoverHoldSchema,
  TakeoverActionSchema,
  TakeoverAction_ValueDisposition,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';

const listTakeoverActivity = jest.fn();
jest.mock('../../connectors/tenant-runtime-service-client', () => ({
  getBrowserSessionsServiceClient: jest.fn(async () => ({
    listTakeoverActivity: (...a: unknown[]) => listTakeoverActivity(...a),
  })),
}));

import {
  BROWSER_EVENT_NOT_PENDING,
  BROWSER_EVENT_WINDOW_MS,
  browserEventExternalRef,
  browserEventOf,
  browserEventStatusLine,
  handbackStatusLine,
  verifyBrowserEvent,
} from '../handback';

const NOW = new Date('2026-09-01T10:20:00Z');
const HOLD = '11111111-1111-4111-8111-111111111111';
const at = (s: string) => timestampFromDate(new Date(s));

function hold(over: Record<string, unknown> = {}) {
  return create(TakeoverHoldSchema, {
    id: HOLD, kind: 'takeover', startedAt: at('2026-09-01T10:00:00Z'), endedAt: at('2026-09-01T10:10:00Z'), endReason: 'released', live: false,
    actions: [create(TakeoverActionSchema, {
      kind: 'point', url: 'https://a.example/sports', tag: 'a', role: 'link', name: 'Sports', at: at('2026-09-01T10:10:00Z'),
      valueDisposition: TakeoverAction_ValueDisposition.NONE,
    })],
    ...over,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  listTakeoverActivity.mockResolvedValue(create(ListTakeoverActivityResponseSchema, { holds: [hold()], nextCursor: '' }));
});

describe('verifyBrowserEvent', () => {
  it('asks the runtime for exactly the named hold on this thread', async () => {
    const out = await verifyBrowserEvent('t', 'th', 'handback', HOLD, NOW);
    expect(listTakeoverActivity).toHaveBeenCalledWith({
      tenantContext: { tenantId: 't' }, threadId: 'th', limit: 1, beforeCursor: '', holdId: HOLD, newestActions: 1,
    });
    expect(out).toEqual({ kind: 'handback', holdId: HOLD });
  });

  it('refuses a hold that is not this thread\'s (the runtime returns none)', async () => {
    listTakeoverActivity.mockResolvedValue(create(ListTakeoverActivityResponseSchema, { holds: [], nextCursor: '' }));
    expect(await verifyBrowserEvent('t', 'th', 'handback', HOLD, NOW)).toBeNull();
  });

  it('refuses a hand-back whose hold was not released: still live, ended another way, or a point', async () => {
    listTakeoverActivity.mockResolvedValue(create(ListTakeoverActivityResponseSchema, { holds: [hold({ live: true, endedAt: undefined, endReason: '' })], nextCursor: '' }));
    expect(await verifyBrowserEvent('t', 'th', 'handback', HOLD, NOW)).toBeNull();
    listTakeoverActivity.mockResolvedValue(create(ListTakeoverActivityResponseSchema, { holds: [hold({ endReason: 'absent_driver' })], nextCursor: '' }));
    expect(await verifyBrowserEvent('t', 'th', 'handback', HOLD, NOW)).toBeNull();
    listTakeoverActivity.mockResolvedValue(create(ListTakeoverActivityResponseSchema, { holds: [hold({ kind: 'point' })], nextCursor: '' }));
    expect(await verifyBrowserEvent('t', 'th', 'handback', HOLD, NOW)).toBeNull();
  });

  it('refuses a hand-back older than fifteen minutes, and honours one inside the window', async () => {
    expect(BROWSER_EVENT_WINDOW_MS).toBe(15 * 60_000);
    listTakeoverActivity.mockResolvedValue(create(ListTakeoverActivityResponseSchema, { holds: [hold({ endedAt: at('2026-09-01T10:04:59Z') })], nextCursor: '' }));
    expect(await verifyBrowserEvent('t', 'th', 'handback', HOLD, NOW)).toBeNull();
    listTakeoverActivity.mockResolvedValue(create(ListTakeoverActivityResponseSchema, { holds: [hold({ endedAt: at('2026-09-01T10:05:01Z') })], nextCursor: '' }));
    expect(await verifyBrowserEvent('t', 'th', 'handback', HOLD, NOW)).not.toBeNull();
  });

});

describe('the body, the lines and the key', () => {
  it('reads the event a body names', () => {
    expect(browserEventOf({})).toBeNull();
    expect(browserEventOf({ browserHandback: { holdId: HOLD } })).toEqual({ kind: 'handback', holdId: HOLD });
    // browserPoint is gone from every client and from the body type; a body
    // that still carries one names no event rather than naming a point.
    expect(browserEventOf({ browserPoint: { holdId: HOLD } } as never)).toBeNull();
  });

  it('spells the status line once: the name and what they did', () => {
    expect(handbackStatusLine('Ada Lovelace')).toBe('Ada Lovelace handed the browser back');
    expect(browserEventStatusLine('Ada', { kind: 'handback', holdId: HOLD })).toBe('Ada handed the browser back');
    expect(BROWSER_EVENT_NOT_PENDING).toBe('handback_not_pending');
  });

  it('keys the agent-chat row on the hold', () => {
    expect(browserEventExternalRef({ kind: 'handback', holdId: HOLD })).toBe(`browser_handback:${HOLD}`);
  });
});
