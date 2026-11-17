// A tool whose answer is a picture, across the providers that can carry one
// and the providers that cannot.
//
// The split is not the one you would guess, and it is why this file exists.
// Verified against the installed SDK types (2026-09-24):
//   Anthropic  tool_result.content: string | Array<TextBlockParam | ImageBlockParam | ...>
//   Google     FunctionResponse.parts: "List of parts that constitute a function response"
//   OpenAI     ChatCompletionToolMessageParam.content: string | Array<ChatCompletionContentPartText>
// So two vendors take the frame inside the tool result and one takes text and
// only text. OpenRouter extends the OpenAI provider and inherits that.
//
// What every caller is promised, and what these assert: it sets
// `LLMToolResult.images` and the model SEES the picture, at the same point in
// the conversation, on every provider. Only the envelope differs.

import type OpenAI from 'openai';
import { buildAnthropicMessages } from '../anthropic-shared';
import { OpenAIProvider } from '../openai';
import { GoogleProvider } from '../google';
import type { LLMMessage } from '../../types';

jest.mock('../../../infrastructure/secrets', () => ({
  getOpenAIApiKey: jest.fn().mockResolvedValue('test-key'),
}));
jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const FRAME = { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' };

const turn: LLMMessage[] = [
  { role: 'user', content: 'what does this page look like' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'read_active_browser_session', input: {} }] },
  {
    role: 'user',
    content: '',
    toolResults: [{ toolCallId: 'call-1', content: 'The browser is on https://a.example/.', images: [FRAME] }],
  },
];

describe('Anthropic carries the frame inside the tool result', () => {
  it('puts the text and the image in tool_result.content, in that order', () => {
    const built = buildAnthropicMessages({ messages: turn } as never);
    const userTurn = built.find(
      (m: { role: string; content: unknown }) => m.role === 'user' && Array.isArray(m.content)
        && (m.content as Array<{ type: string }>).some(b => b.type === 'tool_result'),
    ) as { content: Array<{ type: string; content: unknown }> };
    const result = userTurn.content.find(b => b.type === 'tool_result')!;
    expect(Array.isArray(result.content)).toBe(true);
    const blocks = result.content as Array<{ type: string; source?: { data: string; media_type: string } }>;
    expect(blocks.map(b => b.type)).toEqual(['text', 'image']);
    expect(blocks[1].source).toEqual({ type: 'base64', media_type: 'image/png', data: FRAME.dataBase64 });
  });

  it('a tool result with no frame is still a plain string, not a one-element array', () => {
    const plain: LLMMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 't', input: {} }] },
      { role: 'user', content: '', toolResults: [{ toolCallId: 'c', content: 'words' }] },
    ];
    const built = buildAnthropicMessages({ messages: plain } as never);
    const userTurn = built.find(
      (m: { role: string; content: unknown }) => m.role === 'user' && Array.isArray(m.content),
    ) as { content: Array<{ type: string; content: unknown }> };
    expect(userTurn.content.find(b => b.type === 'tool_result')!.content).toBe('words');
  });
});

describe('Google carries the frame inside the function response', () => {
  it('puts it in functionResponse.parts as inlineData', async () => {
    const generateContent = jest.fn().mockResolvedValue({
      response: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'ok' }] } }], usageMetadata: {} },
    });
    const vertexAI = { getGenerativeModel: jest.fn().mockReturnValue({ generateContent, generateContentStream: jest.fn(), startChat: jest.fn() }) };
    const Ctor = GoogleProvider as unknown as new (v: unknown, p: string) => GoogleProvider;
    await new Ctor(vertexAI, 'test-project').complete({ messages: turn, model: 'gemini-3-pro' } as never);

    const sent = generateContent.mock.calls[0][0] as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
    const fnPart = sent.contents.flatMap(c => c.parts).find(p => 'functionResponse' in p) as {
      functionResponse: { parts?: Array<{ inlineData: { mimeType: string; data: string } }> };
    };
    expect(fnPart.functionResponse.parts).toEqual([{ inlineData: { mimeType: 'image/png', data: FRAME.dataBase64 } }]);
  });
});

describe('OpenAI cannot, so the frame goes on the user turn straight after', () => {
  it('emits the tool message as text, then a user turn carrying the image', async () => {
    const create = jest.fn().mockResolvedValue({
      model: 'gpt-5.4', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: {},
    });
    const stub = { chat: { completions: { create } } } as unknown as OpenAI;
    const Ctor = OpenAIProvider as unknown as new (client: unknown) => OpenAIProvider;
    await new Ctor(stub).complete({ messages: turn, model: 'gpt-5.4' } as never);

    const sent = create.mock.calls[0][0] as { messages: Array<{ role: string; content: unknown; tool_call_id?: string }> };
    const toolIdx = sent.messages.findIndex(m => m.role === 'tool');
    expect(typeof sent.messages[toolIdx].content).toBe('string');

    // The very next message, so the model meets the picture where the tool
    // result left off rather than a turn later.
    const next = sent.messages[toolIdx + 1] as { role: string; content: Array<{ type: string; image_url?: { url: string } }> };
    expect(next.role).toBe('user');
    expect(next.content[0].type).toBe('image_url');
    expect(next.content[0].image_url!.url).toBe(`data:image/png;base64,${FRAME.dataBase64}`);
  });
});
