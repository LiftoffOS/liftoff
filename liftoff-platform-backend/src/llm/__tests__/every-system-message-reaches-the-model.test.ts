// A system message a caller writes has to reach the model, on every provider.
//
// Two of the five providers take the system prompt as its OWN request field and
// skip system-role entries when they build the turn list. Both read it with
// `messages.find(m => m.role === 'system')`, which is the first one. A caller
// that sends two therefore had the second silently dropped — no error, no
// warning, and only on those providers.
//
// `buildBudgetedPrompt` sends two. The first is the system prompt; the second is
// a preamble carrying the caller's name, their role and the conversation's
// rolling summary, and it is what Liftoff chat and the Insights chat use to know
// who they are talking to and what was said before the window. On OpenAI both
// arrived. On Anthropic and Gemini the second did not, so the same conversation
// behaved differently depending on which provider the tenant had selected.
//
// This is a PROPERTY test over the request builders rather than a test of one
// caller: the defect is in how a provider reads the request, so it recurs the
// next time somebody writes `messages.find(role === 'system')`.

import { buildAnthropicMessages, buildAnthropicSystemParam } from '../providers/anthropic-shared';
import type { LLMCompletionRequest, LLMMessage } from '../types';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/** The shape buildBudgetedPrompt actually emits. */
const TWO_SYSTEM_MESSAGES: LLMMessage[] = [
  { role: 'system', content: 'PROMPT', cacheControl: { type: 'ephemeral' } },
  { role: 'system', content: '## User context\nCaller: Ada (admin)' },
  { role: 'user', content: 'what did we decide?' },
];

function requestWith(messages: LLMMessage[]): LLMCompletionRequest {
  return { messages };
}

describe('Anthropic', () => {
  it('carries every system message, in order', () => {
    const system = buildAnthropicSystemParam(TWO_SYSTEM_MESSAGES);

    expect(system).toEqual([
      { type: 'text', text: 'PROMPT', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '## User context\nCaller: Ada (admin)' },
    ]);
  });

  it('marks only the message the caller marked, so the volatile half stays outside the cached span', () => {
    // The point of splitting rather than joining. The breakpoint sits at the end
    // of the stable block; the preamble after it is re-read each turn without
    // moving the prefix. A join would put the preamble inside the cached span
    // and every turn would miss.
    const system = buildAnthropicSystemParam(TWO_SYSTEM_MESSAGES) as Array<{
      cache_control?: unknown;
    }>;

    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1].cache_control).toBeUndefined();
  });

  it('still returns a plain string for the ordinary single unmarked prompt', () => {
    // The shape every existing caller and vendor example uses. Changing it for
    // the common case would be churn with nothing bought.
    expect(buildAnthropicSystemParam([
      { role: 'system', content: 'PROMPT' },
      { role: 'user', content: 'hi' },
    ])).toBe('PROMPT');
  });

  it('returns undefined when there is no system message', () => {
    expect(buildAnthropicSystemParam([{ role: 'user', content: 'hi' }])).toBeUndefined();
  });

  it('skips an empty system message rather than sending a blank block', () => {
    // The vendor rejects an empty text block, and a caller that conditionally
    // builds a preamble hands over '' when there is nothing in it.
    expect(buildAnthropicSystemParam([
      { role: 'system', content: 'PROMPT' },
      { role: 'system', content: '' },
      { role: 'user', content: 'hi' },
    ])).toBe('PROMPT');
  });

  it('does not also leave the system messages in the turn list', () => {
    // They are carried by the `system` parameter; a duplicate in `messages`
    // would be rejected by the vendor, which only accepts user and assistant.
    const turns = buildAnthropicMessages(requestWith(TWO_SYSTEM_MESSAGES));

    expect(turns.map(t => t.role)).toEqual(['user']);
  });
});

