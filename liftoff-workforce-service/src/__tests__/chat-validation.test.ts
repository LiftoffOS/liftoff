// A rejection the person can act on.
//
// The client displays `error` verbatim and deliberately does not render
// `details`, because raw zod paths are not user-facing copy. A bare
// "Validation failed" therefore reaches someone with no reason and no hint at
// what would fix it, even though the reason is on the wire.

import { z } from 'zod';
import { describeChatValidationFailure } from '../workforce-plans/chat-validation.js';
import { MAX_CHAT_MESSAGE_CHARS } from '../workforce-plans/context-budget.js';

const schema = z.object({
  content: z.string().min(1).max(MAX_CHAT_MESSAGE_CHARS),
});

function failureFor(content: string): z.ZodError {
  const result = schema.safeParse({ content });
  if (result.success) throw new Error('expected a validation failure');
  return result.error;
}

describe('describeChatValidationFailure', () => {
  it('names the limit when the message is too long', () => {
    const message = describeChatValidationFailure(
      failureFor('x'.repeat(MAX_CHAT_MESSAGE_CHARS + 1)),
    );

    expect(message).not.toBe('Validation failed');
    expect(message).toMatch(/too long/i);
    expect(message).toContain('32,000');
  });

  it('asks for a message when the body is empty', () => {
    expect(describeChatValidationFailure(failureFor(''))).toMatch(/type a message/i);
  });

  it('falls back to the generic string for anything else', () => {
    const result = schema.safeParse({ content: 42 });
    if (result.success) throw new Error('expected a validation failure');
    expect(describeChatValidationFailure(result.error)).toBe('Validation failed');
  });

  it('accepts a realistic role brief that the old cap rejected', () => {
    // A realistic role brief: responsibilities, a workflow, per-field mapping
    // and failure handling.
    expect(schema.safeParse({ content: 'x'.repeat(4164) }).success).toBe(true);
  });

  it('keeps product voice: no contractions, no em dash, never says "agent"', () => {
    const copy = [
      describeChatValidationFailure(failureFor('x'.repeat(MAX_CHAT_MESSAGE_CHARS + 1))),
      describeChatValidationFailure(failureFor('')),
    ];
    for (const line of copy) {
      expect(line).not.toMatch(/—/);
      expect(line).not.toMatch(/\b\w+'(s|t|re|ve|ll|d|m)\b/i);
      expect(line).not.toMatch(/\bagents?\b/i);
    }
  });
});
