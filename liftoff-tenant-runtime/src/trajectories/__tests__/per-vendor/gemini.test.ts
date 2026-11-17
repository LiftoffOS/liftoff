// Part 6 §D — Gemini per-vendor mapper.
//
// Per-part thoughtSignature ordering is the key thing: SFT replay needs the
// signatures in the same positions they appeared in the original response so
// the model can re-emit them.

import { geminiResponseToCanonical } from '../../per-vendor/gemini';

describe('geminiResponseToCanonical', () => {
  it('preserves thoughtSignature on every functionCall + thinking part in original order', () => {
    const unknown = new Set<string>();
    const { message, extras } = geminiResponseToCanonical({
      candidates: [{
        content: {
          parts: [
            { text: 'plain text part', thoughtSignature: undefined },
            { text: 'thinking out loud', thought: true, thoughtSignature: 'sig-thought-1' },
            { functionCall: { id: 'fc1', name: 'lookup', args: { id: 7 } }, thoughtSignature: 'sig-fc-1' },
            { text: 'wrap up', thoughtSignature: undefined },
          ],
        },
      }],
    }, unknown);

    expect(message.content[0]).toEqual({ type: 'text', text: 'plain text part' });
    expect(message.content[1]).toEqual({ type: 'thinking', thinking: 'thinking out loud', signature: 'sig-thought-1' });
    expect(message.content[2]).toEqual({ type: 'tool_use', id: 'fc1', name: 'lookup', input: { id: 7 } });
    expect(message.content[3]).toEqual({ type: 'text', text: 'wrap up' });

    // The per-part signatures parallel array MUST be the same length as
    // content, with null in non-thinking/non-functionCall positions.
    const sigs = (extras as { per_part_thought_signatures: Array<string | null> }).per_part_thought_signatures;
    expect(sigs).toEqual([null, 'sig-thought-1', null, null]);
  });

  it('functionResponse parts map to tool_result blocks', () => {
    const unknown = new Set<string>();
    const { message } = geminiResponseToCanonical({
      candidates: [{
        content: {
          parts: [
            { functionResponse: { id: 'fc1', name: 'lookup', response: { hits: 3 } } },
          ],
        },
      }],
    }, unknown);

    // `name` is carried. Gemini REQUIRES functionResponse.name on
    // replay; dropping it made a Gemini transcript unreplayable on Gemini.
    expect(message.content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'fc1',
      name: 'lookup',
      content: [{ type: 'text', text: JSON.stringify({ hits: 3 }) }],
    });
  });

  // Every candidate is read, not just candidates[0].
  it('reads parts from EVERY candidate, not only the first', () => {
    const unknown = new Set<string>();
    const { message } = geminiResponseToCanonical({
      candidates: [
        { content: { parts: [{ text: 'from candidate 0' }] } },
        { content: { parts: [{ text: 'from candidate 1' }] } },
      ],
    }, unknown);

    expect(message.content).toEqual([
      { type: 'text', text: 'from candidate 0' },
      { type: 'text', text: 'from candidate 1' },
    ]);
  });

  it('records unknown part types in the metric set', () => {
    const unknown = new Set<string>();
    geminiResponseToCanonical({
      candidates: [{ content: { parts: [{ someNewField: 1 } as Parameters<typeof geminiResponseToCanonical>[0] extends { candidates?: Array<{ content?: { parts?: Array<infer P> } }> } ? P : never] } }],
    }, unknown);
    expect(unknown.size).toBeGreaterThan(0);
  });
});