describe('a cache breakpoint on a TURN', () => {
  // `LLMMessage.cacheControl` says "a checkpoint at this message's position",
  // and for every position but the system one that was not true: the turn
  // builder never read the field, so a caller that marked a user turn got
  // nothing and looked identical to one that had marked the right thing.
  //
  // The placement is a real choice, not a detail. A conversation marks its
  // system prompt so the volatile turns stay OUTSIDE the cached span. A
  // single-shot call repeated with identical input — the workflow diagram,
  // generated once for the preview and once by the writer — wants the whole
  // request inside it, and can only say so on the last turn.

  it('lands on the last content block of the marked turn', () => {
    // Last, because the cached prefix runs up to and INCLUDING the marked
    // block. Anywhere earlier leaves the rest of the same message outside it.
    const turns = buildAnthropicMessages(requestWith([
      { role: 'system', content: 'RULES' },
      { role: 'user', content: 'THE WHOLE REQUEST', cacheControl: { type: 'ephemeral' } },
    ]));

    expect(turns).toHaveLength(1);
    expect(turns[0].content).toEqual([
      { type: 'text', text: 'THE WHOLE REQUEST', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('leaves an unmarked turn as a bare string', () => {
    // The ordinary shape, unchanged. Turning every turn into a block array
    // would be churn on every request this platform makes.
    const turns = buildAnthropicMessages(requestWith([
      { role: 'user', content: 'hello' },
    ]));

    expect(turns[0].content).toBe('hello');
  });

  it('marks the text block that follows a turn\'s images', () => {
    const turns = buildAnthropicMessages(requestWith([
      {
        role: 'user',
        content: 'what is in this picture?',
        images: [{ mimeType: 'image/png', dataBase64: 'AAAA' }],
        cacheControl: { type: 'ephemeral' },
      },
    ]));

    const blocks = turns[0].content as Array<{ type: string; cache_control?: unknown }>;
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].type).toBe('text');
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks an assistant turn that carried tool calls', () => {
    const turns = buildAnthropicMessages(requestWith([
      {
        role: 'assistant',
        content: 'calling',
        toolCalls: [{ id: 't1', name: 'read', input: {} }],
        cacheControl: { type: 'ephemeral' },
      },
    ]));

    const blocks = turns[0].content as Array<{ type: string; cache_control?: unknown }>;
    expect(blocks[blocks.length - 1].type).toBe('tool_use');
    expect(blocks[blocks.length - 1].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('the caller that sends two', () => {
  // The two halves tied together: not "the builder handles an array with two
  // entries" but "what buildBudgetedPrompt actually emits arrives intact".
  const { buildBudgetedPrompt } = require('../../insights/context-budget');

  it('carries the caller context and the rolling summary that the budget built', () => {
    const budgeted = buildBudgetedPrompt({
      systemPrompt: 'PROMPT',
      userContext: 'Caller: Ada (admin)',
      rollingSummary: 'They were investigating last month\'s spend.',
      recentTurns: [],
      currentMessage: 'and what about this month?',
    });

    const system = buildAnthropicSystemParam(budgeted.messages);
    const rendered = Array.isArray(system)
      ? system.map(b => b.text).join('\n')
      : String(system);

    expect(rendered).toContain('PROMPT');
    expect(rendered).toContain('Caller: Ada (admin)');
    expect(rendered).toContain("They were investigating last month's spend.");
  });
});

describe('Google', () => {
  // The provider module pulls in the vendor SDK, so the request builder is
  // exercised through the same seam the provider uses rather than by
  // instantiating a client that would need credentials.
  const { __internalBuildGoogleContents } = require('../providers/google');

  it('joins every system message into the instruction', () => {
    const { systemInstruction, contents } = __internalBuildGoogleContents(
      requestWith(TWO_SYSTEM_MESSAGES),
    );

    expect(systemInstruction).toBe('PROMPT\n\n## User context\nCaller: Ada (admin)');
    expect(contents).toHaveLength(1);
  });

  it('is undefined when there is no system message', () => {
    const { systemInstruction } = __internalBuildGoogleContents(
      requestWith([{ role: 'user', content: 'hi' }]),
    );

    expect(systemInstruction).toBeUndefined();
  });
});

describe('OpenAI-wire', () => {
  const { __internalBuildOpenAIMessages } = require('../providers/openai');

  it('passes every system message through as its own turn', () => {
    // This wire format has no separate system field, so both were already
    // arriving. Pinned so the three providers cannot diverge again.
    const messages = __internalBuildOpenAIMessages(requestWith(TWO_SYSTEM_MESSAGES));

    expect(messages.map((m: { role: string }) => m.role)).toEqual(['system', 'system', 'user']);
  });
});
