// One test per repair rule, plus a property test over every engine pair.
//
// The property test is the one that matters: a repaired transcript has to be
// acceptable to the engine it is being replayed on, for EVERY (source, target)
// combination, not just the pairs somebody thought to enumerate.

import { repairForReplay } from '../repair';
import type { CanonicalMessage } from '../types';
import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../../agent-execution/adapter/types';
import type { ExecutionEngineId } from '../../agent-execution/adapter/types';
import { FIDELITY_FIXTURES, runFidelityFixture } from '../fidelity-fixtures';

// Derived, because the header above promises every combination rather than the
// pairs somebody thought to enumerate — and written out, this list was one
// engine short of every combination.
const ENGINES: readonly ExecutionEngineId[] = RESOLVABLE_EXECUTION_ENGINE_IDS;

const sameEngine = {
  sourceEngine: 'claude-agent-sdk' as ExecutionEngineId,
  targetEngine: 'claude-agent-sdk' as ExecutionEngineId,
  targetSupportsImages: true,
};
const crossEngine = {
  sourceEngine: 'openai-agents' as ExecutionEngineId,
  targetEngine: 'claude-agent-sdk' as ExecutionEngineId,
  targetSupportsImages: true,
};

describe('rule 1 — drop failed assistant turns', () => {
  const messages: CanonicalMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'partial answ' }] },
  ];

  it('keeps the trailing assistant turn when the run did not fail', () => {
    const out = repairForReplay(messages, sameEngine);
    expect(out).toHaveLength(2);
  });

  it('drops the trailing assistant turn when the run ended error or aborted', () => {
    const out = repairForReplay(messages, { ...sameEngine, lastTurnFailed: true });
    expect(out).toEqual([{ role: 'user', content: [{ type: 'text', text: 'do the thing' }] }]);
  });

  it('keeps earlier assistant turns — a run has one terminal event, not one per turn', () => {
    const out = repairForReplay([
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'complete answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
    ], { ...sameEngine, lastTurnFailed: true });
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('rule 2 — synthesize missing tool results', () => {
  it('answers a dangling tool_use before the next message', () => {
    const out = repairForReplay([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'file_read', input: {} }] },
      { role: 'user', content: [{ type: 'text', text: 'never mind' }] },
    ], sameEngine);

    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'No result provided', is_error: true }],
    });
  });

  it('answers a dangling tool_use at end of conversation', () => {
    const out = repairForReplay([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'file_read', input: {} }] },
    ], sameEngine);
    expect(out).toHaveLength(2);
    expect((out[1].content[0] as { tool_use_id: string }).tool_use_id).toBe('t9');
  });

  // A fabricated success would tell the model its call worked and let it build
  // on an outcome that never happened.
  it('marks the synthesized result is_error, never a fabricated success', () => {
    const out = repairForReplay([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
    ], sameEngine);
    expect((out[1].content[0] as { is_error?: boolean }).is_error).toBe(true);
  });

  it('leaves an already-answered tool_use alone', () => {
    const out = repairForReplay([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'real result' }] },
    ], sameEngine);
    expect(out).toHaveLength(2);
  });
});

