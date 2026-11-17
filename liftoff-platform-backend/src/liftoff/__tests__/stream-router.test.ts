// Stream router tests: the SSE endpoint for the Liftoff chat.
//
// Tests the router handler directly (bypassing the express stack) with
// mocked dependencies. Verifies:
//   - Request validation (400 on a bad body)
//   - Auth failures (401 / 404)
//   - Thread permission (404 via getThread)
//   - Rate limit (429 with a Retry-After header)
//   - SSE response headers and flushHeaders()
//   - Event forwarding from runLiftoffChatTurn() to SSE frames, and that
//     content_block is never among them
//   - The interrupt path, lock contention (409) and an unreachable lock store (503)
//   - Heartbeats, the hard duration cap, and cleanup on success, on error, and
//     on client disconnect
//
// Attachments are the one thing this suite leaves alone: they are the deviation
// from the insights chat and get their own file, stream-router.attachments.test.ts.

import type { Request, Response } from 'express';

// ── Mocks ──────────────────────────────────────────────────────────────

// The chat service is stubbed for its turn function only. The rest of the
// module is real, because the stream router builds its Zod schema out of that
// module's attachment caps at import time, and a hand-copied number here would
// drift from the one the route actually enforces.
const mockRunChatTurn = jest.fn();
jest.mock('../chat-service', () => {
  const actual = jest.requireActual('../chat-service');
  return {
    ...actual,
    runLiftoffChatTurn: (...args: unknown[]) => mockRunChatTurn(...args),
  };
});

// Keeping the real chat-service module loadable means keeping its own imports
// inert: none of them are exercised here.
jest.mock('../../llm', () => ({
  llmClient: { completeStream: jest.fn(), complete: jest.fn() },
}));
jest.mock('../../shared/thread-title-generation', () => ({
  maybeGenerateThreadTitle: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../insights/conversation-summarization', () => ({
  shouldSummarize: jest.fn().mockReturnValue(false),
  generateRollingSummary: jest.fn(),
  formatSummaryForPrompt: jest.fn().mockReturnValue('formatted summary'),
}));

const mockGetThread = jest.fn();
const mockGetCallerRole = jest.fn();
const mockAppendMessage = jest.fn();
jest.mock('../chat-repository', () => ({
  getThread: (...args: unknown[]) => mockGetThread(...args),
  getCallerRole: (...args: unknown[]) => mockGetCallerRole(...args),
  appendMessage: (...args: unknown[]) => mockAppendMessage(...args),
  listMessages: jest.fn(),
  getThreadRollingSummary: jest.fn(),
  // When the assistant last spoke, for the Browser section: none by default.
  lastAssistantReplyAt: jest.fn().mockResolvedValue(null),
  updateThreadRollingSummary: jest.fn(),
  updateThreadTitleInternal: jest.fn(),
}));

// The Browser section is its own module with its own suite; here the turn
// gets an empty block, as a thread with no browser does.
jest.mock('../../browser-sessions/browser-state', () => ({
  buildAssistantBrowserState: jest.fn().mockResolvedValue(''),
  browserDriverNameForThread: jest.fn().mockResolvedValue(''),
}));

const mockCheckRateLimit = jest.fn();
jest.mock('../rate-limiter', () => ({
  checkAndIncrementLiftoffRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
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
  claimAbortSignal: jest.fn(),
  claimUserMessageSignal: jest.fn(),
  frameInterrupt: jest.fn(),
}));

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: jest.fn() }),
  withTenantScope: jest.fn(),
  withAdminScope: jest.fn(),
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

interface MockRequest extends Request {
  _listeners: Record<string, Array<() => void>>;
}

function createMockRequest(body: unknown, firebaseUid: string | null = FIREBASE_UID): MockRequest {
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
  } as unknown as MockRequest;
  return req;
}

/** Fire the socket-closed handler the route registered. */
function fireClientDisconnect(req: MockRequest): void {
  for (const handler of req._listeners.close ?? []) handler();
}

