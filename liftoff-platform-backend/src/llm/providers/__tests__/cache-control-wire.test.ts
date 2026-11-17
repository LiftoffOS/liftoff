// A cache breakpoint reaches the gateway, and does NOT reach plain OpenAI.
//
// `cacheControl` on a message is a request to create a cache checkpoint there.
// It only ever reached Anthropic: `cache_control` is a property of a content
// BLOCK, and the OpenAI-wire builder emitted `content` as a plain string, which
// has nowhere to carry it. Nothing looked broken, because the gateway vendors
// cache automatically on a prefix of their own choosing — it simply cached less
// than it could.
//
// Measured against Qwen through the gateway before this was written: an explicit
// breakpoint cached 7,716 tokens where automatic caching cached 7,168-7,424, and
// made the repeat call 2.1-2.2x cheaper on plus and max. It costs 1.25x once to
// prime, so it pays back after roughly two turns — and a chat thread is the case
// that benefits most, because the system prompt is identical every turn.
//
// The negative half is the half that can break something. This builder also
// serves api.openai.com, which does not document the field; sending it there is
// a request shape the vendor never agreed to, and the failure would be a 400 on
// every assistant turn rather than a missed discount.

import { __internalBuildOpenAIMessages } from '../openai';
import type { LLMCompletionRequest } from '../../types';

function requestWithCachedSystem(): LLMCompletionRequest {
  return {
    messages: [
      { role: 'system', content: 'STANDING RULES', cacheControl: { type: 'ephemeral' } },
      { role: 'user', content: 'hello' },
    ],
  };
}

/** The wire shape of one message, narrowed enough to assert on. */
type WireMessage = {
  role: string;
  content: unknown;
};

describe('cache_control on the OpenAI wire', () => {
  it('emits a breakpoint block when the target accepts it', () => {
    const [system] = __internalBuildOpenAIMessages(
      requestWithCachedSystem(), true,
    ) as unknown as WireMessage[];
    expect(system.role).toBe('system');
    // The BLOCK shape, because that is where cache_control can live.
    expect(system.content).toEqual([
      { type: 'text', text: 'STANDING RULES', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('leaves the message a plain string when the target does not', () => {
    const [system] = __internalBuildOpenAIMessages(
      requestWithCachedSystem(), false,
    ) as unknown as WireMessage[];
    expect(system.content).toBe('STANDING RULES');
  });

  it('defaults to withholding it, so a new caller cannot 400 OpenAI by accident', () => {
    const [system] = __internalBuildOpenAIMessages(
      requestWithCachedSystem(),
    ) as unknown as WireMessage[];
    expect(system.content).toBe('STANDING RULES');
  });

  it('touches only the messages that asked for it', () => {
    const wire = __internalBuildOpenAIMessages(
      requestWithCachedSystem(), true,
    ) as unknown as WireMessage[];
    const user = wire.find((m) => m.role === 'user');
    expect(user?.content).toBe('hello');
  });

  it('does not emit a block for an empty message', () => {
    // A breakpoint on nothing is not a checkpoint, and the block shape would
    // send an empty text part where a string was expected.
    const wire = __internalBuildOpenAIMessages(
      {
        messages: [
          { role: 'system', content: '', cacheControl: { type: 'ephemeral' } },
          { role: 'user', content: 'hi' },
        ],
      },
      true,
    ) as unknown as WireMessage[];
    expect(wire[0].content).toBe('');
  });
});
