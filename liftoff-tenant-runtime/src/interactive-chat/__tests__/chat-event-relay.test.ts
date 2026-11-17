// Chat event relay — translation of engine InvocationEvents into the chat SSE
// protocol the frontend speaks. Guards the frontend contract (agentChat.ts reads
// data.text / data.tool) when a fresh chat turn runs through executeTask.

import {
  invocationEventToChatFrame,
  assistantMessageText,
  appendAssistantMessage,
} from '../chat-event-relay';
import type { InvocationEvent } from '../../agent-execution/adapter/types';

describe('invocationEventToChatFrame', () => {
  it('maps assistant_delta → text_delta { text }', () => {
    const frame = invocationEventToChatFrame({ type: 'assistant_delta', text: 'Hel' });
    expect(frame).toEqual({ type: 'text_delta', data: { text: 'Hel' } });
  });

  it('drops empty assistant_delta (no client frame)', () => {
    expect(invocationEventToChatFrame({ type: 'assistant_delta', text: '' })).toBeNull();
  });

  it('maps tool_call_started → tool_call { tool, callId } (uses toolName, never args)', () => {
    const frame = invocationEventToChatFrame({
      type: 'tool_call_started',
      toolName: 'web_search',
      args: { q: 'hi' },
      callId: 'c1',
    });
    // The callId travels in BOTH modes now. It was trace-only, and the control
    // plane's activity counter counts one per FRAME — so six write attempts
    // were reported as "12 documents written" with exactly one document in
    // existence, and nothing in the frame could tell a duplicate from a second
    // call. `args` still never travels; see the leak test below.
    expect(frame).toEqual({ type: 'tool_call', data: { tool: 'web_search', callId: 'c1' } });
  });

  it('produces no wire frame for pause_requested (pauses surface from the result, not the stream)', () => {
    const frame = invocationEventToChatFrame({
      type: 'pause_requested',
      reason: 'hitl_gate',
      token: 'tok',
    } as Extract<InvocationEvent, { type: 'pause_requested' }>);
    expect(frame).toBeNull();
  });

  it('marks a message boundary so consecutive messages do not render as one block', () => {
    // Token deltas arrive as an undifferentiated stream, so the consumer needs
    // an explicit end-of-message signal to place a paragraph break. It carries
    // no text: the content already streamed as assistant_delta.
    const frame = invocationEventToChatFrame({
      type: 'assistant_message',
      content: [{ type: 'text', text: 'done' }],
    } as Extract<InvocationEvent, { type: 'assistant_message' }>);
    expect(frame).toEqual({ type: 'text_break', data: {} });
  });

  it('produces no wire frame for usage / completion / tool_call_finished / session_started', () => {
    const noFrame: InvocationEvent[] = [
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'completion', outcome: 'success' },
      { type: 'tool_call_finished', callId: 'c1', result: 'ok' },
      // session_started is captured by chat-turn-handler's streamSink (for
      // the terminal complete SSE event); it produces no client-facing frame.
      { type: 'session_started', sessionId: 'sess-abc' },
    ];
    for (const ev of noFrame) {
      expect(invocationEventToChatFrame(ev)).toBeNull();
    }
  });
});

describe('invocationEventToChatFrame — trace mode (opt-in)', () => {
  // Trace mode is set ONLY by the PB-side agent-test-harness endpoint
  // so it gets full args/result/usage parity with the TR-side harness.
  // Real chat never sets it; the frontend-visible wire stays the
  // text_delta+tool_call(name-only) shape tested above.

  it('tool_call carries tool name + callId + args when trace mode is on', () => {
    const frame = invocationEventToChatFrame({
      type: 'tool_call_started',
      toolName: 'web_search',
      args: { q: 'hi' },
      callId: 'c1',
    }, { traceMode: true });
    expect(frame).toEqual({
      type: 'tool_call',
      data: { tool: 'web_search', callId: 'c1', args: { q: 'hi' } },
    });
  });

  it('tool_call_finished emits a wire frame with callId + result in trace mode', () => {
    const frame = invocationEventToChatFrame({
      type: 'tool_call_finished',
      callId: 'c1',
      result: { ok: true },
    }, { traceMode: true });
    expect(frame).toEqual({
      type: 'tool_call_finished',
      data: { callId: 'c1', result: { ok: true } },
    });
  });

  it('tool_call_finished includes error field when present', () => {
    const frame = invocationEventToChatFrame({
      type: 'tool_call_finished',
      callId: 'c2',
      result: undefined,
      error: 'tool failed',
    }, { traceMode: true });
    expect(frame).toEqual({
      type: 'tool_call_finished',
      data: { callId: 'c2', result: undefined, error: 'tool failed' },
    });
  });

  it('usage emits a wire frame with input/output (and cached when present) in trace mode', () => {
    const a = invocationEventToChatFrame({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 20 },
    }, { traceMode: true });
    expect(a).toEqual({ type: 'usage', data: { inputTokens: 10, outputTokens: 20 } });

    const b = invocationEventToChatFrame({
      type: 'usage',
      usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 3 },
    }, { traceMode: true });
    expect(b).toEqual({ type: 'usage', data: { inputTokens: 1, outputTokens: 2, cachedTokens: 3 } });
  });

  it('default mode (traceMode unset) still drops tool_call_finished + usage', () => {
    expect(invocationEventToChatFrame({ type: 'tool_call_finished', callId: 'c1', result: 'ok' })).toBeNull();
    expect(invocationEventToChatFrame({ type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } })).toBeNull();
  });

  it('default mode leaks no ARGS to the frontend, which is the property this guards', () => {
    const frame = invocationEventToChatFrame({
      type: 'tool_call_started',
      toolName: 'web_search',
      args: { q: 'secret' },
      callId: 'c1',
    });
    // The concern is the PAYLOAD, not the identifier: `args` can hold anything
    // a model passed a tool, and an opaque engine call id holds nothing. The id
    // is what lets a consumer count distinct calls instead of frames.
    const data = (frame as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('args');
    expect(JSON.stringify(frame)).not.toContain('secret');
    expect(data.callId).toBe('c1');
  });
});

