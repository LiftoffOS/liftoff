// A compressor must not be told to do something impossible, and must not return
// a result that reads as complete when it is not.
//
// The original instruction says "if the input is a list of records, keep every
// record and its identifying fields". At 1,181 URLs into 8,192 characters that
// needs roughly 65,000 characters of identifiers alone. The model cannot comply,
// drops records while having been told not to, and returns something shaped like
// a faithful compression — which is worse than an obviously short answer,
// because the consumer has no reason to doubt it.

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockComplete = jest.fn();
jest.mock('../../../llm', () => ({ llmClient: { complete: (...a: unknown[]) => mockComplete(...a) } }));

import { compressForPrompt } from '../compress-for-prompt';

const ATTR = { tenantId: 't-1', agentId: 'a-1', invocationId: 'i-1' };

/** Serializes far past `budget * 4`, so "keep every record" is unsatisfiable. */
function farTooBig(budget: number): string {
  return 'x'.repeat(budget * 10);
}

/** Over budget but within the ratio: dropping prose genuinely can fit it. */
function mildlyTooBig(budget: number): string {
  return 'y'.repeat(Math.floor(budget * 1.5));
}

function promptSentTo(): string {
  const call = mockComplete.mock.calls[0];
  return (call[0] as { messages: Array<{ content: string }> }).messages[0].content;
}

beforeEach(() => {
  mockComplete.mockReset();
  process.env.SEMANTIC_COMPRESSION_ENABLED = '1';
});
afterEach(() => { delete process.env.SEMANTIC_COMPRESSION_ENABLED; });

describe('the instruction matches what is actually possible', () => {
  it('asks to keep every record when the input can plausibly fit', async () => {
    mockComplete.mockResolvedValue({ content: 'compressed' });
    await compressForPrompt(mildlyTooBig(1_000), { maxChars: 1_000, attribution: ATTR, purpose: 'p' });

    const sent = promptSentTo();
    expect(sent).toContain('keep every record');
    expect(sent).not.toContain('It CANNOT be preserved in full');
  });

  it('stops asking for that once the ratio makes it impossible', async () => {
    mockComplete.mockResolvedValue({ content: 'compressed' });
    await compressForPrompt(farTooBig(1_000), { maxChars: 1_000, attribution: ATTR, purpose: 'p' });

    const sent = promptSentTo();
    expect(sent).toContain('It CANNOT be preserved in full');
    expect(sent).not.toContain('keep every record');
  });

  it('asks for whole records and a count, not prose about them', async () => {
    // A half-described record is worse than an omitted one: it looks like data.
    mockComplete.mockResolvedValue({ content: 'compressed' });
    await compressForPrompt(farTooBig(1_000), { maxChars: 1_000, attribution: ATTR, purpose: 'p' });

    const sent = promptSentTo();
    expect(sent).toMatch(/kept N of M records/);
    expect(sent).toMatch(/Do not/i);
    expect(sent).toMatch(/Invent totals/i);
  });
});

describe('the result states its own partiality', () => {
  it('marks a lossy compression even when the model did not', async () => {
    // The guarantee cannot rest on the model remembering the instruction.
    mockComplete.mockResolvedValue({ content: 'looks totally complete' });
    const out = await compressForPrompt(farTooBig(1_000), { maxChars: 1_000, attribution: ATTR, purpose: 'p' });

    expect(out).toMatch(/^PARTIAL:/);
    expect(out).toMatch(/NOT the complete value/);
    expect(out).toMatch(/may still exist/);
  });

  it('does not double-mark when the model already said it', async () => {
    mockComplete.mockResolvedValue({ content: 'PARTIAL: kept 12 of 900 records\nrec1' });
    const out = await compressForPrompt(farTooBig(1_000), { maxChars: 1_000, attribution: ATTR, purpose: 'p' });

    expect(out.match(/PARTIAL/g)).toHaveLength(1);
    expect(out).toContain('kept 12 of 900 records');
  });

  it('charges the marker against the budget rather than blowing it', async () => {
    // A caller that asked for at most N characters gets at most N.
    mockComplete.mockResolvedValue({ content: 'z'.repeat(1_000) });
    const out = await compressForPrompt(farTooBig(1_000), { maxChars: 1_000, attribution: ATTR, purpose: 'p' });

    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(out).toMatch(/^PARTIAL:/);
  });

  it('leaves an in-ratio compression unmarked', async () => {
    // Where the instruction was satisfiable, the result carries no false alarm.
    mockComplete.mockResolvedValue({ content: 'compressed faithfully' });
    const out = await compressForPrompt(mildlyTooBig(1_000), { maxChars: 1_000, attribution: ATTR, purpose: 'p' });

    expect(out).toBe('compressed faithfully');
  });
});

