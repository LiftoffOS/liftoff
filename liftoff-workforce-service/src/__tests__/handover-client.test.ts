// The hand-over stream client: what it sends, how it reads the frames back,
// and what it does when the stream ends badly or the caller stops it.

jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../infrastructure/service-auth.js', () => ({
  getServiceAuthHeaders: jest.fn().mockResolvedValue({
    Authorization: 'Bearer oidc',
    'X-Service-Auth': 'test-service-auth',
  }),
}));

import { resetConfigForTests } from '../infrastructure/config.js';
import { streamHandover, type HandoverStreamEvent } from '../workforce-plans/handover-client.js';

const mockFetch = jest.fn();

/** A Response-alike whose body streams the given SSE text in chunks, so the
 *  parser is exercised across boundaries the way a real socket splits. */
function sseResponse(chunks: string[], status = 200): unknown {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        read: async () =>
          index < chunks.length
            ? { done: false, value: encoder.encode(chunks[index++]) }
            : { done: true, value: undefined },
        cancel: async () => undefined,
      }),
    },
  };
}

async function collect(iter: AsyncIterable<HandoverStreamEvent>): Promise<HandoverStreamEvent[]> {
  const out: HandoverStreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

const INSIGHTS = { id: 'insights' as const, label: 'Insights Manager' };
const ARGS = {
  caller: { tenantId: 'tenant-1', accountId: 'account-1', role: 'member' as const, origin: { via: 'mcp' as const, client: 'claude-code', credentialId: 'cred-1' } },
  displayName: 'Dana Reyes',
  threadId: 'tp-1',
  target: INSIGHTS,
  content: 'how many runs',
  request: 'They are sizing the Watches team.',
};

beforeEach(() => {
  jest.clearAllMocks();
  resetConfigForTests();
  process.env['PLATFORM_BACKEND_URL'] = 'http://pb.test';
  process.env['GCP_PROJECT_ID'] = 'test';
  process.env['DB_INSTANCE_CONNECTION_NAME'] = 'test:us-west1:test-db';
  process.env['WORKFORCE_SERVICE_TOKEN'] = 'test-service-auth';
  (globalThis as { fetch: unknown }).fetch = mockFetch;
});

afterEach(() => {
  delete process.env['PLATFORM_BACKEND_URL'];
  delete process.env['GCP_PROJECT_ID'];
  delete process.env['DB_INSTANCE_CONNECTION_NAME'];
  delete process.env['WORKFORCE_SERVICE_TOKEN'];
  resetConfigForTests();
});

describe('streamHandover', () => {
  it('posts the hand-over as the person, with the service token, the caller headers and the origin', async () => {
    mockFetch.mockResolvedValue(sseResponse(['event: complete\ndata: {"text":"","blocks":[]}\n\n']));
    const controller = new AbortController();

    await collect(streamHandover({ ...ARGS, signal: controller.signal }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://pb.test/api/internal/assistants/handover-stream');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer oidc',
      'X-Service-Auth': 'test-service-auth',
      'x-tenant-id': 'tenant-1',
      'x-account-id': 'account-1',
      'x-tenant-role': 'member',
      'x-origin': JSON.stringify({ via: 'mcp', client: 'claude-code', credentialId: 'cred-1' }),
      Accept: 'text/event-stream',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'member',
      displayName: 'Dana Reyes',
      surface: 'caio',
      threadId: 'tp-1',
      colleague: 'insights',
      content: 'how many runs',
      request: 'They are sizing the Watches team.',
    });
    expect(init.signal).toBe(controller.signal);
  });

  it('parses every frame, across chunk boundaries, ending on complete', async () => {
    mockFetch.mockResolvedValue(sseResponse([
      'event: delegation_started\ndata: {"author":"insights","authorLabel":"Insights Manager"}\n\n: heartbeat\n\nevent: think',
      'ing\ndata: {}\n\nevent: tool_call\ndata: {"tool":"get_execution_trends"}\n\n',
      'event: text_delta\ndata: {"text":"Twelve runs."}\n\nevent: content_block\ndata: {"block":{"type":"metric_card"}}\n\n',
      'event: complete\ndata: {"text":"Twelve runs.","blocks":[{"type":"metric_card"}],"inputTokens":5,"outputTokens":6,'
        + '"delegateThreadId":"it-9","stopped":false}\n\n',
    ]));

    const events = await collect(streamHandover({ ...ARGS, signal: new AbortController().signal }));

    expect(events).toEqual([
      { type: 'delegation_started', author: 'insights', authorLabel: 'Insights Manager' },
      { type: 'thinking' },
      { type: 'tool_call', tool: 'get_execution_trends' },
      { type: 'text_delta', text: 'Twelve runs.' },
      { type: 'content_block', block: { type: 'metric_card' } },
      {
        type: 'complete',
        text: 'Twelve runs.',
        blocks: [{ type: 'metric_card' }],
        inputTokens: 5,
        outputTokens: 6,
        delegateThreadId: 'it-9',
        stopped: false,
      },
    ]);
  });

  it('parses a pause with what the colleague said, and an error frame', async () => {
    mockFetch.mockResolvedValue(sseResponse([
      'event: delegation_paused\ndata: {"author":"insights","authorLabel":"Insights Manager","delegateThreadId":"it-9",'
        + '"reason":"Insights Manager is waiting.","message":null,"text":"Half.","blocks":[],"inputTokens":1,"outputTokens":2}\n\n',
    ]));
    const paused = await collect(streamHandover({ ...ARGS, signal: new AbortController().signal }));
    expect(paused).toEqual([{
      type: 'delegation_paused',
      author: 'insights',
      authorLabel: 'Insights Manager',
      delegateThreadId: 'it-9',
      reason: 'Insights Manager is waiting.',
      text: 'Half.',
      blocks: [],
      inputTokens: 1,
      outputTokens: 2,
    }]);

    mockFetch.mockResolvedValue(sseResponse(['event: error\ndata: {"code":"DELEGATION_ERROR","message":"Down."}\n\n']));
    const errored = await collect(streamHandover({ ...ARGS, signal: new AbortController().signal }));
    expect(errored).toEqual([{ type: 'error', code: 'DELEGATION_ERROR', message: 'Down.' }]);
  });

  it('drops a frame it has not been taught rather than failing the turn', async () => {
    mockFetch.mockResolvedValue(sseResponse([
      'event: mystery\ndata: {"x":1}\n\nevent: text_delta\ndata: {"text":"ok"}\n\nevent: complete\ndata: {"text":"ok"}\n\n',
    ]));
    const events = await collect(streamHandover({ ...ARGS, signal: new AbortController().signal }));
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'complete']);
  });

  it('turns a refusal and a network failure into one error event, in the colleague\'s name', async () => {
    mockFetch.mockResolvedValue(sseResponse([], 503));
    expect(await collect(streamHandover({ ...ARGS, signal: new AbortController().signal }))).toEqual([
      { type: 'error', code: 'DELEGATION_ERROR', message: 'Insights Manager could not be reached just now. Please try again in a moment.' },
    ]);

    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await collect(streamHandover({ ...ARGS, signal: new AbortController().signal }))).toEqual([
      { type: 'error', code: 'DELEGATION_ERROR', message: 'Insights Manager could not be reached just now. Please try again in a moment.' },
    ]);
  });

  it('ends quietly when the caller aborted it: the stop is the caller\'s own', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let reads = 0;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            reads++;
            if (reads === 1) return { done: false, value: encoder.encode('event: text_delta\ndata: {"text":"Half"}\n\n') };
            controller.abort();
            throw new Error('The operation was aborted');
          },
          cancel: async () => undefined,
        }),
      },
    });

    const events = await collect(streamHandover({ ...ARGS, signal: controller.signal }));
    expect(events).toEqual([{ type: 'text_delta', text: 'Half' }]);
  });

  it('reports a stream that broke for any other reason', async () => {
    const encoder = new TextEncoder();
    let reads = 0;
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            reads++;
            if (reads === 1) return { done: false, value: encoder.encode('event: text_delta\ndata: {"text":"Half"}\n\n') };
            throw new Error('socket hang up');
          },
          cancel: async () => undefined,
        }),
      },
    });

    const events = await collect(streamHandover({ ...ARGS, signal: new AbortController().signal }));
    expect(events).toEqual([
      { type: 'text_delta', text: 'Half' },
      { type: 'error', code: 'DELEGATION_ERROR', message: 'Insights Manager stopped responding. Please try again.' },
    ]);
  });
});
