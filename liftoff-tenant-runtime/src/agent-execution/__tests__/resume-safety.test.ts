// The predicate that decides whether a session is safe to keep.
//
// The asymmetry matters more than the accuracy: a MISS costs the next run one
// wasted attempt, and a FALSE POSITIVE silently throws away a conversation
// somebody is in the middle of. Every case below is written from that side.

import { contextExhaustedCompletion } from '../resume-safety';

describe('contextExhaustedCompletion', () => {
  it.each([
    'I have run out of context and cannot continue this task.',
    'The context window is full, so I am unable to finish.',
    'Context length exceeded — I cannot process any more of this conversation.',
    'This conversation is too long to continue.',
    'I have reached the maximum context limit.',
    'Token limit exceeded before I could finish.',
  ])('matches a capitulation: %s', (text) => {
    expect(contextExhaustedCompletion(text)).toBe(true);
  });

  it.each([
    // A real answer that happens to be ABOUT context limits.
    'Your prompt is well under the context window, so no truncation is needed here.',
    // Named the subject but said nothing about exhaustion.
    'I loaded the full context of the ticket and drafted a reply.',
    // Named exhaustion but about something that is not the window.
    'The customer ran out of trial credits last Tuesday.',
    // Nothing to do with any of it.
    'Done. I sent the summary to the finance channel.',
  ])('does not match: %s', (text) => {
    expect(contextExhaustedCompletion(text)).toBe(false);
  });

  it('does not match a long answer that discusses context limits at length', () => {
    const essay = 'The context window is the amount of text a model can consider at once, '
      + 'and when it is full the provider returns an error rather than truncating silently. '
      + 'Teams usually handle this by summarising older turns, by splitting the work across '
      + 'several sessions, or by moving the bulk of the material into a retrieval step so '
      + 'only the relevant passages are ever loaded. Each has a cost. Summarising loses '
      + 'detail, splitting loses continuity, and retrieval adds a component that can itself '
      + 'be wrong. For this codebase the third is already in place, so the practical answer '
      + 'is to tighten what the retriever returns before considering the other two.';
    expect(essay.length).toBeGreaterThan(600);
    expect(contextExhaustedCompletion(essay)).toBe(false);
  });

  it('is not fooled by output that is not prose', () => {
    expect(contextExhaustedCompletion(undefined)).toBe(false);
    expect(contextExhaustedCompletion(null)).toBe(false);
    expect(contextExhaustedCompletion('')).toBe(false);
    expect(contextExhaustedCompletion('   ')).toBe(false);
    expect(contextExhaustedCompletion({ context: 'window', state: 'full' })).toBe(false);
    expect(contextExhaustedCompletion(['context window is full'])).toBe(false);
  });

  it('requires BOTH halves of a clause, never a single stray word', () => {
    expect(contextExhaustedCompletion('context')).toBe(false);
    expect(contextExhaustedCompletion('full')).toBe(false);
    expect(contextExhaustedCompletion('The report is full and ready.')).toBe(false);
  });
});
