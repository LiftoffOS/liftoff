// Chat event relay — pure translation of engine InvocationEvents into the chat
// SSE protocol the frontend already speaks.
//
// When a fresh chat turn runs through the shared agent-execution engine
// (executeTask → runAgentHybridLoop), the engine emits InvocationEvents. The
// chat-turn handler's streamSink forwards them to the SSE response. The frontend
// (liftoff-react agentChat.ts) reads `data.text` for `text_delta` and `data.tool`
// for `tool_call`. Keeping the wire translation here (pure, no `res`/DB) makes it
// unit-testable independently of the integration-heavy handler.
//
// Pauses (ask_user / HITL) are NOT surfaced from the mid-stream `pause_requested`
// event — the question and resume id only exist after the engine creates the
// pause record, so the handler surfaces them from the `paused` TaskExecutionResult
// once executeTask returns (`awaiting_input` for ask_user, a reason note for HITL).

import type { InvocationEvent } from '../agent-execution/adapter/types';
import { openAssistantMessage } from './assistant-message-boundary';
import type { PlatformContent } from '../agent-execution/adapter';

/** A chat-protocol SSE frame: the event name + the JSON payload the frontend reads.
 *  text_delta / tool_call are the user-facing event types — what the chat UI
 *  consumes. tool_call_finished / usage / catalog only appear in TRACE MODE
 *  (an opt-in flag on the chat-turn body) and exist for the agent-test-harness
 *  PB-side runner that needs full args/result/usage parity with the TR-side
 *  runner. Frontend never sets traceMode → frontend wire is unchanged. */
export interface ChatSseFrame {
  type: 'text_delta' | 'text_break' | 'tool_call' | 'tool_call_finished' | 'usage' | 'catalog' | 'delegation_started' | 'delegation_paused' | 'workflow_step' | 'host_delivered';
  data: Record<string, unknown>;
}

/**
 * Translate one engine InvocationEvent into the chat SSE frame the consumer
 * speaks, or `null` when the event produces no client-facing frame.
 *
 * Default mode (traceMode unset or false): only the frontend-visible
 * subset — text_delta + tool_call (tool name only). This is the wire the
 * React chat UI parses; do not change without coordinating a frontend release.
 *
 * Trace mode (traceMode: true): adds tool_call args+callId, plus separate
 * tool_call_finished and usage frames so an agent-test-harness consumer has
 * full parity with what the TR-side runner sees (executeTask events). Real
 * chat never sets traceMode → real chat SSE is unaffected → no privacy
 * leak of tool args/results to the browser.
 *
 * `host_delivered` is user-facing in BOTH modes and is not built here: it
 * carries values the gateway lifted OUT of the tool result, so it has no
 * InvocationEvent to translate from. The turn handler emits it from the side
 * channel — see `hostDeliveredFrame` below for the shape both sides agree on.
 */
/**
 * The frame that carries lifted values to the surface.
 *
 * Built here rather than at the emit site so the wire shape lives beside every
 * other frame's, and so the browser contract is testable without a turn. Same
 * discipline as `delegation_paused` above: enumerated fields only, never a raw
 * result — the difference is that these fields were REMOVED from the result
 * before the model saw it, which is exactly why the person needs them.
 */
export function hostDeliveredFrame(entry: { toolName: string; fields: Record<string, unknown> }): ChatSseFrame {
  return {
    type: 'host_delivered',
    data: {
      tool: entry.toolName,
      fields: Object.entries(entry.fields).map(([path, value]) => ({ path, value })),
    },
  };
}

