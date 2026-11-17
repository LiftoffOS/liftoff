// Part 6 §D — Anthropic SDK raw → canonical block array.
//
// Variants handled directly: text, thinking, redacted_thinking, tool_use,
// tool_result (only on user-role; see A4 in plan), server_tool_use,
// web_search_tool_result, web_fetch_tool_result. Everything else falls into
// extras.unknown_blocks verbatim so downstream consumers (or a future schema
// version) can recover them without re-running the invocation.

import type { CanonicalContentBlock } from '../types';

interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: CanonicalContentBlock[] | string;
  is_error?: boolean;
  citations?: import('../types').Citation[];
}

export function anthropicSDKMessageToCanonical(raw: unknown, unknown: Set<string>): {
  message: { role: 'user' | 'assistant'; content: CanonicalContentBlock[] };
  extras: Record<string, unknown>;
} {
  const m = raw as { role: 'user' | 'assistant'; content: AnthropicBlock[] };
  const content: CanonicalContentBlock[] = [];
  const extras: { unknown_blocks?: Array<{ type: string; raw: unknown }> } = {};

  for (const b of m.content ?? []) {
    switch (b.type) {
      case 'text':
        content.push({ type: 'text', text: b.text ?? '', citations: b.citations });
        break;
      case 'thinking':
        content.push({ type: 'thinking', thinking: b.thinking ?? '', signature: b.signature });
        break;
      case 'redacted_thinking':
        content.push({ type: 'redacted_thinking', data: b.data ?? '' });
        break;
      case 'tool_use':
        content.push({ type: 'tool_use', id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} });
        break;
      case 'tool_result':
        // Only valid on user-role messages — see §A4 PostToolUse capture.
        content.push({ type: 'tool_result', tool_use_id: b.tool_use_id ?? '', content: b.content ?? [], is_error: b.is_error });
        break;
      case 'server_tool_use':
        content.push({ type: 'server_tool_use', id: b.id ?? '', name: b.name ?? '', input: b.input ?? {} });
        break;
      case 'web_search_tool_result':
        content.push({ type: 'web_search_tool_result', tool_use_id: b.tool_use_id ?? '', content: b.content });
        break;
      case 'web_fetch_tool_result':
        content.push({ type: 'web_fetch_tool_result', tool_use_id: b.tool_use_id ?? '', content: b.content });
        break;
      default:
        // Preserve unknown block types verbatim so we don't lose training data
        // on a new Anthropic block (mcp_tool_*, code_execution_*, etc.). The
        // unknown-block metric flags new types so the schema can catch up
        // before they ship in canonical output.
        (extras.unknown_blocks ??= []).push({ type: b.type, raw: b });
        unknown.add(b.type);
    }
  }
  return { message: { role: m.role, content }, extras };
}
