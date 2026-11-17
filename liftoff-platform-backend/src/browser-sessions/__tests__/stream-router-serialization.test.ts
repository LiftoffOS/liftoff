/**
 * The SSE stream can actually write the events it carries.
 *
 * It could not. The Connect client returns protobuf-es MESSAGES, and a
 * `google.protobuf.Timestamp` holds its seconds as a `bigint` — which
 * `JSON.stringify` refuses. The router passed `event.session` and
 * `event.emittedAt` straight in, so the FIRST session event threw, straight
 * out of the `for await` and into the catch that ends the stream.
 *
 * Every browser-session stream therefore died on its first event, and it was
 * invisible: the pane has a 90-second refetch backstop, so live updates simply
 * never arrived and the product looked slow rather than broken. The only
 * signal was `browser session stream failed` in the log — 62 times a day on
 * dev, naming neither the event nor the reason.
 *
 * The sibling REST router had already learned this exact lesson and said so in
 * a comment naming the same error string; it serializes with `toJson`. One of
 * the two routers carrying this message knew, and the other did not.
 */
import type { Request, Response } from 'express';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  BrowserSessionSchema,
  StreamSessionEventsResponse_Type,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';

const resolveCallerMock = jest.fn();
const getAgentThreadMock = jest.fn();
const streamSessionEventsMock = jest.fn();
const logErrorMock = jest.fn();

jest.mock('../../auth/resolve-caller', () => ({
  resolveCaller: (...a: unknown[]) => resolveCallerMock(...a),
}));
jest.mock('../../agent-chat/chat-repository', () => ({
  getThread: (...a: unknown[]) => getAgentThreadMock(...a),
}));
jest.mock('../../liftoff/chat-repository', () => ({ getThread: jest.fn().mockResolvedValue(null) }));
jest.mock('../../insights/chat-repository', () => ({ getThread: jest.fn().mockResolvedValue(null) }));
jest.mock('../../workforce-plans/team-plan-thread-client', () => ({
  teamPlanThreadExists: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../connectors/tenant-runtime-service-client', () => ({
  getBrowserSessionsServiceClient: jest.fn().mockResolvedValue({
    streamSessionEvents: (...a: unknown[]) => streamSessionEventsMock(...a),
  }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: (...a: unknown[]) => logErrorMock(...a) },
}));

import { browserSessionsStreamRouter } from '../stream-router';

const TENANT = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';

function handler() {
  const layer = (browserSessionsStreamRouter.stack as Array<{
    route?: { path: string; stack: Array<{ handle: unknown }> };
  }>).find((l) => l.route?.path === '/threads/:threadId/browser-sessions/stream');
  const route = layer!.route!;
  return route.stack[route.stack.length - 1].handle as (req: Request, res: Response) => Promise<void>;
}

function mockRes() {
  const res = {
    status: jest.fn(), end: jest.fn(), setHeader: jest.fn(), flushHeaders: jest.fn(),
    write: jest.fn(), writableEnded: false,
  };
  res.status.mockReturnValue(res);
  res.end.mockImplementation(() => { res.writableEnded = true; return res; });
  return res as unknown as Response & typeof res;
}

const req = () => ({
  params: { threadId: THREAD },
  query: { tenantId: TENANT },
  ctx: { userId: 'user-1' },
  on: jest.fn(), off: jest.fn(),
} as unknown as Request);

/** A session as the wire really delivers one: timestamps present, and so
 *  bigint seconds inside. Built through the schema rather than hand-written,
 *  so it cannot drift into a shape the real client never produces. */
function realSession() {
  return create(BrowserSessionSchema, {
    id: '33333333-3333-4333-8333-333333333333',
    createdAt: timestampFromDate(new Date('2026-09-23T06:00:00Z')),
    lastUsedAt: timestampFromDate(new Date('2026-09-23T06:05:00Z')),
  });
}

async function* oneRealEvent() {
  yield {
    type: StreamSessionEventsResponse_Type.SESSION_UPDATED,
    session: realSession(),
    emittedAt: timestampFromDate(new Date('2026-09-23T06:05:00Z')),
  };
}

const writes = (res: { write: jest.Mock }) => res.write.mock.calls.map((c) => String(c[0])).join('');

beforeEach(() => {
  jest.clearAllMocks();
  resolveCallerMock.mockResolvedValue({ ok: true, caller: { accountId: 'acc-1', tenantId: TENANT, role: 'admin' } });
  getAgentThreadMock.mockResolvedValue({ id: THREAD });
});

describe('an event carrying protobuf timestamps', () => {
  it('reaches the client instead of killing the stream', async () => {
    streamSessionEventsMock.mockReturnValue(oneRealEvent());
    const res = mockRes();

    await handler()(req(), res);

    const out = writes(res);
    expect(out).toContain('event: SESSION_UPDATED');
    // The failure this replaces wrote NOTHING but an error frame.
    expect(out).not.toContain('event: error');
    expect(logErrorMock).not.toHaveBeenCalled();
  });

  it('writes timestamps as RFC3339 strings, never a BigInt', async () => {
    streamSessionEventsMock.mockReturnValue(oneRealEvent());
    const res = mockRes();

    await handler()(req(), res);

    const line = writes(res).split('\n').find((l) => l.startsWith('data: '))!;
    const payload = JSON.parse(line.slice(6));
    expect(payload.emittedAt).toBe('2026-09-23T06:05:00Z');
    expect(payload.session.createdAt).toBe('2026-09-23T06:00:00Z');
    // Proto-JSON, the same shape the REST router serializes to.
    expect(payload.session.id).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('is what the frontend keys on: the event NAME survives', async () => {
    // The pane's hook reads the event name and refetches; it never parses the
    // payload. So the name is the contract, and it is what the BigInt throw
    // was destroying.
    streamSessionEventsMock.mockReturnValue(oneRealEvent());
    const res = mockRes();
    await handler()(req(), res);
    expect(writes(res)).toMatch(/event: SESSION_UPDATED\n/);
  });
});

describe('a frame that still cannot be serialized', () => {
  it('is dropped, and the stream carries the next one', async () => {
    // Defence in depth: one unserializable frame used to cost every
    // SUBSEQUENT event, because the throw unwound into the catch that ends the
    // stream. A live-update stream that dies silently is worse than one that
    // skips a frame.
    async function* mixed() {
      yield {
        type: StreamSessionEventsResponse_Type.SESSION_UPDATED,
        // A value no serializer can take, standing in for whatever the next
        // unconvertible field turns out to be.
        session: { toJSON() { throw new Error('nope'); } } as never,
        emittedAt: undefined,
      };
      yield {
        type: StreamSessionEventsResponse_Type.SESSION_CLOSED,
        session: realSession(),
        emittedAt: timestampFromDate(new Date('2026-09-23T06:06:00Z')),
      };
    }
    streamSessionEventsMock.mockReturnValue(mixed());
    const res = mockRes();

    await handler()(req(), res);

    const out = writes(res);
    expect(out).not.toContain('event: SESSION_UPDATED');   // the bad frame
    expect(out).toContain('event: SESSION_CLOSED');        // the next one
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'SESSION_UPDATED' }),
      expect.stringContaining('could not serialize'),
    );
  });
});

describe('the binary shape is real', () => {
  it('the fixture is a session the wire could actually deliver', () => {
    // Guards the test itself: if BrowserSessionSchema stops accepting these
    // fields this fails here rather than silently testing a fiction.
    expect(() => toBinary(BrowserSessionSchema, realSession())).not.toThrow();
  });
});
