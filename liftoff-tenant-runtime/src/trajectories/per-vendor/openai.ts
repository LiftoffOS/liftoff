// Part 6 §D — OpenAI RunItem raw → canonical block array.
//
// RunItem type strings verified against @openai/agents-core/items.d.ts:
//   message_output_item   — AssistantMessageItem with output_text + refusal blocks
//   tool_call_item        — FunctionCallItem with stringified arguments
//   tool_call_output_item — FunctionCallOutputItem with output payload
//   reasoning_item        — ReasoningItem with content[] (summary) + rawContent[]
//                           (full reasoning_text) + providerData.encrypted_content
//
// `arguments` arrives as a JSON string. We parse to Record<string, unknown>
// for the canonical schema; the inverse mapper re-stringifies on the way out
// (round-trip is byte-faithful for well-formed JSON; whitespace differences are
// replay-irrelevant). Malformed `arguments` are preserved verbatim under
// `__raw_arguments` rather than dropping the call — see note 3 below.
//
// Fidelity rules this mapper has to hold to (it was the lossiest of the six):
//  1. reasoning stays WITH its message via `message_scoped`, not in a run-level
//     flat array that `mergeProviderExtras` concatenates and nothing can re-pair.
//  2. a refusal is a first-class `refusal` block, not `extras.refusals[]`.
//  3. a `tool_call_item` with invalid-JSON `arguments` still emits its
//     `tool_use` — the call HAPPENED, and dropping it orphans the tool_result
//     that follows, which is exactly what makes providers 400 on replay.
//  4. `tool_call_output_item` carries `is_error`.

import type { CanonicalContentBlock } from '../types';

/** A function-call result the SDK could not complete successfully.
 *
 *  `@openai/agents-core` has no `is_error` on `FunctionCallResultItem`, so the
 *  error signal has to be read off the three places it actually appears:
 *  the SDK's own `status` (a failed call lands `incomplete`), `providerData.error`,
 *  and our mcp-bridge's uniform TOOL_ERROR envelope, which returns
 *  `{ content: [...], isError: true }` or `{ error }` as the tool's output. */
export function isFunctionCallError(r: {
  status?: string;
  providerData?: Record<string, unknown>;
  output?: unknown;
}): boolean {
  if (r.status === 'incomplete') return true;
  if (r.providerData && r.providerData.error) return true;
  const out = r.output;
  if (out && typeof out === 'object') {
    const o = out as { isError?: unknown; error?: unknown };
    if (o.isError === true) return true;
    if (o.error !== undefined && o.error !== null) return true;
  }
  return false;
}

export function openaiRunItemToCanonical(
  raw: unknown,
  unknown: Set<string>,
  unknownReplayRelevant: Set<string> = new Set(),
): {
  message: { role: 'user' | 'assistant'; content: CanonicalContentBlock[]; message_scoped?: Record<string, unknown> };
  extras: Record<string, unknown>;
} {
  const item = raw as { type: string; rawItem?: unknown };
  const content: CanonicalContentBlock[] = [];
  const extras: Record<string, unknown> = {};

  switch (item.type) {
    case 'reasoning_item': {
      const r = item.rawItem as {
        id?: string;
        content?: Array<{ text: string }>;
        rawContent?: Array<{ text: string }>;
        providerData?: Record<string, unknown>;
      };
      // Prefer rawContent (full reasoning_text) over content (summary input_text).
      const text = (r.rawContent ?? r.content ?? []).map((p) => p.text).join('\n');
      const encRaw = r.providerData?.encrypted_content;
      const enc = typeof encRaw === 'string' ? encRaw : undefined;
      // Push even when `text` is empty but `enc` is present: an OpenAI
      // signed-but-empty reasoning block is load-bearing on same-engine replay.
      if (text || enc) {
        content.push({ type: 'thinking', thinking: text, signature: undefined });
      }
      return {
        message: {
          role: 'assistant',
          content,
          message_scoped: { responses_api_id: r.id, encrypted_reasoning: enc },
        },
        extras,
      };
    }
    case 'message_output_item': {
      const r = item.rawItem as {
        content?: Array<{ type: string; text?: string; refusal?: string }>;
      };
      const text = (r.content ?? [])
        .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
        .map((c) => c.text!)
        .join('');
      const refusal = (r.content ?? [])
        .filter((c) => c.type === 'refusal' && typeof c.refusal === 'string')
        .map((c) => c.refusal!)
        .join('');
      if (text) content.push({ type: 'text', text });
      // A refusal is content, not an extra.
      if (refusal) content.push({ type: 'refusal', text: refusal });
      return { message: { role: 'assistant', content }, extras };
    }
    case 'tool_call_item': {
      const r = item.rawItem as {
        type: string;
        name?: string;
        arguments?: string;
        call_id?: string | null;
        id?: string;
      };
      if (r.type !== 'function_call' || typeof r.arguments !== 'string') {
        unknown.add(`tool_call_item:${r.type}`);
        return { message: { role: 'assistant', content: [] }, extras };
      }
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(r.arguments) as Record<string, unknown>; }
      catch {
        // A malformed call still happened. Emit it; do not orphan its result.
        unknownReplayRelevant.add('openai:invalid_json_args');
        parsed = { __raw_arguments: r.arguments };
      }
      content.push({
        type: 'tool_use',
        id: r.call_id ?? r.id ?? '',
        name: r.name ?? '',
        input: parsed,
      });
      return { message: { role: 'assistant', content }, extras };
    }
    case 'tool_call_output_item': {
      const r = item.rawItem as {
        output?: unknown;
        call_id?: string | null;
        id?: string;
        status?: string;
        providerData?: Record<string, unknown>;
      };
      content.push({
        type: 'tool_result',
        tool_use_id: r.call_id ?? r.id ?? '',
        ...(isFunctionCallError(r) ? { is_error: true } : {}),
        content: [{
          type: 'text',
          text: typeof r.output === 'string' ? r.output : JSON.stringify(r.output),
        }],
      });
      return { message: { role: 'user', content }, extras };
    }
    default:
      unknown.add(item.type);
      return { message: { role: 'assistant', content: [] }, extras };
  }
}