describe('assistantMessageText', () => {
  it('concatenates text blocks in order', () => {
    expect(assistantMessageText([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ])).toBe('Hello world');
  });

  it('ignores non-text blocks (tool_use etc.)', () => {
    expect(assistantMessageText([
      { type: 'text', text: 'before ' },
      { type: 'tool_use', toolName: 'x', args: {}, callId: 'c1' },
      { type: 'text', text: 'after' },
    ])).toBe('before after');
  });

  it('returns empty string when there is no text', () => {
    expect(assistantMessageText([
      { type: 'tool_use', toolName: 'x', args: {}, callId: 'c1' },
    ])).toBe('');
  });
});

// A turn is not one message: the model speaks, calls a tool, reads the result
// and speaks again. The handler kept only the newest one, so everything before
// the last tool call was dropped from the text that becomes the persisted
// history, the settle callback's replyText, and the `complete` frame's output.
describe('appendAssistantMessage', () => {
  it('keeps both messages, separated as paragraphs', () => {
    expect(appendAssistantMessage('Retrying the fetch now.', 'Still failing.'))
      .toBe('Retrying the fetch now.\n\nStill failing.');
  });

  it('keeps every message of a longer turn', () => {
    const turn = ['First.', 'Second.', 'Third.'].reduce(appendAssistantMessage, '');
    expect(turn).toBe('First.\n\nSecond.\n\nThird.');
  });

  it('does not open a gap of four when the message ended on its own newline', () => {
    expect(appendAssistantMessage('- one\n- two\n', 'Done.')).toBe('- one\n- two\n\nDone.');
  });

  it('adds nothing when the text already ends on a blank line', () => {
    expect(appendAssistantMessage('Para.\n\n', 'Next.')).toBe('Para.\n\nNext.');
  });

  it('writes no separator in front of the first message', () => {
    expect(appendAssistantMessage('', 'Only one message.')).toBe('Only one message.');
  });

  it('leaves the turn untouched when a message carried no text', () => {
    expect(appendAssistantMessage('So far.', '')).toBe('So far.');
  });
});

describe('delegation pause promotion', () => {
  // The one tool result that is user-facing regardless of trace mode. Prose is
  // where this fact used to disappear: the model narrated the pause and the
  // person saw a vague answer instead of a status row with a way to the review
  // queue.
  const PAUSED_RESULT = JSON.stringify({
    delegation_paused: true,
    approval_id: 'appr-1',
    child_invocation_id: 'inv-9',
    child_agent_id: 'agent-7',
    reason: 'Security Review stopped for an approval.',
  });

  it('promotes a structured delegation pause to its own frame, even without trace mode', () => {
    const frame = invocationEventToChatFrame(
      { type: 'tool_call_finished', callId: 'c1', result: PAUSED_RESULT } as never,
    );
    expect(frame).toEqual({
      type: 'delegation_paused',
      data: {
        agentId: 'agent-7',
        approvalId: 'appr-1',
        reason: 'Security Review stopped for an approval.',
      },
    });
  });

  it('forwards only the enumerated fields, never the raw result', () => {
    const frame = invocationEventToChatFrame(
      { type: 'tool_call_finished', callId: 'c1', result: PAUSED_RESULT } as never,
    );
    // child_invocation_id is deliberately absent: the browser gets no ids
    // beyond what the affordance needs.
    expect(frame!.data).not.toHaveProperty('child_invocation_id');
    expect(JSON.stringify(frame)).not.toContain('inv-9');
  });

  it('leaves an ordinary tool result alone in default mode', () => {
    // A result that merely MENTIONS the marker text but is not the structured
    // pause must not be promoted.
    const frame = invocationEventToChatFrame(
      { type: 'tool_call_finished', callId: 'c1', result: 'not json "delegation_paused":true here' } as never,
    );
    expect(frame).toBeNull();
  });

  it('does not promote a pause with no agent to attribute', () => {
    const frame = invocationEventToChatFrame(
      { type: 'tool_call_finished', callId: 'c1', result: JSON.stringify({ delegation_paused: true }) } as never,
    );
    expect(frame).toBeNull();
  });
});

