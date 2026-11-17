// Stream router tests — SSE endpoint for the insights chat.
//
// Tests the router handler directly (bypassing the express stack) with
// mocked dependencies. Verifies:
//   - Request validation (400 on bad body)
//   - Auth failures (401 / 404)
//   - Thread permission (404 via getThread)
//   - Rate limit (429 with Retry-After header)
//   - SSE response headers and flushHeaders()
//   - Event forwarding from runInsightsChatTurn() to SSE frames
//   - Cleanup on success, on error, and on client disconnect

// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

import type { Request, Response } from 'express';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockRunChatTurn = jest.fn();
jest.mock('../chat-service', () => ({
  runInsightsChatTurn: (...args: unknown[]) => mockRunChatTurn(...args),
}));

const mockGetThread = jest.fn();
const mockGetCallerRole = jest.fn();
const mockAppendMessage = jest.fn();
jest.mock('../chat-repository', () => ({
  getThread: (...args: unknown[]) => mockGetThread(...args),
  getCallerRole: (...args: unknown[]) => mockGetCallerRole(...args),
  appendMessage: (...args: unknown[]) => mockAppendMessage(...args),
}));

const mockCheckRateLimit = jest.fn();
jest.mock('../rate-limiter', () => ({
  checkAndIncrementInsightsRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

// The payment gate. An assistant that can browse, read data sources and run a
// sandbox needs what running anything needs: an active plan, or a prepaid
// balance above the reload floor. Allowed by default here so these tests keep
// exercising the path under test; the refusal itself is owned by
// agent-chat/__tests__/admission.test.ts and internal-api/llm-router.test.ts.
const mockAssistantAdmission = jest.fn().mockResolvedValue({ allowed: true });
jest.mock('../../agent-chat/admission', () => ({
  checkAssistantAdmission: (...args: unknown[]) => mockAssistantAdmission(...args),
}));

const mockGetByFirebaseUid = jest.fn();
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: (...args: unknown[]) => mockGetByFirebaseUid(...args),
  })),
}));

// Mid-run control (ADR-041). The turn takes the thread lock before it streams,
// so these have to answer for every request that reaches the stream.
const mockFindActiveTurnId = jest.fn();
const mockInsertTurnSignal = jest.fn();
const mockTryAcquireTurnLock = jest.fn();
const mockReleaseTurnLock = jest.fn();
jest.mock('../turn-control', () => ({
  findActiveTurnId: (...args: unknown[]) => mockFindActiveTurnId(...args),
  insertTurnSignal: (...args: unknown[]) => mockInsertTurnSignal(...args),
  newTurnId: () => 'turn-fixed',
  releaseTurnLock: (...args: unknown[]) => mockReleaseTurnLock(...args),
  tryAcquireTurnLock: (...args: unknown[]) => mockTryAcquireTurnLock(...args),
  TurnLockUnavailableError: class TurnLockUnavailableError extends Error {},
}));

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: jest.fn() }),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

// The runtime's record, for the verification of a claimed browser event.
const mockListTakeoverActivity = jest.fn();
jest.mock('../../connectors/tenant-runtime-service-client', () => ({
  getBrowserSessionsServiceClient: jest.fn(async () => ({
    listTakeoverActivity: (...args: unknown[]) => mockListTakeoverActivity(...args),
  })),
}));

import { streamRouter, writeChatEventAsSse } from '../stream-router';
import { openChatStream, type ChatStream } from '../../common/chat-stream';
import type { ChatServiceEvent } from '../chat-service';
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  ListTakeoverActivityResponseSchema,
  TakeoverActionSchema,
  TakeoverAction_ValueDisposition,
  TakeoverHoldSchema,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';

// ── Test constants ─────────────────────────────────────────────────────

const TENANT_A = '00000000-0000-0000-0000-000000000001';
const ACCOUNT_ID = '00000000-0000-0000-0000-000000000010';
const THREAD_ID = '00000000-0000-0000-0000-000000000100';
const FIREBASE_UID = 'firebase-uid-abc';

// ── Helpers ────────────────────────────────────────────────────────────

interface RouterStackLayer {
  route?: {
    path: string;
    stack: Array<{ method: string; handle: (req: Request, res: Response) => Promise<void> }>;
  };
}

