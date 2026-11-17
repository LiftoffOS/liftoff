// Reading a Claude Code session, independent of how the messages arrived.
//
// Two transports carry the SAME objects. `@anthropic-ai/claude-agent-sdk`'s
// `query()` yields them from an async iterable; `claude -p --output-format
// stream-json --verbose` prints them one per line — verified against the CLI at
// 2.1.88, whose output is the SDK's SDKMessage union exactly.
//
// So the reducer lives here and both transports feed it. The alternative — a
// second copy for the CLI path — would drift on the one thing that has already
// gone wrong once: which terminal messages count as a failure. That answer is
// subtle enough to get wrong in one place, and having it in two would mean the
// sandboxed path and the in-process path disagreeing about whether the same
// session succeeded.

import type { CodeSessionModelUsage, CodeSessionExitReason, RunnerResult } from '../types';

export const ANTHROPIC_DEFAULT_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Task'];

/** The instruction wrapper both transports send, so a sandboxed session and an
 *  in-process one are given the same job in the same words.
 *
 *  Here rather than beside the SDK runner so the sandboxed transport can reach
 *  it WITHOUT importing `@anthropic-ai/claude-agent-sdk`. That is not tidiness:
 *  a CLI runner that drags the SDK in loads a vendor package it never calls,
 *  and INV-TR-007 exists to stop exactly that. */
export function anthropicCodeSessionPrompt(task: string, workspaceRoot: string): string {
  return `${task}\n\nWork in this workspace (${workspaceRoot}). Use the `
    + `native tools to read, edit, and verify your changes. When done, `
    + `your final response should be a concise summary of what you changed.`;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** The per-model slice of the terminal `result` message.
 *  Both SDKResultSuccess and SDKResultError carry `modelUsage` (sdk.d.ts:4279
 *  and :4312), so a session that ends in an error is metered exactly like one
 *  that succeeds — the tokens were spent either way. */
interface AnthropicModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  costUSD?: number;
}

export interface AnthropicMessage {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  api_error_status?: number | null;
  message?: { model?: string; content?: unknown };
  tool_use_result?: unknown;
  modelUsage?: Record<string, AnthropicModelUsageEntry>;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
}

export interface AnthropicStreamState {
  summary: string;
  toolCallsMade: RunnerResult['tool_calls_made'];
  exitReason: CodeSessionExitReason;
  modelUsage?: CodeSessionModelUsage[];
  usage?: Record<string, unknown>;
  /** The terminal message has been seen; nothing after it matters. */
  done: boolean;
  /** A `subtype:'success'` that carried `is_error`, with the API status when
   *  the message named one. Worth a log line at the call site: it means the
   *  session ended tidily having done nothing. */
  apiErrorUnderSuccess?: { status: number | null };
}

export function createAnthropicStreamState(): AnthropicStreamState {
  return { summary: '', toolCallsMade: [], exitReason: 'success', done: false };
}

/** Fold one message into the state. Safe to call after `done`. */
export function applyAnthropicMessage(
  state: AnthropicStreamState,
  message: AnthropicMessage,
): void {
  if (state.done) return;

  if (message.type === 'assistant' && message.message?.content) {
    for (const block of message.message.content as AnthropicContentBlock[]) {
      if (block.type === 'tool_use' && block.name) {
        state.toolCallsMade.push({ tool: block.name, args: block.input, result: '' });
      } else if (block.type === 'text' && typeof block.text === 'string') {
        state.summary = block.text;
      }
    }
  }

  if (message.type === 'user' && message.tool_use_result !== undefined) {
    const lastUnpaired = [...state.toolCallsMade].reverse().find((c) => c.result === '');
    if (lastUnpaired) {
      lastUnpaired.result = typeof message.tool_use_result === 'string'
        ? message.tool_use_result
        : JSON.stringify(message.tool_use_result);
    }
  }

  if (message.type === 'result') {
    // Two independent ways this can be a failure, and checking only the first
    // is how an API error reads as finished work.
    //
    // `subtype` names the SESSION's outcome: error_during_execution /
    // error_max_turns / error_max_budget_usd /
    // error_max_structured_output_retries (sdk.d.ts:4268).
    //
    // `is_error` names the TURN's outcome, and SDKResultSuccess declares it too
    // (sdk.d.ts:4305, beside `api_error_status`) — so a session that reached
    // its end tidily, having got a 404/429/529/401 from the API, is
    // `subtype:'success'` with `is_error:true`. Verified against the CLI: a
    // request for an unavailable model emits exactly
    // {"subtype":"success","is_error":true,...,"modelUsage":{}}.
    if (message.subtype !== 'success' || message.is_error === true) {
      state.exitReason = 'error';
      if (message.is_error === true && message.subtype === 'success') {
        state.apiErrorUnderSuccess = { status: message.api_error_status ?? null };
      }
    }

    // The terminal message is the only place the session reports what it cost.
    // `costUSD` is the vendor's OWN per-model figure — load-bearing, because
    // the session runs on whatever model the CLI defaulted to and our rate
    // table cannot be assumed to know it.
    state.modelUsage = Object.entries(message.modelUsage ?? {}).map(([model, entry]) => ({
      model,
      inputTokens: entry.inputTokens ?? 0,
      outputTokens: entry.outputTokens ?? 0,
      // cache READ only, matching what the outer Anthropic adapter reports as
      // cachedTokens — the same column has to mean the same thing.
      cachedTokens: entry.cacheReadInputTokens ?? 0,
      ...(typeof entry.costUSD === 'number' ? { costUsd: entry.costUSD } : {}),
    }));
    state.usage = {
      ...(message.usage ?? {}),
      ...(typeof message.total_cost_usd === 'number'
        ? { total_cost_usd: message.total_cost_usd }
        : {}),
    };
    state.done = true;
  }
}

/** The RunnerResult fields this stream determines. */
export function finalizeAnthropicStream(
  state: AnthropicStreamState,
): Pick<RunnerResult, 'summary' | 'tool_calls_made' | 'exit_reason' | 'usage' | 'modelUsage'> {
  return {
    summary: state.summary,
    tool_calls_made: state.toolCallsMade,
    exit_reason: state.exitReason,
    ...(state.usage ? { usage: state.usage } : {}),
    ...(state.modelUsage && state.modelUsage.length > 0 ? { modelUsage: state.modelUsage } : {}),
  };
}

/** Parse NDJSON, skipping anything that is not a JSON object.
 *
 *  A CLI's stdout is not guaranteed to be only the stream: a warning, a
 *  progress line, or a partial final line after a kill all turn up. Dropping
 *  them is right; throwing would lose every message that DID parse, including
 *  the terminal one that carries the bill.
 *
 *  Generic because Codex emits JSONL too, and the failure modes are the same
 *  ones for the same reasons. */
export function* parseNdjson<T = AnthropicMessage>(stdout: string): Generator<T> {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed[0] !== '{') continue;
    try {
      yield JSON.parse(trimmed) as T;
    } catch {
      // A truncated last line is expected when a session is killed at its
      // deadline. Everything before it still counts.
    }
  }
}