describe('rule 3 — normalize tool-call ids across engines', () => {
  // OpenAI Responses emits ids over 450 chars containing '|'; Anthropic requires
  // ^[a-zA-Z0-9_-]{1,64}$.
  const hostile = `fc_${'a'.repeat(460)}|call|${'b'.repeat(20)}`;

  it('rewrites an id the target cannot accept, and its result with it', () => {
    const out = repairForReplay([
      { role: 'assistant', content: [{ type: 'tool_use', id: hostile, name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: hostile, content: 'ok' }] },
    ], crossEngine);

    const useId = (out[0].content[0] as { id: string }).id;
    const resultId = (out[1].content[0] as { tool_use_id: string }).tool_use_id;
    expect(useId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(resultId).toBe(useId);
  });

  it('leaves ids alone on a same-engine replay', () => {
    const out = repairForReplay([
      { role: 'assistant', content: [{ type: 'tool_use', id: hostile, name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: hostile, content: 'ok' }] },
    ], sameEngine);
    expect((out[0].content[0] as { id: string }).id).toBe(hostile);
  });

  it('gives the same id the same rewrite everywhere it appears', () => {
    const other = `fc_${'c'.repeat(500)}|z`;
    const out = repairForReplay([
      { role: 'assistant', content: [
        { type: 'tool_use', id: hostile, name: 'x', input: {} },
        { type: 'tool_use', id: other, name: 'y', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: other, content: 'b' },
        { type: 'tool_result', tool_use_id: hostile, content: 'a' },
      ] },
    ], crossEngine);

    const uses = out[0].content.map((b) => (b as { id: string }).id);
    const results = out[1].content.map((b) => (b as { tool_use_id: string }).tool_use_id);
    expect(new Set(uses).size).toBe(2);
    expect(results).toEqual([uses[1], uses[0]]);
  });
});

describe('rule 4 — reasoning', () => {
  it('keeps thinking verbatim including its signature on a same-engine replay', () => {
    const out = repairForReplay([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'because', signature: 'sig-1' }] },
    ], sameEngine);
    expect(out[0].content[0]).toEqual({ type: 'thinking', thinking: 'because', signature: 'sig-1' });
  });

  // An OpenAI signed-but-empty reasoning block is load-bearing: the signature IS
  // the payload, so "it looks empty" is not a reason to drop it.
  it('keeps a signed but empty thinking block on a same-engine replay', () => {
    const out = repairForReplay([
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig-only' }] },
    ], sameEngine);
    expect(out[0].content[0]).toEqual({ type: 'thinking', thinking: '', signature: 'sig-only' });
  });

  it('converts thinking to text and strips the signature cross-engine', () => {
    const out = repairForReplay([
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'because', signature: 'sig-1' }] },
    ], crossEngine);
    expect(out[0].content[0]).toEqual({ type: 'text', text: 'because' });
  });

  it('drops redacted_thinking entirely cross-engine', () => {
    const out = repairForReplay([
      { role: 'assistant', content: [
        { type: 'redacted_thinking', data: 'OPAQUE' },
        { type: 'text', text: 'the answer' },
      ] },
    ], crossEngine);
    expect(out[0].content).toEqual([{ type: 'text', text: 'the answer' }]);
  });

  it('strips message-scoped encrypted reasoning cross-engine', () => {
    const out = repairForReplay([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        message_scoped: { responses_api_id: 'rs_1', encrypted_reasoning: 'ENC' },
      },
    ], crossEngine);
    expect(out[0].message_scoped).toEqual({ responses_api_id: 'rs_1' });
  });

  it('drops a message left empty by the reasoning rules', () => {
    const out = repairForReplay([
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'OPAQUE' }] },
    ], crossEngine);
    expect(out).toEqual([]);
  });
});

describe('rule 5 — refusals', () => {
  it('keeps the refusal block on a same-engine replay', () => {
    const out = repairForReplay([
      { role: 'assistant', content: [{ type: 'refusal', text: 'I cannot.' }] },
    ], sameEngine);
    expect(out[0].content[0]).toEqual({ type: 'refusal', text: 'I cannot.' });
  });

  it('converts a refusal to text cross-engine', () => {
    const out = repairForReplay([
      { role: 'assistant', content: [{ type: 'refusal', text: 'I cannot.' }] },
    ], crossEngine);
    expect(out[0].content[0]).toEqual({ type: 'text', text: 'I cannot.' });
  });
});

describe('rule 6 — images', () => {
  const withImages = (n: number): CanonicalMessage[] => ([
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 't1',
        content: Array.from({ length: n }, () => ({ type: 'image', source: { data: 'AAA' } })) as never,
      }],
    },
  ]);

  it('leaves images alone when the target supports them', () => {
    const out = repairForReplay(withImages(2), sameEngine);
    const content = (out[0].content[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(2);
  });

  it('replaces an image with a placeholder when the target does not', () => {
    const out = repairForReplay(withImages(1), { ...sameEngine, targetSupportsImages: false });
    const content = (out[0].content[0] as { content: unknown[] }).content;
    expect(content).toEqual([{ type: 'text', text: '(image omitted: model does not support images)' }]);
  });

  // Forty screenshots must not become forty identical lines.
  it('collapses consecutive placeholders', () => {
    const out = repairForReplay(withImages(40), { ...sameEngine, targetSupportsImages: false });
    const content = (out[0].content[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(1);
  });

  it('does not collapse placeholders separated by real content', () => {
    const out = repairForReplay([
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'image', source: { data: 'A' } },
            { type: 'text', text: 'between' },
            { type: 'image', source: { data: 'B' } },
          ] as never,
        }],
      },
    ], { ...sameEngine, targetSupportsImages: false });
    const content = (out[0].content[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(3);
  });
});