function getRouteHandler(path: string): (req: Request, res: Response) => Promise<void> {
  const stack = (streamRouter as unknown as { stack: RouterStackLayer[] }).stack;
  for (const layer of stack) {
    if (layer.route && layer.route.path === path) {
      const handlers = layer.route.stack.filter(l => l.method === 'post');
      if (handlers.length > 0) return handlers[handlers.length - 1].handle;
    }
  }
  throw new Error(`Route not found: POST ${path}`);
}

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  writtenChunks: string[];
  ended: boolean;
  flushedHeaders: boolean;
  res: Response;
}

function createMockResponse(): MockResponse {
  const state: MockResponse = {
    statusCode: 200,
    headers: {},
    writtenChunks: [],
    ended: false,
    flushedHeaders: false,
    res: {} as Response,
  };

  const resMock = {
    statusCode: 200,
    writableEnded: false,
    status: jest.fn((code: number) => {
      state.statusCode = code;
      return resMock;
    }),
    json: jest.fn((body: unknown) => {
      state.writtenChunks.push(JSON.stringify(body));
      state.ended = true;
      resMock.writableEnded = true;
      return resMock;
    }),
    setHeader: jest.fn((name: string, value: string) => {
      state.headers[name.toLowerCase()] = value;
      return resMock;
    }),
    flushHeaders: jest.fn(() => {
      state.flushedHeaders = true;
    }),
    write: jest.fn((chunk: string) => {
      state.writtenChunks.push(chunk);
      return true;
    }),
    end: jest.fn(() => {
      state.ended = true;
      resMock.writableEnded = true;
    }),
  };

  state.res = resMock as unknown as Response;
  return state;
}

function createMockRequest(body: unknown, firebaseUid: string | null = FIREBASE_UID): Request {
  const listeners: Record<string, Array<() => void>> = {};
  const resolvedUid = firebaseUid === null ? undefined : firebaseUid;
  const req = {
    body,
    ctx: { userId: resolvedUid, tenantId: TENANT_A },
    on: jest.fn((event: string, handler: () => void) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(handler);
      return req;
    }),
    off: jest.fn((event: string, handler: () => void) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(h => h !== handler);
      }
      return req;
    }),
    _listeners: listeners,
  } as unknown as Request;
  return req;
}

function streamFrom(events: ChatServiceEvent[]): AsyncIterable<ChatServiceEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

// Default happy-path mocks
beforeEach(() => {
  jest.clearAllMocks();
  mockGetByFirebaseUid.mockResolvedValue({ id: ACCOUNT_ID });
  mockGetCallerRole.mockResolvedValue('owner');
  mockGetThread.mockResolvedValue({
    id: THREAD_ID,
    tenantId: TENANT_A,
    accountId: ACCOUNT_ID,
  });
  mockCheckRateLimit.mockResolvedValue({
    allowed: true,
    remaining: { minute: 5, hour: 30, day: 100 },
  });
  mockAppendMessage.mockResolvedValue({ id: 'message-1' });
  // No turn running, and the thread lock is granted.
  mockFindActiveTurnId.mockResolvedValue(null);
  mockInsertTurnSignal.mockResolvedValue('delivered');
  mockReleaseTurnLock.mockResolvedValue(undefined);
  mockTryAcquireTurnLock.mockResolvedValue({
    tenantId: TENANT_A,
    threadId: THREAD_ID,
    turnId: 'turn-fixed',
    abortController: new AbortController(),
    heartbeatTask: null,
    consecutiveFailures: 0,
    released: false,
  });
});

// ── Validation + auth ──────────────────────────────────────────────────

