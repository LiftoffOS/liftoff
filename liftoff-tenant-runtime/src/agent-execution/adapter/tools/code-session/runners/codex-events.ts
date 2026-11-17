// Reading a Codex session, independent of how the events arrived.
//
// `@openai/codex-sdk` spawns the `codex` binary and translates its JSONL into
// ThreadEvents, so the SDK transport and the CLI transport carry the same
// objects. This module is what both of them fold those objects with.
//
// The types here are STRUCTURAL rather than the SDK's. Two reasons, and the
// second is the load-bearing one:
//
//   1. The CLI transport parses JSON and has no SDK types to hand.
//   2. INV-TR-007 restricts vendor SDK imports by module basename, so a shared
//      module that imported `@openai/codex-sdk` — or that simply lived in a
//      file called `openai.ts` — could not be imported from a sibling runner.
//      Describing the handful of fields actually read is smaller than the SDK's
//      union anyway, and it makes the coupling visible: these five item shapes
//      and four usage counters are the whole contract.

import type { CodeSessionModelUsage, RunnerResult } from '../types';

export interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface CodexItem {
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  changes?: unknown;
  status?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  error?: { message?: string };
  result?: { content?: unknown; structured_content?: unknown };
  query?: string;
}

/** Fold one completed item into the tool-call list, or into the summary. */
export function handleItem(
  item: CodexItem,
  toolCallsMade: RunnerResult['tool_calls_made'],
  setSummary: (s: string) => void,
): void {
  switch (item.type) {
    case 'agent_message':
      // Last assistant message wins → final summary.
      setSummary(item.text ?? '');
      break;
    case 'command_execution':
      toolCallsMade.push({
        tool: 'Bash',
        args: { command: item.command },
        result: item.aggregated_output ?? '',
      });
      break;
    case 'file_change':
      toolCallsMade.push({
        tool: 'Edit',
        args: { changes: item.changes },
        result: item.status ?? '',
      });
      break;
    case 'mcp_tool_call':
      toolCallsMade.push({
        tool: `${item.server}.${item.tool}`,
        args: item.arguments,
        result: item.error
          ? `error: ${item.error.message}`
          : item.result
            ? JSON.stringify(item.result.content ?? item.result.structured_content)
            : '',
      });
      break;
    case 'web_search':
      toolCallsMade.push({ tool: 'WebSearch', args: { query: item.query }, result: '' });
      break;
    // reasoning / todo_list / error items don't map to platform tool calls.
  }
}

/**
 * Normalize a Codex `Usage` into the metering shape, or undefined when the
 * vendor reported nothing.
 *
 * No `costUsd`: Codex publishes no cost figure of its own the way the Claude
 * SDK does. When a model was pinned the id rides along and the dispatch site
 * prices it off the platform rate table; when it was not, Codex names no model
 * on ANY event it emits — the whole event union carries usage alone — and the
 * default it runs is fetched from OpenAI's own remote manifest at run time, so
 * the spend is recorded and counted as unpriced. Visible and fixable beats an
 * invented number.
 */
export function modelUsageFrom(
  u: CodexUsage | undefined,
  model: string | undefined,
): CodeSessionModelUsage[] | undefined {
  if (!u) return undefined;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cached = u.cached_input_tokens ?? 0;
  if (input === 0 && output === 0 && cached === 0) return undefined;
  return [{
    ...(model ? { model } : {}),
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
  }];
}

export function usageToRecord(u: CodexUsage): Record<string, unknown> {
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cached_input_tokens: u.cached_input_tokens,
    reasoning_output_tokens: u.reasoning_output_tokens,
  };
}
