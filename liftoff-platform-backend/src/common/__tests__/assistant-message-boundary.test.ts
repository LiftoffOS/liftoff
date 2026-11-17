/**
 * Where one assistant message ends and the next begins.
 *
 * A turn writes more than once -- it says what it is about to do, runs a tool,
 * and answers in a later round -- and the string it accumulates is what gets
 * persisted. Joined with nothing between them the two messages run together
 * mid-sentence, and that is what reaches people: stored Liftoff replies read
 * like "...so let me pull the rest.Here are the top 20".
 */

import { assistantMessageGap, openAssistantMessage } from '../assistant-message-boundary';

describe('assistantMessageGap', () => {
  it('opens a paragraph between two messages that would otherwise run together', () => {
    expect(assistantMessageGap('so let me pull the rest.', 'Here are the top 20')).toBe('\n\n');
  });

  it('does not widen a gap the text already has', () => {
    expect(assistantMessageGap('a paragraph.\n\n', 'The next one')).toBe('');
    expect(assistantMessageGap('a paragraph.\n', 'The next one')).toBe('\n');
    expect(assistantMessageGap('a paragraph.', '\n\nThe next one')).toBe('');
    expect(assistantMessageGap('a paragraph.', '\nThe next one')).toBe('\n');
    // One newline each side is already a paragraph break between them.
    expect(assistantMessageGap('a paragraph.\n', '\nThe next one')).toBe('');
  });

  it('counts the newlines in whitespace rather than requiring the string to end in one', () => {
    // A guard hands a paragraph back with its own trailing spaces intact.
    expect(assistantMessageGap('a paragraph.\n\n   ', 'The next one')).toBe('');
    expect(assistantMessageGap('a paragraph. \n ', 'The next one')).toBe('\n');
  });

  it('has nothing to separate when either side is empty or blank', () => {
    expect(assistantMessageGap('', 'The first words')).toBe('');
    expect(assistantMessageGap('   \n ', 'The first words')).toBe('');
    expect(assistantMessageGap('Some words.', '')).toBe('');
    expect(assistantMessageGap('Some words.', '   ')).toBe('');
  });

  it('sizes the gap from what it has when the next message has not arrived', () => {
    // The surface that is told "that message ended" writes the gap then.
    expect(assistantMessageGap('Some words.')).toBe('\n\n');
    expect(assistantMessageGap('Some words.\n')).toBe('\n');
    expect(assistantMessageGap('Some words.\n\n')).toBe('');
    expect(assistantMessageGap('')).toBe('');
  });
});

describe('openAssistantMessage', () => {
  it('drops the spaces the next message opened with, once a gap is in front of it', () => {
    // They were shaping it against the message before it. After a paragraph
    // break they are stray, and four of them is a markdown code block.
    expect(openAssistantMessage('here is the rewrite', ' and the shorter version'))
      .toEqual({ gap: '\n\n', text: 'and the shorter version' });
    expect(openAssistantMessage('a line', '    indented by four'))
      .toEqual({ gap: '\n\n', text: 'indented by four' });
  });

  it('leaves the text alone when no gap was needed', () => {
    // Nothing was inserted, so nothing was shaped against anything: what the
    // model wrote is what is kept.
    expect(openAssistantMessage('a paragraph.\n\n', '   already spaced'))
      .toEqual({ gap: '', text: '   already spaced' });
    expect(openAssistantMessage('', '  the first words'))
      .toEqual({ gap: '', text: '  the first words' });
  });

  it('keeps newlines the next message opened with, counting them in the gap', () => {
    expect(openAssistantMessage('a line', '\nnext')).toEqual({ gap: '\n', text: '\nnext' });
  });

  it('never rewrites the text already sent', () => {
    // It has been streamed to the person; the row must stay what they saw.
    expect(openAssistantMessage('Reading on. ', 'Here is what I have.'))
      .toEqual({ gap: '\n\n', text: 'Here is what I have.' });
  });
});
