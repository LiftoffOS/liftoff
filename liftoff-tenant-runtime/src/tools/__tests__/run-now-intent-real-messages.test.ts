/**
 * Sentences the way people actually type them, and what they must mean.
 *
 * The classifier knew verbs for running a PROCESS — run, start, trigger, kick
 * off — and nothing for asking for the OUTPUT. "i want my report now" matched
 * neither list, came back `unclear`, and the routine was refused while the
 * person had said plainly what they wanted.
 *
 * So the cases here are real phrasings, not tidy invented ones. A table of what a
 * real message has to mean is the only thing that catches this, and inventing
 * plausible-sounding inputs is how it gets missed.
 */
import { readRunNowIntent } from '../run-now-intent';

describe('messages the way people type them', () => {
  it.each([
    // No PROCESS verb, so a verb list alone reads it as `unclear`.
    ['i want my report now', 'start'],
    // Asks about work already done; it must not arm a second sweep while
    // the run holds the link to the document being asked about.
    ['so where is my report', 'asks_about_work'],
    // The model's own paraphrase when it does ask for a run.
    ['run the weekly competitor sweep now', 'start'],
  ] as const)('%s -> %s', (message, expected) => {
    expect(readRunNowIntent(message)).toBe(expected);
  });
});

describe('a demand for the deliverable is a request for the work', () => {
  it.each([
    'send me the report',
    'give me the summary',
    'i need the digest',
    'show me the analysis',
    'i want the competitor brief now',
  ])('%s', (message) => {
    expect(readRunNowIntent(message)).toBe('start');
  });
});

describe('a question about the deliverable is still a question', () => {
  // These contain the same nouns and must NOT arm a run: `ASKS_ABOUT_WORK` is
  // checked first and is what keeps them on this side.
  it.each([
    'where is my report',
    'did you send the digest?',
    'what happened to my analysis',
    'is the summary ready',
    'any update on the report',
    'i never got the digest',
  ])('%s', (message) => {
    expect(readRunNowIntent(message)).toBe('asks_about_work');
  });
});

describe('neither', () => {
  it.each([
    // Wants something that is not a deliverable.
    'i want to understand the pricing',
    // Names a deliverable but asks for nothing.
    'the report was useful',
    'thanks, that helps',
    '',
  ])('%s', (message) => {
    expect(readRunNowIntent(message)).toBe('unclear');
  });
});