describe('POST /chat-stream — validation + auth', () => {
  const handler = getRouteHandler('/chat-stream');

  it('returns 400 on missing body fields', async () => {
    const req = createMockRequest({ tenantId: TENANT_A });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(state.statusCode).toBe(400);
  });

  it('returns 400 on content exceeding 4000 chars', async () => {
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'X'.repeat(4001),
    });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(state.statusCode).toBe(400);
  });

  it('returns 401 when no firebase uid on req.ctx', async () => {
    const req = createMockRequest(
      { tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' },
      null,
    );
    const state = createMockResponse();
    await handler(req, state.res);
    expect(state.statusCode).toBe(401);
  });

  it('returns 401 when account lookup fails', async () => {
    mockGetByFirebaseUid.mockResolvedValue(null);
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'hi',
    });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(state.statusCode).toBe(401);
  });

  it('returns 404 when caller is not a tenant member', async () => {
    mockGetCallerRole.mockResolvedValue(null);
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'hi',
    });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(state.statusCode).toBe(404);
  });

  it('returns 404 when the thread does not exist or is in another workspace', async () => {
    mockGetThread.mockResolvedValue(null);
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'hi',
    });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(state.statusCode).toBe(404);
  });

  // Migration 351: a member can carry on a conversation somebody else started.
  // The thread lookup no longer takes an identity, so the only thing that could
  // turn this away is the thread being absent or in another workspace.
  it('lets a member send on a thread another account started', async () => {
    mockGetByFirebaseUid.mockResolvedValue({ id: ACCOUNT_ID });
    mockGetCallerRole.mockResolvedValue('member');
    mockGetThread.mockResolvedValue({
      id: THREAD_ID,
      tenantId: TENANT_A,
      accountId: 'some-other-account',
    });
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'picking this up',
    });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(mockGetThread).toHaveBeenCalledWith(THREAD_ID, TENANT_A);
    expect(state.statusCode).not.toBe(404);
    // Reaching the rate limiter is the proof it got past the thread gate: that
    // is the step immediately after it.
    expect(mockCheckRateLimit).toHaveBeenCalledWith(TENANT_A, ACCOUNT_ID);
  });

  it('returns 429 with Retry-After header when rate limited', async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      retryAfter: 60,
      remaining: { minute: 0, hour: 10, day: 50 },
    });
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'hi',
    });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(state.statusCode).toBe(429);
    expect(state.headers['retry-after']).toBe('60');
  });
});

// ── SSE streaming ──────────────────────────────────────────────────────

describe('POST /chat-stream — SSE streaming', () => {
  const handler = getRouteHandler('/chat-stream');

  it('sets the expected SSE headers and flushes them', async () => {
    mockRunChatTurn.mockReturnValue(
      streamFrom([
        { type: 'thinking' },
        { type: 'text_delta', text: 'Hello.' },
        {
          type: 'complete',
          message: {
            id: 'msg-1',
            threadId: THREAD_ID,
            role: 'assistant',
            content: 'Hello.',
            visualizationBlocks: null,
            inputTokens: 20,
            outputTokens: 5,
            createdAt: '2026-04-08T12:00:00Z',
          },
        },
      ]),
    );
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'hi',
    });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.headers['content-type']).toBe('text/event-stream');
    expect(state.headers['cache-control']).toBe('no-cache');
    expect(state.headers['x-accel-buffering']).toBe('no');
    expect(state.flushedHeaders).toBe(true);
    expect(state.ended).toBe(true);
  });

  it('forwards each chat-service event as the correct SSE frame', async () => {
    mockRunChatTurn.mockReturnValue(
      streamFrom([
        { type: 'thinking' },
        { type: 'tool_call', tool: 'get_agent_performance' },
        { type: 'text_delta', text: 'Reply.' },
        {
          type: 'content_block',
          block: { type: 'metric_card', label: 'X', value: '1' },
        },
        {
          type: 'complete',
          message: {
            id: 'msg-1',
            threadId: THREAD_ID,
            role: 'assistant',
            content: 'Reply.',
            visualizationBlocks: null,
            inputTokens: 20,
            outputTokens: 5,
            createdAt: '2026-04-08T12:00:00Z',
          },
        },
      ]),
    );
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'hi',
    });
    const state = createMockResponse();

    await handler(req, state.res);

    const allOutput = state.writtenChunks.join('');
    expect(allOutput).toContain('event: thinking');
    expect(allOutput).toContain('event: tool_call');
    expect(allOutput).toContain('"tool":"get_agent_performance"');
    expect(allOutput).toContain('event: text_delta');
    expect(allOutput).toContain('"text":"Reply."');
    expect(allOutput).toContain('event: content_block');
    expect(allOutput).toContain('"type":"metric_card"');
    expect(allOutput).toContain('event: complete');
  });

  it('emits an error SSE frame when the chat service iterator throws', async () => {
    mockRunChatTurn.mockImplementation(() => {
      // Return an iterator that throws on first iteration
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'thinking' } as ChatServiceEvent;
          throw new Error('provider boom');
        },
      };
    });
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'hi',
    });
    const state = createMockResponse();

    await handler(req, state.res);

    const output = state.writtenChunks.join('');
    expect(output).toContain('event: thinking');
    expect(output).toContain('event: error');
    expect(output).toContain('"code":"INTERNAL"');
    expect(state.ended).toBe(true);
  });

  it('passes tenantId, accountId, role, the caller\'s name and userMessage to runInsightsChatTurn', async () => {
    // The name is what a hand-over forwards as the sender to whichever
    // colleague answers; without it a colleague brought in from here
    // answered "A teammate".
    mockGetByFirebaseUid.mockResolvedValue({ id: ACCOUNT_ID, firstName: 'Dana', lastName: 'Reyes', email: 'dana@example.com' });
    mockRunChatTurn.mockReturnValue(
      streamFrom([
        {
          type: 'complete',
          message: {
            id: 'msg-1',
            threadId: THREAD_ID,
            role: 'assistant',
            content: '',
            visualizationBlocks: null,
            inputTokens: 10,
            outputTokens: 1,
            createdAt: '2026-04-08T12:00:00Z',
          },
        },
      ]),
    );
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'What is my cost?',
    });
    const state = createMockResponse();
    await handler(req, state.res);

    expect(mockRunChatTurn).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      tenantId: TENANT_A,
      accountId: ACCOUNT_ID,
      role: 'owner',
      userMessage: 'What is my cost?',
      callerName: 'Dana Reyes',
      // Empty rather than absent: the router always sanitizes the field, and a
      // request that carried no files reaches the turn as an empty list.
      attachments: [],
      // The turn carries its own id and the lock's controller, so it can be
      // stopped and steered while it runs (ADR-041).
      turnId: 'turn-fixed',
      abortController: expect.any(AbortController),
      // When the reply must be on its way: the stream's cutoff less the
      // closing reserve, so the turn closes inside the stream's lifetime.
      deadlineAt: expect.any(Number),
    });
  });
});

