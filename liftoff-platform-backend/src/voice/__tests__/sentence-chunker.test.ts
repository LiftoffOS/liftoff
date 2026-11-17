import { SentenceChunker } from '../sentence-chunker';

describe('SentenceChunker', () => {
  it('holds a sentence until it is complete', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('The pipeline review is')).toEqual([]);
    expect(chunker.push(' ready.')).toEqual([]);
    // The terminator alone is not enough — a closing quote could still follow.
    expect(chunker.push(' Two deals need')).toEqual(['The pipeline review is ready.']);
  });

  it('starts speaking sooner than it continues', () => {
    // "Done." is 5 characters and would be held mid-reply, but as the FIRST
    // thing said it is what gets a voice started.
    const first = new SentenceChunker();
    expect(first.push('Sure. Here is what I found today.')).toEqual(['Sure.']);
  });

  it('does not split on an abbreviation, a decimal, or an initial', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('Dr. Chen approved 3.5 million for J. Rivera today. Next item')).toEqual([
      'Dr. Chen approved 3.5 million for J. Rivera today.',
    ]);
  });

  it('keeps closing punctuation with its sentence', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('She asked "is it ready?" and left the room.')).toEqual([
      'She asked "is it ready?"',
    ]);
  });

  it('emits at a clause when a sentence runs too long to wait for', () => {
    const chunker = new SentenceChunker();
    const long = `${'the quarterly figures kept climbing '.repeat(6)}, and then`;
    const out = chunker.push(long);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.length).toBeLessThanOrEqual(320);
  });

  it('flush returns the last words when a reply ends without a full stop', () => {
    const chunker = new SentenceChunker();
    chunker.push('All set. One more thing');
    expect(chunker.flush()).toEqual(['One more thing']);
  });

  it('flush on an empty buffer says nothing', () => {
    const chunker = new SentenceChunker();
    chunker.push('Done. ');
    expect(chunker.flush()).toEqual([]);
  });

  it('never loses or duplicates text across a stream', () => {
    const reply = 'First point here. Second point follows! Third one, unterminated';
    const chunker = new SentenceChunker();
    const spoken: string[] = [];
    // Fed one character at a time, the way a token stream actually arrives.
    for (const char of reply) spoken.push(...chunker.push(char));
    spoken.push(...chunker.flush());
    expect(spoken.join(' ')).toBe(reply);
  });
});
