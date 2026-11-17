// The runtime's browser record, read for every host: the activity stream's
// paging and its Unimplemented fallback, the redaction that upgrades a flag
// rather than silently changing a string, the disposition normalisation for
// an older runtime, and the one-shot takeover read under its budget.

import { Code, ConnectError } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  ListTakeoverActivityResponseSchema,
  ListBrowserActivityResponseSchema,
  BrowserActivityRowSchema,
  BrowserTaskStepSchema,
  TakeoverHoldSchema,
  TakeoverActionSchema,
  TakeoverAction_ValueDisposition,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const listTakeoverActivity = jest.fn();
const listBrowserActivity = jest.fn();
jest.mock('../../connectors/tenant-runtime-service-client', () => ({
  getBrowserSessionsServiceClient: jest.fn(async () => ({
    listTakeoverActivity: (...a: unknown[]) => listTakeoverActivity(...a),
    listBrowserActivity: (...a: unknown[]) => listBrowserActivity(...a),
  })),
}));

import type { RecordedCall, RecordedSegment } from '@liftoffos/browser-record';
import {
  activityStream, holdStream, readTakeoverActivity, takeoverActionOut, takeoverRowOut, valueDispositionOut, runtimeRowOut,
  TAKEOVER_CHAR_BUDGET, type AssistantActivityOut, type TakeoverActivityOut,
} from '../takeover-activity';

// The rows this module returns are what the one prose renderer takes. A field
// added on one side and not the other fails here, at compile time, rather than
// in a renderer at run time.
({} as TakeoverActivityOut) satisfies RecordedSegment;
({} as AssistantActivityOut) satisfies RecordedCall;

const KEY = 'sk-ant-api03-' + 'A'.repeat(40);
const at = (s: string) => timestampFromDate(new Date(s));

