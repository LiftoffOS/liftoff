/**
 * The `complete` frame carries `delegatedTo`: the runtime agent ids of the
 * teammates a chat turn handed work to. The parser copies it through as the
 * list of strings it is, and nothing else — a malformed entry names nobody,
 * and an older runtime that sends no field reads as no hand-over rather than
 * as a failed turn. Harness mirrors tenant-runtime-client-chat-body.test.ts.
 */

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getIdTokenClient: jest.fn().mockRejectedValue(new Error('no metadata server')),
  })),
}));

jest.mock('../../tenants/repository', () => ({
  TenantRepository: jest.fn().mockImplementation(() => ({
    findById: jest.fn().mockResolvedValue(null),
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { tenantRuntimeClient, type ChatTurnStreamEvent } from '../tenant-runtime-client';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function params() {
  return {
    agentId: '22222222-2222-4222-8222-222222222222',
    threadId: '33333333-3333-4333-8333-333333333333',
    invocationId: 'inv-1',
    userMessage: 'hello',
    channelHint: 'web' as const,
    userId: 'user-1',
    userDisplayName: 'Test',
    userRole: 'member',
  };
}

/** An SSE response that delivers exactly the given frames, then ends. */
function sseResponse(frames: Array<{ event: string; data: unknown }>) {
  const text = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
  let delivered = false;
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: {
      getReader: () => ({
        read: async () => {
          if (delivered) return { done: true, value: undefined };
          delivered = true;
          return { done: false, value: new TextEncoder().encode(text) };
        },
        releaseLock: () => undefined,
      }),
    },
  };
}

async function collect(): Promise<ChatTurnStreamEvent[]> {
  const out: ChatTurnStreamEvent[] = [];
  for await (const e of tenantRuntimeClient.runChatTurnStream(TENANT_ID, params())) out.push(e);
  return out;
}

const COMPLETE = { outputText: 'Reviewed.', inputTokens: 1, outputTokens: 2, sessionId: 's' };

beforeEach(() => {
  mockFetch.mockReset();
});

describe('runChatTurnStream — delegatedTo on the complete frame', () => {
  it('copies the list of ids through, in order', async () => {
    mockFetch.mockResolvedValue(sseResponse([
      { event: 'complete', data: { ...COMPLETE, delegatedTo: ['rt-8', 'rt-7'] } },
    ]));
    const [complete] = await collect();
    expect(complete).toEqual({ type: 'complete', ...COMPLETE, delegatedTo: ['rt-8', 'rt-7'] });
  });

  it('keeps only the strings from a list with junk in it', async () => {
    mockFetch.mockResolvedValue(sseResponse([
      { event: 'complete', data: { ...COMPLETE, delegatedTo: ['rt-7', 7, null, { id: 'x' }] } },
    ]));
    const [complete] = await collect();
    expect((complete as { delegatedTo?: string[] }).delegatedTo).toEqual(['rt-7']);
  });

  it('leaves the field off when an older runtime sends none, or sends something that is not a list', async () => {
    mockFetch.mockResolvedValue(sseResponse([{ event: 'complete', data: COMPLETE }]));
    const [absent] = await collect();
    expect(absent).toEqual({ type: 'complete', ...COMPLETE });

    mockFetch.mockResolvedValue(sseResponse([{ event: 'complete', data: { ...COMPLETE, delegatedTo: 'rt-7' } }]));
    const [notAList] = await collect();
    expect(notAList).toEqual({ type: 'complete', ...COMPLETE });
  });
});

// The two pauses that persist speech carry the field for the same reason
// `complete` does, and read it through the same parser.
describe('runChatTurnStream — delegatedTo on the pause frames', () => {
  it('copies it through on hitl_required', async () => {
    mockFetch.mockResolvedValue(sseResponse([
      { event: 'hitl_required', data: { approvalId: 'a-1', reason: 'needs approval', delegatedTo: ['rt-7', 3] } },
    ]));
    const [paused] = await collect();
    expect(paused).toEqual({
      type: 'hitl_required', approvalId: 'a-1', reason: 'needs approval',
      action: null, why: null, detail: null, delegatedTo: ['rt-7'],
    });
  });

  it('copies it through on awaiting_input, and leaves it off when absent', async () => {
    mockFetch.mockResolvedValue(sseResponse([
      { event: 'awaiting_input', data: { question: 'Which one?', sessionId: 's-1', delegatedTo: ['rt-8'] } },
    ]));
    const [asking] = await collect();
    expect(asking).toEqual({ type: 'awaiting_input', question: 'Which one?', sessionId: 's-1', delegatedTo: ['rt-8'] });

    mockFetch.mockResolvedValue(sseResponse([
      { event: 'awaiting_input', data: { question: 'Which one?', sessionId: 's-1' } },
    ]));
    const [absent] = await collect();
    expect(absent).toEqual({ type: 'awaiting_input', question: 'Which one?', sessionId: 's-1' });
  });
});
