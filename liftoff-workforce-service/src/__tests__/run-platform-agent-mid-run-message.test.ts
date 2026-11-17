// Steering a run that is already going (ADR-041, the other half of the stop
// migration 016 shipped).
//
// One case per trap the agent-chat rollout paid for, because those follow-up
// fixes are the real specification for this port:
//
//   fb501bb — a mid-run message is claimed only where another model turn is
//             guaranteed. Claiming it anywhere else marks it delivered and then
//             drops it.
//   7ba086a — an injected message must actually run its turn, including when it
//             arrives after the last tool call.
//   c247793 — the turn that answers the injection still keeps its reply.
//
// Plus the mechanical guarantee the loop's own stop check cannot give: a stop
// pressed while a model call is in flight cancels that call instead of waiting
// it out.

import { runPlatformAgent } from '../platform-agent/execution.js';
import type { PlatformAgentEvent } from '../platform-agent/types.js';
import type { LLMToolDefinition } from '../llm/types.js';

jest.mock('../platform-agent/config.js', () => ({
  loadPlatformAgentConfig: jest.fn().mockResolvedValue({
    agentId: '00000000-0000-0000-0000-000000000001',
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
  { name: 'do_thing', description: 'Does a thing', input_schema: { type: 'object', properties: {} } },
];

const toolUseTurn = (text = '') => ({
  content: [
    ...(text ? [{ type: 'text', text }] : []),
    { type: 'tool_use', id: 't1', name: 'do_thing', input: { x: 1 } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 10, output_tokens: 2 },
});

const finalTurn = (text: string) => ({
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 2 },
});

async function drain(input: Parameters<typeof runPlatformAgent>[0]): Promise<PlatformAgentEvent[]> {
  const events: PlatformAgentEvent[] = [];
  for await (const e of runPlatformAgent(input)) events.push(e);
  return events;
}

const baseInput = (overrides = {}): Parameters<typeof runPlatformAgent>[0] => ({
  agentId: '00000000-0000-0000-0000-000000000001',
  tenantId: 'tenant-1',
  threadId: 'thread-1',
  objective: 'plan my workforce',
  tools,
  toolContext: { tenantId: 'tenant-1' },
  dispatchToolCall: jest.fn().mockResolvedValue({ ok: true, data: { result: 'ok' } }),
  auditAction: 'caio.chat_turn',
  usagePurpose: 'caio_workforce_planning',
  triggeredBy: 'human:account-1',
  ...overrides,
});

/** The conversation array handed to the Nth model call (1-based). */
function conversationForCall(n: number): Array<{ role: string; content: unknown }> {
  return (callPBLlmComplete as jest.Mock).mock.calls[n - 1][0].conversation;
}

beforeEach(() => {
  (callPBLlmComplete as jest.Mock).mockReset();
});

describe('runPlatformAgent mid-run messages', () => {
  it('appends a claimed message as its own user entry AFTER the tool-result entry', async () => {
    // Its own entry is not cosmetic: convertConversationToPBMessages drops text
    // from a user turn carrying tool_result blocks, so folding it in would send
    // an empty message.
    (callPBLlmComplete as jest.Mock)
      .mockResolvedValueOnce(toolUseTurn())
      .mockResolvedValueOnce(finalTurn('answered the redirect'));
    const claimUserMessage = jest
      .fn()
      .mockResolvedValueOnce('FRAMED: also look at support')
      .mockResolvedValue(null);

    await drain(baseInput({ claimUserMessage }));

    const second = conversationForCall(2);
    expect(second[second.length - 1]).toEqual({ role: 'user', content: 'FRAMED: also look at support' });
    const beforeLast = second[second.length - 2];
    expect(Array.isArray(beforeLast.content)).toBe(true);
    expect((beforeLast.content as Array<{ type: string }>)[0].type).toBe('tool_result');
  });

  it('runs another model turn for a message that lands after the last tool call', async () => {
    // 7ba086a: injection must guarantee a following model turn. The break
    // condition looks once more and continues instead of ending the turn.
    (callPBLlmComplete as jest.Mock)
      .mockResolvedValueOnce(finalTurn('here is the plan'))
      .mockResolvedValueOnce(finalTurn('and here is the change you asked for'));
    const claimUserMessage = jest
      .fn()
      .mockResolvedValueOnce('FRAMED: make it cheaper')
      .mockResolvedValue(null);

    const events = await drain(baseInput({ claimUserMessage }));

    expect(callPBLlmComplete as jest.Mock).toHaveBeenCalledTimes(2);
    const second = conversationForCall(2);
    expect(second[second.length - 1]).toEqual({ role: 'user', content: 'FRAMED: make it cheaper' });
    // c247793: the turn that answers the injection still keeps its reply.
    //
    // The two replies are separated, because they are two messages with the
    // person's own message between them: the model said one thing, somebody
    // typed while it was working, and it answered that. The fixtures used to
    // read as one sentence and were asserted joined, which only worked while
    // the loop glued every iteration together.
    const final = events[events.length - 1];
    expect(final.type).toBe('complete');
    if (final.type === 'complete') {
      expect(final.summary.terminator).toBe('normal');
      expect(final.summary.text).toBe('here is the plan\n\nand here is the change you asked for');
    }
  });

  it('never claims a message it cannot answer', async () => {
    // fb501bb: consuming at a boundary with no following model turn marks the
    // signal delivered and the message evaporates. A provider error ends the
    // turn, so nothing is claimed on the way out.
    (callPBLlmComplete as jest.Mock).mockRejectedValueOnce(new Error('upstream 503'));
    const claimUserMessage = jest.fn().mockResolvedValue('FRAMED: hello');

    await drain(baseInput({ claimUserMessage }));

    expect(claimUserMessage).not.toHaveBeenCalled();
  });

  it('bounds trailing continuations so a stream of messages cannot run forever', async () => {
    (callPBLlmComplete as jest.Mock).mockResolvedValue(finalTurn('ok'));
    const claimUserMessage = jest.fn().mockResolvedValue('FRAMED: and another thing');

    await drain(baseInput({ claimUserMessage }));

    // One original turn + two continuations, then the loop stops claiming.
    expect(callPBLlmComplete as jest.Mock).toHaveBeenCalledTimes(3);
    expect(claimUserMessage).toHaveBeenCalledTimes(2);
  });

  it('lets a stop win over a message waiting at the same boundary', async () => {
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce(finalTurn('partial'));
    const shouldStop = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const claimUserMessage = jest.fn().mockResolvedValue('FRAMED: change course');

    const events = await drain(baseInput({ shouldStop, claimUserMessage }));

    expect(claimUserMessage).not.toHaveBeenCalled();
    const final = events[events.length - 1];
    if (final.type === 'complete') expect(final.summary.terminator).toBe('stopped');
  });

  it('leaves the loop untouched for a run with nobody in front of it (HRBP)', async () => {
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce(finalTurn('done'));
    const events = await drain(baseInput());
    expect(callPBLlmComplete as jest.Mock).toHaveBeenCalledTimes(1);
    const final = events[events.length - 1];
    if (final.type === 'complete') expect(final.summary.terminator).toBe('normal');
    // Nothing to cancel, so no signal is passed either.
    expect((callPBLlmComplete as jest.Mock).mock.calls[0][0].signal).toBeUndefined();
  });
});

describe('runPlatformAgent stop while a call is in flight', () => {
  it('cancels the model call instead of waiting it out', async () => {
    jest.useFakeTimers();
    try {
      // The loop's own check runs between iterations; it cannot reach a call
      // that is already running, and that call is where the time goes.
      const shouldStop = jest.fn().mockResolvedValue(true);
      let receivedSignal: AbortSignal | undefined;
      (callPBLlmComplete as jest.Mock).mockImplementationOnce(
        ({ signal }: { signal?: AbortSignal }) => {
          receivedSignal = signal;
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        },
      );

      const events: PlatformAgentEvent[] = [];
      const run = (async () => {
        for await (const e of runPlatformAgent(baseInput({
          // False once so the pre-call check lets the turn start, then true.
          shouldStop: jest.fn().mockResolvedValueOnce(false).mockImplementation(shouldStop),
        }))) {
          events.push(e);
        }
      })();

      // The watcher polls on the same spacing the boundaries use.
      await jest.advanceTimersByTimeAsync(2_500);
      await run;

      expect(receivedSignal?.aborted).toBe(true);
      const final = events[events.length - 1];
      expect(final.type).toBe('complete');
      if (final.type === 'complete') {
        expect(final.summary.terminator).toBe('stopped');
        expect(final.summary.ok).toBe(true);
      }
      // Cancelled, not failed: no error event reaches the person.
      expect(events.find(e => e.type === 'error')).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
