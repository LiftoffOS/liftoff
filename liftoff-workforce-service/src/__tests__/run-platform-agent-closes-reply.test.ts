// A reply is closed, not abandoned. When a run's text is a reply someone is
// waiting to read, spending the tool rounds, filling the guarded share of the
// model's window, or passing the reply's deadline earns one more model call
// with no tools, so the person gets an answer from what the run found rather
// than the narration that preceded its last call. A run with no reply to close
// ends at the bound exactly as before.
//
// The bounds permit the work: fifty rounds, and a guard on the prompt each
// call carried against the served model's window rather than on a sum across
// calls, which was "N rounds of a context of size C" in disguise.

import { runPlatformAgent } from '../platform-agent/execution.js';
import type { PlatformAgentEvent } from '../platform-agent/types.js';
import type { LLMToolDefinition } from '../llm/types.js';

jest.mock('../platform-agent/config.js', () => ({
  loadPlatformAgentConfig: jest.fn().mockResolvedValue({
    agentId: '00000000-0000-0000-0000-000000000003',
    systemRole: 'caio',
    systemPromptTemplate: 'You are the CAIO. Tools: {{TOOLS}}',
    modelConfig: { tier: 'medium' },
  }),
}));

jest.mock('../platform-agent/audit-log-writer.js', () => ({
  writeAgentAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../llm/client.js', () => ({
  callPBLlmComplete: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { callPBLlmComplete } = require('../llm/client.js');

const tools: LLMToolDefinition[] = [
  { name: 'pull', description: 'Pulls a page of results', input_schema: { type: 'object', properties: {} } },
];

/** The window every call in this file is measured against, pinned: the
 *  registry's real windows differ by model and by week. */
const WINDOW = 200_000;

const toolTurn = (n: number, contextTokens = 10) => ({
  content: [{ type: 'tool_use', id: `t${n}`, name: 'pull', input: { page: n } }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 10, output_tokens: 5, context_tokens: contextTokens },
  context_window: WINDOW,
});
const textTurn = (text: string) => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5, context_tokens: 10 },
  context_window: WINDOW,
});

async function drain(input: Parameters<typeof runPlatformAgent>[0]): Promise<PlatformAgentEvent[]> {
  const events: PlatformAgentEvent[] = [];
  for await (const e of runPlatformAgent(input)) events.push(e);
  return events;
}

const baseInput = (overrides = {}): Parameters<typeof runPlatformAgent>[0] => ({
  agentId: '00000000-0000-0000-0000-000000000003',
  tenantId: 'tenant-1',
  objective: 'pull ten results',
  tools,
  toolContext: { tenantId: 'tenant-1' },
  dispatchToolCall: jest.fn().mockResolvedValue({ ok: true, data: { items: 2 } }),
  auditAction: 'caio.chat_turn',
  usagePurpose: 'caio_workforce_planning',
  triggeredBy: 'human:acct-1',
  ...overrides,
});

type Call = { tools: unknown[]; conversation: Array<{ role: string; content: unknown }> };
const calls = (): Call[] => (callPBLlmComplete as jest.Mock).mock.calls.map((c) => c[0] as Call);
const lastUserText = (call: Call): string => {
  const last = call.conversation[call.conversation.length - 1];
  return typeof last.content === 'string' ? last.content : '';
};
const summary = (events: PlatformAgentEvent[]) => {
  const done = events.find((e) => e.type === 'complete');
  if (!done || done.type !== 'complete') throw new Error('no complete event');
  return done.summary;
};
const streamedText = (events: PlatformAgentEvent[]): string =>
  events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('');

const CLOSING = /^You must write the reply now, without calling a tool\./;
const NOT_RUN = { error: 'Not run: answer now from what you have.' };

beforeEach(() => {
  (callPBLlmComplete as jest.Mock).mockReset();
});

