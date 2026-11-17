// A model turn replayed to a Chat Completions endpoint is ONE assistant message.
//
// The SDK splits a chat-completions response into items — a reasoning item, a
// message item, one function-call item per call — and rebuilds messages from
// those items for the next request. Through 0.14 the rebuild emitted a separate
// assistant message per item, and the reasoning one had `content: null` and no
// `tool_calls`: a message that is nothing. Z.AI refuses that with code 1210 and
// no parameter name, so every event-triggered run on GLM died on its second
// request while chat turns, which rarely call a tool, kept passing. 0.16 folds
// the reasoning onto the message it belongs to and 0.17.1 merges a streamed
// turn's calls the same way.
//
// This pins the wire shape through the SDK's public Model interface, with a
// client that records the body instead of sending it, so a downgrade or an
// upstream regression fails here rather than at a provider that will not say
// what it rejected.

import { OpenAIChatCompletionsModel } from '@openai/agents-openai';
import { withTrace } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents';

type WireMessage = {
  role: string;
  content: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  reasoning?: string;
};

/** The client the model is handed: records the chat-completions body. */
function recordingClient(): { client: unknown; bodies: Array<{ messages: WireMessage[] }> } {
  const bodies: Array<{ messages: WireMessage[] }> = [];
  const client = {
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: 'test',
    chat: {
      completions: {
        create: jest.fn(async (body: { messages: WireMessage[] }) => {
          bodies.push(body);
          return {
            id: 'cmpl-1',
            choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        }),
      },
    },
  };
  return { client, bodies };
}

/** What the SDK holds after a turn that reasoned, spoke, and called two tools,
 *  in the order the non-streamed path produces them. */
const ONE_TURN: AgentInputItem[] = [
  { role: 'user', content: 'Review PR 123.' },
  { type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: 'I will read the diff first.' }] },
  { id: 'm1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Reading the diff.' }] },
  { id: 'c1', type: 'function_call', callId: 'call_1', name: 'get_pull_request', arguments: '{"number":123}', status: 'completed' },
  { id: 'c2', type: 'function_call', callId: 'call_2', name: 'get_pull_request_diff', arguments: '{"number":123}', status: 'completed' },
  { type: 'function_call_result', callId: 'call_1', name: 'get_pull_request', status: 'completed', output: { type: 'text', text: '{"head_sha":"abc"}' } },
  { type: 'function_call_result', callId: 'call_2', name: 'get_pull_request_diff', status: 'completed', output: { type: 'text', text: '+1 -1' } },
] as AgentInputItem[];

async function replay(items: AgentInputItem[]): Promise<WireMessage[]> {
  const { client, bodies } = recordingClient();
  const model = new OpenAIChatCompletionsModel(client as never, 'z-ai/glm-5-turbo');
  // The model opens a generation span, which needs an enclosing trace.
  await withTrace('replay', () => model.getResponse({
    systemInstructions: 'You are terse.',
    input: items,
    modelSettings: {},
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
  }));
  expect(bodies).toHaveLength(1);
  return bodies[0].messages;
}

describe('Chat Completions: replaying one model turn', () => {
  it('never sends an assistant message that has neither content nor tool calls', async () => {
    // The one shape Z.AI refuses. Everything else the turn carries — a
    // reasoning field, a parts-array content, several assistant messages in a
    // row — it accepts; this is the only message that is nothing.
    const messages = await replay(ONE_TURN);
    const nothing = messages.filter(
      (m) => m.role === 'assistant' && (m.content === null || m.content === undefined) && !(m.tool_calls && m.tool_calls.length > 0),
    );
    expect(nothing).toEqual([]);
  });

  it('keeps the reasoning, the text and the calls on ONE assistant message', async () => {
    const messages = await replay(ONE_TURN);
    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    const [turn] = assistants;
    expect(turn.reasoning).toBe('I will read the diff first.');
    expect(turn.content).toEqual([{ type: 'text', text: 'Reading the diff.' }]);
    expect(turn.tool_calls).toHaveLength(2);
  });

  it('answers every call with a tool message, after the message that made it', async () => {
    const messages = await replay(ONE_TURN);
    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'tool']);
    expect(messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['call_1', 'call_2']);
  });

  it('merges the turn when its calls arrive before its text', async () => {
    // The order the SDK's converter guards for a streamed turn. Same wire
    // shape either way.
    const [user, reasoning, message, c1, c2, ...results] = ONE_TURN;
    const messages = await replay([user, reasoning, c1, c2, message, ...results]);
    const assistants = messages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].tool_calls).toHaveLength(2);
    expect(assistants[0].reasoning).toBe('I will read the diff first.');
  });
});