function row(id: string, createdAt: string, over: Record<string, unknown> = {}) {
  return create(BrowserActivityRowSchema, {
    id, tool: 'run_browser_task', instruction: 'open the portal', outcome: 'opened', hasSteps: false, createdAt: at(createdAt), ...over,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  listTakeoverActivity.mockResolvedValue(create(ListTakeoverActivityResponseSchema, { holds: [], nextCursor: '' }));
  listBrowserActivity.mockResolvedValue(create(ListBrowserActivityResponseSchema, { rows: [], nextCursor: '' }));
});

describe('activityStream', () => {
  it('pages the runtime in pages of 50, newest first, following the cursor only when asked', async () => {
    listBrowserActivity
      .mockResolvedValueOnce(create(ListBrowserActivityResponseSchema, { rows: [row('a2', '2026-09-01T00:00:02Z'), row('a1', '2026-09-01T00:00:01Z')], nextCursor: 'older' }))
      .mockResolvedValueOnce(create(ListBrowserActivityResponseSchema, { rows: [row('a0', '2026-09-01T00:00:00Z')], nextCursor: '' }));
    const stream = activityStream('t', 'th');
    expect((await stream.peek())!.row.id).toBe('a2');
    expect(listBrowserActivity).toHaveBeenCalledTimes(1);
    expect(listBrowserActivity).toHaveBeenCalledWith({ tenantContext: { tenantId: 't' }, threadId: 'th', limit: 50, beforeCursor: '' });
    expect((await stream.pop())!.row.id).toBe('a2');
    expect((await stream.pop())!.row.id).toBe('a1');
    expect(stream.hasMore()).toBe(true);
    expect((await stream.pop())!.row.id).toBe('a0');
    expect(listBrowserActivity).toHaveBeenLastCalledWith(expect.objectContaining({ beforeCursor: 'older' }));
    expect(await stream.pop()).toBeNull();
    expect(stream.hasMore()).toBe(false);
  });

  it('reads an older runtime without the RPC as no rows', async () => {
    listBrowserActivity.mockRejectedValue(new ConnectError('unimplemented', Code.Unimplemented));
    const stream = activityStream('t', 'th');
    expect(await stream.peek()).toBeNull();
    expect(stream.hasMore()).toBe(false);
  });

  it('rethrows any other runtime failure', async () => {
    listBrowserActivity.mockRejectedValue(new ConnectError('down', Code.Unavailable));
    await expect(activityStream('t', 'th').peek()).rejects.toMatchObject({ code: Code.Unavailable });
  });

  it('hasId fetches back to the window and answers whether the runtime carries the id', async () => {
    listBrowserActivity
      .mockResolvedValueOnce(create(ListBrowserActivityResponseSchema, { rows: [row('a2', '2026-09-01T01:00:00Z')], nextCursor: 'p2' }))
      .mockResolvedValueOnce(create(ListBrowserActivityResponseSchema, { rows: [row('a1', '2026-09-01T00:30:00Z')], nextCursor: 'p3' }))
      .mockResolvedValueOnce(create(ListBrowserActivityResponseSchema, { rows: [row('a0', '2026-09-01T00:00:00Z')], nextCursor: '' }));
    const stream = activityStream('t', 'th');
    expect(await stream.hasId('a1', new Date('2026-09-01T00:25:00Z'))).toBe(true);
    expect(listBrowserActivity).toHaveBeenCalledTimes(2);
    // Everything down to 00:35 is already fetched: no further page.
    expect(await stream.hasId('nope', new Date('2026-09-01T00:35:00Z'))).toBe(false);
    expect(listBrowserActivity).toHaveBeenCalledTimes(2);
    // A window that reaches further back fetches the rest.
    expect(await stream.hasId('nope', new Date('2025-01-01T00:00:00Z'))).toBe(false);
    expect(listBrowserActivity).toHaveBeenCalledTimes(3);
    // Nothing popped was lost to the lookahead.
    expect((await stream.pop())!.row.id).toBe('a2');
  });
});

describe('redaction upgrades the flag rather than silently changing the string', () => {
  it('runtimeRowOut: an instruction, outcome, step action or page URL the redactor changed is marked', () => {
    const out = runtimeRowOut(row('a', '2026-09-01T00:00:00Z', {
      instruction: `use ${KEY}`, outcome: 'fine', hasSteps: true,
      steps: [create(BrowserTaskStepSchema, { type: 'act', action: `type ${KEY}`, pageUrl: `https://a.example/?k=${KEY}`, at: at('2026-09-01T00:00:01Z') })],
      captureGap: true, gapReason: 'cap', stepsTruncated: true,
    }), new Date('2026-09-01T00:00:00Z'));
    expect(out.instruction).toBe('use [REDACTED]');
    expect(out).toMatchObject({ instructionProtectedDataOmitted: true, outcomeProtectedDataOmitted: false, captureGap: true, gapReason: 'cap', stepsTruncated: true });
    expect(out.steps![0]).toMatchObject({ action: 'type [REDACTED]', protectedDataOmitted: true, protectedKind: 'sensitive_text', pageUrlProtectedDataOmitted: true, at: '2026-09-01T00:00:01.000Z' });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it('takeoverActionOut: a recorded value the redactor would alter goes whole as sensitive_text_omitted; a clean one is kept', () => {
    const dropped = takeoverActionOut(create(TakeoverActionSchema, {
      kind: 'change', url: 'https://a.example/', name: 'Notes', value: `token ${KEY}`,
      valueDisposition: TakeoverAction_ValueDisposition.RECORDED, valueTruncated: true, at: at('2026-09-01T00:00:00Z'),
    }));
    expect(dropped).toMatchObject({ value: '', valueDisposition: 'sensitive_text_omitted', valueTruncated: false });
    const kept = takeoverActionOut(create(TakeoverActionSchema, {
      kind: 'change', url: 'https://a.example/', name: 'Search', value: 'browser', valueDisposition: TakeoverAction_ValueDisposition.RECORDED, at: at('2026-09-01T00:00:00Z'),
    }));
    expect(kept).toMatchObject({ value: 'browser', valueDisposition: 'recorded' });
    const omitted = takeoverActionOut(create(TakeoverActionSchema, {
      kind: 'enter', url: 'https://a.example/', name: 'Password', value: '', valueDisposition: TakeoverAction_ValueDisposition.PAYMENT_OMITTED, at: at('2026-09-01T00:00:00Z'),
    }));
    expect(omitted).toMatchObject({ value: '', valueDisposition: 'payment_omitted' });
  });

  it('takeoverActionOut: a card number or identity number typed into an ordinary field goes whole as sensitive_text_omitted', () => {
    for (const value of ['4111 1111 1111 1111', '123-45-6789', 'see https://a.example/reset?token=abc123']) {
      const out = takeoverActionOut(create(TakeoverActionSchema, {
        kind: 'change', url: 'https://a.example/', name: 'Notes', value, valueDisposition: TakeoverAction_ValueDisposition.RECORDED, at: at('2026-09-01T00:00:00Z'),
      }));
      expect(out).toMatchObject({ value: '', valueDisposition: 'sensitive_text_omitted' });
    }
    // An ordinary long number that is not a card, and an ordinary address, stay.
    const kept = takeoverActionOut(create(TakeoverActionSchema, {
      kind: 'change', url: 'https://a.example/', name: 'Order', value: 'order 1234567890123, 12 Rue de la Paix', valueDisposition: TakeoverAction_ValueDisposition.RECORDED, at: at('2026-09-01T00:00:00Z'),
    }));
    expect(kept).toMatchObject({ value: 'order 1234567890123, 12 Rue de la Paix', valueDisposition: 'recorded' });
  });

  it('valueDispositionOut normalises UNSPECIFIED from an older runtime by the action kind', () => {
    expect(valueDispositionOut({ kind: 'change', valueDisposition: TakeoverAction_ValueDisposition.UNSPECIFIED })).toBe('legacy_unavailable');
    expect(valueDispositionOut({ kind: 'enter', valueDisposition: TakeoverAction_ValueDisposition.UNSPECIFIED })).toBe('legacy_unavailable');
    expect(valueDispositionOut({ kind: 'click', valueDisposition: TakeoverAction_ValueDisposition.UNSPECIFIED })).toBe('none');
    expect(valueDispositionOut({ kind: 'change', valueDisposition: TakeoverAction_ValueDisposition.LEGACY_UNAVAILABLE })).toBe('legacy_unavailable');
    expect(valueDispositionOut({ kind: 'change', valueDisposition: TakeoverAction_ValueDisposition.FILE_OMITTED })).toBe('file_omitted');
  });
});

describe('readTakeoverActivity', () => {
  const hold = (startedAt: string, n: number) => create(TakeoverHoldSchema, {
    startedAt: at(startedAt), endedAt: at(startedAt), endReason: 'released',
    actions: Array.from({ length: n }, (_, i) => create(TakeoverActionSchema, {
      kind: 'click', url: 'https://a.example/', tag: 'button', role: 'button', name: `Control ${i}`, at: at(startedAt),
      valueDisposition: TakeoverAction_ValueDisposition.NONE,
    })),
  });

  it('returns the holds oldest first, redacted, with truncated false when everything fit', async () => {
    listTakeoverActivity.mockResolvedValueOnce(create(ListTakeoverActivityResponseSchema, {
      holds: [hold('2026-09-01T00:02:00Z', 2), hold('2026-09-01T00:01:00Z', 1)], nextCursor: '',
    }));
    const out = await readTakeoverActivity('t', 'th');
    expect(out.truncated).toBe(false);
    expect(out.takeovers.map((h) => h.startedAt)).toEqual(['2026-09-01T00:01:00.000Z', '2026-09-01T00:02:00.000Z']);
    expect(out.takeovers[1].steps).toHaveLength(2);
    expect(out.takeovers[0]).toMatchObject({ tool: 'person_takeover', personTookOver: true, live: false, captureGap: false });
  });

  it('keeps the newest holds and the newest steps under the budget, and says so', async () => {
    listTakeoverActivity.mockResolvedValueOnce(create(ListTakeoverActivityResponseSchema, {
      holds: [hold('2026-09-01T00:02:00Z', 200), hold('2026-09-01T00:01:00Z', 200)], nextCursor: '',
    }));
    const out = await readTakeoverActivity('t', 'th', 12_000);
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out.takeovers).length).toBeLessThanOrEqual(12_000);
    const newest = out.takeovers[out.takeovers.length - 1];
    expect(newest.startedAt).toBe('2026-09-01T00:02:00.000Z');
    expect(newest.steps[newest.steps.length - 1].name).toBe('Control 199');
    expect(TAKEOVER_CHAR_BUDGET).toBe(20_000);
  });

  it('reads Unimplemented as no holds', async () => {
    listTakeoverActivity.mockRejectedValue(new ConnectError('unimplemented', Code.Unimplemented));
    expect(await readTakeoverActivity('t', 'th')).toEqual({ takeovers: [], truncated: false });
  });

  it('a row carries the hold kind, and the actions the runtime left out are missing steps', async () => {
    const point = create(TakeoverHoldSchema, {
      ...hold('2026-09-01T00:03:00Z', 1), kind: 'point', id: 'h-point',
    });
    const cut = create(TakeoverHoldSchema, { ...hold('2026-09-01T00:02:00Z', 3), actionsOmitted: 7, id: 'h-cut' });
    const plain = takeoverRowOut({ hold: hold('2026-09-01T00:01:00Z', 1), startedAt: new Date('2026-09-01T00:01:00Z'), order: 0 });
    expect(plain.kind).toBe('takeover');
    expect(plain.stepsTruncated).toBeUndefined();
    expect(takeoverRowOut({ hold: point, startedAt: new Date('2026-09-01T00:03:00Z'), order: 1 }).kind).toBe('point');
    expect(takeoverRowOut({ hold: cut, startedAt: new Date('2026-09-01T00:02:00Z'), order: 2 }).stepsTruncated).toBe(true);
  });

  it('holdStream asks the runtime for the newest N actions per hold when told to', async () => {
    listTakeoverActivity.mockResolvedValueOnce(create(ListTakeoverActivityResponseSchema, { holds: [hold('2026-09-01T00:02:00Z', 1)], nextCursor: '' }));
    await holdStream('t', 'th', { newestActions: 20 }).pop();
    expect(listTakeoverActivity).toHaveBeenCalledWith({ tenantContext: { tenantId: 't' }, threadId: 'th', limit: 5, beforeCursor: '', newestActions: 20 });
    listTakeoverActivity.mockResolvedValueOnce(create(ListTakeoverActivityResponseSchema, { holds: [], nextCursor: '' }));
    await holdStream('t', 'th').pop();
    expect(listTakeoverActivity).toHaveBeenLastCalledWith({ tenantContext: { tenantId: 't' }, threadId: 'th', limit: 5, beforeCursor: '' });
  });
});