// ── writeChatEventAsSse (unit helper) ──────────────────────────────────

// ── The terminal frame, on the wire, for every shape of this stream ────
//
// "Confirm a `done` frame closes every stream shape by reading the raw SSE body"
// could be a manual check, but it is a property of the router, so it is asserted
// here instead: a manual check confirms today and guards nothing tomorrow.
//
// `done` is the ONLY thing that distinguishes a finished stream from a socket
// that died mid-turn — the client (Liftoff-React services/chatSse.ts) reports its
// absence at EOF as STREAM_TRUNCATED. The interrupt acknowledgment is the shape
// most at risk: `interrupt_delivered` is not terminal to the client, so an exit
// that ends the socket above the `try` whose `finally` writes the frame makes
// steering a running turn raise "The connection dropped before the reply
// finished arriving." every time, on a message that HAD been delivered.
//
// This surface has no greeting: an Insights thread always exists before a turn.

describe('POST /chat-stream — every shape ends with exactly one done frame', () => {
  const handler = getRouteHandler('/chat-stream');
  const DONE = 'event: done\ndata: {}\n\n';

  const doneFrames = (body: string): number => body.split(DONE).length - 1;

  it('the interrupt acknowledgment — THE DEFECT', async () => {
    mockFindActiveTurnId.mockResolvedValue('turn-live');
    const req = createMockRequest({
      tenantId: TENANT_A, threadId: THREAD_ID, content: 'break it down by team',
    });
    const state = createMockResponse();

    await handler(req, state.res);

    const body = state.writtenChunks.join('');
    expect(body).toBe('event: interrupt_delivered\ndata: {}\n\n' + DONE);
    expect(doneFrames(body)).toBe(1);
  });

  it('a normal turn', async () => {
    mockRunChatTurn.mockReturnValue(streamFrom([{ type: 'thinking' }]));
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    const body = state.writtenChunks.join('');
    expect(doneFrames(body)).toBe(1);
    expect(body.endsWith(DONE)).toBe(true);
  });

  it('a turn whose iterator threw', async () => {
    mockRunChatTurn.mockReturnValue((async function* () {
      yield { type: 'thinking' } as ChatServiceEvent;
      throw new Error('provider exploded');
    })());
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    const body = state.writtenChunks.join('');
    expect(body).toContain('"code":"INTERNAL"');
    expect(doneFrames(body)).toBe(1);
    expect(body.endsWith(DONE)).toBe(true);
  });
});

