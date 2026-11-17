// No text handed to a model carries an untrusted delimiter without its pair.
//
// The defect this exists for: `boundToolText` lifted the delimiters off and put
// them back only when the frame WAS the whole text block. A frame framed IN
// PLACE — `web_fetch_advanced`'s page, `read_active_browser_session`'s body, a
// sandbox browser extraction, `file_read`'s slice — sits inside a serialised
// result, matched neither anchored pattern, and was cut by the structure-aware
// reducer, which kept the opening delimiter and dropped the closing one.
//
// What the model then reads is an untrusted region that never ends, against a
// standing system-prompt notice saying a marker cannot be unbalanced. And it is
// measured, not hypothetical: observe-result-size.ts records a real 62,918
// character fetch against a 50,000 budget.

import { missingClosers, sealFrames, truncateWithinFrames } from '../frame-balance';
import { _setFramerSecretForTesting, frameUntrusted } from '../untrusted-content-wrapper';
import { boundToolText, spillToolText } from '../../agent-execution/adapter/tool-result-bound';
import { truncateForPrompt } from '../../agent-execution/engine/truncate-for-prompt';

const NONCE_A = 'a'.repeat(32);
const NONCE_B = 'b'.repeat(32);
const BEGIN_A = `<UNTRUSTED_${NONCE_A}_BEGIN>`;
const END_A = `<UNTRUSTED_${NONCE_A}_END>`;
const BEGIN_B = `<UNTRUSTED_${NONCE_B}_BEGIN>`;
const END_B = `<UNTRUSTED_${NONCE_B}_END>`;

/** Begin and end counts, which must always agree. */
function balance(text: string): { begin: number; end: number } {
  return {
    begin: (text.match(/<UNTRUSTED_[0-9a-fA-F]{32,64}_BEGIN>/g) ?? []).length,
    end: (text.match(/<UNTRUSTED_[0-9a-fA-F]{32,64}_END>/g) ?? []).length,
  };
}

function expectBalanced(text: string): void {
  const { begin, end } = balance(text);
  expect({ begin, end }).toEqual({ begin, end: begin });
}

beforeEach(() => { _setFramerSecretForTesting(Buffer.alloc(32, 4)); });
afterAll(() => { _setFramerSecretForTesting(null); });

describe('missingClosers', () => {
  it('reports nothing for balanced text, framed or plain', () => {
    expect(missingClosers('just words')).toBe('');
    expect(missingClosers(`${BEGIN_A}\nbody\n${END_A}`)).toBe('');
    expect(missingClosers(`${BEGIN_A}x${END_A} between ${BEGIN_B}y${END_B}`)).toBe('');
  });

  it('names the frame that was left open, by its own nonce', () => {
    expect(missingClosers(`${BEGIN_A}\nbody, cut here`)).toBe(`\n\n${END_A}`);
  });

  it('closes nested frames innermost first', () => {
    // Order matters: closing the outer one first would leave the delimiters
    // crossed rather than balanced.
    expect(missingClosers(`${BEGIN_A} outer ${BEGIN_B} inner`)).toBe(`\n\n${END_B}\n\n${END_A}`);
  });

  it('an END closes its own frame wherever it sits, not whatever is on top', () => {
    expect(missingClosers(`${BEGIN_A} outer ${BEGIN_B} inner ${END_A}`)).toBe(`\n\n${END_B}`);
  });

  it('an END with no BEGIN is not a frame to close', () => {
    expect(missingClosers(`tail of a payload ${END_A}`)).toBe('');
  });
});

describe('sealFrames', () => {
  it('returns balanced text byte for byte', () => {
    const text = `${BEGIN_A}\nbody\n${END_A}`;
    expect(sealFrames(text)).toBe(text);
  });

  it('closes what a cut opened', () => {
    const sealed = sealFrames(`${BEGIN_A}\nbody, cut`);
    expect(sealed.endsWith(END_A)).toBe(true);
    expectBalanced(sealed);
  });
});

