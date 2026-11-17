// A conversation's tool history as plain text, for a vendor that cannot be
// told "no tools this time".
//
// `toolChoice: 'none'` is an intent every loop may state: answer now, call
// nothing. Most vendors take it on the wire; some do not (Z.AI documents
// `auto` as the only value; MiniMax's OpenAI-format API documents no
// tool_choice at all). For those the adapter honours the intent the one way
// every chat API accepts by construction: no tools in the request, and no
// tool-call or tool-result blocks in the messages — because a message that
// carries them is only valid beside a tools definition on many APIs. The
// calls and their results are folded into the text of the turns that made
// them, so the model still reads everything the turn gathered.

import type { LLMCompletionRequest, LLMMessage } from './types';

const ARGS_CHARS = 400;

function argsText(input: unknown): string {
  const s = JSON.stringify(input ?? {});
  return s.length > ARGS_CHARS ? `${s.slice(0, ARGS_CHARS)}…` : s;
}

/** The same request with every tool call and tool result rendered into the
 *  text of its own message, and no tool fields left. Messages without tool
 *  fields are returned as they are. */
export function foldToolHistory(request: LLMCompletionRequest): LLMCompletionRequest {
  const names = new Map<string, string>();
  const messages: LLMMessage[] = request.messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) names.set(tc.id, tc.name);
      const calls = m.toolCalls.map((tc) => `${tc.name}(${argsText(tc.input)})`).join('\n');
      const { toolCalls: _calls, ...rest } = m;
      return { ...rest, content: `${m.content ? `${m.content}\n\n` : ''}[Tools called]\n${calls}` };
    }
    if (m.role === 'user' && m.toolResults && m.toolResults.length > 0) {
      const results = m.toolResults
        .map((tr) => `${names.get(tr.toolCallId) ?? tr.toolCallId}:\n${tr.content}`)
        .join('\n\n');
      const { toolResults: _results, ...rest } = m;
      return { ...rest, content: `[Tool results]\n${results}${m.content ? `\n\n${m.content}` : ''}` };
    }
    return m;
  });
  const { toolResults: _legacy, tools: _tools, serverTools: _server, toolChoice: _choice, ...rest } = request;
  return { ...rest, messages };
}
