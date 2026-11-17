// The verdict a closing reply ends with, read once and removed: the last
// line on its own decides, a stray marker anywhere is removed too, and a
// reply with no line carries no verdict (the caller reads that as unfinished).

import { readClosingVerdict } from '../closing-verdict';

describe('readClosingVerdict', () => {
  it('reads [continue] and [done] off the last line and strips it', () => {
    expect(readClosingVerdict('Twelve done; eight to go.\n[continue]')).toEqual({ text: 'Twelve done; eight to go.', verdict: 'continue' });
    expect(readClosingVerdict('All twenty done.\n\n[done]\n')).toEqual({ text: 'All twenty done.', verdict: 'done' });
    expect(readClosingVerdict('All twenty done.\n  [DONE]  ')).toEqual({ text: 'All twenty done.', verdict: 'done' });
  });

  it('removes a stray marker mid-text, and a marker line that is not last does not decide', () => {
    expect(readClosingVerdict('I found three. [done] That is all.\n[done]')).toEqual({ text: 'I found three. That is all.', verdict: 'done' });
    expect(readClosingVerdict('[continue]\nMore words after it.')).toEqual({ text: '\nMore words after it.', verdict: null });
  });

  it('carries no verdict when the reply has no marker line, and keeps the text as it was', () => {
    expect(readClosingVerdict('Here is what I have so far.')).toEqual({ text: 'Here is what I have so far.', verdict: null });
    expect(readClosingVerdict('')).toEqual({ text: '', verdict: null });
  });
});
