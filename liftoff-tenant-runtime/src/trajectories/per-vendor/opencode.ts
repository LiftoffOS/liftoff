// OpenCode raw Event → canonical block array.
//
// Only `message.part.updated` events carry content; the adapter taps recordRaw
// with the full Event ({ type, properties }). Part mapping mirrors the adapter's
// translateEvent:
// text part → assistant[text]
// tool part (pending/running) → assistant[tool_use], named as the catalog
//                              names it (the CLI's server prefix removed)
// tool part (completed/error) → user[tool_result] (is_error on 'error')
// step-finish/step-start → no content (usage is emitted by the adapter)
// Session lifecycle events (session.idle/session.error/permission.updated) carry
// no content. Unrecognized part types are preserved in extras.opencode_unmapped
// and flagged on the unknown set.
//
// COALESCING. OpenCode streams text as repeated `message.part.updated`
// events whose `part.text` is CUMULATIVE, not a delta. Pushing a block per
// event yielded a turn's answer as N growing prefixes, which was not merely
// untidy — it was a live defect with no replay involved:
//   · finalAssistantText() concatenated every copy, so the goal judge, the
//     conformance judge and serializeForGrading all read the same answer
//     repeated at increasing lengths;
//   · messageFeatures() counted one assistant message per part update, so
//     nAssistant was inflated and spread / firstHumanIdx were skewed —
//     collab-session detection was wrong for every opencode run;
//   · collectToolUses / collectToolResults `order` values were inflated.
// This mapper therefore returns a `coalesceKey` on text parts; the recorder
// REPLACES the previously-recorded block for that key instead of appending.
//
// A tool part streams the same way: `pending` with empty input, then
// `running` with the arguments, then `completed` or `error` — one part, one
// call id, three or more events. The call coalesces under its id so the
// record holds ONE tool_use per call, carrying the arguments the run sent;
// the result closes the key. Two tool_use blocks under one id are a record
// no engine will accept back, and a checkpoint that resumes a pause replays
// the record to the engine.

import type { CanonicalContentBlock } from '../types';
import { opencodeCatalogToolName } from '../../agent-execution/adapter/mcp-tool-names';

interface OpencodeEvent {
  type?: string;
  properties?: {
    part?: {
      type?: string;
      text?: string;
      tool?: string;
      callID?: string;
      id?: string;
      state?: { status?: string; input?: unknown; output?: unknown; error?: string };
    };
  };
}

function toResultContent(x: unknown): CanonicalContentBlock[] | string {
  if (typeof x === 'string') return x;
  return JSON.stringify(x ?? null);
}

export function opencodePartToCanonical(raw: unknown, unknown: Set<string>): {
  message: { role: 'user' | 'assistant'; content: CanonicalContentBlock[] };
  extras: Record<string, unknown>;
  /** Set on cumulative-text parts and on a call's pending/running parts.
   *  The recorder replaces the message it previously recorded under this
   *  key rather than appending a new one. */
  coalesceKey?: string;
  /** The call whose streaming is over: its result closes the key. */
  closeKeys?: string[];
} {
  const ev = (raw ?? {}) as OpencodeEvent;
  const extras: { opencode_unmapped?: Array<{ type: string; raw: unknown }> } = {};

  // Non-content lifecycle events (session.idle/error, permission.updated,...).
  if (ev.type !== 'message.part.updated') {
    return { message: { role: 'assistant', content: [] }, extras };
  }
  const part = ev.properties?.part;
  if (!part) return { message: { role: 'assistant', content: [] }, extras };

  const content: CanonicalContentBlock[] = [];
  let role: 'user' | 'assistant' = 'assistant';
  let coalesceKey: string | undefined;
  let closeKeys: string[] | undefined;

  if (part.type === 'text' && typeof part.text === 'string') {
    content.push({ type: 'text', text: part.text });
    // `part.id` identifies the streaming part across its updates. Fall back to
    // callID, then to a stable per-event constant so a part with no id at all
    // still coalesces within its turn rather than reproducing the old defect.
    coalesceKey = `text:${part.id ?? part.callID ?? 'anonymous'}`;
  } else if (part.type === 'tool') {
    const state = part.state ?? {};
    const callId = part.callID ?? part.id ?? '';
    if (state.status === 'running' || state.status === 'pending') {
      content.push({
        type: 'tool_use',
        id: callId,
        name: opencodeCatalogToolName(part.tool ?? ''),
        input: (state.input as Record<string, unknown>) ?? {},
      });
      coalesceKey = `tool:${callId}`;
    } else if (state.status === 'completed' || state.status === 'error') {
      role = 'user';
      const isError = state.status === 'error' || !!state.error;
      content.push({
        type: 'tool_result',
        tool_use_id: callId,
        content: toResultContent(state.error ?? state.output),
        ...(isError ? { is_error: true } : {}),
      });
      closeKeys = [`tool:${callId}`];
    }
  } else if (part.type === 'step-finish' || part.type === 'step-start') {
    // Usage / step markers — no trajectory content (usage is emitted by the adapter).
  } else if (part.type) {
    (extras.opencode_unmapped ??= []).push({ type: String(part.type), raw: ev });
    unknown.add(`opencode:${part.type}`);
  }

  return {
    message: { role, content },
    extras,
    ...(coalesceKey ? { coalesceKey } : {}),
    ...(closeKeys ? { closeKeys } : {}),
  };
}
