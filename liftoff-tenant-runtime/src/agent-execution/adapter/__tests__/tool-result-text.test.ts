// #1 fix: the live recovery fast-trip parses the TOOL_ERROR envelope out of the
// tool-result the adapter hands its anomaly handler. On MCP tools that envelope
// arrives inside a block-array `content`; `JSON.stringify` of the array escapes
// the inner JSON and defeats the parser. flattenToolResultText reduces the array
// to its bare text so the envelope survives. This test proves the seam:
// block-array content → flatten → parseToolErrorEnvelope → structured contract.

import { flattenToolResultText } from '../tool-result-text';
import { parseToolErrorEnvelope } from '../../../tool-gateway/tool-error-envelope';

const ENVELOPE = `TOOL_ERROR ${JSON.stringify({
  error: 'connection expired',
  code: 'auth_expired',
  retryable: false,
  recovery: 'reconnect the connector',
})}`;

describe('flattenToolResultText', () => {
  it('returns a bare string unchanged', () => {
    expect(flattenToolResultText(ENVELOPE)).toBe(ENVELOPE);
  });

  it('extracts the text from an MCP block array', () => {
    const content = [{ type: 'text', text: ENVELOPE }];
    expect(flattenToolResultText(content)).toBe(ENVELOPE);
  });

  it('joins multiple text blocks with newlines', () => {
    const content = [
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ];
    expect(flattenToolResultText(content)).toBe('line one\nline two');
  });

  it('falls back to JSON for a block array with no text (e.g. image-only)', () => {
    const content = [{ type: 'image', data: 'abc', mimeType: 'image/png' }];
    expect(flattenToolResultText(content)).toBe(JSON.stringify(content));
  });

  it('maps null/undefined content to an empty string', () => {
    expect(flattenToolResultText(null)).toBe('');
    expect(flattenToolResultText(undefined)).toBe('');
  });
});

describe('#1 seam — block-array TOOL_ERROR envelope survives to the parser', () => {
  it('flatten → parseToolErrorEnvelope yields the structured contract', () => {
    const mcpContent = [{ type: 'text', text: ENVELOPE }];
    const parsed = parseToolErrorEnvelope(flattenToolResultText(mcpContent));
    expect(parsed).not.toBeNull();
    expect(parsed!.code).toBe('auth_expired');
    expect(parsed!.retryable).toBe(false);
    expect(parsed!.recovery).toBe('reconnect the connector');
  });

  it('documents the pre-fix failure: JSON.stringify of the array does NOT parse', () => {
    const mcpContent = [{ type: 'text', text: ENVELOPE }];
    // The old hook did `JSON.stringify(content)` — escaped inner JSON → null.
    expect(parseToolErrorEnvelope(JSON.stringify(mcpContent))).toBeNull();
  });
});