describe('truncateWithinFrames', () => {
  const note = (n: number) => `…[truncated:${n} more chars]`;

  it('leaves text within budget untouched', () => {
    expect(truncateWithinFrames('short', 100, note)).toBe('short');
  });

  it('closes the frame the cut opened, and says what it dropped', () => {
    const text = `${BEGIN_A}\n${'x'.repeat(5_000)}\n${END_A}`;
    const out = truncateWithinFrames(text, 300, note);
    expectBalanced(out);
    expect(out.startsWith(BEGIN_A)).toBe(true);
    expect(out.endsWith(END_A)).toBe(true);
    expect(out).toContain('more chars]');
    // The note sits INSIDE the frame here because the frame is what was cut —
    // and the model is told everything inside is data, which the note is not.
    // Accepted: a host note read as data costs nothing; an unterminated frame
    // costs the boundary itself.
  });

  it('bounds the CONTENT at the budget, with the note and the closers after it', () => {
    // The convention every cutter here already used: `boundToolText` reserves
    // its header and footer and then lets the marker follow, `spillToolText`
    // slices to PREVIEW_CHARS and appends the path note. Keeping it is what
    // makes this a drop-in rather than a behaviour change.
    const text = `${'x'.repeat(5_000)}`;
    const out = truncateWithinFrames(text, 400, note);
    expect(out.startsWith('x'.repeat(400))).toBe(true);
    expect(out).toBe('x'.repeat(400) + note(4_600));
  });

  it('never cuts through the middle of a delimiter', () => {
    const text = `${'x'.repeat(40)}${BEGIN_A}${'y'.repeat(5_000)}${END_A}`;
    // A budget that lands inside the opening delimiter.
    const out = truncateWithinFrames(text, 40 + 10, note);
    expect(out).not.toMatch(/<UNTRUSTED_[0-9a-f]{1,31}(?![0-9a-f])/);
    expectBalanced(out);
    // Snapped back before the delimiter, so the frame was never opened.
    expect(balance(out)).toEqual({ begin: 0, end: 0 });
  });

  it('keeps the invariant however small the budget', () => {
    const text = `${BEGIN_A}${'x'.repeat(5_000)}${END_A}`;
    expectBalanced(truncateWithinFrames(text, 10, note));
    expectBalanced(truncateWithinFrames(text, 0, note));
    expectBalanced(truncateWithinFrames(text, BEGIN_A.length + 3, note));
  });

  it('leaves unframed text cut exactly as it was before this existed', () => {
    const out = truncateWithinFrames('y'.repeat(1_000), 100, note);
    expect(out).toBe('y'.repeat(100) + note(900));
    expect(balance(out)).toEqual({ begin: 0, end: 0 });
  });
});

describe('the cutters that must obey it', () => {
  const BIG = 'Northwind Supply pricing detail. '.repeat(3_000);

  it('the tool-result bound: a frame that IS the whole block', () => {
    const whole = frameUntrusted('web:web_extract', JSON.stringify({ success: true, result: { data: BIG } }));
    const out = boundToolText(whole, 50_000);
    expectBalanced(out);
    expect(balance(out).begin).toBe(1);
  });

  it('the tool-result bound: a frame framed IN PLACE, inside a serialised result', () => {
    // The regression. Before the fix this returned begin=1, end=0.
    const embedded = JSON.stringify({
      success: true,
      result: { content: frameUntrusted('web:northwind.example', BIG), finalUrl: 'https://northwind.example' },
    });
    const out = boundToolText(embedded, 50_000);
    expectBalanced(out);
    expect(balance(out).begin).toBe(1);
    // And it is still valid JSON: the closer went inside the string value it
    // belongs to, not after the object.
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out).result.finalUrl).toBe('https://northwind.example');
  });

  it('the tool-result bound: nested frames', () => {
    const nested = JSON.stringify({
      outer: frameUntrusted('web:a', `intro ${frameUntrusted('web:b', BIG)} outro`),
    });
    expectBalanced(boundToolText(nested, 50_000));
  });

  it('the spill preview: a frame framed in place', async () => {
    const embedded = JSON.stringify({
      result: { content: frameUntrusted('web:northwind.example', BIG) },
    });
    const spilled = await spillToolText(embedded, { writeFile: async () => undefined }, 'call-1');
    expectBalanced(spilled!.text);
    expect(spilled!.text).toContain('written to');
  });

  it('the spill preview: a frame that is the whole block', async () => {
    const whole = frameUntrusted('web:web_extract', BIG);
    const spilled = await spillToolText(whole, { writeFile: async () => undefined }, 'call-2');
    expectBalanced(spilled!.text);
  });

  it('truncateForPrompt: a framed string leaf', () => {
    const out = truncateForPrompt({ content: frameUntrusted('file:/w/page.txt', BIG) }, 2_000);
    expectBalanced(out);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('truncateForPrompt: the last-resort hard cap still seals', () => {
    // Many framed leaves, each already shrunk, still over the byte cap: the
    // final slice is through the SERIALISED form and can open a frame.
    const value: Record<string, string> = {};
    for (let i = 0; i < 19; i++) value[`k${i}`] = frameUntrusted(`file:/w/${i}.txt`, BIG);
    expectBalanced(truncateForPrompt(value, 600));
  });
});
