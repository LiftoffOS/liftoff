// The Claude SDK's history replay carries a tool exchange as text.
//
// The SDK's streaming input takes user messages only, so a replayed assistant
// call cannot be sent as a tool_use block and a replayed result cannot be sent
// as the tool_result that answers one. Rendering them — the same rendering
// the CLI engines' text preamble uses — is the one way they reach the model;
// dropping them, which is what happened, left a resumed run reading an
// approval's outcome from nowhere.

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  AbortError: class AbortError extends Error {},
  query: jest.fn(),
}));

import type { PlatformMessage } from '../types';

async function replayed(messages: PlatformMessage[]): Promise<string[]> {
  const { AnthropicAdapter } = await import('../anthropic');
  const adapter = new AnthropicAdapter();
  // Paused, so the generator ends once the initial messages are replayed
  // instead of waiting on the live queue.
  (adapter as unknown as { paused: boolean }).paused = true;
  const stream = (adapter as unknown as {
    makeStreamInput(m: PlatformMessage[]): AsyncIterable<{ message: { content: unknown } }>;
  }).makeStreamInput(messages);
  const out: string[] = [];
  for await (const m of stream) {
    const c = m.message.content;
    out.push(typeof c === 'string' ? c : JSON.stringify(c));
  }
  return out;
}

describe('Claude SDK history replay: tool exchanges reach the model as text', () => {
  it('renders the call with its arguments and the result with its payload, in content order', async () => {
    const texts = await replayed([
      { role: 'user', content: [{ type: 'text', text: 'Email Dana the summary.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Sending.' },
          { type: 'tool_use', toolName: 'gmail__send_email', callId: 'toolu_1', args: { to: 'dana@example.com' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', callId: 'toolu_1', result: '{"messageId":"m-1"}' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ]);
    expect(texts).toEqual([
      'Email Dana the summary.',
      'Sending.\n[called gmail__send_email({"to":"dana@example.com"})]',
      '[tool result: {"messageId":"m-1"}]',
      'continue',
    ]);
  });

  it('marks a failed result as an error', async () => {
    const texts = await replayed([
      { role: 'user', content: [{ type: 'tool_result', callId: 'toolu_2', result: '{"error":"quota"}', error: 'quota' }] },
    ]);
    expect(texts).toEqual(['[tool result error: {"error":"quota"}]']);
  });

  it('a turn that holds only tool blocks is sent, not skipped', async () => {
    const texts = await replayed([
      { role: 'assistant', content: [{ type: 'tool_use', toolName: 'web_search', callId: 'toolu_3', args: { query: 'x' } }] },
    ]);
    expect(texts).toEqual(['[called web_search({"query":"x"})]']);
  });
});
