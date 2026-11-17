// Part 6 §D — Gemini response raw → canonical block array.
//
// Maps `candidates[].content.parts[]` to canonical blocks. Records each
// part's thoughtSignature in extras.per_part_thought_signatures (parallel
// array, same length as content blocks) so Gemini → Gemini replay can
// reconstruct the signatures verbatim — they would otherwise be lost in the
// SFT export shape.

import type { CanonicalContentBlock } from '../types';

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name?: string; response?: unknown };
}

export function geminiResponseToCanonical(raw: unknown, unknown: Set<string>): {
  message: { role: 'user' | 'assistant'; content: CanonicalContentBlock[] };
  extras: Record<string, unknown>;
} {
  const r = raw as { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> };
  // Iterate EVERY candidate, not just candidates[0]. A multi-candidate response
  // otherwise loses everything past the first, and the loss is invisible.
  const parts = (r.candidates ?? []).flatMap((c) => c.content?.parts ?? []);
  const content: CanonicalContentBlock[] = [];
  const partSignatures: Array<string | null> = [];

  for (const p of parts) {
    if (typeof p.text === 'string' && !p.thought) {
      content.push({ type: 'text', text: p.text });
      partSignatures.push(null);
    } else if (p.thought) {
      content.push({ type: 'thinking', thinking: p.text ?? '', signature: p.thoughtSignature });
      partSignatures.push(p.thoughtSignature ?? null);
    } else if (p.functionCall) {
      content.push({
        type: 'tool_use',
        id: p.functionCall.id ?? '',
        name: p.functionCall.name,
        input: p.functionCall.args ?? {},
      });
      partSignatures.push(null);
    } else if (p.functionResponse) {
      // function_response → tool_result on a (canonical) user-role message.
      // The recorder emits this canonical message under role 'assistant' as
      // a quirk of streaming aggregation — fix up here so the canonical
      // schema's role contract holds.
      content.push({
        type: 'tool_result',
        tool_use_id: p.functionResponse.id ?? '',
        // Gemini requires `name` on replay.
        name: p.functionResponse.name,
        content: [{ type: 'text', text: JSON.stringify(p.functionResponse.response ?? null) }],
      });
      partSignatures.push(null);
    } else {
      unknown.add(Object.keys(p).join('|') || 'empty');
    }
  }
  return {
    message: { role: 'assistant', content },
    extras: { per_part_thought_signatures: partSignatures },
  };
}
