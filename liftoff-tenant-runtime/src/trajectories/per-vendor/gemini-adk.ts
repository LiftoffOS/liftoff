// Google ADK raw Event → canonical block array.
//
// An ADK Event wraps a Gemini Content ({ role?, parts: Part[] }) plus
// usageMetadata / errorCode / errorMessage. Parts map like the @google/genai
// mapper: text → text, thought → thinking (with signature), functionCall →
// tool_use, functionResponse → tool_result (role user). Error events carry
// errorCode/errorMessage and no content — preserved in extras.adk_error (the
// adapter emits its own anomaly + completion:error). Unrecognized parts are
// flagged on the unknown set so nothing is silently dropped.

import type { CanonicalContentBlock } from '../types';

interface AdkPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name?: string; response?: unknown };
}

interface AdkEvent {
  content?: { role?: string; parts?: AdkPart[] };
  errorCode?: string;
  errorMessage?: string;
}

export function adkEventToCanonical(raw: unknown, unknown: Set<string>): {
  message: { role: 'user' | 'assistant'; content: CanonicalContentBlock[] };
  extras: Record<string, unknown>;
} {
  const ev = (raw ?? {}) as AdkEvent;
  const extras: {
    adk_error?: { errorCode?: string; errorMessage?: string };
    per_part_thought_signatures?: Array<string | null>;
  } = {};

  // ADK surfaces model/transport failures as an event with errorCode/errorMessage
  // and no content. Preserve the failure verbatim; the adapter emits its own
  // anomaly + completion:error separately.
  if (ev.errorCode || ev.errorMessage) {
    extras.adk_error = { errorCode: ev.errorCode, errorMessage: ev.errorMessage };
    unknown.add('adk:error');
    return { message: { role: 'assistant', content: [] }, extras };
  }

  const parts = ev.content?.parts ?? [];
  const content: CanonicalContentBlock[] = [];
  const partSignatures: Array<string | null> = [];
  let role: 'user' | 'assistant' = 'assistant';

  for (const p of parts) {
    if (p.functionResponse) {
      role = 'user';
      content.push({
        type: 'tool_result',
        tool_use_id: p.functionResponse.id ?? '',
        // Gemini requires `name` on replay.
        name: p.functionResponse.name,
        content: [{ type: 'text', text: JSON.stringify(p.functionResponse.response ?? null) }],
      });
      partSignatures.push(null);
    } else if (p.functionCall) {
      content.push({
        type: 'tool_use',
        id: p.functionCall.id ?? '',
        name: p.functionCall.name,
        input: p.functionCall.args ?? {},
      });
      partSignatures.push(null);
    } else if (p.thought) {
      content.push({ type: 'thinking', thinking: p.text ?? '', signature: p.thoughtSignature });
      partSignatures.push(p.thoughtSignature ?? null);
    } else if (typeof p.text === 'string') {
      content.push({ type: 'text', text: p.text });
      partSignatures.push(null);
    } else {
      unknown.add(`adk:${Object.keys(p).join('|') || 'empty'}`);
    }
  }

  if (partSignatures.some((s) => s !== null)) extras.per_part_thought_signatures = partSignatures;
  return { message: { role, content }, extras };
}