describe('POST /chat-stream — mid-run control (ADR-041)', () => {
  const handler = getRouteHandler('/chat-stream');

  it('delivers a message typed mid-stream into the running turn and starts no second turn', async () => {
    mockFindActiveTurnId.mockResolvedValue('turn-live');
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'break it down by team',
    });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(mockInsertTurnSignal).toHaveBeenCalledWith(
      TENANT_A,
      'turn-live',
      'user_message',
      expect.objectContaining({ text: 'break it down by team', senderAccountId: ACCOUNT_ID }),
    );
    // Acknowledged as an SSE frame, so every chat surface keeps one client path.
    expect(state.writtenChunks.join('')).toContain('event: interrupt_delivered');
    // The message the person watched being accepted is in the transcript too,
    // with the caller the request authenticated as as its sender (migration 492).
    expect(mockAppendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'break it down by team', senderAccountId: ACCOUNT_ID }),
    );
    expect(mockRunChatTurn).not.toHaveBeenCalled();
    expect(mockTryAcquireTurnLock).not.toHaveBeenCalled();
  });

  it('starts a normal turn when the run ended in the moment before delivery', async () => {
    // The foreign key rejected the signal because the turn had just finished.
    // The person meant to say something, so answer it rather than telling them
    // to wait for a turn that is already over.
    mockFindActiveTurnId.mockResolvedValue('turn-live');
    mockInsertTurnSignal.mockResolvedValue('no_turn');
    mockRunChatTurn.mockReturnValue(streamFrom([{ type: 'text_delta', text: 'Sure.' }]));
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'break it down by team',
    });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(mockRunChatTurn).toHaveBeenCalled();
    expect(state.writtenChunks.join('')).toContain('event: text_delta');
    // The turn that answers it persists it; the interrupt path must not have.
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('still 409s when a concurrent turn genuinely holds the thread', async () => {
    mockFindActiveTurnId.mockResolvedValue('turn-live');
    mockInsertTurnSignal.mockResolvedValue('unavailable');
    mockTryAcquireTurnLock.mockResolvedValue(null);
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'break it down by team',
    });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.statusCode).toBe(409);
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });

  it('answers 409 when the lock is held and there was nothing to deliver into', async () => {
    mockTryAcquireTurnLock.mockResolvedValue(null);
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.statusCode).toBe(409);
    expect(mockRunChatTurn).not.toHaveBeenCalled();
  });

  it('answers 503 rather than a dead stream when the lock store is unreachable', async () => {
     
    const { TurnLockUnavailableError } = jest.requireMock('../turn-control') as {
      TurnLockUnavailableError: new (m: string) => Error;
    };
    mockTryAcquireTurnLock.mockRejectedValue(new TurnLockUnavailableError('connection terminated'));
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.statusCode).toBe(503);
  });

  it('releases the lock when the turn ends', async () => {
    mockRunChatTurn.mockReturnValue(streamFrom([{ type: 'text_delta', text: 'Hello.' }]));
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(mockReleaseTurnLock).toHaveBeenCalled();
  });
});

// ── The person's browser events ────────────────────────────────────────

