// Refusal normalization tests — every provider signals a safety refusal
// differently, and the adapters must normalise all of them to
// stopReason === 'refusal' so the unified client can fail loud rather than
// return an empty "successful" completion.

import type OpenAI from 'openai';
import { mapAnthropicStopReason } from '../anthropic-shared';
import { mapOpenAIFinishReason, OpenAIProvider } from '../openai';
import { GoogleProvider } from '../google';

jest.mock('../../../infrastructure/secrets', () => ({
  getOpenAIApiKey: jest.fn().mockResolvedValue('test-key'),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

async function* fromChunks<T>(chunks: T[]): AsyncIterable<T> {
  for (const c of chunks) yield c;
}

function makeOpenAIProvider(stub: unknown): OpenAIProvider {
  const Ctor = OpenAIProvider as unknown as new (client: unknown) => OpenAIProvider;
  return new Ctor(stub);
}

function makeGoogleProvider(vertexAI: unknown): GoogleProvider {
  const Ctor = GoogleProvider as unknown as new (vertexAI: unknown, projectId: string) => GoogleProvider;
  return new Ctor(vertexAI, 'test-project');
}

function buildVertexStub(opts: {
  generateContent?: jest.Mock;
  generateContentStream?: jest.Mock;
}) {
  const getGenerativeModel = jest.fn().mockReturnValue({
    generateContent: opts.generateContent ?? jest.fn(),
    generateContentStream: opts.generateContentStream ?? jest.fn(),
    startChat: jest.fn(),
  });
  return { getGenerativeModel };
}

describe('mapAnthropicStopReason — refusal', () => {
  it('maps "refusal" → "refusal"', () => {
    expect(mapAnthropicStopReason('refusal')).toBe('refusal');
  });

  it('still maps the non-refusal cases', () => {
    expect(mapAnthropicStopReason('tool_use')).toBe('tool_use');
    expect(mapAnthropicStopReason('max_tokens')).toBe('max_tokens');
    expect(mapAnthropicStopReason('end_turn')).toBe('end_turn');
    expect(mapAnthropicStopReason('stop_sequence')).toBe('end_turn');
    expect(mapAnthropicStopReason(null)).toBe('end_turn');
  });
});

describe('mapOpenAIFinishReason — refusal', () => {
  it('maps "content_filter" → "refusal"', () => {
    expect(mapOpenAIFinishReason('content_filter')).toBe('refusal');
  });

  it('still maps the non-refusal cases', () => {
    expect(mapOpenAIFinishReason('tool_calls')).toBe('tool_use');
    expect(mapOpenAIFinishReason('length')).toBe('max_tokens');
    expect(mapOpenAIFinishReason('stop')).toBe('end_turn');
    expect(mapOpenAIFinishReason(null)).toBe('end_turn');
  });
});

describe('OpenAIProvider — message.refusal', () => {
  it('non-streaming: promotes stopReason to "refusal" when message.refusal is set even if finish_reason is "stop"', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-5.4',
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: null, refusal: 'I cannot help with that.' },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    const provider = makeOpenAIProvider({ chat: { completions: { create } } } as unknown as OpenAI);

    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.stopReason).toBe('refusal');
    expect(result.refusalCategory).toBe('refusal');
  });

  it('non-streaming: content_filter finish_reason → refusal category "content_filter"', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-5.4',
      choices: [{ finish_reason: 'content_filter', message: { role: 'assistant', content: '' } }],
      usage: { prompt_tokens: 4, completion_tokens: 0 },
    });
    const provider = makeOpenAIProvider({ chat: { completions: { create } } } as unknown as OpenAI);

    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.stopReason).toBe('refusal');
    expect(result.refusalCategory).toBe('content_filter');
  });

  it('streaming: refusal deltas promote the terminal stopReason to "refusal"', async () => {
    const chunks = [
      { choices: [{ delta: { refusal: 'I cannot ' } }] },
      { choices: [{ delta: { refusal: 'help with that.' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 8, completion_tokens: 3 } },
    ];
    const create = jest.fn().mockResolvedValue(fromChunks(chunks));
    const provider = makeOpenAIProvider({ chat: { completions: { create } } } as unknown as OpenAI);

    const events = [];
    for await (const ev of provider.completeStream({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev);
    }
    const complete = events.find(e => e.type === 'message_complete');
    expect(complete).toMatchObject({ type: 'message_complete', stopReason: 'refusal', refusalCategory: 'refusal' });
    // Refusal text must NOT leak out as assistant text_delta.
    expect(events.some(e => e.type === 'text_delta')).toBe(false);
  });
});

describe('GoogleProvider — safety refusals', () => {
  it('non-streaming: candidate finishReason SAFETY → refusal', async () => {
    const generateContent = jest.fn().mockResolvedValue({
      response: {
        candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 0 },
      },
    });
    const provider = makeGoogleProvider(buildVertexStub({ generateContent }));

    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.stopReason).toBe('refusal');
    expect(result.refusalCategory).toBe('SAFETY');
  });

  it('non-streaming: candidate finishReason PROHIBITED_CONTENT → refusal', async () => {
    const generateContent = jest.fn().mockResolvedValue({
      response: {
        candidates: [{ content: { parts: [] }, finishReason: 'PROHIBITED_CONTENT' }],
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 0 },
      },
    });
    const provider = makeGoogleProvider(buildVertexStub({ generateContent }));

    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.stopReason).toBe('refusal');
  });

  it('non-streaming: prompt-level block (no candidates + promptFeedback.blockReason) → refusal', async () => {
    const generateContent = jest.fn().mockResolvedValue({
      response: {
        candidates: [],
        promptFeedback: { blockReason: 'BLOCKLIST' },
        usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 0 },
      },
    });
    const provider = makeGoogleProvider(buildVertexStub({ generateContent }));

    const result = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.stopReason).toBe('refusal');
    expect(result.refusalCategory).toBe('prompt_block:BLOCKLIST');
  });

  it('streaming: prompt-level block → refusal at message_complete', async () => {
    const chunks = [
      { candidates: [], promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 0 } },
    ];
    const generateContentStream = jest.fn().mockResolvedValue({ stream: fromChunks(chunks) });
    const provider = makeGoogleProvider(buildVertexStub({ generateContentStream }));

    const events = [];
    for await (const ev of provider.completeStream({ messages: [{ role: 'user', content: 'hi' }] })) {
      events.push(ev);
    }
    const complete = events.find(e => e.type === 'message_complete');
    expect(complete).toMatchObject({ type: 'message_complete', stopReason: 'refusal', refusalCategory: 'prompt_block:SAFETY' });
  });
});
