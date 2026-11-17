// Gemini CLI stream-json event → canonical block array.
//
// The adapter taps recordRaw with each JSONL event the CLI prints
// (`--output-format stream-json`). Mapping mirrors the adapter's translation:
//   message (assistant, delta)  → assistant[text], COALESCED per turn
//   tool_use                    → assistant[tool_use]
//                                 (google_web_search → server_tool_use: it is
//                                  Google's own grounded search, not a call
//                                  through our gateway)
//   tool_result                 → user[tool_result] (is_error on status error);
//                                 for a google_web_search call, the hosted
//                                 form user[web_search_tool_result] — a
//                                 `tool_result` there would answer a call no
//                                 replay can re-dispatch, and the repair pass
//                                 would drop it as an orphan
//   init / error / result       → no content (session id, warnings and usage
//                                 are emitted by the adapter)
// Unrecognized event types are preserved in extras.gemini_cli_unmapped and
// flagged on the unknown set.
//
// COALESCING. The CLI streams the assistant's text as `message` events with
// `delta: true`, each carrying ONE chunk rather than the cumulative text — the
// opposite of opencode. Appending a block per chunk would record an answer as
// N fragments, so the chunks are joined under one key per turn with the
// recorder's CONCAT join (opencode's cumulative parts use REPLACE), and the
// key is closed at the turn's `result` so the next turn's answer starts a new
// block rather than growing the last one. The mapper itself stays stateless.

import type { CanonicalContentBlock } from '../types';
import { geminiCliCatalogToolName } from '../../agent-execution/adapter/mcp-tool-names';

interface GeminiCliEvent {
  type?: string;
  session_id?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  tool_name?: string;
  tool_id?: string;
  parameters?: Record<string, unknown>;
  status?: string;
  output?: string;
  error?: { type?: string; message?: string };
  severity?: string;
  message?: string;
}

const GOOGLE_WEB_SEARCH = 'google_web_search';

/** One key per turn's answer: the recorder joins every delta recorded under
 *  it, and the turn's `result` closes it. */
const TURN_TEXT_KEY = 'text:turn';

/** Calls that were the CLI's own search, so their results record in the
 *  hosted form. A `tool_result` event names only the call id, and the CLI's
 *  ids are unique per process, so a bounded set is enough to answer. */
const webSearchCallIds = new Set<string>();
const WEB_SEARCH_CALL_IDS_CAP = 2_000;


export function geminiCliEventToCanonical(raw: unknown, unknown: Set<string>): {
  message: { role: 'user' | 'assistant'; content: CanonicalContentBlock[] };
  extras: Record<string, unknown>;
  coalesceKey?: string;
  coalesce?: 'replace' | 'concat';
  closeKeys?: string[];
} {
  const ev = (raw ?? {}) as GeminiCliEvent;
  const extras: { gemini_cli_unmapped?: Array<{ type: string; raw: unknown }> } = {};
  const content: CanonicalContentBlock[] = [];
  let role: 'user' | 'assistant' = 'assistant';
  let coalesceKey: string | undefined;
  let closeKeys: string[] | undefined;

  switch (ev.type) {
    case 'init':
      closeKeys = [TURN_TEXT_KEY];
      break;
    case 'message':
      if (ev.role === 'assistant' && typeof ev.content === 'string' && ev.content) {
        content.push({ type: 'text', text: ev.content });
        coalesceKey = TURN_TEXT_KEY;
      }
      break;
    case 'tool_use': {
      // A call ends the text before it: the answer after the tool's result is
      // a new block, in order, not a continuation of the one before the call.
      closeKeys = [TURN_TEXT_KEY];
      const name = ev.tool_name ?? '';
      const input = (ev.parameters as Record<string, unknown>) ?? {};
      if (name === GOOGLE_WEB_SEARCH) {
        if (webSearchCallIds.size >= WEB_SEARCH_CALL_IDS_CAP) webSearchCallIds.clear();
        if (ev.tool_id) webSearchCallIds.add(ev.tool_id);
        content.push({ type: 'server_tool_use', id: ev.tool_id ?? '', name: 'web_search', input });
      } else {
        content.push({ type: 'tool_use', id: ev.tool_id ?? '', name: geminiCliCatalogToolName(name), input });
      }
      break;
    }
    case 'tool_result': {
      role = 'user';
      const id = ev.tool_id ?? '';
      const isError = ev.status === 'error' || !!ev.error;
      if (webSearchCallIds.has(id) || id.startsWith(`${GOOGLE_WEB_SEARCH}-`)) {
        webSearchCallIds.delete(id);
        content.push({ type: 'web_search_tool_result', tool_use_id: id, content: ev.error?.message ?? ev.output ?? '' });
        break;
      }
      content.push({
        type: 'tool_result',
        tool_use_id: id,
        content: ev.error?.message ?? ev.output ?? '',
        ...(isError ? { is_error: true } : {}),
      });
      break;
    }
    case 'error':
      // Warnings — emitted by the adapter, not content.
      break;
    case 'result':
      // The turn's usage — emitted by the adapter. The answer is complete.
      closeKeys = [TURN_TEXT_KEY];
      break;
    default:
      if (ev.type) {
        (extras.gemini_cli_unmapped ??= []).push({ type: String(ev.type), raw: ev });
        unknown.add(`gemini_cli:${ev.type}`);
      }
  }

  return {
    message: { role, content },
    extras,
    ...(coalesceKey ? { coalesceKey, coalesce: 'concat' as const } : {}),
    ...(closeKeys ? { closeKeys } : {}),
  };
}