describe('the caller transcript is never mutated', () => {
  it('leaves the input array and its blocks untouched', () => {
    const input: CanonicalMessage[] = [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
    ];
    const before = JSON.stringify(input);
    repairForReplay(input, crossEngine);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// ── Property test over every engine pair ────────────────────────────────────
//
// A repaired transcript must satisfy the invariants every provider enforces,
// whichever direction it is being moved in. These are the properties that decide
// whether a replay is accepted or 400s, so they are asserted for all 49 pairs
// rather than for the handful somebody remembered to write down.
//
// THE INPUT IS RECORDED VENDOR OUTPUT, NOT A HAND-WRITTEN CANONICAL LIST. Each
// engine's fidelity fixture is a canned stream of the shapes its SDK actually
// emits, driven through the REAL forward mapper by the real recorder — so this
// tests the pipeline a production transcript goes through, rather than a
// canonical array somebody typed out and could equally have typed wrong. A
// synthetic input would only prove `repairForReplay` is self-consistent with my
// idea of what a transcript looks like.
describe('property — every (source, target) engine pair yields a replayable list', () => {
  /** The nastiest transcript we can construct: every recorded engine's own
   *  output, concatenated, plus the structural hazards no single fixture
   *  happens to contain (a hostile OpenAI tool id, images in a tool result, a
   *  dangling call). The recorded half is what production produces; the added
   *  half is what production produces on a bad day. */
  const recordedFromEveryEngine = (): CanonicalMessage[] =>
    FIDELITY_FIXTURES.flatMap((f) => runFidelityFixture(f, `repair-${f.engine}`).messages);

  const hazards = (): CanonicalMessage[] => ([
    {
      role: 'assistant',
      content: [
        { type: 'redacted_thinking', data: 'OPAQUE' },
        { type: 'tool_use', id: `fc_${'x'.repeat(500)}|c`, name: 'file_read', input: { p: '/a' } },
      ],
      message_scoped: { responses_api_id: 'rs_1', encrypted_reasoning: 'ENC' },
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: `fc_${'x'.repeat(500)}|c`,
        content: [
          { type: 'image', source: { data: 'A' } },
          { type: 'image', source: { data: 'B' } },
        ] as never,
      }],
    },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'dangling_1', name: 'shell_exec', input: {} }] },
    { role: 'assistant', content: [{ type: 'refusal', text: 'no' }] },
  ]);

  const messy = (): CanonicalMessage[] => ([
    { role: 'user', content: [{ type: 'text', text: 'objective' }] },
    ...recordedFromEveryEngine(),
    ...hazards(),
  ]);

  // The input is only worth calling "recorded" if it genuinely came through the
  // mappers, so that is asserted rather than assumed.
  it('is built from real recorded vendor output', () => {
    const recorded = recordedFromEveryEngine();
    expect(recorded.length).toBeGreaterThanOrEqual(FIDELITY_FIXTURES.length);
    // Anthropic thinking with a signature, Gemini's carried tool_result name,
    // and OpenAI's message-scoped reasoning are all things only the real
    // mappers produce.
    const blocks = recorded.flatMap((m) => m.content);
    expect(blocks.some((b) => b.type === 'thinking' && b.signature)).toBe(true);
    expect(blocks.some((b) => b.type === 'tool_result' && b.name)).toBe(true);
    expect(recorded.some((m) => m.message_scoped?.encrypted_reasoning)).toBe(true);
    expect(blocks.some((b) => b.type === 'refusal')).toBe(true);
  });

  for (const source of ENGINES) {
    for (const target of ENGINES) {
      it(`${source} → ${target}`, () => {
        const out = repairForReplay(messy(), {
          sourceEngine: source,
          targetEngine: target,
          targetSupportsImages: false,
        });

        // Every tool_use is answered.
        const uses = new Set<string>();
        const results = new Set<string>();
        for (const m of out) {
          for (const b of m.content) {
            if (b.type === 'tool_use') uses.add(b.id);
            if (b.type === 'tool_result') results.add(b.tool_use_id);
          }
        }
        for (const id of uses) expect(results.has(id)).toBe(true);

        // No orphan results: every result answers a call that is present.
        for (const id of results) expect(uses.has(id)).toBe(true);

        // No empty messages.
        for (const m of out) expect(m.content.length).toBeGreaterThan(0);

        // Cross-engine: nothing vendor-opaque survives, and every id is
        // acceptable to the strictest grammar of the seven.
        if (source !== target) {
          for (const m of out) {
            for (const b of m.content) {
              expect(b.type).not.toBe('redacted_thinking');
              expect(b.type).not.toBe('refusal');
              expect(b.type).not.toBe('thinking');
              if (b.type === 'tool_use') expect(b.id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
            }
            expect(m.message_scoped?.encrypted_reasoning).toBeUndefined();
          }
        }

        // No images survive a target that cannot read them.
        for (const m of out) {
          for (const b of m.content) {
            if (b.type === 'tool_result' && Array.isArray(b.content)) {
              for (const inner of b.content) {
                expect((inner as { type: string }).type).not.toBe('image');
              }
            }
          }
        }
      });
    }
  }
});
