// A turn's messages carry two cache breakpoints: the system prompt, which
// does not change between turns, and the last message, so that each round of
// the tool-use loop reads the previous round's prefix from the cache instead
// of paying for every earlier round's results again. Nothing in between is
// marked — a mark on the middle of a growing prefix serves no lookup.

jest.mock('../infrastructure/config.js', () => ({
  loadConfig: () => ({ PLATFORM_BACKEND_URL: 'http://pb.test', WORKFORCE_SERVICE_TOKEN: 'tok' }),
}));

import { callPBLlmComplete } from '../llm/client.js';

interface SentMessage { role: string; content: string; cacheControl?: { type: string }; toolResults?: unknown[] }

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

async function sentMessages(conversation: Parameters<typeof callPBLlmComplete>[0]['conversation']): Promise<SentMessage[]> {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ content: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  await callPBLlmComplete({ systemPrompt: 'SYS', conversation, tools: [], maxTokens: 10, tenantId: 't1' });
  const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { request: { messages: SentMessage[] } };
  return body.request.messages;
}

describe('a turn’s messages', () => {
  it('mark the system prompt and the last message, and nothing between', async () => {
    const messages = await sentMessages([
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 't1', name: 'pull', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"items":2}' }] },
    ]);
    expect(messages.map((m) => [m.role, m.cacheControl?.type ?? null])).toEqual([
      ['system', 'ephemeral'],
      ['user', null],
      ['assistant', null],
      ['user', 'ephemeral'],
    ]);
    expect(messages[3].toolResults).toHaveLength(1);
  });

  it('mark the kickoff message when it is the only one', async () => {
    const messages = await sentMessages([{ role: 'user', content: 'hello' }]);
    expect(messages.map((m) => m.cacheControl?.type ?? null)).toEqual(['ephemeral', 'ephemeral']);
  });
});
