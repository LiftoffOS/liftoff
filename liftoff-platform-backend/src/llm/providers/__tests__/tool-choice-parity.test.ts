// Tool Choice Parity Tests — Phase 5
//
// Verify that toolChoice is threaded correctly through all providers.
// Each provider maps our { 'auto' | 'required' | { name } } abstraction
// to its native wire format. These tests validate the mapping functions
// directly (reimplemented where not exported) and cross-check parity.

import { FunctionCallingMode } from '@google-cloud/vertexai';
import { toAnthropicToolChoice } from '../anthropic-shared';

// ── Reimplemented mapping functions (mirroring non-exported originals) ───
// These are tested against the same contract to ensure behaviour matches.

/** OpenAI mapping — mirrors toOpenAIToolChoice in openai.ts */
function toOpenAIToolChoice(
  toolChoice: 'auto' | 'required' | { name: string } | undefined,
): 'auto' | 'required' | { type: 'function'; function: { name: string } } {
  if (!toolChoice || toolChoice === 'auto') return 'auto';
  if (toolChoice === 'required') return 'required';
  return { type: 'function', function: { name: toolChoice.name } };
}

/** Google mapping — mirrors toGoogleFunctionCallingConfig in google.ts */
function toGoogleFunctionCallingConfig(
  toolChoice: 'auto' | 'required' | { name: string } | undefined,
): { mode: FunctionCallingMode; allowedFunctionNames?: string[] } {
  if (!toolChoice || toolChoice === 'auto') {
    return { mode: FunctionCallingMode.AUTO };
  }
  if (toolChoice === 'required') {
    return { mode: FunctionCallingMode.ANY };
  }
  return { mode: FunctionCallingMode.ANY, allowedFunctionNames: [toolChoice.name] };
}

describe('toAnthropicToolChoice (exported from anthropic-shared)', () => {
  it('maps "auto" to { type: "auto" }', () => {
    expect(toAnthropicToolChoice('auto')).toEqual({ type: 'auto' });
  });

  it('maps "required" to { type: "any" }', () => {
    expect(toAnthropicToolChoice('required')).toEqual({ type: 'any' });
  });

  it('maps { name: "x" } to { type: "tool", name: "x" }', () => {
    expect(toAnthropicToolChoice({ name: 'produce_agent' })).toEqual({
      type: 'tool',
      name: 'produce_agent',
    });
  });

  it('returns undefined for undefined input', () => {
    expect(toAnthropicToolChoice(undefined)).toBeUndefined();
  });
});

describe('toOpenAIToolChoice (reimplemented parity check)', () => {
  it('maps "auto" to "auto"', () => {
    expect(toOpenAIToolChoice('auto')).toBe('auto');
  });

  it('maps "required" to "required"', () => {
    expect(toOpenAIToolChoice('required')).toBe('required');
  });

  it('maps { name: "x" } to forced function call', () => {
    expect(toOpenAIToolChoice({ name: 'get_cost' })).toEqual({
      type: 'function',
      function: { name: 'get_cost' },
    });
  });

  it('defaults to "auto" for undefined', () => {
    expect(toOpenAIToolChoice(undefined)).toBe('auto');
  });
});

describe('toGoogleFunctionCallingConfig (reimplemented parity check)', () => {
  it('maps "auto" to FunctionCallingMode.AUTO', () => {
    expect(toGoogleFunctionCallingConfig('auto')).toEqual({
      mode: FunctionCallingMode.AUTO,
    });
  });

  it('maps "required" to FunctionCallingMode.ANY', () => {
    expect(toGoogleFunctionCallingConfig('required')).toEqual({
      mode: FunctionCallingMode.ANY,
    });
  });

  it('maps { name: "x" } to ANY with allowedFunctionNames', () => {
    expect(toGoogleFunctionCallingConfig({ name: 'search_records' })).toEqual({
      mode: FunctionCallingMode.ANY,
      allowedFunctionNames: ['search_records'],
    });
  });

  it('defaults to AUTO for undefined', () => {
    expect(toGoogleFunctionCallingConfig(undefined)).toEqual({
      mode: FunctionCallingMode.AUTO,
    });
  });
});

describe('Cross-provider parity', () => {
  const inputs: Array<{
    label: string;
    input: 'auto' | 'required' | { name: string };
  }> = [
    { label: 'auto', input: 'auto' },
    { label: 'required', input: 'required' },
    { label: 'named tool', input: { name: 'produce_agent' } },
  ];

  it.each(inputs)('all providers handle "$label" without throwing', ({ input }) => {
    // None of these should throw
    expect(() => toAnthropicToolChoice(input)).not.toThrow();
    expect(() => toOpenAIToolChoice(input)).not.toThrow();
    expect(() => toGoogleFunctionCallingConfig(input)).not.toThrow();
  });

  it('"required" forces tool use across all providers', () => {
    const anthropic = toAnthropicToolChoice('required');
    const openai = toOpenAIToolChoice('required');
    const google = toGoogleFunctionCallingConfig('required');

    // Anthropic: { type: 'any' } means "must call some tool"
    expect(anthropic).toEqual({ type: 'any' });
    // OpenAI: 'required' is the native keyword
    expect(openai).toBe('required');
    // Google: FunctionCallingMode.ANY means "must call some function"
    expect(google.mode).toBe(FunctionCallingMode.ANY);
    // Google should NOT constrain to a specific function for 'required'
    expect(google.allowedFunctionNames).toBeUndefined();
  });

  it('named tool forces a specific tool across all providers', () => {
    const toolName = 'produce_workflow';
    const anthropic = toAnthropicToolChoice({ name: toolName });
    const openai = toOpenAIToolChoice({ name: toolName });
    const google = toGoogleFunctionCallingConfig({ name: toolName });

    // Anthropic: { type: 'tool', name }
    expect(anthropic).toEqual({ type: 'tool', name: toolName });
    // OpenAI: { type: 'function', function: { name } }
    expect(openai).toEqual({ type: 'function', function: { name: toolName } });
    // Google: ANY + allowedFunctionNames
    expect(google.mode).toBe(FunctionCallingMode.ANY);
    expect(google.allowedFunctionNames).toEqual([toolName]);
  });
});
