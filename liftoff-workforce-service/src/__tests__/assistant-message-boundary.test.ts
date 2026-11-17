/**
 * Where one assistant message ends and the next begins.
 *
 * The same table of cases is kept in platform-backend
 * (src/common/__tests__/assistant-message-boundary.test.ts) and in
 * Liftoff-Tenant-Runtime. One thread carries messages assembled in all
 * three processes -- the Chief AI Officer here, the three platform assistants, the Chief
 * AI Officer -- and they have to read the same afterwards.
 *
 * What goes wrong without it: a turn that narrates, runs a tool and answers in
 * a later round is persisted as one run-on sentence ("...so let me pull the
 * rest.Here are the top 20"). The stream looked right; the stored row is what
 * a reload and a /share link show.
 */

import { assistantMessageGap, openAssistantMessage } from '../platform-agent/assistant-message-boundary.js';

describe('assistantMessageGap', () => {
  it('opens a paragraph between two messages that would otherwise run together', () => {
    expect(assistantMessageGap('so let me pull the rest.', 'Here are the top 20')).toBe('\n\n');
  });

  it('does not widen a gap the text already has', () => {
    expect(assistantMessageGap('a paragraph.\n\n', 'The next one')).toBe('');
    expect(assistantMessageGap('a paragraph.\n', 'The next one')).toBe('\n');
    expect(assistantMessageGap('a paragraph.', '\n\nThe next one')).toBe('');
    expect(assistantMessageGap('a paragraph.', '\nThe next one')).toBe('\n');
    expect(assistantMessageGap('a paragraph.\n', '\nThe next one')).toBe('');
  });

  it('counts the newlines in whitespace rather than requiring the string to end in one', () => {
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
    expect(assistantMessageGap('Some words.')).toBe('\n\n');
    expect(assistantMessageGap('Some words.\n')).toBe('\n');
    expect(assistantMessageGap('Some words.\n\n')).toBe('');
    expect(assistantMessageGap('')).toBe('');
  });
});

describe('openAssistantMessage', () => {
  it('drops the spaces the next message opened with, once a gap is in front of it', () => {
    expect(openAssistantMessage('here is the rewrite', ' and the shorter version'))
      .toEqual({ gap: '\n\n', text: 'and the shorter version' });
    expect(openAssistantMessage('a line', '    indented by four'))
      .toEqual({ gap: '\n\n', text: 'indented by four' });
  });

  it('leaves the text alone when no gap was needed', () => {
    expect(openAssistantMessage('a paragraph.\n\n', '   already spaced'))
      .toEqual({ gap: '', text: '   already spaced' });
    expect(openAssistantMessage('', '  the first words'))
      .toEqual({ gap: '', text: '  the first words' });
  });

  it('keeps newlines the next message opened with, counting them in the gap', () => {
    expect(openAssistantMessage('a line', '\nnext')).toEqual({ gap: '\n', text: '\nnext' });
  });

  it('never rewrites the text already sent', () => {
    expect(openAssistantMessage('Reading on. ', 'Here is what I have.'))
      .toEqual({ gap: '\n\n', text: 'Here is what I have.' });
  });
});
