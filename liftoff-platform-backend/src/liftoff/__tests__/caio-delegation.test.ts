// The wire to workforce-service, with `fetch` mocked and no real network.
//
// This is the only one of the three colleagues that is not in this process, so
// it is the only one with an HTTP contract to get wrong: the auth headers
// workforce resolves its caller from, the SSE frames it answers with, and the
// stop that has to be written where its loop reads it.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@liftoffos/service-client', () => ({
  buildOidcAuthHeader: jest.fn().mockResolvedValue({ Authorization: 'Bearer oidc-token' }),
}));

import {
  createPairedTeamPlanThread,
  requestCAIOTurnStop,
  streamCAIOTurn,
  CAIODelegationError,
  type CAIOStreamEvent,
} from '../caio-delegation';

const CALLER = { tenantId: 'tenant-1', accountId: 'account-1', role: 'viewer' };

const mockFetch = jest.fn();

/** Build a Response-alike whose body streams the given SSE text in chunks, so
 *  the parser is exercised across boundaries the way a real socket splits. */
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

async function collect(iter: AsyncIterable<CAIOStreamEvent>): Promise<CAIOStreamEvent[]> {
  const out: CAIOStreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env['WORKFORCE_SERVICE_URL'] = 'https://workforce.example.invalid';
  process.env['WORKFORCE_SERVICE_TOKEN'] = 'service-token';
  (globalThis as { fetch: unknown }).fetch = mockFetch;
});

afterEach(() => {
  delete process.env['WORKFORCE_SERVICE_URL'];
  delete process.env['WORKFORCE_SERVICE_TOKEN'];
});

describe('createPairedTeamPlanThread', () => {
  it('sends the three trusted caller headers, the service token and the OIDC bearer', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ thread: { id: 'team-plan-thread' } }),
    });

    await expect(createPairedTeamPlanThread({ caller: CALLER })).resolves.toBe('team-plan-thread');

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://workforce.example.invalid/team-plan/threads');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'x-tenant-id': 'tenant-1',
      'x-account-id': 'account-1',
      // The caller's REAL role. workforce makes its own permission decisions
      // from this header.
      'x-tenant-role': 'viewer',
      'X-Service-Auth': 'service-token',
      Authorization: 'Bearer oidc-token',
    });
  });

  it('sends the person\'s name URL-encoded, and no header when there is none', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ thread: { id: 'team-plan-thread' } }),
    });

    await createPairedTeamPlanThread({ caller: { ...CALLER, displayName: 'Zoë 李' } });
    expect(mockFetch.mock.calls[0][1].headers).toMatchObject({
      'x-caller-name': encodeURIComponent('Zoë 李'),
    });

    await createPairedTeamPlanThread({ caller: { ...CALLER, displayName: '  ' } });
    expect(mockFetch.mock.calls[1][1].headers).not.toHaveProperty('x-caller-name');
    await createPairedTeamPlanThread({ caller: CALLER });
    expect(mockFetch.mock.calls[2][1].headers).not.toHaveProperty('x-caller-name');
  });

  it('fails with a sentence for the person when workforce is not configured', async () => {
    delete process.env['WORKFORCE_SERVICE_URL'];

    await expect(createPairedTeamPlanThread({ caller: CALLER })).rejects.toBeInstanceOf(
      CAIODelegationError,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails when the answer carries no thread id', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });

    await expect(createPairedTeamPlanThread({ caller: CALLER })).rejects.toBeInstanceOf(
      CAIODelegationError,
    );
  });
});