describe('delegation hand-over promotion', () => {
  // The tool takes the teammate's label, not an id: the roster the gateway
  // built is what turns it back into one.
  const roster = new Map([['Security Review', 'agent-7']]);
  const delegateIdForTeammate = (teammate: string) => roster.get(teammate);

  it('promotes a delegate_to_agent call to delegation_started with the target', () => {
    const frame = invocationEventToChatFrame(
      {
        type: 'tool_call_started', callId: 'c1', toolName: 'delegate_to_agent',
        args: { teammate: 'Security Review', objective: 'review this' },
      } as never,
      { delegateIdForTeammate },
    );
    expect(frame).toEqual({ type: 'delegation_started', data: { agentId: 'agent-7' } });
  });

  it('keeps the raw tool_call in trace mode, for started/finished pairing', () => {
    const frame = invocationEventToChatFrame(
      {
        type: 'tool_call_started', callId: 'c1', toolName: 'delegate_to_agent',
        args: { teammate: 'Security Review' },
      } as never,
      { traceMode: true, delegateIdForTeammate },
    );
    expect(frame!.type).toBe('tool_call');
  });

  it('leaves every other tool call alone', () => {
    const frame = invocationEventToChatFrame(
      { type: 'tool_call_started', callId: 'c1', toolName: 'gmail__send_email', args: {} } as never,
      { delegateIdForTeammate },
    );
    expect(frame).toEqual({ type: 'tool_call', data: { tool: 'gmail__send_email', callId: 'c1' } });
  });

  it('falls back to a plain tool_call when the args carry no target', () => {
    const frame = invocationEventToChatFrame(
      { type: 'tool_call_started', callId: 'c1', toolName: 'delegate_to_agent', args: {} } as never,
      { delegateIdForTeammate },
    );
    expect(frame).toEqual({ type: 'tool_call', data: { tool: 'delegate_to_agent', callId: 'c1' } });
  });

  it('falls back to a plain tool_call when the label is not on the roster', () => {
    const frame = invocationEventToChatFrame(
      {
        type: 'tool_call_started', callId: 'c1', toolName: 'delegate_to_agent',
        args: { teammate: 'Nobody' },
      } as never,
      { delegateIdForTeammate },
    );
    expect(frame).toEqual({ type: 'tool_call', data: { tool: 'delegate_to_agent', callId: 'c1' } });
  });

  it('falls back to a plain tool_call when no resolver was given', () => {
    const frame = invocationEventToChatFrame(
      {
        type: 'tool_call_started', callId: 'c1', toolName: 'delegate_to_agent',
        args: { teammate: 'Security Review' },
      } as never,
    );
    expect(frame).toEqual({ type: 'tool_call', data: { tool: 'delegate_to_agent', callId: 'c1' } });
  });
});

describe('a workflow run says where it has got to', () => {
  // The step loop was the one shape of run that emitted nothing at all. The
  // sink is fed from the conversational adapter loop, so a workflow-shaped run
  // sent no tool calls and no text between the question and the answer, and a
  // person watching a sixteen-step run watched a blank thread. This frame is
  // the only thing such a run has to say while it works.
  it('translates a step into a frame the chat consumer reads', () => {
    expect(invocationEventToChatFrame({
      type: 'workflow_step_started', stepId: 's9', index: 9, total: 16,
    })).toEqual({ type: 'workflow_step', data: { stepId: 's9', index: 9, total: 16 } });
  });

  it('is NOT trace-only, because real chat is the whole reason for it', () => {
    const frame = invocationEventToChatFrame(
      { type: 'workflow_step_started', stepId: 's1', index: 1, total: 4 },
      { traceMode: false },
    );
    expect(frame).not.toBeNull();
  });
});
