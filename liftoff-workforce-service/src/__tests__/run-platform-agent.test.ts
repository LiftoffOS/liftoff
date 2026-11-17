// runPlatformAgent loop contract tests (PR 0.2):
//   - normal completion path emits text_delta + complete events
//   - tool dispatch path emits tool_call + tool_result, then loops
//   - HrbpBlockerException terminates with terminator='tool_blocker' and
//     does NOT emit a synthetic tool_result (D6 reverted)
//   - a call whose prompt fills the guarded share of the served model's
//     window yields terminator='context_full' (an HRBP run has no reply to
//     close, so it ends there)
//   - LLM provider error yields terminator='error' with code+message
//   - shouldStop ends the loop with terminator='stopped', before spending an
//     LLM call and between tool calls

import { runPlatformAgent } from '../platform-agent/execution.js';
import { HrbpBlockerException, type PlatformAgentEvent } from '../platform-agent/types.js';
import type { LLMToolDefinition } from '../llm/types.js';

jest.mock('../platform-agent/config.js', () => ({
  loadPlatformAgentConfig: jest.fn().mockResolvedValue({
    agentId: '00000000-0000-0000-0000-000000000002',
    systemRole: 'hrbp',
    systemPromptTemplate: 'You are HRBP. Tools: {{TOOLS}}',
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

async function drain(input: Parameters<typeof runPlatformAgent>[0]): Promise<PlatformAgentEvent[]> {
  const events: PlatformAgentEvent[] = [];
  for await (const e of runPlatformAgent(input)) events.push(e);
  return events;
}

const baseInput = (overrides = {}): Parameters<typeof runPlatformAgent>[0] => ({
  agentId: '00000000-0000-0000-0000-000000000002',
  tenantId: 'tenant-1',
  objective: 'do the thing',
  tools,
  toolContext: { tenantId: 'tenant-1' },
  dispatchToolCall: jest.fn(),
  auditAction: 'hrbp.provision_spec',
  usagePurpose: 'hrbp_provision_spec',
  triggeredBy: 'agent:00000000-0000-0000-0000-000000000001',
  ...overrides,
});

beforeEach(() => {
  (callPBLlmComplete as jest.Mock).mockReset();
});

describe('runPlatformAgent', () => {
  // A `max_tokens` stop means the model was cut off mid-generation, not that it
  // finished. Ending the turn there produces an empty assistant message and no
  // tool call — the work the person asked for silently does not happen.
  it('resumes a turn that was truncated, instead of ending it', async () => {
    (callPBLlmComplete as jest.Mock)
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Setting that up' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 100, output_tokens: 16000 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: ' — done.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 120, output_tokens: 10 },
      });

    const events = await drain(baseInput());
    const final = events[events.length - 1];

    expect((callPBLlmComplete as jest.Mock).mock.calls.length).toBe(2);
    expect(final.type).toBe('complete');
    if (final.type === 'complete') {
      expect(final.summary.terminator).toBe('normal');
      // The continuation is one assistant message, not two turns stitched.
      expect(final.summary.text).toBe('Setting that up — done.');
    }
  });

  it('prefills the continuation with the partial text so the model carries on', async () => {
    (callPBLlmComplete as jest.Mock)
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'partial' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 10, output_tokens: 16000 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: ' rest' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
      });

    await drain(baseInput());

    const secondCall = (callPBLlmComplete as jest.Mock).mock.calls[1][0];
    const last = secondCall.conversation[secondCall.conversation.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('partial');
  });

  it('stops rather than spinning when the whole budget went into an unfinished tool call', async () => {
    // No text to prefill with, so re-running would truncate identically.
    (callPBLlmComplete as jest.Mock).mockResolvedValue({
      content: [{ type: 'tool_use', id: 't1', name: 'do_thing', input: {} }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 16000 },
    });

    const events = await drain(baseInput());
    const final = events[events.length - 1];

    expect((callPBLlmComplete as jest.Mock).mock.calls.length).toBe(1);
    expect(final.type).toBe('complete');
    // Not a bound of the loop's, and not the provider's fault: the output
    // ceiling is ours, so it ends under its own name and the run is not ok.
    if (final.type === 'complete') {
      expect(final.summary.terminator).toBe('output_truncated');
      expect(final.summary.errorCode).toBe('OUTPUT_TRUNCATED');
      expect(final.summary.ok).toBe(false);
    }
  });

  // One model response is one assistant message as the person reads it.
  // Concatenating them raw produces replies like "Drafting the plan
  // now.Approved. Both teams are being set up now:": two messages either side
  // of a tool call, glued at the full stop. The separator has to reach both the stream and the accumulated
  // text, because chat-service persists the latter and that row is what a
  // reload, a /share link and the Liftoff mirror show.
  describe('message boundaries between iterations', () => {
    function twoMessagesAroundATool(first: string, second: string) {
      (callPBLlmComplete as jest.Mock)
        .mockResolvedValueOnce({
          content: [
            { type: 'text', text: first },
            { type: 'tool_use', id: 't1', name: 'do_thing', input: {} },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: second }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 6 },
        });
    }

    it('separates the text either side of a tool call', async () => {
      twoMessagesAroundATool('Drafting the plan now.', 'Approved. Both teams are being set up.');

      const events = await drain(
        baseInput({ dispatchToolCall: jest.fn().mockResolvedValue({ ok: true, data: {} }) }),
      );
      const final = events[events.length - 1];

      expect(final.type).toBe('complete');
      if (final.type === 'complete') {
        expect(final.summary.text).toBe(
          'Drafting the plan now.\n\nApproved. Both teams are being set up.',
        );
      }
    });

    it('streams the separator too, so the live reader sees the same break', async () => {
      twoMessagesAroundATool('First.', 'Second.');

      const events = await drain(
        baseInput({ dispatchToolCall: jest.fn().mockResolvedValue({ ok: true, data: {} }) }),
      );

      const streamed = events
        .filter((e): e is Extract<PlatformAgentEvent, { type: 'text_delta' }> => e.type === 'text_delta')
        .map((e) => e.text)
        .join('');
      expect(streamed).toBe('First.\n\nSecond.');
    });

    it('does not open a gap of four when the message ended on its own newline', async () => {
      twoMessagesAroundATool('- one\n- two\n', 'Done.');

      const events = await drain(
        baseInput({ dispatchToolCall: jest.fn().mockResolvedValue({ ok: true, data: {} }) }),
      );
      const final = events[events.length - 1];

      if (final.type === 'complete') {
        expect(final.summary.text).toBe('- one\n- two\n\nDone.');
      }
    });

    it('writes no separator when the first response was tool calls only', async () => {
      (callPBLlmComplete as jest.Mock)
        .mockResolvedValueOnce({
          content: [{ type: 'tool_use', id: 't1', name: 'do_thing', input: {} }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Here is what I found.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 6 },
        });

      const events = await drain(
        baseInput({ dispatchToolCall: jest.fn().mockResolvedValue({ ok: true, data: {} }) }),
      );
      const final = events[events.length - 1];

      if (final.type === 'complete') {
        expect(final.summary.text).toBe('Here is what I found.');
      }
    });

    // The one continuation that is not a new message. Covered by the truncation
    // tests above as well; asserted here against the boundary rule directly, so
    // a future change to the separator cannot quietly break a resumed sentence.
    it('does not break a sentence the model was cut off in', async () => {
      (callPBLlmComplete as jest.Mock)
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Setting that up' }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 10, output_tokens: 16000 },
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: ', done.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 12, output_tokens: 6 },
        });

      const events = await drain(baseInput());
      const final = events[events.length - 1];

      if (final.type === 'complete') {
        expect(final.summary.text).toBe('Setting that up, done.');
      }
    });
  });

  it('emits text_delta + complete when the LLM finishes without tools', async () => {
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'all done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 5 },
    });
    const events = await drain(baseInput());
    expect(events[0]).toEqual({ type: 'text_delta', text: 'all done' });
    const final = events[events.length - 1];
    expect(final.type).toBe('complete');
    if (final.type === 'complete') {
      expect(final.summary.terminator).toBe('normal');
      expect(final.summary.text).toBe('all done');
      expect(final.summary.inputTokens).toBe(100);
      expect(final.summary.outputTokens).toBe(5);
    }
  });

  it('dispatches a tool call, surfaces the result, and continues to the next turn', async () => {
    (callPBLlmComplete as jest.Mock)
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 't1', name: 'do_thing', input: { x: 1 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'finished' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 60, output_tokens: 3 },
      });
    const dispatch = jest.fn().mockResolvedValue({ ok: true, data: { result: 'ok' } });
    const events = await drain(baseInput({ dispatchToolCall: dispatch }));
    expect(dispatch).toHaveBeenCalledWith('do_thing', { x: 1 }, expect.any(Object));
    const toolCallEvent = events.find(e => e.type === 'tool_call');
    expect(toolCallEvent).toEqual({ type: 'tool_call', tool: 'do_thing', input: { x: 1 } });
    const toolResultEvent = events.find(e => e.type === 'tool_result');
    expect(toolResultEvent).toEqual({
      type: 'tool_result',
      tool: 'do_thing',
      result: { result: 'ok' },
    });
  });

  // The loop used to hardcode triggeredBy:'agent' on all three audit rows,
  // which attributed every platform-agent run to nobody. Attribution is the
  // caller's to state — CAIO turns are human:<accountId>, HRBP provisioning is
  // agent:<caio-id> — so the loop must pass it through untouched.
  it('stamps the caller-supplied triggeredBy on the started, tool_called, and completed rows', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { writeAgentAuditLog } = require('../platform-agent/audit-log-writer.js');
    (writeAgentAuditLog as jest.Mock).mockClear();
    (callPBLlmComplete as jest.Mock)
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 't1', name: 'do_thing', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 5 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'finished' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 60, output_tokens: 3 },
      });

    await drain(baseInput({
      dispatchToolCall: jest.fn().mockResolvedValue({ ok: true, data: {} }),
      triggeredBy: 'human:acct-42',
    }));

    const writes = (writeAgentAuditLog as jest.Mock).mock.calls.map(c => c[0]);
    expect(writes.map(w => w.action)).toEqual([
      'hrbp.provision_spec.started',
      'hrbp.provision_spec.tool_called',
      'hrbp.provision_spec.completed',
    ]);
    for (const write of writes) {
      expect(write.triggeredBy).toBe('human:acct-42');
    }
  });

  it('terminates with terminator=tool_blocker on HrbpBlockerException without a synthetic tool_result', async () => {
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 't1', name: 'do_thing', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 50, output_tokens: 5 },
    });
    const dispatch = jest.fn().mockRejectedValue(new HrbpBlockerException('name_collision', 'Agent already exists'));
    const events = await drain(baseInput({ dispatchToolCall: dispatch }));
    const final = events[events.length - 1];
    expect(final.type).toBe('complete');
    if (final.type === 'complete') {
      expect(final.summary.terminator).toBe('tool_blocker');
      expect(final.summary.toolCalls).toEqual([]); // D6 reverted — no bookkeeping
    }
    expect(events.find(e => e.type === 'tool_result')).toBeUndefined();
  });

  it('terminates with terminator=context_full when a call\'s prompt fills the guarded share of the window', async () => {
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 't1', name: 'do_thing', input: {} }],
      stop_reason: 'tool_use',
      // The prompt this call carried, as the relay's provider counted it,
      // against the served model's RECORDED window: 150k of 200k is past
      // seven tenths.
      usage: { input_tokens: 150_000, output_tokens: 100, context_tokens: 150_000 },
      context_window: 200_000,
      context_window_recorded: 200_000,
    });
    const events = await drain(baseInput());
    const final = events[events.length - 1];
    expect(final.type).toBe('complete');
    if (final.type === 'complete') {
      expect(final.summary.terminator).toBe('context_full');
    }
    // The round it asked for was not run: an HRBP run has no reply to close.
    expect(events.find(e => e.type === 'tool_call')).toBeUndefined();
  });

  it('measures a big model against its own window: 500k of a recorded 1M keeps going', async () => {
    // The defect the registry migration fixes, from this side: an unsized
    // model is bounded by the conservative fallback, so a 1M model used to
    // close its turns at roughly ninety thousand tokens. With the window
    // recorded, the same prompt runs on.
    (callPBLlmComplete as jest.Mock)
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 't1', name: 'do_thing', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 500_000, output_tokens: 100, context_tokens: 500_000 },
        context_window: 1_000_000,
        context_window_recorded: 1_000_000,
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'finished' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 500_000, output_tokens: 10, context_tokens: 500_000 },
        context_window: 1_000_000,
        context_window_recorded: 1_000_000,
      });
    const events = await drain(baseInput({ dispatchToolCall: jest.fn().mockResolvedValue({ ok: true, data: { done: true } }) }));
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1);
    const final = events[events.length - 1];
    if (final.type === 'complete') expect(final.summary.terminator).toBe('normal');
  });

  it('guards an UNSIZED model at the conservative fallback rather than going inert', async () => {
    // A relay that reports no recorded window used to leave the guard off
    // entirely: the model ran to whatever the provider would accept and the
    // turn died on an overflow. 100k is under the 200k the relay named and
    // past seven tenths of the 128k fallback, which is the whole difference.
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce({
      content: [{ type: 'tool_use', id: 't1', name: 'do_thing', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100_000, output_tokens: 100, context_tokens: 100_000 },
      context_window: 200_000,
    });
    const events = await drain(baseInput());
    const final = events[events.length - 1];
    if (final.type === 'complete') expect(final.summary.terminator).toBe('context_full');
    expect(events.find(e => e.type === 'tool_call')).toBeUndefined();
  });

  it('stays inert when the relay reports no prompt size at all', async () => {
    // The other silence, and it is a different fact: with no prompt size there
    // is nothing to measure, and tripping on a zero would close every reply on
    // its first call.
    (callPBLlmComplete as jest.Mock)
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 't1', name: 'do_thing', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 900_000, output_tokens: 100 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'finished' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 900_000, output_tokens: 10 },
      });
    const events = await drain(baseInput({ dispatchToolCall: jest.fn().mockResolvedValue({ ok: true, data: { done: true } }) }));
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1);
    const final = events[events.length - 1];
    if (final.type === 'complete') expect(final.summary.terminator).toBe('normal');
  });

  it('a cumulative sum across calls never trips the guard: thirty rounds of a 14k context run to the end', async () => {
    for (let i = 1; i <= 30; i++) {
      (callPBLlmComplete as jest.Mock).mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: `t${i}`, name: 'do_thing', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 14_000, output_tokens: 100, context_tokens: 14_000 },
        context_window: 200_000,
        context_window_recorded: 200_000,
      });
    }
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'finished' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 14_000, output_tokens: 10, context_tokens: 14_000 },
      context_window: 200_000,
      context_window_recorded: 200_000,
    });
    const events = await drain(baseInput({ dispatchToolCall: jest.fn().mockResolvedValue({ ok: true, data: { done: true } }) }));
    const final = events[events.length - 1];
    expect((callPBLlmComplete as jest.Mock).mock.calls.length).toBe(31);
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(30);
    if (final.type === 'complete') expect(final.summary.terminator).toBe('normal');
  });

  it('terminates with terminator=error on provider failure and emits an error event', async () => {
    (callPBLlmComplete as jest.Mock).mockRejectedValueOnce(new Error('upstream 503'));
    const events = await drain(baseInput());
    const errorEvent = events.find(e => e.type === 'error');
    expect(errorEvent).toEqual({ type: 'error', code: 'PROVIDER_ERROR', message: 'upstream 503' });
    const final = events[events.length - 1];
    expect(final.type).toBe('complete');
    if (final.type === 'complete') {
      expect(final.summary.terminator).toBe('error');
      expect(final.summary.errorCode).toBe('PROVIDER_ERROR');
    }
  });

  // ── User stop (ADR-041, extended to the CAIO chat) ────────────────────

  it('stops before spending an LLM call when the signal is already set', async () => {
    const shouldStop = jest.fn().mockResolvedValue(true);
    const events = await drain(baseInput({ shouldStop }));

    // The check comes first in the loop, so a stop that lands between turns
    // costs nothing: no provider call at all.
    expect(callPBLlmComplete as jest.Mock).not.toHaveBeenCalled();
    const final = events[events.length - 1];
    expect(final.type).toBe('complete');
    if (final.type === 'complete') {
      expect(final.summary.terminator).toBe('stopped');
      // A stop is a deliberate ending, so the partial reply is kept and the
      // caller persists it like any other.
      expect(final.summary.ok).toBe(true);
    }
  });

  it('stops between tool calls, leaving the pending ones undispatched', async () => {
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'working on it' },
        { type: 'tool_use', id: 'tu-1', name: 'do_thing', input: {} },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    // False on the loop check, true by the time the tool is about to run.
    const shouldStop = jest.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const dispatchToolCall = jest.fn();

    const events = await drain(baseInput({ shouldStop, dispatchToolCall }));

    expect(dispatchToolCall).not.toHaveBeenCalled();
    expect(events.some(e => e.type === 'tool_call')).toBe(false);
    const final = events[events.length - 1];
    if (final.type === 'complete') {
      expect(final.summary.terminator).toBe('stopped');
      // Whatever it had said before the stop survives.
      expect(final.summary.text).toBe('working on it');
    }
  });

  it('runs normally when nobody has stopped it', async () => {
    (callPBLlmComplete as jest.Mock).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'all done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const shouldStop = jest.fn().mockResolvedValue(false);
    const events = await drain(baseInput({ shouldStop }));
    const final = events[events.length - 1];
    if (final.type === 'complete') expect(final.summary.terminator).toBe('normal');
  });

});

