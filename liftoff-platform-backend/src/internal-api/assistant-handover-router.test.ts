// The hand-over stream workforce-service opens when the Chief AI Officer
// brings Liftoff or the Insights Manager into one of its conversations.
//
// What matters here: a caller without the service token gets nothing; the
// rail runs AS the Chief AI Officer, on the person's real role, with the
// pairing recorded on the assistants' own table keyed on the workforce
// thread; every frame the rail yields crosses in order with the terminal
// frame carrying what workforce has to persist; and a close before the end
// is a stop that reaches the colleague through the rail, not a dropped
// stream.

import express from 'express';
import type { AddressInfo } from 'net';

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetPairing = jest.fn();
const mockPair = jest.fn();
jest.mock('../agent-chat/assistant-delegations', () => ({
  getAssistantThreadDelegation: (...a: unknown[]) => mockGetPairing(...a),
  pairAssistantThreadDelegation: (...a: unknown[]) => mockPair(...a),
}));

const mockCreateDelegateRuntime = jest.fn();
jest.mock('../liftoff/delegation-runtimes', () => ({
  createDelegateRuntime: (...a: unknown[]) => mockCreateDelegateRuntime(...a),
}));

import { assistantHandoverRouter } from './assistant-handover-router';
import { workforceServiceAuth } from './workforce-service-auth';
import type { DelegatedEvent } from '../liftoff/delegation-runtimes';

const TOKEN = 'workforce-token-under-test';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const CAIO_THREAD_ID = '33333333-3333-3333-3333-333333333333';

function buildApp(): express.Express {
  const app = express();
  app.use('/api/internal/assistants', workforceServiceAuth, express.json({ limit: '64kb' }), assistantHandoverRouter);
  return app;
}

interface Frame { event: string; data: Record<string, unknown> }

