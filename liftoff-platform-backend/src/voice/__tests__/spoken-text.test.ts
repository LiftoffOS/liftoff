import { toSpokenText } from '../spoken-text';

describe('toSpokenText', () => {
  it('drops emphasis markers but keeps the words', () => {
    expect(toSpokenText('This is **important** and *urgent*.')).toBe(
      'This is important and urgent.',
    );
  });

  it('reads a link by its text, never its address', () => {
    const spoken = toSpokenText('See [the pipeline report](https://example.com/a/b?c=d).');
    expect(spoken).toBe('See the pipeline report.');
    expect(spoken).not.toContain('example.com');
  });

  it('replaces a bare URL rather than spelling it out', () => {
    const spoken = toSpokenText('Details at https://example.com/very/long/path?token=abc123');
    expect(spoken).not.toContain('example.com');
    expect(spoken).toContain('(link)');
  });

  it('names a long code block instead of reading it', () => {
    const spoken = toSpokenText(
      'Try this:\n```ts\nconst client = new SpeechClient(); await client.recognize(request);\n```\n',
    );
    expect(spoken).toContain('code omitted');
    expect(spoken).not.toContain('SpeechClient');
  });

  it('reads a short snippet, which is usually a name', () => {
    expect(toSpokenText('Run ```npm test``` first.')).toContain('npm test');
  });

  it('turns headings into their own sentence', () => {
    expect(toSpokenText('## Pipeline\nTwo deals need a decision.')).toBe(
      'Pipeline. Two deals need a decision.',
    );
  });

  it('strips list markers, ordered and unordered', () => {
    expect(toSpokenText('- first item\n- second item')).toBe('first item second item');
    expect(toSpokenText('1. first item\n2. second item')).toBe('first item second item');
  });

  it('reads a table row the way a person would', () => {
    const spoken = toSpokenText('| Deal | Stage |\n| --- | --- |\n| Acme | Review |');
    expect(spoken).toContain('Deal, Stage');
    expect(spoken).toContain('Acme, Review');
    expect(spoken).not.toContain('|');
    expect(spoken).not.toContain('---');
  });

  it('returns nothing speakable when there was nothing but code', () => {
    expect(
      toSpokenText(
        '```\nconst averylongidentifiername = await someOtherLongFunctionCall(withAnArgument);\n```',
      ),
    ).toBe('(code omitted)');
  });

  it('is empty for empty input rather than throwing', () => {
    expect(toSpokenText('')).toBe('');
    expect(toSpokenText('   \n\n  ')).toBe('');
  });

  it('leaves ordinary prose untouched', () => {
    const prose = 'Two deals need a decision today, and the forecast is unchanged.';
    expect(toSpokenText(prose)).toBe(prose);
  });
});