describe('runPlatformAgent — a tool result larger than one message', () => {
  const HUGE = { rows: [{ body: 'x'.repeat(60_000) }] };

  const oneToolThenAnswer = () => {
    (callPBLlmComplete as jest.Mock)
      .mockResolvedValueOnce({
        content: [{ type: 'tool_use', id: 't1', name: 'do_thing', input: {} }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 10, context_tokens: 100 },
        context_window: 200_000,
        context_window_recorded: 200_000,
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 120, output_tokens: 10, context_tokens: 120 },
        context_window: 200_000,
        context_window_recorded: 200_000,
      });
  };

  it('hands the whole serialization to the model when no parker was supplied', async () => {
    // The HRBP fan-out. It has no dataset tools, so parking would give it an
    // id it cannot read — worse than a large result, because it loses the
    // content AND offers no way back to it.
    oneToolThenAnswer();
    await drain(baseInput({ dispatchToolCall: jest.fn().mockResolvedValue({ ok: true, data: HUGE }) }));
    const second = (callPBLlmComplete as jest.Mock).mock.calls[1][0];
    const blocks = second.conversation.flatMap((m: { content: unknown }) => (Array.isArray(m.content) ? m.content : []));
    const toolResult = blocks.find((b: { type?: string }) => b?.type === 'tool_result');
    expect(toolResult.content).toBe(JSON.stringify(HUGE));
  });

  it('asks the parker for the text when one was supplied, and sends what it answers', async () => {
    oneToolThenAnswer();
    const parkToolResult = jest.fn().mockResolvedValue('PARKED VIEW');
    await drain(baseInput({
      dispatchToolCall: jest.fn().mockResolvedValue({ ok: true, data: HUGE }),
      parkToolResult,
    }));
    expect(parkToolResult).toHaveBeenCalledWith('do_thing', HUGE, JSON.stringify(HUGE));
    const second = (callPBLlmComplete as jest.Mock).mock.calls[1][0];
    const blocks = second.conversation.flatMap((m: { content: unknown }) => (Array.isArray(m.content) ? m.content : []));
    const toolResult = blocks.find((b: { type?: string }) => b?.type === 'tool_result');
    expect(toolResult.content).toBe('PARKED VIEW');
  });

  it('keeps the whole result on the event and in the record, whatever the context reads', async () => {
    oneToolThenAnswer();
    const events = await drain(baseInput({
      dispatchToolCall: jest.fn().mockResolvedValue({ ok: true, data: HUGE }),
      parkToolResult: jest.fn().mockResolvedValue('PARKED VIEW'),
    }));
    const toolResultEvent = events.find((e) => e.type === 'tool_result');
    expect(toolResultEvent).toEqual({ type: 'tool_result', tool: 'do_thing', result: HUGE });
    const final = events[events.length - 1];
    if (final.type === 'complete') expect(final.summary.toolCalls[0].output).toEqual(HUGE);
  });
});