describe("POST /chat-stream — the person's browser events", () => {
  const handler = getRouteHandler('/chat-stream');
  const HOLD = '00000000-0000-4000-8000-000000000777';
  const recent = () => new Date(Date.now() - 60_000);
  const releasedHold = (over: Record<string, unknown> = {}) => create(TakeoverHoldSchema, {
    id: HOLD, kind: 'takeover', startedAt: timestampFromDate(new Date(Date.now() - 120_000)), endedAt: timestampFromDate(recent()), endReason: 'released', live: false,
    ...over,
  });
  const runtimeAnswers = (holds: unknown[]) => {
    mockListTakeoverActivity.mockResolvedValue(create(ListTakeoverActivityResponseSchema, { holds: holds as never, nextCursor: '' }));
  };
  const complete: ChatServiceEvent = { type: 'complete', message: { id: 'm', threadId: THREAD_ID, role: 'assistant', content: 'ok', createdAt: '2026-09-01T00:00:00Z' } as never };

  beforeEach(() => {
    mockGetByFirebaseUid.mockResolvedValue({ id: ACCOUNT_ID, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' });
    runtimeAnswers([releasedHold()]);
    mockRunChatTurn.mockReturnValue((async function* () { yield complete; })());
  });

  it('accepts a hand-back alone: verifies the hold, writes the status row, runs the turn with no words', async () => {
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, browserHandback: { holdId: HOLD } });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(mockListTakeoverActivity).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD_ID, holdId: HOLD }));
    expect(mockAppendMessage).toHaveBeenCalledWith({
      threadId: THREAD_ID, role: 'assistant', content: 'Ada Lovelace handed the browser back', messageType: 'browser_handback',
    });
    expect(mockRunChatTurn).toHaveBeenCalledWith(expect.objectContaining({ userMessage: '', browserEvent: { kind: 'handback', holdId: HOLD } }));
    expect(state.headers['content-type']).toBe('text/event-stream');
  });

  it('accepts a hand-back beside the words sent while driving', async () => {
    const state = createMockResponse();
    await handler(createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'summarise', browserHandback: { holdId: HOLD } }), state.res);
    expect(mockRunChatTurn).toHaveBeenCalledWith(expect.objectContaining({ userMessage: 'summarise', browserEvent: { kind: 'handback', holdId: HOLD } }));
  });

  it("refuses with 409 and writes nothing when the hold is not this thread's, not released, or older than fifteen minutes", async () => {
    for (const holds of [
      [],
      [releasedHold({ endReason: 'expired' })],
      [releasedHold({ endedAt: timestampFromDate(new Date(Date.now() - 16 * 60_000)) })],
    ]) {
      mockAppendMessage.mockClear();
      mockRunChatTurn.mockClear();
      runtimeAnswers(holds);
      const state = createMockResponse();
      await handler(createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, browserHandback: { holdId: HOLD } }), state.res);
      expect(state.statusCode).toBe(409);
      expect(state.writtenChunks.join('')).toContain('handback_not_pending');
      expect(mockAppendMessage).not.toHaveBeenCalled();
      expect(mockRunChatTurn).not.toHaveBeenCalled();
    }
  });

});

// The event-to-frame mapping is asserted through the REAL ChatStream rather than
// a stand-in for it, so these assertions pin the bytes production writes. The
// wrapper is also the thing that now guarantees the stream cannot be closed
// without its terminal frame (src/common/chat-stream.ts).
function collectingStream(): { stream: ChatStream; frames: string[] } {
  const frames: string[] = [];
  const res = {
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      frames.push(chunk);
      return true;
    },
    end: () => undefined,
    writableEnded: false,
    destroyed: false,
  } as unknown as Response;
  return { stream: openChatStream(res), frames };
}

describe('writeChatEventAsSse', () => {
  it('writes the expected frame shape for each event type', () => {
    const { stream, frames: writes } = collectingStream();

    writeChatEventAsSse(stream, { type: 'thinking' });
    writeChatEventAsSse(stream, { type: 'tool_call', tool: 'get_cost_breakdown' });
    writeChatEventAsSse(stream, { type: 'text_delta', text: 'Hello' });
    writeChatEventAsSse(stream, {
      type: 'content_block',
      block: { type: 'metric_card', label: 'X', value: '1' },
    });
    writeChatEventAsSse(stream, { type: 'delegation_started', author: 'caio', authorLabel: 'Chief AI Officer' });
    writeChatEventAsSse(stream, {
      type: 'delegation_paused',
      author: 'caio',
      authorLabel: 'Chief AI Officer',
      delegateThreadId: 'tp-1',
      reason: 'Chief AI Officer is waiting on an approval before it can continue.',
      message: null,
    });
    writeChatEventAsSse(stream, {
      type: 'error',
      code: 'PROVIDER_ERROR',
      message: 'boom',
    });

    const all = writes.join('');
    // The two hand-over frames carry Liftoff's payloads, so one client reads
    // both surfaces.
    expect(all).toContain('event: delegation_started\ndata: {"author":"caio","authorLabel":"Chief AI Officer"}\n\n');
    expect(all).toContain(
      'event: delegation_paused\ndata: {"author":"caio","authorLabel":"Chief AI Officer","delegateThreadId":"tp-1",'
      + '"reason":"Chief AI Officer is waiting on an approval before it can continue.","message":null}\n\n',
    );
    expect(all).toContain('event: thinking\n');
    expect(all).toContain('event: tool_call\n');
    expect(all).toContain('"tool":"get_cost_breakdown"');
    expect(all).toContain('event: text_delta\n');
    expect(all).toContain('"text":"Hello"');
    expect(all).toContain('event: content_block\n');
    expect(all).toContain('"type":"metric_card"');
    expect(all).toContain('event: error\n');
    expect(all).toContain('"code":"PROVIDER_ERROR"');
  });
});
