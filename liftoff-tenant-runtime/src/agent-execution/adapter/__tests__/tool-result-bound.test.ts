import { boundToolText, boundToolResult } from '../tool-result-bound';

const NONCE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 32 hex chars

function frame(content: string, source = 'connector:google_mail/list'): string {
  // Mirrors UntrustedContentFramer.wrap: delimiters and a source line. The
  // standing rule about what the markers mean lives in the system prompt now,
  // not inside every payload.
  return [
    `<UNTRUSTED_${NONCE}_BEGIN>`,
    `source=${source}`,
    '',
    content,
    '',
    `<UNTRUSTED_${NONCE}_END>`,
  ].join('\n');
}

describe('boundToolText', () => {
  it('passes short text through unchanged', () => {
    expect(boundToolText('hello world', 1000)).toBe('hello world');
  });

  it('slices a large non-JSON string and appends a truncation marker', () => {
    const big = 'x'.repeat(5000);
    const out = boundToolText(big, 500);
    expect(out.length).toBeLessThanOrEqual(600); // 500 + short marker
    expect(out.startsWith('x'.repeat(500))).toBe(true);
    expect(out).toContain('truncated:');
    expect(out).toContain('paginate');
  });

  it('shape-reduces a large JSON array, keeping structure and staying within budget', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i, body: 'z'.repeat(300) }));
    const text = JSON.stringify(rows);
    expect(text.length).toBeGreaterThan(50_000);
    const out = boundToolText(text, 5_000);
    expect(out.length).toBeLessThanOrEqual(5_000);
    // structure preserved: still parseable-ish / retains ids and the item marker
    expect(out).toContain('"id"');
    expect(out).toContain('more items truncated');
  });

  it('bounds the INNER body of a framed result and preserves BEGIN/END delimiters', () => {
    const inner = JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, body: 'z'.repeat(300) })));
    const framed = frame(inner);
    expect(framed.length).toBeGreaterThan(50_000);
    const out = boundToolText(framed, 5_000);
    // delimiters survive verbatim
    expect(out.startsWith(`<UNTRUSTED_${NONCE}_BEGIN>`)).toBe(true);
    expect(out.trimEnd().endsWith(`<UNTRUSTED_${NONCE}_END>`)).toBe(true);
    expect(out).toContain('source=connector:google_mail/list');
    // and it actually shrank
    expect(out.length).toBeLessThan(framed.length);
    expect(out.length).toBeLessThanOrEqual(5_500);
  });

  it('leaves a framed result alone when it is already under budget', () => {
    const framed = frame(JSON.stringify({ ok: true }));
    expect(boundToolText(framed, 50_000)).toBe(framed);
  });
});

describe('boundToolResult', () => {
  it('bounds oversized text blocks in a CallToolResult', () => {
    const result = { content: [{ type: 'text', text: 'x'.repeat(100_000) }] };
    const out = boundToolResult(result, 1_000) as typeof result;
    expect(out.content[0].text.length).toBeLessThanOrEqual(1_100);
  });

  it('never touches an error result (TOOL_ERROR must survive verbatim)', () => {
    const result = { isError: true, content: [{ type: 'text', text: 'TOOL_ERROR ' + 'x'.repeat(100_000) }] };
    const out = boundToolResult(result, 1_000) as typeof result;
    expect(out.content[0].text.length).toBe(('TOOL_ERROR ' + 'x'.repeat(100_000)).length);
  });

  it('leaves non-text blocks (e.g. images) untouched', () => {
    const result = { content: [{ type: 'image', data: 'z'.repeat(100_000) }] };
    const out = boundToolResult(result, 1_000) as { content: Array<{ type: string; data?: string }> };
    expect(out.content[0].data!.length).toBe(100_000);
  });

  it('passes through results with no content array', () => {
    const result = { error: 'paused_for_human_approval' };
    expect(boundToolResult(result, 1_000)).toBe(result);
  });

  it('only bounds the oversized block when multiple blocks are present', () => {
    const result = { content: [
      { type: 'text', text: 'small' },
      { type: 'text', text: 'y'.repeat(100_000) },
    ] };
    const out = boundToolResult(result, 1_000) as typeof result;
    expect(out.content[0].text).toBe('small');
    expect(out.content[1].text.length).toBeLessThanOrEqual(1_100);
  });
});