describe('streamCAIOTurn', () => {
  it('parses frames that straddle chunk boundaries', async () => {
    // SSE frames do not respect socket reads. Splitting on "\n\n" per chunk
    // would drop the frame cut in half here.
    mockFetch.mockResolvedValue(
      sseResponse([
        'event: thinking\ndata: {}\n\n: heartbeat\n\nevent: text_de',
        'lta\ndata: {"text":"Here is the plan."}\n\n',
        'event: content_block\ndata: {"block":{"type":"org_chart"}}\n\n',
        'event: complete\ndata: {"message":{"content":"Here is the plan.",'
          + '"visualizationBlocks":[{"type":"org_chart"}],"inputTokens":7,"outputTokens":9}}\n\n',
      ]),
    );

    const events = await collect(
      streamCAIOTurn({ caller: CALLER, workforceThreadId: 'tp-1', content: 'build a team' }),
    );

    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'text_delta', text: 'Here is the plan.' },
      { type: 'content_block', block: { type: 'org_chart' } },
      {
        type: 'complete',
        message: {
          content: 'Here is the plan.',
          visualizationBlocks: [{ type: 'org_chart' }],
          inputTokens: 7,
          outputTokens: 9,
          messageType: null,
          contributors: [],
        },
      },
    ]);
  });

  it('carries who wrote the reply when the Chief AI Officer handed its own turn on', async () => {
    // A coding tool's turn on the Chief AI Officer's own thread: it may bring
    // in a colleague, and the row it persists says so. The two hand-over
    // frames are parsed rather than dropped, or the pause would end the
    // stream with no terminal event.
    mockFetch.mockResolvedValue(
      sseResponse([
        'event: delegation_started\ndata: {"author":"insights","authorLabel":"Insights Manager"}\n\n',
        'event: text_delta\ndata: {"text":"Twelve runs."}\n\n',
        'event: complete\ndata: {"message":{"content":"Twelve runs.","visualizationBlocks":null,'
          + '"inputTokens":1,"outputTokens":2,"messageType":"colleague",'
          + '"contributors":[{"id":"insights","label":"Insights Manager"},{"bogus":true}]}}\n\n',
      ]),
    );

    const events = await collect(
      streamCAIOTurn({ caller: CALLER, workforceThreadId: 'tp-1', content: 'how many runs' }),
    );

    expect(events).toEqual([
      { type: 'delegation_started', author: 'insights', authorLabel: 'Insights Manager' },
      { type: 'text_delta', text: 'Twelve runs.' },
      {
        type: 'complete',
        message: {
          content: 'Twelve runs.',
          visualizationBlocks: null,
          inputTokens: 1,
          outputTokens: 2,
          messageType: 'colleague',
          contributors: [{ id: 'insights', label: 'Insights Manager' }],
        },
      },
    ]);
  });

  it('parses a pause of the colleague the Chief AI Officer brought in', async () => {
    mockFetch.mockResolvedValue(
      sseResponse([
        'event: delegation_paused\ndata: {"author":"liftoff","authorLabel":"Liftoff",'
          + '"delegateThreadId":"lt-1","reason":"Liftoff is waiting on an approval.","message":null}\n\n',
      ]),
    );

    const events = await collect(
      streamCAIOTurn({ caller: CALLER, workforceThreadId: 'tp-1', content: 'go' }),
    );

    expect(events).toEqual([
      {
        type: 'delegation_paused',
        author: 'liftoff',
        authorLabel: 'Liftoff',
        reason: 'Liftoff is waiting on an approval.',
      },
    ]);
  });

  it('sends the hand-over flag and the forwarder only when they apply', async () => {
    mockFetch.mockResolvedValue(sseResponse(['event: complete\ndata: {"message":null}\n\n']));

    await collect(streamCAIOTurn({
      caller: CALLER,
      workforceThreadId: 'tp-1',
      content: 'pause it',
      forwardedContext: 'Insights Manager shared background from the conversation so far\n\nThe team costs the most.',
      forwardedBy: { id: 'insights', label: 'Insights Manager' },
      handover: true,
    }));
    const handoverBody = JSON.parse(mockFetch.mock.calls.at(-1)![1].body as string);
    expect(handoverBody).toEqual({
      threadId: 'tp-1',
      content: 'pause it',
      forwardedContext: 'Insights Manager shared background from the conversation so far\n\nThe team costs the most.',
      forwardedBy: { id: 'insights', label: 'Insights Manager' },
      handover: true,
    });

    // A turn that is not a hand-over sends neither key, so an older workforce
    // image that strips unknown keys and a current one behave the same.
    await collect(streamCAIOTurn({
      caller: CALLER,
      workforceThreadId: 'tp-1',
      content: 'hello',
      forwardedBy: { id: 'liftoff', label: 'Liftoff' },
    }));
    const plainBody = JSON.parse(mockFetch.mock.calls.at(-1)![1].body as string);
    expect(plainBody).toEqual({ threadId: 'tp-1', content: 'hello' });
  });

  it('posts the paired thread id and the message', async () => {
    mockFetch.mockResolvedValue(sseResponse(['event: complete\ndata: {"message":null}\n\n']));

    await collect(
      streamCAIOTurn({ caller: CALLER, workforceThreadId: 'tp-1', content: 'build a team' }),
    );

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://workforce.example.invalid/team-plan/chat-stream');
    expect(JSON.parse(init.body)).toEqual({ threadId: 'tp-1', content: 'build a team' });
  });

  it('reports a 409 as busy, which is a wait rather than a failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 409 });

    const events = await collect(
      streamCAIOTurn({ caller: CALLER, workforceThreadId: 'tp-1', content: 'hi' }),
    );

    expect(events).toEqual([{ type: 'busy' }]);
  });

  it('reports its interrupt_delivered frame as busy too', async () => {
    // Same situation reached the other way: the message was folded into a turn
    // already running, so no reply is coming back on this stream.
    mockFetch.mockResolvedValue(sseResponse(['event: interrupt_delivered\ndata: {}\n\n']));

    const events = await collect(
      streamCAIOTurn({ caller: CALLER, workforceThreadId: 'tp-1', content: 'hi' }),
    );

    expect(events).toEqual([{ type: 'busy' }]);
  });

  it('turns any other refusal into one error event rather than throwing', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const events = await collect(
      streamCAIOTurn({ caller: CALLER, workforceThreadId: 'tp-1', content: 'hi' }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'DELEGATION_UNAVAILABLE' });
  });

  it('turns a network failure into one error event rather than throwing', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const events = await collect(
      streamCAIOTurn({ caller: CALLER, workforceThreadId: 'tp-1', content: 'hi' }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
  });

  it('drops a frame it has not been taught rather than failing the turn', async () => {
    // workforce may add events. A Liftoff turn must not die because of one.
    mockFetch.mockResolvedValue(
      sseResponse([
        'event: something_new\ndata: {"whatever":1}\n\n',
        'event: complete\ndata: {"message":null}\n\n',
      ]),
    );

    const events = await collect(
      streamCAIOTurn({ caller: CALLER, workforceThreadId: 'tp-1', content: 'hi' }),
    );

    expect(events).toEqual([{ type: 'complete', message: null }]);
  });
});

describe('requestCAIOTurnStop', () => {
  it('posts to the paired thread\'s stop route', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await requestCAIOTurnStop({ caller: CALLER, workforceThreadId: 'tp-1' });

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://workforce.example.invalid/team-plan/threads/tp-1/stop');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'x-tenant-role': 'viewer' });
  });

  it('never throws, because the Liftoff turn is already ending', async () => {
    mockFetch.mockRejectedValue(new Error('gone'));

    await expect(
      requestCAIOTurnStop({ caller: CALLER, workforceThreadId: 'tp-1' }),
    ).resolves.toBeUndefined();
  });
});
