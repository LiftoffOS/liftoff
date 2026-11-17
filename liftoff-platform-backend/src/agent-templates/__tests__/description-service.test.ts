// The one-line description written for a template somebody rewrote inline.
//
// Two things are worth guarding. The tidy-up, because the model is asked for a
// bare sentence and will occasionally hand back a quoted one, a labelled one,
// or one far past the width the header can hold — and each of those reaches the
// screen as a rendering fault rather than as a bad description. And the tier,
// because the whole reason this route exists separately from the distiller is
// that it is cheap; silently promoting it to large would cost orders of
// magnitude more for a line of UI that is never even stored.

import { tidy, DESCRIPTION_MAX_CHARS } from '../description-service';

describe('tidy', () => {
  it('leaves a well-formed sentence alone', () => {
    const sentence = 'Reads vendor invoices, matches them to POs, and runs payment batches.';
    expect(tidy(sentence)).toBe(sentence);
  });

  it('strips wrapping quotes, straight and curly', () => {
    expect(tidy('"Reads vendor invoices."')).toBe('Reads vendor invoices.');
    expect(tidy('“Reads vendor invoices.”')).toBe('Reads vendor invoices.');
  });

  it('strips a label the instructions asked it not to write', () => {
    expect(tidy('Description: Reads vendor invoices.')).toBe('Reads vendor invoices.');
    expect(tidy('summary: Reads vendor invoices.')).toBe('Reads vendor invoices.');
  });

  it('replaces em dashes, which are out of house style product-wide', () => {
    expect(tidy('Reads invoices — and pays them.')).toBe('Reads invoices, and pays them.');
  });

  it('collapses the newlines a model adds when it pads an answer', () => {
    expect(tidy('  Reads vendor\n  invoices.  ')).toBe('Reads vendor invoices.');
  });

  it('leaves a description the length of a real catalog one alone', () => {
    // The cap was 200 and the catalog's own median is 256, so 47 of the 65
    // templates were longer than the limit their rewrite had to fit. Every
    // faithful rewrite came back clipped, with the ellipsis as the symptom.
    const typical =
      'Delivers a pre-meeting brief to your reps 55 to 65 minutes before every '
      + 'client call, pulling account history, deal status, recent interactions, '
      + 'and risk signals from your CRM so they walk in fully prepared.';
    expect(typical.length).toBeGreaterThan(200);
    expect(tidy(typical)).toBe(typical);
    expect(tidy(typical)).not.toContain('…');
  });

  it('cuts back to the last whole sentence when it overruns', () => {
    const long = 'Reads vendor invoices and matches them to purchase orders. '.repeat(10);
    const out = tidy(long);

    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
    // Ends the way a sentence ends, not the way a string gets cut.
    expect(out.endsWith('.')).toBe(true);
    expect(out).not.toContain('…');
  });

  it('falls back to a word boundary only when one sentence outruns the budget', () => {
    const runaway = `Reads ${'vendor invoices and purchase orders '.repeat(20)}continuously`;
    const out = tidy(runaway);

    expect(out.length).toBeLessThanOrEqual(DESCRIPTION_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
    // Whole words only: a severed word reads as a rendering fault.
    const source = new Set(runaway.split(/\s+/));
    for (const word of out.slice(0, -1).trim().split(' ')) {
      expect(source.has(word)).toBe(true);
    }
  });

  it('does not add an ellipsis to something already short enough', () => {
    expect(tidy('Reads invoices.')).not.toContain('…');
  });
});

describe('describeEditedTemplate', () => {
  const complete = jest.fn();
  jest.mock('../../llm', () => ({ llmClient: { complete } }));

  beforeEach(() => {
    jest.resetModules();
    complete.mockReset();
  });

  it('runs on the small tier, not the large one the distiller uses', async () => {
    complete.mockResolvedValue({ content: 'Reads vendor invoices.' });
    jest.doMock('../../llm', () => ({ llmClient: { complete } }));
    const { describeEditedTemplate } = await import('../description-service');

    await describeEditedTemplate(
      'accounts-payable-specialist',
      { role: 'AP Specialist', responsibilities: 'Reads invoices.', additionalContext: '' },
      'tenant-1',
    );

    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].tier).toBe('small');
  });

  it('throws rather than inventing a fallback when the model returns nothing', async () => {
    // The caller renders NOTHING on a failure, deliberately. Returning the
    // template's own line here would put a description of the unedited team
    // under a team that has been edited.
    complete.mockResolvedValue({ content: '   ' });
    jest.doMock('../../llm', () => ({ llmClient: { complete } }));
    const { describeEditedTemplate } = await import('../description-service');

    await expect(describeEditedTemplate(
      'accounts-payable-specialist',
      { role: 'AP Specialist', responsibilities: 'Reads invoices.', additionalContext: '' },
      'tenant-1',
    )).rejects.toThrow();
  });
});
