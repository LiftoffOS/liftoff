// A stream that fails before it says anything is retried; one that fails after
// is not; and neither ever hands the provider's own words to a person.
//
// A provider capacity episode can arrive two ways. As an HTTP 529, the SDK
// retries it and the person sees nothing. As a mid-stream SSE frame, which no
// SDK retries, the person would get toasts containing the vendor's wire format.
// So there is one retry policy that does not care which side of the 200 the
// failure landed on, and one sentence that goes to the person instead of the
// payload.

import type { LLMProviderClient, LLMStreamEvent } from '../types';
import {
  classifyStreamFailure,
  isRetryableStreamFailure,
  streamFailureMessage,
} from '../stream-failure';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** An overloaded error as it arrives in a mid-stream SSE frame. */
const INCIDENT_FRAME =
  '{"type":"error","error":{"details":null,"type":"overloaded_error",'
  + '"message":"Overloaded"},"request_id":"req_011zHpbmM6LlcBwmsdb1eWiB"}';

/** The same condition by the other route: an HTTP error body, status-prefixed. */
const INCIDENT_HTTP_BODY =
  '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},'
  + '"request_id":"req_0117dtxn5nPJ1nuu32a9HQdz"}';

/** One scripted attempt per entry; the last is repeated if asked for again. */
let scripts: LLMStreamEvent[][] = [];
let attempts = 0;

class ScriptedProvider implements LLMProviderClient {
  readonly provider = 'openai' as const;
  async complete(): Promise<never> {
    throw new Error('not used in this test');
  }
  async *completeStream(): AsyncIterable<LLMStreamEvent> {
    const script = scripts[Math.min(attempts, scripts.length - 1)];
    attempts++;
    for (const ev of script) yield ev;
  }
  static async create(): Promise<ScriptedProvider> {
    return new ScriptedProvider();
  }
}

jest.mock('../providers', () => ({
  AnthropicProvider: { create: jest.fn().mockResolvedValue(null), createPool: jest.fn().mockResolvedValue(null) },
  GoogleProvider: { create: jest.fn().mockResolvedValue(null) },
  OpenRouterProvider: { createOpenRouter: jest.fn().mockResolvedValue(null) },
  OpenAIProvider: {
    create: jest.fn().mockImplementation(() => Promise.resolve(new ScriptedProvider())),
    createPool: jest.fn().mockImplementation(() => {
      const pool = new Map();
      const inst = new ScriptedProvider();
      for (const g of ['agent-execution', 'reflective-services', 'platform-analytics', 'background-services']) {
        pool.set(g, inst);
      }
      return Promise.resolve(pool);
    }),
  },
}));

const DONE: LLMStreamEvent = {
  type: 'message_complete',
  stopReason: 'end_turn',
  usage: { inputTokens: 7, outputTokens: 3 },
};

async function drain(): Promise<LLMStreamEvent[]> {
  const { llmClient } = await import('../client');
  const out: LLMStreamEvent[] = [];
  for await (const ev of llmClient.completeStream({ messages: [{ role: 'user', content: 'hi' }] })) {
    out.push(ev);
  }
  return out;
}

describe('classifying what the provider actually sent', () => {
  it('reads the mid-stream frame that no status can be found in', () => {
    // The reason a status-only retry policy misses this: there is no HTTP
    // status anywhere on this error. A status-only classifier scores it `unknown`.
    expect(classifyStreamFailure(new Error(INCIDENT_FRAME))).toBe('overloaded');
    expect(isRetryableStreamFailure('overloaded')).toBe(true);
  });

  it('reads the HTTP body form of the same condition identically', () => {
    // Same condition, other route. If these two classified differently we
    // would have rebuilt the split this file exists to prevent.
    expect(classifyStreamFailure(new Error(INCIDENT_HTTP_BODY))).toBe('overloaded');
  });

  it('does not retry what repeating cannot fix', () => {
    expect(classifyStreamFailure({ status: 400 })).toBe('invalid_request');
    expect(classifyStreamFailure({ status: 401 })).toBe('auth');
    expect(isRetryableStreamFailure('invalid_request')).toBe(false);
    expect(isRetryableStreamFailure('auth')).toBe(false);
    expect(isRetryableStreamFailure('context_overflow')).toBe(false);
  });

  it('never puts an identifier or a payload in what a person reads', () => {
    const classes = [
      'overloaded', 'rate_limited', 'timeout', 'connection',
      'context_overflow', 'auth', 'invalid_request', 'unknown',
    ] as const;
    for (const c of classes) {
      const msg = streamFailureMessage(c);
      expect(msg).not.toMatch(/req_|request_id|\{|\}|anthropic|openai|claude/i);
      // Product voice: no em dashes, no contractions, does not say "agent".
      expect(msg).not.toMatch(/—/);
      expect(msg).not.toMatch(/\b\w+'(s|t|re|ll|ve|d)\b/);
      expect(msg.toLowerCase()).not.toMatch(/\bagent\b/);
    }
  });
});

describe('retrying a stream that failed before it said anything', () => {
  beforeEach(() => {
    jest.resetModules();
    attempts = 0;
    scripts = [];
  });

  it('absorbs a mid-stream overload the person never sees', async () => {
    scripts = [
      [{ type: 'error', message: INCIDENT_FRAME }],
      [{ type: 'text_delta', text: 'the answer' }, DONE],
    ];

    const events = await drain();

    expect(attempts).toBe(2);
    expect(events).toEqual([{ type: 'text_delta', text: 'the answer' }, DONE]);
    expect(events.some(e => e.type === 'error')).toBe(false);
  });

  it('does NOT retry once content has been yielded', async () => {
    // The boundary that makes this safe. A retry here would append a second
    // answer to the first, and the first cannot be un-yielded.
    scripts = [
      [{ type: 'text_delta', text: 'half an ans' }, { type: 'error', message: INCIDENT_FRAME }],
      [{ type: 'text_delta', text: 'SHOULD NEVER APPEAR' }, DONE],
    ];

    const events = await drain();

    expect(attempts).toBe(1);
    expect(events[0]).toEqual({ type: 'text_delta', text: 'half an ans' });
    expect(events[1]).toEqual({
      type: 'error',
      message: streamFailureMessage('overloaded'),
    });
    expect(JSON.stringify(events)).not.toContain('SHOULD NEVER APPEAR');
  });

  it('gives up after a bounded number of attempts, saying something safe', async () => {
    scripts = [[{ type: 'error', message: INCIDENT_FRAME }]];

    const events = await drain();

    expect(attempts).toBe(3);
    expect(events).toEqual([
      { type: 'error', message: 'The service is busy right now. Please try again in a moment.' },
    ]);
  });

  it('never forwards the provider payload, even when it gives up', async () => {
    // The defect in its own right. This assertion is the one that must not be
    // relaxed: it is what stands between a capacity blip and a wire frame in a
    // chat window.
    scripts = [[{ type: 'error', message: INCIDENT_FRAME }]];

    const serialized = JSON.stringify(await drain());

    expect(serialized).not.toContain('req_011zHpbmM6LlcBwmsdb1eWiB');
    expect(serialized).not.toContain('overloaded_error');
    expect(serialized).not.toContain('"details"');
  });

  it('does not retry a failure that repeating cannot fix', async () => {
    scripts = [[{ type: 'error', message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}' }]];

    const events = await drain();

    expect(attempts).toBe(1);
    expect(events).toEqual([
      { type: 'error', message: streamFailureMessage('invalid_request') },
    ]);
  });
});
