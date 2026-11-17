import { interpretMcpToolCallResult, inputRequiredError } from '../mcp-result';

describe('interpretMcpToolCallResult', () => {
  it('flags an MRTR input_required interim result', () => {
    const i = interpretMcpToolCallResult({ resultType: 'input_required', requestState: 'blob' });
    expect(i.inputRequired).toBe(true);
    expect(i.isError).toBe(false);
  });

  it('flags an isError tool result', () => {
    const i = interpretMcpToolCallResult({ isError: true, content: [{ type: 'text', text: 'boom' }] });
    expect(i.inputRequired).toBe(false);
    expect(i.isError).toBe(true);
  });

  it('treats a normal/complete result as neither', () => {
    expect(interpretMcpToolCallResult({ resultType: 'complete', content: [] })).toEqual({
      inputRequired: false,
      isError: false,
    });
    expect(interpretMcpToolCallResult({ content: [] })).toEqual({ inputRequired: false, isError: false });
  });

  it('is null/undefined/non-object safe (e.g. A2A results)', () => {
    expect(interpretMcpToolCallResult(null)).toEqual({ inputRequired: false, isError: false });
    expect(interpretMcpToolCallResult(undefined)).toEqual({ inputRequired: false, isError: false });
    expect(interpretMcpToolCallResult('a2a-string')).toEqual({ inputRequired: false, isError: false });
  });
});

describe('inputRequiredError', () => {
  it('names the tool and the MRTR reason', () => {
    const msg = inputRequiredError('search_docs');
    expect(msg).toContain('search_docs');
    expect(msg).toContain('input_required');
    expect(msg).toContain('Multi Round-Trip Requests');
  });
});
