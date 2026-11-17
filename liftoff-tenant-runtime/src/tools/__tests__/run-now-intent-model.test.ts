/**
 * The model reads the intent; the patterns answer when it cannot be reached.
 *
 * A list of verbs is not a language model. It knew how to say "run" and not how
 * to say "I want my report now". Intent is a judgement about language, which is what `typesafe` is
 * already used for elsewhere in this runtime.
 *
 * What must hold, and what these test:
 *   - the model's verdict is used when it answers;
 *   - a QUESTION wins a tie, because arming a sweep nobody asked for is the
 *     failure this gate exists to prevent and is not recoverable;
 *   - every way the model can be unavailable falls back to the patterns, and
 *     none of them falls back to starting a run.
 */
const mockAsk = jest.fn();
jest.mock('../../typesafe/client', () => ({ ask: (...a: unknown[]) => mockAsk(...a) }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { readRunNowIntentAsync } from '../run-now-intent';

const CTX = { tenantId: 't1', invocationId: 'inv1' };
const answer = (asksToRun: number, asksAboutWork: number) => ({
  answers: { asks_to_run: { noul: asksToRun }, asks_about_work: { noul: asksAboutWork } },
});

beforeEach(() => mockAsk.mockReset());

describe('the model decides when it answers', () => {
  it('a confident request starts the run', async () => {
    mockAsk.mockResolvedValue(answer(0.91, 0.03));
    await expect(readRunNowIntentAsync('i want my report now', CTX)).resolves.toBe('start');
  });

  it('a confident question does not', async () => {
    mockAsk.mockResolvedValue(answer(0.10, 0.88));
    await expect(readRunNowIntentAsync('where is my report', CTX)).resolves.toBe('asks_about_work');
  });

  it('neither is unclear, and arms nothing', async () => {
    mockAsk.mockResolvedValue(answer(0.11, 0.09));
    await expect(readRunNowIntentAsync('thanks, that helps', CTX)).resolves.toBe('unclear');
  });

  it('a QUESTION wins a tie', async () => {
    // Both over their thresholds. Answering from work already done is
    // recoverable; starting a sweep nobody asked for is not.
    mockAsk.mockResolvedValue(answer(0.95, 0.95));
    await expect(readRunNowIntentAsync('did you run my report, run it now', CTX)).resolves.toBe('asks_about_work');
  });
});

describe('it falls back to the patterns, never to a run', () => {
  it('when ask returns null — no key, no clock, an unpinned threshold', async () => {
    mockAsk.mockResolvedValue(null);
    await expect(readRunNowIntentAsync('i want my report now', CTX)).resolves.toBe('start');
    await expect(readRunNowIntentAsync('where is my report', CTX)).resolves.toBe('asks_about_work');
    await expect(readRunNowIntentAsync('thanks, that helps', CTX)).resolves.toBe('unclear');
  });

  it('when ask throws', async () => {
    mockAsk.mockRejectedValue(new Error('network'));
    await expect(readRunNowIntentAsync('i want my report now', CTX)).resolves.toBe('start');
  });

  it('when the answer is not a number', async () => {
    mockAsk.mockResolvedValue({ answers: { asks_to_run: { noul: 'yes' }, asks_about_work: {} } });
    await expect(readRunNowIntentAsync('where is my report', CTX)).resolves.toBe('asks_about_work');
  });

  it('an unavailable model never turns silence into a run', async () => {
    // The dangerous direction. A message the patterns cannot read is `unclear`,
    // and `unclear` arms nothing.
    mockAsk.mockResolvedValue(null);
    await expect(readRunNowIntentAsync('hmm', CTX)).resolves.toBe('unclear');
  });

  it('an empty message is never asked about', async () => {
    await expect(readRunNowIntentAsync('   ', CTX)).resolves.toBe('unclear');
    expect(mockAsk).not.toHaveBeenCalled();
  });
});