function streamFrom(events: ChatServiceEvent[]): AsyncIterable<ChatServiceEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

/** An iterable that parks after its first event until the test releases it, so
 *  a test can look at the stream while the turn is still running. */
function pausedStream(before: ChatServiceEvent[], after: ChatServiceEvent[]) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const iterable = (async function* () {
    for (const e of before) yield e;
    await gate;
    for (const e of after) yield e;
  })();
  return { iterable, release: () => release() };
}

/** Let queued microtasks run so a parked handler reaches its await. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const completeEvent: ChatServiceEvent = {
  type: 'complete',
  message: {
    id: 'msg-1',
    threadId: THREAD_ID,
    role: 'assistant',
    content: 'Hello.',
    inputTokens: 20,
    outputTokens: 5,
    createdAt: '2026-08-08T12:00:00Z',
  },
};

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
  mockRunChatTurn.mockReturnValue(streamFrom([completeEvent]));
});

// ── Validation + auth ──────────────────────────────────────────────────

describe('POST /chat-stream: validation + auth', () => {
  const handler = getRouteHandler('/chat-stream');

  // Was `{ tenantId }` alone, which is now the greeting — the one request that
  // is allowed to carry neither a thread nor a message.
  it('returns 400 on missing body fields', async () => {
    const req = createMockRequest({ threadId: THREAD_ID, content: 'hello' });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.statusCode).toBe(400);
    expect(mockTryAcquireTurnLock).not.toHaveBeenCalled();
  });

  it('returns 400 on a message with no thread to write it to', async () => {
    const req = createMockRequest({ tenantId: TENANT_A, content: 'hello' });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.statusCode).toBe(400);
    expect(mockTryAcquireTurnLock).not.toHaveBeenCalled();
  });

  it('returns 400 on a thread with nothing to say to it', async () => {
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.statusCode).toBe(400);
    expect(mockRunChatTurn).not.toHaveBeenCalled();
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

  it('returns 400 when the message is only control characters', async () => {
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: '\u0000\u0001\u0002',
    });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.statusCode).toBe(400);
    expect(mockRunChatTurn).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no firebase uid on req.ctx', async () => {
    const req = createMockRequest(
      { tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' },
      null,
    );
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.statusCode).toBe(401);
  });

  it('returns 401 when the account lookup fails', async () => {
    mockGetByFirebaseUid.mockResolvedValue(null);
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.statusCode).toBe(401);
  });

  it('returns 404, not 403, when the caller is not a tenant member', async () => {
    mockGetCallerRole.mockResolvedValue(null);
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.statusCode).toBe(404);
  });

  it('returns 404 when the thread does not exist or is not visible', async () => {
    mockGetThread.mockResolvedValue(null);
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.statusCode).toBe(404);
    expect(mockTryAcquireTurnLock).not.toHaveBeenCalled();
  });

  it('returns 429 with a Retry-After header when rate limited', async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      retryAfter: 60,
      remaining: { minute: 0, hour: 10, day: 50 },
    });
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.statusCode).toBe(429);
    expect(state.headers['retry-after']).toBe('60');
    expect(mockRunChatTurn).not.toHaveBeenCalled();
  });
});

// ── SSE streaming ──────────────────────────────────────────────────────

// The greeting Liftoff opens with. Same shape as agent chat's and the CAIO's:
// no thread, nothing persisted, and the first message the person sends is what
// creates the conversation. This page had no greeting at all until now — it
// said "Send a message to get started" in grey empty-state text — so there is
// no old behaviour to preserve, only the one design to match.
describe('POST /chat-stream: the greeting', () => {
  const handler = getRouteHandler('/chat-stream');

  function greetingRequest() {
    return createMockRequest({ tenantId: TENANT_A });
  }

  it('streams the greeting and ends', async () => {
    mockGetByFirebaseUid.mockResolvedValue({ id: ACCOUNT_ID, timezone: 'America/New_York' });
    const state = createMockResponse();

    await handler(greetingRequest(), state.res);

    const body = state.writtenChunks.join('');
    expect(body).toContain('event: text_delta');
    expect(body).toMatch(/How can I help you (this (morning|afternoon|evening)|tonight)\?/);
    expect(body).toContain('event: complete');
    // Null: there is no stored row to hand back.
    expect(body).toContain('"message":null');
    expect(state.ended).toBe(true);
  });

  it('writes nothing down and runs no turn', async () => {
    const state = createMockResponse();

    await handler(greetingRequest(), state.res);

    expect(mockAppendMessage).not.toHaveBeenCalled();
    expect(mockRunChatTurn).not.toHaveBeenCalled();
  });

  it('touches nothing that belongs to a thread', async () => {
    const state = createMockResponse();

    await handler(greetingRequest(), state.res);

    // No transcript to check permissions on, no turn to race, no lock to take.
    expect(mockGetThread).not.toHaveBeenCalled();
    expect(mockFindActiveTurnId).not.toHaveBeenCalled();
    expect(mockTryAcquireTurnLock).not.toHaveBeenCalled();
  });

  it('flushes SSE headers before saying anything', async () => {
    const state = createMockResponse();

    await handler(greetingRequest(), state.res);

    expect(state.headers['content-type']).toBe('text/event-stream');
    expect(state.flushedHeaders).toBe(true);
  });

  it('still requires a signed-in caller', async () => {
    const state = createMockResponse();

    await handler(createMockRequest({ tenantId: TENANT_A }, null), state.res);

    expect(state.statusCode).toBe(401);
  });

  it('does not confirm a tenant the caller is not in', async () => {
    mockGetCallerRole.mockResolvedValue(null);
    const state = createMockResponse();

    await handler(greetingRequest(), state.res);

    expect(state.statusCode).toBe(404);
  });

  it('falls back to a timeless greeting when the account has no timezone', async () => {
    mockGetByFirebaseUid.mockResolvedValue({ id: ACCOUNT_ID, timezone: null });
    const state = createMockResponse();

    await handler(greetingRequest(), state.res);

    expect(state.writtenChunks.join('')).toContain('How can I help you?');
  });
});

describe('POST /chat-stream: SSE streaming', () => {
  const handler = getRouteHandler('/chat-stream');

  it('sets the expected SSE headers and flushes them', async () => {
    mockRunChatTurn.mockReturnValue(
      streamFrom([{ type: 'thinking' }, { type: 'text_delta', text: 'Hello.' }, completeEvent]),
    );
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.headers['content-type']).toBe('text/event-stream');
    expect(state.headers['cache-control']).toBe('no-cache');
    expect(state.headers['connection']).toBe('keep-alive');
    // Cloud Run and nginx buffer by default, which would hold every delta back
    // until the turn ended.
    expect(state.headers['x-accel-buffering']).toBe('no');
    expect(state.headers['content-encoding']).toBe('identity');
    expect(state.flushedHeaders).toBe(true);
    expect(state.ended).toBe(true);
  });

  it('forwards each chat-service event as the correct SSE frame', async () => {
    mockRunChatTurn.mockReturnValue(
      streamFrom([
        { type: 'thinking' },
        { type: 'tool_call', tool: 'get_workspace_summary' },
        { type: 'text_delta', text: 'Reply.' },
        completeEvent,
      ]),
    );
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    const allOutput = state.writtenChunks.join('');
    expect(allOutput).toContain('event: thinking\ndata: {}\n\n');
    // The frame carries the phrase the person reads beside the pulse; the name
    // is for the model. An unauthored name gets the neutral phrase, never itself.
    expect(allOutput).toContain('event: tool_call\ndata: {"tool":"get_workspace_summary","label":"Working on it"}\n\n');
    expect(allOutput).toContain('event: text_delta\ndata: {"text":"Reply."}\n\n');
    expect(allOutput).toContain('event: complete\n');
    expect(allOutput).toContain('"id":"msg-1"');
  });

  it('writes a content_block frame, which only a delegated turn produces', async () => {
    // Liftoff itself still answers in plain text. A colleague brought into the
    // thread does not: the Chief AI Officer's org chart and the Insights
    // Manager's tables arrive as their own events, and dropping them here would
    // lose the chart the person watched appear.
    mockRunChatTurn.mockReturnValue(
      streamFrom([
        { type: 'thinking' },
        {
          type: 'content_block',
          block: { type: 'org_chart', title: 'Proposed team' },
        } as unknown as ChatServiceEvent,
        completeEvent,
      ]),
    );
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    const allOutput = state.writtenChunks.join('');
    expect(allOutput).toContain(
      'event: content_block\ndata: {"block":{"type":"org_chart","title":"Proposed team"}}\n\n',
    );
    // The frames on either side still went out.
    expect(allOutput).toContain('event: thinking');
    expect(allOutput).toContain('event: complete');
  });

  it('emits an error SSE frame when the chat service iterator throws', async () => {
    mockRunChatTurn.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'thinking' } as ChatServiceEvent;
        throw new Error('provider boom');
      },
    }));
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    const output = state.writtenChunks.join('');
    expect(output).toContain('event: thinking');
    expect(output).toContain('event: error');
    expect(output).toContain('"code":"INTERNAL"');
    expect(state.ended).toBe(true);
    // The lock still comes back, or the thread would look busy for 20 minutes.
    expect(mockReleaseTurnLock).toHaveBeenCalled();
  });

  it('passes tenantId, accountId, role, the caller\'s name and the sanitized message to runLiftoffChatTurn', async () => {
    mockGetByFirebaseUid.mockResolvedValue({ id: ACCOUNT_ID, firstName: 'Dana', lastName: 'Reyes', email: 'dana@example.com' });
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'What can you do?',
    });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(mockRunChatTurn).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      tenantId: TENANT_A,
      accountId: ACCOUNT_ID,
      role: 'owner',
      userMessage: 'What can you do?',
      // The person's name, which a hand-over forwards as the sender; the
      // email stands in for an account with no name.
      callerName: 'Dana Reyes',
      // Empty rather than absent: the turn always gets an attachment list.
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

  it('sends the message to the model as the person typed it', async () => {
    // Sanitization strips control characters; it does not rewrite punctuation.
    // Encoding here is what made the model answer about "What&#39;s the best
    // beer garden" instead of the question that was asked.
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: '<b>hi</b>',
    });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(mockRunChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: '<b>hi</b>' }),
    );
  });

  it("keeps an apostrophe on the way to the model", async () => {
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: "What's the best beer garden in Berlin",
    });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(mockRunChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: "What's the best beer garden in Berlin",
      }),
    );
  });

  it('never puts the message text in the audit log, only its length', async () => {
    const { logAudit } = jest.requireMock('../../infrastructure/logging') as {
      logAudit: jest.Mock;
    };
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'my home address is somewhere',
    });
    const state = createMockResponse();

    await handler(req, state.res);

    const received = logAudit.mock.calls.find(c => c[0] === 'liftoff.chat_message_received');
    expect(received).toBeDefined();
    expect(received![2]).toMatchObject({
      threadId: THREAD_ID,
      turnId: 'turn-fixed',
      messageLength: 'my home address is somewhere'.length,
      attachmentCount: 0,
    });
    expect(JSON.stringify(received![2])).not.toContain('home address');
  });
});

// ── The terminal frame, on the wire, for every shape of this stream ────
//
// "A `done` frame closes every stream shape, greeting included" could be
// confirmed by hand by reading the raw SSE body. It is a property of the
// router, so it is asserted here instead: a manual check confirms today and
// guards nothing tomorrow.
//
// `done` is the ONLY thing that distinguishes a finished stream from a socket
// that died mid-turn — the client (Liftoff-React services/chatSse.ts) reports its
// absence at EOF as STREAM_TRUNCATED. The interrupt acknowledgment is the shape
// most at risk: `interrupt_delivered` is not terminal to the client, and an exit
// that ends the socket above the `try` whose `finally` writes the frame makes
// steering a running turn raise "The connection dropped before the reply
// finished arriving." every single time, on a message that HAD been delivered.

describe('POST /chat-stream: every shape ends with exactly one done frame', () => {
  const handler = getRouteHandler('/chat-stream');
  const DONE = 'event: done\ndata: {}\n\n';

  /** The one request shape that carries neither a thread nor content. */
  const greetingRequest = () => createMockRequest({ tenantId: TENANT_A });

  /** How many terminal frames the body carries. Exactly one, always. */
  function doneFrames(body: string): number {
    return body.split(DONE).length - 1;
  }

  it('the greeting', async () => {
    const state = createMockResponse();
    await handler(greetingRequest(), state.res);

    const body = state.writtenChunks.join('');
    expect(doneFrames(body)).toBe(1);
    expect(body.endsWith(DONE)).toBe(true);
    // After `complete`, which the client also treats as terminal. Both, so the
    // client has one rule for every shape rather than a special case per surface.
    expect(body.indexOf('event: complete')).toBeLessThan(body.indexOf(DONE));
    expect(state.ended).toBe(true);
  });

  it('the interrupt acknowledgment — THE DEFECT', async () => {
    mockFindActiveTurnId.mockResolvedValue('turn-live');
    const req = createMockRequest({
      tenantId: TENANT_A, threadId: THREAD_ID, content: 'make it shorter',
    });
    const state = createMockResponse();

    await handler(req, state.res);

    const body = state.writtenChunks.join('');
    expect(body).toBe('event: interrupt_delivered\ndata: {}\n\n' + DONE);
    expect(doneFrames(body)).toBe(1);
  });

  it('a normal turn', async () => {
    mockRunChatTurn.mockReturnValue((async function* () {
      yield { type: 'thinking' } as const;
      yield completeEvent;
    })());
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    const body = state.writtenChunks.join('');
    expect(doneFrames(body)).toBe(1);
    expect(body.endsWith(DONE)).toBe(true);
  });

  it('a turn whose iterator threw', async () => {
    mockRunChatTurn.mockReturnValue((async function* () {
      yield { type: 'thinking' } as const;
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

// ── Mid-run control ────────────────────────────────────────────────────

describe('POST /chat-stream: mid-run control (ADR-041)', () => {
  const handler = getRouteHandler('/chat-stream');

  it('delivers a message typed mid-stream into the running turn and starts no second turn', async () => {
    mockFindActiveTurnId.mockResolvedValue('turn-live');
    const req = createMockRequest({
      tenantId: TENANT_A,
      threadId: THREAD_ID,
      content: 'make it shorter',
    });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(mockInsertTurnSignal).toHaveBeenCalledWith(
      TENANT_A,
      'turn-live',
      'user_message',
      expect.objectContaining({ text: 'make it shorter', senderAccountId: ACCOUNT_ID }),
    );
    // Acknowledged as an SSE frame, so every chat surface keeps one client path.
    expect(state.headers['content-type']).toBe('text/event-stream');
    expect(state.writtenChunks.join('')).toContain('event: interrupt_delivered\ndata: {}\n\n');
    // The message the person watched being accepted is in the transcript too,
    // with the caller the request authenticated as as its sender (migration 492).
    expect(mockAppendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'make it shorter', senderAccountId: ACCOUNT_ID }),
    );
    expect(mockRunChatTurn).not.toHaveBeenCalled();
    expect(mockTryAcquireTurnLock).not.toHaveBeenCalled();
    expect(state.ended).toBe(true);
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
      content: 'make it shorter',
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
      content: 'make it shorter',
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
    // Nothing was taken, so nothing is released.
    expect(mockReleaseTurnLock).not.toHaveBeenCalled();
  });

  it('answers 503 rather than opening a dead stream when the lock store is unreachable', async () => {
    const { TurnLockUnavailableError } = jest.requireMock('../turn-control') as {
      TurnLockUnavailableError: new (m: string) => Error;
    };
    mockTryAcquireTurnLock.mockRejectedValue(new TurnLockUnavailableError('connection terminated'));
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(state.statusCode).toBe(503);
    expect(state.flushedHeaders).toBe(false);
    expect(mockRunChatTurn).not.toHaveBeenCalled();
  });

  it('lets an unexpected lock failure propagate rather than swallowing it as a 503', async () => {
    mockTryAcquireTurnLock.mockRejectedValue(new Error('something else entirely'));
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await expect(handler(req, state.res)).rejects.toThrow('something else entirely');
  });

  it('releases the lock when the turn ends', async () => {
    mockRunChatTurn.mockReturnValue(streamFrom([{ type: 'text_delta', text: 'Hello.' }]));
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    await handler(req, state.res);

    expect(mockReleaseTurnLock).toHaveBeenCalledTimes(1);
  });
});

// ── Long-lived connection behaviour ────────────────────────────────────

describe('POST /chat-stream: heartbeats, timeouts and disconnects', () => {
  const handler = getRouteHandler('/chat-stream');

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('writes a heartbeat comment every 30 seconds so proxies keep the socket open', async () => {
    const paused = pausedStream([{ type: 'thinking' }], [completeEvent]);
    mockRunChatTurn.mockReturnValue(paused.iterable);
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    const inFlight = handler(req, state.res);
    await flushMicrotasks();
    jest.advanceTimersByTime(90_000);
    paused.release();
    await inFlight;

    const heartbeats = state.writtenChunks.filter(c => c === ': heartbeat\n\n');
    expect(heartbeats).toHaveLength(3);
    // A comment line, so clients ignore it and no event handler ever sees it.
    expect(heartbeats[0].startsWith(':')).toBe(true);
  });

  it('cuts the stream off with a TIMEOUT frame at the 10 minute cap', async () => {
    const paused = pausedStream([{ type: 'thinking' }], [completeEvent]);
    mockRunChatTurn.mockReturnValue(paused.iterable);
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    const inFlight = handler(req, state.res);
    await flushMicrotasks();
    jest.advanceTimersByTime(10 * 60 * 1000);

    expect(state.writtenChunks.join('')).toContain('"code":"TIMEOUT"');
    expect(state.ended).toBe(true);

    paused.release();
    await inFlight;
    // Nothing is written after the socket closed, and the lock still comes back.
    expect(state.writtenChunks.join('')).not.toContain('event: complete');
    expect(mockReleaseTurnLock).toHaveBeenCalled();
  });

  it('ends the cut-off stream with exactly one done frame, the finally adding none', async () => {
    // The two writers that can both close: the timeout fires while the turn is
    // still running, then the `finally` runs when it finishes. A second terminal
    // frame would be a write after end — which throws, inside the block that
    // releases the turn lock, turning a cut stream into a thread that stays busy.
    const paused = pausedStream([{ type: 'thinking' }], [completeEvent]);
    mockRunChatTurn.mockReturnValue(paused.iterable);
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    const inFlight = handler(req, state.res);
    await flushMicrotasks();
    jest.advanceTimersByTime(10 * 60 * 1000);
    paused.release();
    await inFlight;

    const body = state.writtenChunks.join('');
    expect(body).toContain('"code":"TIMEOUT"');
    expect(body.split('event: done\ndata: {}\n\n').length - 1).toBe(1);
    expect(mockReleaseTurnLock).toHaveBeenCalled();
  });

  it('stops heartbeating once the turn is over', async () => {
    const paused = pausedStream([{ type: 'thinking' }], [completeEvent]);
    mockRunChatTurn.mockReturnValue(paused.iterable);
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    const inFlight = handler(req, state.res);
    await flushMicrotasks();
    paused.release();
    await inFlight;

    const before = state.writtenChunks.length;
    jest.advanceTimersByTime(5 * 60 * 1000);
    expect(state.writtenChunks).toHaveLength(before);
    // The interval and the hard timeout are both cleared, so nothing is left
    // holding the process open.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps the turn running after the client disconnects, and still persists', async () => {
    // ADR-041: a lost socket must not throw away work the person already paid
    // for. Only an explicit stop aborts.
    const paused = pausedStream([{ type: 'thinking' }], [completeEvent]);
    mockRunChatTurn.mockReturnValue(paused.iterable);
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'hi' });
    const state = createMockResponse();

    const inFlight = handler(req, state.res);
    await flushMicrotasks();
    fireClientDisconnect(req);
    paused.release();
    await inFlight;

    // The turn was not aborted: the whole iterable was consumed.
    const lock = await mockTryAcquireTurnLock.mock.results[0].value;
    expect(lock.abortController.signal.aborted).toBe(false);
    expect(mockReleaseTurnLock).toHaveBeenCalled();
    // The close handler is detached, so a pooled socket cannot leak listeners.
    expect(req._listeners.close).toHaveLength(0);
  });
});

// ── writeChatEventAsSse (unit helper) ──────────────────────────────────

// ── The person's browser events ────────────────────────────────────────

describe("POST /chat-stream: the person's browser events", () => {
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

  beforeEach(() => {
    mockGetByFirebaseUid.mockResolvedValue({ id: ACCOUNT_ID, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' });
    runtimeAnswers([releasedHold()]);
  });

  it('accepts a hand-back alone: verifies the hold with the runtime, writes the status row, and runs the turn with no words', async () => {
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, browserHandback: { holdId: HOLD } });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(mockListTakeoverActivity).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD_ID, holdId: HOLD, limit: 1 }));
    expect(mockAppendMessage).toHaveBeenCalledWith({
      threadId: THREAD_ID, role: 'assistant', content: 'Ada Lovelace handed the browser back', messageType: 'browser_handback',
    });
    expect(mockRunChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      userMessage: '', browserEvent: { kind: 'handback', holdId: HOLD },
    }));
    // The status row is written before the lock is taken and the turn runs.
    expect(mockAppendMessage.mock.invocationCallOrder[0]).toBeLessThan(mockTryAcquireTurnLock.mock.invocationCallOrder[0]);
    expect(state.headers['content-type']).toBe('text/event-stream');
  });

  it('accepts a hand-back beside the words the person sent while driving, in one turn', async () => {
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, content: 'now summarise it', browserHandback: { holdId: HOLD } });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(mockRunChatTurn).toHaveBeenCalledTimes(1);
    expect(mockRunChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      userMessage: 'now summarise it', browserEvent: { kind: 'handback', holdId: HOLD },
    }));
    expect(mockAppendMessage).toHaveBeenCalledWith(expect.objectContaining({ messageType: 'browser_handback' }));
  });

  it("refuses with 409 and writes nothing when the hold is not this thread's, not released, or older than fifteen minutes", async () => {
    const cases: Array<unknown[]> = [
      [],
      [releasedHold({ endReason: 'absent_driver' })],
      [releasedHold({ live: true, endedAt: undefined, endReason: '' })],
      [releasedHold({ endedAt: timestampFromDate(new Date(Date.now() - 16 * 60_000)) })],
    ];
    for (const holds of cases) {
      jest.clearAllMocks();
      mockGetByFirebaseUid.mockResolvedValue({ id: ACCOUNT_ID });
      mockGetCallerRole.mockResolvedValue('owner');
      mockGetThread.mockResolvedValue({ id: THREAD_ID, tenantId: TENANT_A, accountId: ACCOUNT_ID });
      runtimeAnswers(holds);
      const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, browserHandback: { holdId: HOLD } });
      const state = createMockResponse();
      await handler(req, state.res);
      expect(state.statusCode).toBe(409);
      expect(state.writtenChunks.join('')).toContain('handback_not_pending');
      expect(mockAppendMessage).not.toHaveBeenCalled();
      expect(mockRunChatTurn).not.toHaveBeenCalled();
    }
  });



  it('an event turn without words is never delivered as an interrupt to a running turn', async () => {
    mockFindActiveTurnId.mockResolvedValue('turn-running');
    const req = createMockRequest({ tenantId: TENANT_A, threadId: THREAD_ID, browserHandback: { holdId: HOLD } });
    const state = createMockResponse();
    await handler(req, state.res);
    expect(mockInsertTurnSignal).not.toHaveBeenCalled();
    expect(mockTryAcquireTurnLock).toHaveBeenCalled();
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
    writeChatEventAsSse(stream, { type: 'tool_call', tool: 'get_workspace_summary' });
    writeChatEventAsSse(stream, { type: 'text_delta', text: 'Hello' });
    writeChatEventAsSse(stream, { type: 'complete', message: null });
    writeChatEventAsSse(stream, { type: 'error', code: 'PROVIDER_ERROR', message: 'boom' });

    const all = writes.join('');
    expect(all).toContain('event: thinking\ndata: {}\n\n');
    expect(all).toContain('event: tool_call\ndata: {"tool":"get_workspace_summary","label":"Working on it"}\n\n');
    expect(all).toContain('event: text_delta\ndata: {"text":"Hello"}\n\n');
    // A stopped turn that said nothing still gets a terminal frame, carrying no
    // message because there is none to invent.
    expect(all).toContain('event: complete\ndata: {"message":null}\n\n');
    expect(all).toContain('event: error\ndata: {"code":"PROVIDER_ERROR","message":"boom"}\n\n');
  });

  it('translates content_block, carrying the block through untouched', () => {
    const { stream, frames: writes } = collectingStream();

    writeChatEventAsSse(stream, {
      type: 'content_block',
      block: { type: 'bar_chart', title: 'Spend' },
    } as unknown as ChatServiceEvent);

    expect(writes.join('')).toBe(
      'event: content_block\ndata: {"block":{"type":"bar_chart","title":"Spend"}}\n\n',
    );
  });

  // Who is speaking, on the wire while the reply is still arriving. The pair of
  // fields is the same pair the persisted message stores, so the live bubble and
  // the stored reply cannot disagree about who wrote it.
  it('translates delegation_started, carrying both the identity and the label', () => {
    const { stream, frames: writes } = collectingStream();

    writeChatEventAsSse(stream, {
      type: 'delegation_started',
      author: '11111111-2222-3333-4444-555555555555',
      authorLabel: 'Payroll Operations',
    });

    expect(writes.join('')).toBe(
      'event: delegation_started\n'
        + 'data: {"author":"11111111-2222-3333-4444-555555555555",'
        + '"authorLabel":"Payroll Operations"}\n\n',
    );
  });

  // A pause has its own frame precisely so it is not an error: on the error
  // channel the client restored the person's message into the composer as
  // though the send had failed. It carries the paired thread so the client can
  // offer to open the conversation holding the decision without ever putting an
  // id in the address bar.
  it('translates delegation_paused on its own channel, never as an error', () => {
    const { stream, frames: writes } = collectingStream();

    writeChatEventAsSse(stream, {
      type: 'delegation_paused',
      author: '11111111-2222-3333-4444-555555555555',
      authorLabel: 'Payroll Operations',
      delegateThreadId: '99999999-8888-7777-6666-555555555555',
      reason: 'Payroll Operations is waiting on an approval before it can continue.',
      message: null,
    });

    const frame = writes.join('');
    expect(frame.startsWith('event: delegation_paused\n')).toBe(true);
    expect(frame).toContain('"delegateThreadId":"99999999-8888-7777-6666-555555555555"');
    expect(frame).toContain('"authorLabel":"Payroll Operations"');
    expect(frame).not.toContain('event: error');
  });
});