function parseFrames(text: string): Frame[] {
  return text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 && !chunk.startsWith(':'))
    .map((chunk) => {
      const event = /^event: (.*)$/m.exec(chunk)?.[1] ?? '';
      const data = /^data: (.*)$/m.exec(chunk)?.[1] ?? '{}';
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

async function withServer<T>(app: express.Express, fn: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function fakeRuntime(events: DelegatedEvent[]) {
  return {
    createThread: jest.fn().mockResolvedValue('delegate-thread-new'),
    runTurn: jest.fn(() =>
      (async function* () {
        for (const e of events) yield e;
      })(),
    ),
    requestStop: jest.fn().mockResolvedValue(undefined),
  };
}

const VALID_BODY = {
  tenantId: TENANT_ID,
  accountId: 'account-1',
  role: 'member',
  displayName: 'Dana Reyes',
  surface: 'caio',
  threadId: CAIO_THREAD_ID,
  colleague: 'insights',
  content: 'how many runs this week',
  request: 'They are sizing the Watches team; how many runs did it make this week.',
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env['WORKFORCE_SERVICE_TOKEN'] = TOKEN;
  mockGetPairing.mockResolvedValue(null);
  mockPair.mockImplementation(async (input: { delegateThreadId: string }) => input.delegateThreadId);
});

async function post(
  base: string,
  body: unknown,
  token: string | null = TOKEN,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return fetch(`${base}/api/internal/assistants/handover-stream`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-service-auth': token } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

describe('auth and validation', () => {
  it('refuses a caller without the service token before touching anything', async () => {
    await withServer(buildApp(), async (base) => {
      const res = await post(base, VALID_BODY, null);
      expect(res.status).toBe(401);
    });
    expect(mockCreateDelegateRuntime).not.toHaveBeenCalled();
  });

  it('rejects a colleague the Chief AI Officer cannot bring in', async () => {
    await withServer(buildApp(), async (base) => {
      const res = await post(base, { ...VALID_BODY, colleague: 'caio' });
      expect(res.status).toBe(400);
    });
    expect(mockCreateDelegateRuntime).not.toHaveBeenCalled();
  });

  it('rejects a role outside the four the tenant has', async () => {
    await withServer(buildApp(), async (base) => {
      const res = await post(base, { ...VALID_BODY, role: 'superuser' });
      expect(res.status).toBe(400);
    });
  });
});

describe('the stream', () => {
  it('runs the rail as the Chief AI Officer and relays every frame, ending on complete', async () => {
    const runtime = fakeRuntime([
      { type: 'thinking' },
      { type: 'tool_call', tool: 'get_execution_trends' },
      { type: 'text_delta', text: 'Twelve ' },
      { type: 'text_delta', text: 'runs.' },
      { type: 'content_block', block: { type: 'metric_card', value: 12 } },
      { type: 'complete', text: 'Twelve runs.', blocks: [{ type: 'metric_card', value: 12 }], inputTokens: 5, outputTokens: 6, answeredBy: null },
    ]);
    mockCreateDelegateRuntime.mockReturnValue(runtime);

    const frames = await withServer(buildApp(), async (base) => {
      const res = await post(base, VALID_BODY, TOKEN, {
        'x-origin': JSON.stringify({ via: 'mcp', client: 'claude-code', credentialId: 'cred-1' }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      return parseFrames(await res.text());
    });

    // The colleague, the person's real role, the origin, and depth one.
    expect(mockCreateDelegateRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'insights', id: 'insights', label: 'Insights Manager' }),
      expect.objectContaining({
        tenantId: TENANT_ID,
        accountId: 'account-1',
        role: 'member',
        displayName: 'Dana Reyes',
        origin: { via: 'mcp', client: 'claude-code', credentialId: 'cred-1' },
        asColleague: true,
      }),
    );
    // The pairing is the assistants' table, keyed on the workforce thread.
    expect(mockGetPairing).toHaveBeenCalledWith(TENANT_ID, 'caio', CAIO_THREAD_ID, 'insights', null);
    expect(mockPair).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      surface: 'caio',
      threadId: CAIO_THREAD_ID,
      targetKind: 'insights',
      targetId: null,
      delegateThreadId: 'delegate-thread-new',
    });
    // The person's words alone, with the note in the Chief AI Officer's name.
    expect(runtime.runTurn).toHaveBeenCalledWith({
      delegateThreadId: 'delegate-thread-new',
      content: 'how many runs this week',
      forwardedContext:
        'Background from Chief AI Officer, which brought you into this conversation. It is not shown to the person: '
        + 'do not repeat it, or any identifier in it, to them. Answer the message that follows it.\n\n'
        + 'They are sizing the Watches team; how many runs did it make this week.',
      forwardedBy: { id: 'caio', label: 'Chief AI Officer' },
    });

    expect(frames).toEqual([
      { event: 'delegation_started', data: { author: 'insights', authorLabel: 'Insights Manager' } },
      { event: 'thinking', data: {} },
      // Relayed with the colleague's work named in the person's terms.
      { event: 'tool_call', data: { tool: 'get_execution_trends', label: 'Reading the trends' } },
      // A PARAGRAPH is the unit of a relayed reply, as it is on every other
      // surface: the colleague's two deltas arrive as one, and they arrive
      // BEFORE the block they introduce rather than after it.
      { event: 'text_delta', data: { text: 'Twelve runs.' } },
      { event: 'content_block', data: { block: { type: 'metric_card', value: 12 } } },
      {
        event: 'complete',
        data: {
          text: 'Twelve runs.',
          blocks: [{ type: 'metric_card', value: 12 }],
          inputTokens: 5,
          outputTokens: 6,
          delegateThreadId: 'delegate-thread-new',
          stopped: false,
        },
      },
    ]);
  });

  it('reuses the paired thread on a later hand-over', async () => {
    mockGetPairing.mockResolvedValue({ targetKind: 'liftoff', targetId: null, delegateThreadId: 'delegate-existing' });
    const runtime = fakeRuntime([
      { type: 'complete', text: 'Done.', blocks: [], inputTokens: 1, outputTokens: 1, answeredBy: null },
    ]);
    mockCreateDelegateRuntime.mockReturnValue(runtime);

    await withServer(buildApp(), async (base) => {
      const res = await post(base, { ...VALID_BODY, colleague: 'liftoff', request: '' });
      await res.text();
    });

    expect(runtime.createThread).not.toHaveBeenCalled();
    expect(mockPair).not.toHaveBeenCalled();
    expect(runtime.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      delegateThreadId: 'delegate-existing',
      // Nothing worth forwarding: no note, and so no forwarder.
      forwardedContext: null,
    }));
  });

  it('ends on a pause frame carrying what the colleague said, and no error', async () => {
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime([
      { type: 'text_delta', text: 'Pausing it.' },
      { type: 'paused', reason: 'Liftoff is waiting on an approval before it can continue.' },
    ]));

    const frames = await withServer(buildApp(), async (base) => {
      const res = await post(base, { ...VALID_BODY, colleague: 'liftoff' });
      return parseFrames(await res.text());
    });

    expect(frames.map((f) => f.event)).toEqual(['delegation_started', 'text_delta', 'delegation_paused']);
    expect(frames.at(-1)?.data).toEqual({
      author: 'liftoff',
      authorLabel: 'Liftoff',
      delegateThreadId: 'delegate-thread-new',
      reason: 'Liftoff is waiting on an approval before it can continue.',
      message: null,
      text: 'Pausing it.',
      blocks: [],
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('ends on the error frame the rail wrote when the colleague could not answer', async () => {
    mockCreateDelegateRuntime.mockReturnValue(fakeRuntime([
      { type: 'error', message: 'Liftoff is unavailable.' },
    ]));

    const frames = await withServer(buildApp(), async (base) => {
      const res = await post(base, { ...VALID_BODY, colleague: 'liftoff' });
      return parseFrames(await res.text());
    });

    expect(frames.map((f) => f.event)).toEqual(['delegation_started', 'error']);
    expect(frames.at(-1)?.data).toEqual({ code: 'DELEGATION_ERROR', message: 'Liftoff is unavailable.' });
  });

  it('treats the caller closing the stream as a stop, delivered through the colleague', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = {
      createThread: jest.fn().mockResolvedValue('delegate-thread-new'),
      runTurn: jest.fn(() =>
        (async function* () {
          yield { type: 'text_delta', text: 'Working ' } as DelegatedEvent;
          // The colleague is mid-answer when the caller goes away.
          await gate;
          yield { type: 'text_delta', text: 'still.' } as DelegatedEvent;
          yield { type: 'complete', text: 'Working still.', blocks: [], inputTokens: 1, outputTokens: 1, answeredBy: null } as DelegatedEvent;
        })(),
      ),
      requestStop: jest.fn(async () => { release(); }),
    };
    mockCreateDelegateRuntime.mockReturnValue(runtime);

    await withServer(buildApp(), async (base) => {
      const controller = new AbortController();
      const res = await post(base, VALID_BODY, TOKEN, {}, controller.signal);
      const reader = res.body!.getReader();
      // Read until the hand-over has started, then walk away, as workforce does
      // when its own turn is stopped. Waiting on the TEXT would wait forever:
      // a relayed reply is cut on paragraphs, and this colleague is stopped
      // half a sentence in, so nothing has been released yet. That is the
      // point of the case — the stop must travel with no text on the wire.
      let seen = '';
      while (!seen.includes('event: delegation_started')) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += Buffer.from(value).toString('utf8');
      }
      controller.abort();
      await reader.cancel().catch(() => undefined);
      // The stop reaches the colleague through its own control plane.
      for (let i = 0; i < 200 && runtime.requestStop.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });

    expect(runtime.requestStop).toHaveBeenCalledWith({ delegateThreadId: 'delegate-thread-new' });
  });
});
