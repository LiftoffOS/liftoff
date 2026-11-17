// Non-stream acknowledgment plumbing: TR answers the chat-turn POST with plain
// JSON (never SSE) when the message was folded into an in-flight run, answered
// a pending clarification, or stopped a run. These tests pin the PB-side
// mapping at both seams: the TR client (JSON body → typed events, instead of
// feeding JSON to the SSE parser and misreading it as a dead stream) and the
// stream router (typed event → SSE frame the web client dispatches on).

import { TenantRuntimeClient, type ChatTurnStreamEvent } from '../../connectors/tenant-runtime-client';
import { writeAgentChatEventAsSse } from '../stream-router';
import { openChatStream, type ChatStream } from '../../common/chat-stream';
import type { Response } from 'express';

jest.mock('../../connectors/tenant-runtime-url', () => ({
  resolveRuntimeBaseUrl: jest.fn().mockResolvedValue('https://tr.example.test'),
  buildRuntimeHeaders: jest.fn().mockResolvedValue({ 'Content-Type': 'application/json' }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));

function jsonResponse(body: unknown): Partial<globalThis.Response> {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: {} as ReadableStream,
    json: async () => body,
  };
}

async function collect(client: TenantRuntimeClient): Promise<ChatTurnStreamEvent[]> {
  const events: ChatTurnStreamEvent[] = [];
  for await (const event of client.runChatTurnStream('11111111-1111-1111-1111-111111111111', {
    agentId: 'a', threadId: 't', invocationId: 'i',
    channelHint: 'web', userId: 'u', userDisplayName: 'U', userRole: 'member',
    userMessage: 'hello',
  })) {
    events.push(event);
  }
  return events;
}

describe('runChatTurnStream — non-SSE JSON acknowledgments', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('maps deliveredAs interrupt to interrupt_delivered', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ acknowledged: true, deliveredAs: 'interrupt' }),
    ) as unknown as typeof fetch;
    expect(await collect(new TenantRuntimeClient())).toEqual([{ type: 'interrupt_delivered' }]);
  });

  it('maps resumed to clarification_accepted', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ resumed: true }),
    ) as unknown as typeof fetch;
    expect(await collect(new TenantRuntimeClient())).toEqual([{ type: 'clarification_accepted' }]);
  });

  it('maps deliveredAs abort AND noop to stop_acknowledged', async () => {
    for (const deliveredAs of ['abort', 'noop']) {
      global.fetch = jest.fn().mockResolvedValue(
        jsonResponse({ acknowledged: true, deliveredAs }),
      ) as unknown as typeof fetch;
      expect(await collect(new TenantRuntimeClient())).toEqual([{ type: 'stop_acknowledged' }]);
    }
  });

  it('surfaces an unknown JSON shape as an error event, not a dead stream', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ unexpected: true }),
    ) as unknown as typeof fetch;
    const events = await collect(new TenantRuntimeClient());
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect((events[0] as { code: string }).code).toBe('UNEXPECTED_RESPONSE');
  });
});

// Asserted through the REAL ChatStream rather than a stand-in for it, so these
// pin the bytes production writes. The wrapper is also what now guarantees this
// router's stream cannot be closed without its terminal frame — which it never
// lost, but only because its `interrupt_delivered` is a domain event that
// reaches the `finally`, where Liftoff's and Insights' were early exits above it
// (src/common/chat-stream.ts).
function capture(): { stream: ChatStream; frames: string[] } {
  const frames: string[] = [];
  const res = {
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    write: (chunk: string) => { frames.push(chunk); return true; },
    end: () => undefined,
    writableEnded: false,
    destroyed: false,
  } as unknown as Response;
  return { stream: openChatStream(res), frames };
}

describe('writeAgentChatEventAsSse — acknowledgment frames', () => {
  it.each([
    ['interrupt_delivered'],
    ['clarification_accepted'],
    ['stop_acknowledged'],
  ] as const)('emits an %s frame', (type) => {
    const { stream, frames } = capture();
    writeAgentChatEventAsSse(stream, { type } as never);
    expect(frames.join('')).toBe(`event: ${type}\ndata: {}\n\n`);
  });
});

// Message boundaries must survive the middle hop. The runtime emits a
// payload-free `text_break` when an assistant message ends, and the web client
// places a paragraph break on it. Platform-backend proxies that stream, and a
// frame it does not know is logged and dropped — so shipping the two ends
// without this hop left the browser fusing consecutive messages into one
// run-on block, which is exactly the bug the frame was added to fix.
describe('text_break relays end to end', () => {
  it('stream router writes a text_break SSE frame with an empty payload', () => {
    const { stream, frames } = capture();
    writeAgentChatEventAsSse(stream, { type: 'text_break' });

    expect(frames.join('')).toContain('event: text_break');
    expect(frames.join('')).toContain('data: {}');
  });

  it('is a distinct event from text_delta, carrying no text', () => {
    const { stream, frames } = capture();

    writeAgentChatEventAsSse(stream, { type: 'text_delta', text: 'hello' });
    writeAgentChatEventAsSse(stream, { type: 'text_break' });

    const written = frames.join('');
    const events = [...written.matchAll(/event: (\S+)/g)].map(m => m[1]);
    expect(events).toEqual(['text_delta', 'text_break']);
    expect(written).toContain('"text":"hello"');
  });
});

// A hand-over is attributed on the wire with the same frame Liftoff sends, so
// the browser has one handler for "a colleague is working on this reply" on
// every surface: the teammate's id as `author` and its name as `authorLabel`.
describe('delegation_started carries { author, authorLabel }', () => {
  it('writes the teammate id and label, and nothing else', () => {
    const { stream, frames } = capture();

    writeAgentChatEventAsSse(stream, {
      type: 'delegation_started',
      author: '00000000-0000-0000-0000-000000000007',
      authorLabel: 'Security Review',
    });

    expect(frames.join('')).toBe(
      'event: delegation_started\n'
      + 'data: {"author":"00000000-0000-0000-0000-000000000007","authorLabel":"Security Review"}\n\n',
    );
  });
});