export function invocationEventToChatFrame(
  event: InvocationEvent,
  opts?: {
    traceMode?: boolean;
    /** Resolves the `teammate` label a `delegate_to_agent` call names to the
     *  runtime agent id it was built from. Injected because the relay is pure
     *  and has no roster; the handler passes the gateway's own map so the frame
     *  attributes the hand-over to the same id the tool will run. */
    delegateIdForTeammate?: (teammate: string) => string | undefined;
  },
): ChatSseFrame | null {
  const trace = opts?.traceMode === true;
  switch (event.type) {
    case 'assistant_delta':
      // Token-level streaming text. Empty deltas carry no payload — drop them.
      return event.text ? { type: 'text_delta', data: { text: event.text } } : null;
    case 'workflow_step_started':
      // Where a long run has got to. Not trace-only: this is the only signal a
      // workflow-shaped run emits while it works, and without it the chat has
      // nothing to show between the question and the answer.
      return {
        type: 'workflow_step',
        data: { stepId: event.stepId, index: event.index, total: event.total },
      };
    case 'tool_call_started': {
      // A blocking delegation is the one tool call whose subject the person
      // should see BY NAME: "Using delegate to agent" both said "agent" to a
      // user (INV-UI-003) and named the mechanism instead of the teammate. The
      // tool takes the teammate's LABEL (the enum the model chooses from), so
      // the label is resolved back to the roster id it was built from and the
      // frame carries that id; the consumer resolves the display name. This
      // used to read `args.agent_id`, a field the tool stopped taking when it
      // moved to labels, so the frame never fired. Default mode only — trace
      // mode keeps the raw tool_call frame for harness started/finished
      // pairing.
      if (!trace && event.toolName === 'delegate_to_agent') {
        const teammate = (event.args as { teammate?: unknown } | undefined)?.teammate;
        const agentId = typeof teammate === 'string'
          ? opts?.delegateIdForTeammate?.(teammate)
          : undefined;
        if (agentId) {
          return { type: 'delegation_started', data: { agentId } };
        }
      }
      // The callId travels in BOTH modes. Trace mode also carries `args` so the
      // harness can assert on input shape; the id itself is what lets a
      // consumer count DISTINCT calls instead of frames.
      //
      // It used to be trace-only, and the control plane's activity counter
      // counts one per frame: a run that made six write attempts was reported
      // as "12 documents written" while exactly one document existed. Whatever
      // delivers a frame twice — a replayed stream, a reconnect, a path that
      // reports a call at more than one seam — the count was wrong and there
      // was nothing in the frame to tell the duplicate from a second call.
      return trace
        ? { type: 'tool_call', data: { tool: event.toolName, callId: event.callId, args: event.args } }
        : { type: 'tool_call', data: { tool: event.toolName, callId: event.callId } };
    }
    case 'tool_call_finished': {
      // LEDGER_OBSERVER_ONLY: a pure event→frame translation. Nothing executes
      // here, and the turn handler that calls this already records the call —
      // recording again would double-count one action.
      //
      // ONE tool result is user-facing regardless of trace mode: a delegation
      // that stopped because the receiving team is waiting on an approval. The
      // structured pause the delegate_to_agent handler returns is sniffed here
      // and promoted to its own frame, because prose is exactly where this fact
      // used to disappear — the model narrated the pause and the person saw a
      // vague answer instead of a status row with a way to the review queue.
      // Only the enumerated fields are forwarded; the raw result never reaches
      // the browser.
      if (typeof event.result === 'string' && event.result.includes('"delegation_paused":true')) {
        try {
          const parsed = JSON.parse(event.result) as {
            delegation_paused?: boolean;
            approval_id?: string | null;
            child_agent_id?: string;
            reason?: string;
          };
          if (parsed.delegation_paused === true && parsed.child_agent_id) {
            return {
              type: 'delegation_paused',
              data: {
                agentId: parsed.child_agent_id,
                approvalId: parsed.approval_id ?? null,
                reason: parsed.reason ?? 'The team stopped for an approval before it could continue.',
              },
            };
          }
        } catch {
          // Not the structured pause after all — fall through to trace handling.
        }
      }
      // Trace-only frame — paired with a prior tool_call by callId. Carries
      // the tool's return value (or error message). Frontend never receives
      // this event because frontend never sets traceMode.
      if (!trace) return null;
      return {
        type: 'tool_call_finished',
        data: { callId: event.callId, result: event.result, ...(event.error ? { error: event.error } : {}) },
      };
    }
    case 'usage':
      // Trace-only — per-message usage deltas. The handler still emits a
      // terminal `complete` event with totals for the frontend.
      if (!trace) return null;
      return {
        type: 'usage',
        data: {
          inputTokens: event.usage.inputTokens ?? 0,
          outputTokens: event.usage.outputTokens ?? 0,
          ...(event.usage.cachedTokens !== undefined ? { cachedTokens: event.usage.cachedTokens } : {}),
        },
      };
    case 'assistant_message':
      // Message boundary. The text itself already reached the consumer as
      // assistant_delta tokens, so this carries no payload — it exists purely
      // to say "that message ended".
      //
      // Without it the consumer has no way to know where one message stops and
      // the next begins, because token deltas arrive as an undifferentiated
      // stream. The React chat UI used to infer paragraph breaks from tool
      // calls instead, which silently glued consecutive messages into one
      // run-on block whenever a boundary was not accompanied by a visible tool
      // call ("...fetching now.Still failing..."). Boundaries are a property of
      // the conversation, not a side effect of tool use, so the wire states them.
      return { type: 'text_break', data: {} };
    default:
      // completion / pause_requested / session_started carry no wire frame
      // here. Completion + token totals and pauses (awaiting_input / reason
      // note) are emitted by the handler after executeTask resolves — see the
      // file header.
      return null;
  }
}

/**
 * Concatenate the text blocks of an `assistant_message` into the canonical turn
 * text used for history persistence + the terminal `complete` event. Non-text
 * blocks (tool_use, etc.) are ignored.
 */
export function assistantMessageText(content: PlatformContent[]): string {
  return content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join('');
}

/**
 * Add one assistant message to the running text of a turn.
 *
 * A turn is not one message. The model speaks, calls a tool, reads the result
 * and speaks again, and each of those is its own `assistant_message`. The
 * handler used to keep only the newest one, so everything said before the last
 * tool call was dropped from the turn text — and the turn text is what gets
 * persisted as history, settled into the person's transcript, and echoed on the
 * terminal `complete` frame.
 *
 * The boundary carries no characters of its own, so it has to be written here or
 * two messages arrive joined at the full stop. Sized to what the text already
 * ends with, so a message that closed on its own newline does not open a gap of
 * four.
 *
 * This is only the HISTORY half of the pair. The other half, the newest message
 * on its own, is what a consumer wants when it is asking about the run's final
 * state rather than about everything the person read — see the saturation guard
 * in chat-turn-handler.ts, which is length-capped and would simply stop firing
 * if it were handed the whole turn.
 */
export function appendAssistantMessage(existing: string, text: string): string {
  if (!text) return existing;
  if (!existing) return text;
  // How big the gap is, and what the next message keeps of the whitespace it
  // opened with, are decided in one place for every surface that assembles a
  // turn (assistant-message-boundary.ts).
  const opened = openAssistantMessage(existing, text);
  return `${existing}${opened.gap}${opened.text}`;
}