describe('a reply whose tool rounds are spent', () => {
  it('is closed by one more call with no tools, framed to answer from what it has, after fifty rounds', async () => {
    for (let i = 1; i <= 50; i++) (callPBLlmComplete as jest.Mock).mockResolvedValueOnce(toolTurn(i));
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce(textTurn('Here are the eight I found; two pages remain.\n[continue]'));

    const events = await drain(baseInput({ reply: {} }));

    expect(calls()).toHaveLength(51);
    const closingCall = calls()[50];
    expect(closingCall.tools).toEqual([]);
    expect(lastUserText(closingCall)).toMatch(CLOSING);
    // The note names no mechanic for the model to relay, and asks for the
    // verdict line.
    expect(lastUserText(closingCall)).toContain('do not mention limits, budgets or rounds');
    expect(lastUserText(closingCall)).toContain('[continue]');
    // The last round's results were appended before the note, so the closing
    // call reads them.
    const beforeNote = closingCall.conversation[closingCall.conversation.length - 2];
    expect(beforeNote.role).toBe('user');
    expect(Array.isArray(beforeNote.content)).toBe(true);

    const s = summary(events);
    expect(s.terminator).toBe('max_iterations');
    // The verdict travels as a fact, and the line is gone from the text and
    // from what streamed.
    expect(s.unfinished).toBe(true);
    expect(s.text).toBe('Here are the eight I found; two pages remain.');
    expect(streamedText(events)).toBe(s.text);
    expect(streamedText(events)).not.toContain('[continue]');
  });

  it('ends at the bound, with no closing call, when the run has no reply to close', async () => {
    for (let i = 1; i <= 52; i++) (callPBLlmComplete as jest.Mock).mockResolvedValueOnce(toolTurn(i));

    const events = await drain(baseInput());

    expect(calls()).toHaveLength(50);
    expect(summary(events).terminator).toBe('max_iterations');
    expect(summary(events).unfinished).toBeUndefined();
  });
});

describe('a reply whose deadline has passed', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is closed at once when the deadline has already passed', async () => {
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce(textTurn('Here is what I have.\n[done]'));

    const events = await drain(baseInput({ reply: { deadlineAt: Date.now() - 1 } }));

    expect(calls()).toHaveLength(1);
    expect(calls()[0].tools).toEqual([]);
    expect(lastUserText(calls()[0])).toMatch(CLOSING);
    expect(summary(events).terminator).toBe('deadline');
    expect(summary(events).unfinished).toBe(false);
    expect(summary(events).text).toBe('Here is what I have.');
  });

  it('answers the calls in flight as not run when it passes mid-call, then closes with no tools', async () => {
    // The deadline passes while the first model call is in flight: the round
    // it asks for is not run, and the next call is the closing one.
    let now = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    (callPBLlmComplete as jest.Mock)
      .mockImplementationOnce(async () => {
        now = 2_000;
        return toolTurn(1);
      })
      .mockResolvedValueOnce(textTurn('Time is up; here is what I have.'));
    const dispatch = jest.fn().mockResolvedValue({ ok: true, data: { items: 2 } });

    const events = await drain(baseInput({ dispatchToolCall: dispatch, reply: { deadlineAt: 1_000 } }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'tool_call')).toBeUndefined();
    expect(calls()).toHaveLength(2);
    const closingCall = calls()[1];
    expect(closingCall.tools).toEqual([]);
    expect(lastUserText(closingCall)).toMatch(CLOSING);
    const results = closingCall.conversation[closingCall.conversation.length - 2].content as Array<{ tool_use_id: string; content: string }>;
    expect(results).toHaveLength(1);
    expect(results[0].tool_use_id).toBe('t1');
    expect(JSON.parse(results[0].content)).toEqual(NOT_RUN);

    const s = summary(events);
    expect(s.terminator).toBe('deadline');
    expect(s.text).toBe('Time is up; here is what I have.');
    // A closing reply with no verdict line is read as unfinished: the bound
    // closed it, and the caller's cap bounds a model that never writes the line.
    expect(s.unfinished).toBe(true);
    expect(s.toolCalls).toEqual([]);
  });

  it('runs every round as usual while the deadline is ahead', async () => {
    (callPBLlmComplete as jest.Mock)
      .mockResolvedValueOnce(toolTurn(1))
      .mockResolvedValueOnce(textTurn('done'));
    const dispatch = jest.fn().mockResolvedValue({ ok: true, data: { items: 2 } });

    const events = await drain(baseInput({ dispatchToolCall: dispatch, reply: { deadlineAt: Date.now() + 60_000 } }));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(calls()[1].tools).toHaveLength(1);
    expect(summary(events).terminator).toBe('normal');
    expect(summary(events).unfinished).toBeUndefined();
  });
});

