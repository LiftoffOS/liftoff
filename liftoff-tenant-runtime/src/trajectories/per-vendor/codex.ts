// Codex SDK raw ThreadEvent → canonical block array.
//
// The Codex adapter taps recordRaw with the full ThreadEvent (codex/index.ts).
// Each event maps to at most ONE canonical message (all blocks share a role):
// item.completed agent_message → assistant[text]
// item.completed reasoning → assistant[thinking] (Codex reasoning summary; unsigned)
// item.started mcp_tool_call → assistant[tool_use]
// item.completed mcp_tool_call → user[tool_result] (is_error on error/failed)
// item.completed web_search → assistant[server_tool_use]
// item.started command_execution → assistant[tool_use]
// item.completed command_execution → user[tool_result] (is_error on failed)
// item.completed file_change → assistant[tool_use]
// Structural/native events (thread.started, turn.*, item.updated) yield no
// content — usage + session id are surfaced by the adapter as InvocationEvents,
// not as trajectory content. Everything else (todo_list, error items,
// turn.failed, thread error) is preserved verbatim in extras.codex_unmapped and
// flagged on the unknown set, so no event is silently dropped.
//
// command_execution and file_change carry a canonical shape so a Codex
// thread can be rebuilt on ANOTHER engine — `canonicalTo<Vendor>` reads
// `messages` and cannot see `extras`. Same-engine Codex replay does not need it
// (Codex resumes by thread id) and diagnostics never did (extras carried them).
//
// Field names verified against the installed @openai/codex-sdk
// dist/index.d.ts (repo rule: check node_modules, do not guess):
//   CommandExecutionItem { id, type, command, aggregated_output, exit_code?, status }
//     status: 'in_progress' | 'completed' | 'failed'
//   FileChangeItem       { id, type, changes: Array<{ path, kind }>, status }
//     status: 'completed' | 'failed'
// Shapes mirror @openai/codex-sdk ThreadItem/ThreadEvent.

import type { CanonicalContentBlock } from '../types';

interface CodexEvent {
  type?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    server?: string;
    tool?: string;
    arguments?: unknown;
    query?: string;
    result?: { content?: unknown; structured_content?: unknown };
    error?: { message?: string };
    status?: string;
    /** CommandExecutionItem */
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    /** FileChangeItem */
    changes?: Array<{ path?: string; kind?: string }>;
  };
}

function toResultContent(x: unknown): CanonicalContentBlock[] | string {
  if (typeof x === 'string') return x;
  return JSON.stringify(x ?? null);
}

export function codexThreadItemToCanonical(raw: unknown, unknown: Set<string>): {
  message: { role: 'user' | 'assistant'; content: CanonicalContentBlock[] };
  extras: Record<string, unknown>;
} {
  const ev = (raw ?? {}) as CodexEvent;
  const content: CanonicalContentBlock[] = [];
  const extras: {
    codex_unmapped?: Array<{ type: string; raw: unknown }>;
    // Provider-native routing detail the canonical tool_use shape cannot
    // hold: which MCP server handled each call. Preserved per call id.
    codex_tool_servers?: Array<{ id: string; server: string; tool: string }>;
  } = {};
  let role: 'user' | 'assistant' = 'assistant';

  const preserve = (type: string): void => {
    (extras.codex_unmapped ??= []).push({ type, raw: ev });
    unknown.add(`codex:${type}`);
  };

  const evType = ev.type;
  if (evType === 'item.started' || evType === 'item.completed') {
    const item = ev.item ?? {};
    switch (item.type) {
      case 'agent_message':
        if (evType === 'item.completed' && item.text) content.push({ type: 'text', text: item.text });
        break;
      case 'reasoning':
        if (evType === 'item.completed' && item.text) content.push({ type: 'thinking', thinking: item.text });
        break;
      case 'mcp_tool_call':
        if (evType === 'item.started') {
          content.push({
            type: 'tool_use',
            id: item.id ?? '',
            name: item.tool ?? 'unknown',
            input: (item.arguments as Record<string, unknown>) ?? {},
          });
          if (item.server) {
            (extras.codex_tool_servers ??= []).push({ id: item.id ?? '', server: item.server, tool: item.tool ?? '' });
          }
        } else {
          role = 'user';
          const isError = !!item.error || item.status === 'failed';
          content.push({
            type: 'tool_result',
            tool_use_id: item.id ?? '',
            content: toResultContent(item.error?.message ?? item.result),
            ...(isError ? { is_error: true } : {}),
          });
        }
        break;
      case 'web_search':
        if (evType === 'item.completed') {
          content.push({ type: 'server_tool_use', id: item.id ?? '', name: 'web_search', input: { query: item.query ?? '' } });
        }
        break;
      case 'command_execution':
        if (evType === 'item.started') {
          content.push({
            type: 'tool_use',
            id: item.id ?? '',
            name: 'command_execution',
            input: { command: item.command ?? item.text ?? '' },
          });
        } else {
          role = 'user';
          content.push({
            type: 'tool_result',
            tool_use_id: item.id ?? '',
            content: toResultContent(item.aggregated_output ?? item.text),
            ...(item.status === 'failed' ? { is_error: true } : {}),
          });
        }
        break;
      case 'file_change':
        if (evType === 'item.completed') {
          content.push({
            type: 'tool_use',
            id: item.id ?? '',
            name: 'file_change',
            input: { changes: item.changes },
          });
        }
        break;
      // Vendor-native items without a lossless canonical shape — preserved
      // verbatim. Not replay-relevant: a to-do list and a non-fatal error item
      // are narration, not conversation the next engine has to reproduce.
      case 'todo_list':
      case 'error':
        if (evType === 'item.completed') preserve(String(item.type));
        break;
      default:
        if (evType === 'item.completed') preserve(item.type ? String(item.type) : 'unknown_item');
    }
  } else if (
    evType === 'thread.started' || evType === 'turn.started' ||
    evType === 'turn.completed' || evType === 'item.updated'
  ) {
    // No canonical content.
  } else if (evType === 'turn.failed' || evType === 'error') {
    preserve(String(evType));
  } else if (evType) {
    preserve(String(evType));
  }

  return { message: { role, content }, extras };
}