describe('making room for the marker does not fake a whole record', () => {
  it('announces the cut when the model used nearly the whole budget', async () => {
    // Prepending the marker means cutting the model's text, and cutting it
    // positionally can leave a half-written record that reads as a complete
    // one — which the lossy instruction itself calls worse than an omission.
    mockComplete.mockResolvedValue({ content: 'z'.repeat(1_000) });
    const out = await compressForPrompt(farTooBig(1_000), { maxChars: 1_000, attribution: ATTR, purpose: 'p' });

    expect(out).toMatch(/^PARTIAL:/);
    expect(out.endsWith('…[cut]')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(1_000);
  });

  it('does not announce a cut when the model left room', async () => {
    mockComplete.mockResolvedValue({ content: 'short' });
    const out = await compressForPrompt(farTooBig(1_000), { maxChars: 1_000, attribution: ATTR, purpose: 'p' });

    expect(out).toContain('short');
    expect(out).not.toContain('…[cut]');
  });
});

describe('the token ceiling does not manufacture an overshoot', () => {
  it('asks for fewer tokens than the character budget can hold', async () => {
    // At maxChars/3 the model runs to stop=max_tokens and returns more
    // characters than the budget — over, every time. The overshoot would be
    // created here, then punished downstream.
    mockComplete.mockResolvedValue({ content: 'ok' });
    await compressForPrompt(farTooBig(8_192), { maxChars: 8_192, attribution: ATTR, purpose: 'p' });

    const req = mockComplete.mock.calls[0][0] as { maxTokens: number };
    // At ~4 characters per token of record-shaped JSON, this many tokens cannot
    // exceed the character budget on its own.
    expect(req.maxTokens * 4).toBeLessThanOrEqual(8_192);
  });

  it('keeps a floor so a small budget still gets a usable answer', async () => {
    mockComplete.mockResolvedValue({ content: 'ok' });
    await compressForPrompt(farTooBig(100), { maxChars: 100, attribution: ATTR, purpose: 'p' });

    const req = mockComplete.mock.calls[0][0] as { maxTokens: number };
    expect(req.maxTokens).toBe(256);
  });
});

describe('a satisfiable input can still get a lossy ANSWER', () => {
  // A compression can turn a large input into a few hundred characters with
  // room to spare — an input ratio under 2x, so "satisfiable" by the gate
  // above, and the model condenses anyway. Judging by the ratio alone lets that
  // through looking complete.
  //
  // Record lists only: that is the shape where a shrunken answer means missing
  // ROWS, which is what turns "which of these already exist" into a wrong one.
  const records = (n: number) => ({
    rows: Array.from({ length: n }, (_, i) => ({
      id: i, url: `https://example.com/item-${i}`, note: 'n'.repeat(60),
    })),
  });

  it('marks a record list the model answered with a précis', async () => {
    mockComplete.mockResolvedValue({ content: 'A brief prose summary of everything.' });
    const out = await compressForPrompt(records(60), { maxChars: 3_000, attribution: ATTR, purpose: 'p' });

    expect(out).toMatch(/^PARTIAL:/);
    expect(out).toContain('A brief prose summary of everything.');
  });

  it('leaves a record list that kept most of its characters unmarked', async () => {
    // Filling the room is what keeping records looks like; a true warning there
    // would be a false one, and a marker that fires on everything is ignored.
    mockComplete.mockResolvedValue({ content: 'z'.repeat(2_400) });
    const out = await compressForPrompt(records(60), { maxChars: 3_000, attribution: ATTR, purpose: 'p' });

    expect(out).not.toMatch(/^PARTIAL:/);
  });

  it('does NOT mark a faithful précis of redundant, non-record data', async () => {
    // `{pad: "ppppp…"}` summarised as "padded string of 500 p characters" lost
    // nothing. Marking it would spend the warning's credibility on a non-event.
    mockComplete.mockResolvedValue({ content: 'padded string of 500 p characters' });
    const out = await compressForPrompt({ pad: 'p'.repeat(5_000) }, {
      maxChars: 2_000, attribution: ATTR, purpose: 'p',
    });

    expect(out).toBe('padded string of 500 p characters');
  });
});