describe('a call whose prompt fills the guarded share of the window', () => {
  it('answers the round in flight as not run, then closes with no tools', async () => {
    (callPBLlmComplete as jest.Mock)
      .mockResolvedValueOnce(toolTurn(1, 150_000))
      .mockResolvedValueOnce(textTurn('Here is what I have.\n\n[continue]'));
    const dispatch = jest.fn().mockResolvedValue({ ok: true, data: { items: 2 } });

    const events = await drain(baseInput({ dispatchToolCall: dispatch, reply: {} }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(calls()).toHaveLength(2);
    const closingCall = calls()[1];
    expect(closingCall.tools).toEqual([]);
    expect(lastUserText(closingCall)).toMatch(CLOSING);
    const results = closingCall.conversation[closingCall.conversation.length - 2].content as Array<{ tool_use_id: string; content: string }>;
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].content)).toEqual(NOT_RUN);

    const s = summary(events);
    expect(s.terminator).toBe('context_full');
    expect(s.text).toBe('Here is what I have.');
    expect(s.unfinished).toBe(true);
    expect(streamedText(events)).not.toContain('[continue]');
  });

  it('ends at once, with nothing run, when the run has no reply to close', async () => {
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce(toolTurn(1, 150_000));
    const dispatch = jest.fn().mockResolvedValue({ ok: true, data: { items: 2 } });

    const events = await drain(baseInput({ dispatchToolCall: dispatch }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(calls()).toHaveLength(1);
    expect(summary(events).terminator).toBe('context_full');
  });

  it('measures the prompt each call carried, never a sum: thirty rounds of a 14k context do not trip it', async () => {
    for (let i = 1; i <= 30; i++) (callPBLlmComplete as jest.Mock).mockResolvedValueOnce(toolTurn(i, 14_000));
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce(textTurn('Done after thirty rounds.'));
    const dispatch = jest.fn().mockResolvedValue({ ok: true, data: { items: 2 } });

    const events = await drain(baseInput({ dispatchToolCall: dispatch, reply: {} }));

    // 420k of re-sent prompt, which the old cumulative cap would have stopped
    // at the second round; thirty rounds ran and the answer was written.
    expect(dispatch).toHaveBeenCalledTimes(30);
    expect(calls()).toHaveLength(31);
    expect(calls().every((c) => c.tools.length === 1)).toBe(true);
    const s = summary(events);
    expect(s.terminator).toBe('normal');
    expect(s.text).toBe('Done after thirty rounds.');
    expect(s.unfinished).toBeUndefined();
  });

  it('stays inert when the relay reports neither the context nor the window (an older backend)', async () => {
    (callPBLlmComplete as jest.Mock)
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 't1', name: 'pull', input: { page: 1 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 190_000, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 190_000, output_tokens: 5 },
      });
    const dispatch = jest.fn().mockResolvedValue({ ok: true, data: { items: 2 } });

    const events = await drain(baseInput({ dispatchToolCall: dispatch, reply: {} }));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(calls()).toHaveLength(2);
    expect(calls()[1].tools).toHaveLength(1);
    expect(summary(events).terminator).toBe('normal');
  });
});

describe('the closing call', () => {
  it('has nothing it asks for run', async () => {
    for (let i = 1; i <= 50; i++) (callPBLlmComplete as jest.Mock).mockResolvedValueOnce(toolTurn(i));
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce(toolTurn(51));
    const dispatch = jest.fn().mockResolvedValue({ ok: true, data: { items: 2 } });

    const events = await drain(baseInput({ dispatchToolCall: dispatch, reply: {} }));

    expect(dispatch).toHaveBeenCalledTimes(50);
    expect(calls()).toHaveLength(51);
    expect(summary(events).terminator).toBe('max_iterations');
  });

  it('strips a stray marker from the middle of the closing text as well as the line at its end', async () => {
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce(textTurn('I found three. [done] That is all.\n[done]\n'));

    const events = await drain(baseInput({ reply: { deadlineAt: Date.now() - 1 } }));

    const s = summary(events);
    expect(s.text).toBe('I found three. That is all.');
    expect(s.unfinished).toBe(false);
    expect(streamedText(events)).toBe('I found three. That is all.');
  });
});
