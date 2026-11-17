// Unit tests for the per-provider stop-reason mappers and LLMRefusalError.
//
// These exercise the refusal-handling behavior introduced in 18da5d0 at the
// smallest testable seam: each provider's stop-reason mapping was extracted
// into an exported pure function (mapAnthropicStopReason, mapOpenAIStopReason,
// mapGoogleStopReason) that
// complete() now delegates to. Testing the functions directly avoids mocking
// each vendor SDK while still exercising the real normalization the adapters
// use in production.

import { mapAnthropicStopReason } from '../providers/anthropic';
import { mapOpenAIStopReason } from '../providers/openai';
import { mapGoogleStopReason } from '../providers/google';
import { LLMRefusalError } from '../types';
import type { LLMProvider } from '../types';

describe('mapAnthropicStopReason', () => {
  it("maps 'refusal' → 'refusal' (safety classifier declined)", () => {
    expect(mapAnthropicStopReason('refusal')).toBe('refusal');
  });

  it('passes through the recognised non-refusal reasons unchanged', () => {
    expect(mapAnthropicStopReason('end_turn')).toBe('end_turn');
    expect(mapAnthropicStopReason('tool_use')).toBe('tool_use');
    expect(mapAnthropicStopReason('max_tokens')).toBe('max_tokens');
  });

  it("collapses 'stop_sequence', unknown, null and undefined into 'other'", () => {
    expect(mapAnthropicStopReason('stop_sequence')).toBe('other');
    expect(mapAnthropicStopReason('something_new')).toBe('other');
    expect(mapAnthropicStopReason(null)).toBe('other');
    expect(mapAnthropicStopReason(undefined)).toBe('other');
  });
});

describe('mapOpenAIStopReason', () => {
  it("maps finish_reason 'content_filter' → 'refusal'", () => {
    expect(mapOpenAIStopReason('content_filter', false)).toBe('refusal');
  });

  it("maps a populated message.refusal → 'refusal' even when finish_reason is 'stop'", () => {
    expect(mapOpenAIStopReason('stop', true)).toBe('refusal');
    // refusal flag wins over every finish_reason, including tool_calls/length
    expect(mapOpenAIStopReason('tool_calls', true)).toBe('refusal');
    expect(mapOpenAIStopReason('length', true)).toBe('refusal');
    expect(mapOpenAIStopReason(null, true)).toBe('refusal');
  });

  it('passes through the recognised non-refusal reasons unchanged', () => {
    expect(mapOpenAIStopReason('stop', false)).toBe('end_turn');
    expect(mapOpenAIStopReason('tool_calls', false)).toBe('tool_use');
    expect(mapOpenAIStopReason('length', false)).toBe('max_tokens');
  });

  it("collapses 'function_call', unknown, null and undefined into 'other'", () => {
    expect(mapOpenAIStopReason('function_call', false)).toBe('other');
    expect(mapOpenAIStopReason('mystery', false)).toBe('other');
    expect(mapOpenAIStopReason(null, false)).toBe('other');
    expect(mapOpenAIStopReason(undefined, false)).toBe('other');
  });
});

describe('mapGoogleStopReason', () => {
  it("maps candidate finishReason SAFETY and PROHIBITED_CONTENT → 'refusal'", () => {
    expect(mapGoogleStopReason('SAFETY', false, false)).toBe('refusal');
    expect(mapGoogleStopReason('PROHIBITED_CONTENT', false, false)).toBe('refusal');
  });

  it("maps the other blocking finish reasons → 'refusal'", () => {
    for (const r of ['RECITATION', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY']) {
      expect(mapGoogleStopReason(r, false, false)).toBe('refusal');
    }
  });

  it("maps a prompt-level block (no candidates + blockReason) → 'refusal'", () => {
    // promptBlocked=true, no candidate finishReason, no tool calls.
    expect(mapGoogleStopReason(undefined, false, true)).toBe('refusal');
    // promptBlocked takes precedence even if a benign finishReason exists.
    expect(mapGoogleStopReason('STOP', false, true)).toBe('refusal');
  });

  it("maps STOP → 'end_turn' and MAX_TOKENS → 'max_tokens'", () => {
    expect(mapGoogleStopReason('STOP', false, false)).toBe('end_turn');
    expect(mapGoogleStopReason('MAX_TOKENS', false, false)).toBe('max_tokens');
  });

  it("maps a present tool call → 'tool_use' (Gemini has no tool_use finish reason)", () => {
    expect(mapGoogleStopReason('STOP', true, false)).toBe('tool_use');
    // tool-use detection wins over MAX_TOKENS / unknown, but NOT over a block.
    expect(mapGoogleStopReason('MAX_TOKENS', true, false)).toBe('tool_use');
    expect(mapGoogleStopReason('SAFETY', true, true)).toBe('refusal');
  });

  it("collapses unknown, null-ish finishReason into 'other'", () => {
    expect(mapGoogleStopReason('FINISH_REASON_UNSPECIFIED', false, false)).toBe('other');
    expect(mapGoogleStopReason('OTHER', false, false)).toBe('other');
    expect(mapGoogleStopReason(undefined, false, false)).toBe('other');
  });
});

describe('LLMRefusalError', () => {
  it('constructs with the right name, message and fields', () => {
    const err = new LLMRefusalError('anthropic' as LLMProvider, 'claude-opus-4-6', 'partial text');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LLMRefusalError);
    expect(err.name).toBe('LLMRefusalError');
    expect(err.provider).toBe('anthropic');
    expect(err.model).toBe('claude-opus-4-6');
    expect(err.partialContent).toBe('partial text');
    expect(err.message).toContain('refused');
    expect(err.message).toContain('anthropic');
    expect(err.message).toContain('claude-opus-4-6');
  });

  it('carries empty partialContent for a pre-output refusal', () => {
    const err = new LLMRefusalError('openai' as LLMProvider, 'gpt-5.5', '');
    expect(err.partialContent).toBe('');
    expect(err.provider).toBe('openai');
  });
});
