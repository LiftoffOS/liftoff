// Shared fixture for the Anthropic direct + Vertex providers.
//
// Both providers wrap the same SDK shape, so the test fixture is exactly one
// canned response that both can be driven through. Used by anthropic.test.ts
// to assert byte-for-byte parity (modulo the `provider` field) with the
// Vertex provider's behavior. Catches drift if a fix lands in one file but
// not the other.

import type { LLMCompletionResponse, LLMStreamEvent } from '../../../types';
import { AnthropicProvider } from '../../anthropic';

type AnyProviderCtor =
  | (new (client: unknown) => AnthropicProvider)
;

/** Canned non-streaming response: assistant says some text, then calls a tool. */
export const CANNED_COMPLETE_RESPONSE = {
  content: [
    { type: 'text', text: 'Looking up cost...' },
    { type: 'tool_use', id: 'toolu_01', name: 'get_cost', input: { period: 'week' } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 12, output_tokens: 8 },
  // Must track the providers' DEFAULT_MODEL. The parity fixture sends no explicit
  // model, so the request resolves to DEFAULT_MODEL: the Vertex provider echoes
  // that resolved request model, while the direct provider echoes this response
  // `model`. Parity only holds when the two match — keep this in sync with
  // DEFAULT_MODEL in providers/anthropic*.ts.
  model: 'claude-opus-5-5',
};

/** Canned streaming events: same shape, fragmented as the SDK would deliver. */
export const CANNED_STREAM_EVENTS = [
  { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking up cost...' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_cost', input: {} },
  },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"per' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'iod":"week"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
  { type: 'message_stop' },
];

async function* fromEvents<T>(events: T[]): AsyncIterable<T> {
  for (const e of events) yield e;
}

/** Drive a provider's `complete()` through the canned non-streaming fixture. */
export async function runProviderCompleteFixture(
  Ctor: AnyProviderCtor,
): Promise<LLMCompletionResponse> {
  const stub = {
    messages: { create: jest.fn().mockResolvedValue({ ...CANNED_COMPLETE_RESPONSE }) },
  };
  const provider = new (Ctor as new (client: unknown) => AnthropicProvider)(stub);
  return provider.complete({
    messages: [{ role: 'user', content: 'cost?' }],
    tools: [{
      name: 'get_cost',
      description: 'Get cost',
      input_schema: { type: 'object', properties: { period: { type: 'string' } } },
    }],
  });
}

/** Drive a provider's `completeStream()` through the canned streaming fixture. */
export async function runProviderStreamFixture(
  Ctor: AnyProviderCtor,
): Promise<LLMStreamEvent[]> {
  const stub = {
    messages: { stream: jest.fn().mockReturnValue(fromEvents(CANNED_STREAM_EVENTS)) },
  };
  const provider = new (Ctor as new (client: unknown) => AnthropicProvider)(stub);
  const events: LLMStreamEvent[] = [];
  for await (const ev of provider.completeStream({
    messages: [{ role: 'user', content: 'cost?' }],
    tools: [{ name: 'get_cost', description: '', input_schema: { type: 'object', properties: {} } }],
  })) {
    events.push(ev);
  }
  return events;
}
