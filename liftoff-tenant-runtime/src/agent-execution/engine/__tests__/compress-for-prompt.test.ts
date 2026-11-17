// Semantic compression of oversized prompt values.
//
// The whole value of this module is that it can only ever improve on the
// deterministic bound. Every failure mode — disabled, empty response, a model
// that ignored the budget, a thrown error, a hung provider — has to return the
// same string `truncateForPrompt` would have returned, because the alternative is
// a workflow step that fails for the sake of a context optimisation.
//
// Also pinned here: the attribution keys. `llm/usage-tracker.ts` reads
// tenantId / agentId / invocationId / purpose off the usage event's context when
// it writes llm_usage_log. Any other spelling silently records NULL, and a
// compression pass would spend real tokens attributed to nobody — the kind of
// defect that shows up as a billing gap months later.

jest.mock('../../../llm', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { compressForPrompt, semanticCompressionEnabled } from '../compress-for-prompt';
import { truncateForPrompt } from '../truncate-for-prompt';
import { llmClient } from '../../../llm';

const mockComplete = llmClient.complete as jest.Mock;

const ATTRIBUTION = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  agentId: '22222222-2222-2222-2222-222222222222',
  invocationId: '33333333-3333-3333-3333-333333333333',
};

/** Comfortably past any budget used below. Also past the ratio at which
 *  "keep every record" stops being possible, so this takes the LOSSY path. */
function oversized(): { rows: Array<{ id: number; note: string }> } {
  return { rows: Array.from({ length: 400 }, (_, i) => ({ id: i, note: 'n'.repeat(120) })) };
}

/** Over budget, but within the ratio where dropping prose can genuinely fit the
 *  records — the case the faithful-compression prompt was written for. Used by
 *  the tests below that are about that path specifically; `oversized()` is 28x
 *  the budget and would take the lossy one. */
function mildlyOversized(): { rows: Array<{ id: number; note: string }> } {
  // ~4,300 characters serialized: over the 2,000 budget used below so it
  // compresses at all, and under 4x it so it takes the faithful path.
  return { rows: Array.from({ length: 30 }, (_, i) => ({ id: i, note: 'n'.repeat(120) })) };
}

describe('compressForPrompt', () => {
  const previousFlag = process.env.SEMANTIC_COMPRESSION_ENABLED;

  beforeEach(() => {
    mockComplete.mockReset();
    process.env.SEMANTIC_COMPRESSION_ENABLED = '1';
  });

  afterAll(() => {
    if (previousFlag === undefined) delete process.env.SEMANTIC_COMPRESSION_ENABLED;
    else process.env.SEMANTIC_COMPRESSION_ENABLED = previousFlag;
  });

  it('returns the value untouched when it already fits, without a model call', () => {
    // The common case by a wide margin: p50 of the upstream distribution is 350
    // characters against a budget of 8,192. Spending a model call here would be
    // pure cost.
    return compressForPrompt({ id: 7, name: 'ok' }, {
      maxChars: 8_192,
      attribution: ATTRIBUTION,
      purpose: 'test',
    }).then(result => {
      expect(result).toBe(truncateForPrompt({ id: 7, name: 'ok' }, 8_192));
      expect(mockComplete).not.toHaveBeenCalled();
    });
  });

  it('is a no-op returning the deterministic bound when the flag is off', async () => {
    process.env.SEMANTIC_COMPRESSION_ENABLED = '0';
    const value = oversized();

    const result = await compressForPrompt(value, {
      maxChars: 2_000,
      attribution: ATTRIBUTION,
      purpose: 'test',
    });

    expect(result).toBe(truncateForPrompt(value, 2_000));
    expect(mockComplete).not.toHaveBeenCalled();
    expect(semanticCompressionEnabled()).toBe(false);
  });

  it('returns the compressed text when the model honours the budget', async () => {
    // Sized like a real compression of a record list (over a fifth of the
    // input): a two-line answer to 4,300 characters of rows is a précis, and
    // now carries a PARTIAL marker of its own.
    mockComplete.mockResolvedValue({ content: `  ${'r'.repeat(1_200)}  ` });

    const result = await compressForPrompt(mildlyOversized(), {
      maxChars: 2_000,
      attribution: ATTRIBUTION,
      purpose: 'workflow_step_output_compression',
    });

    expect(result).toBe('r'.repeat(1_200));
    expect(mockComplete).toHaveBeenCalledTimes(1);
  });

  it('attributes the call with the exact keys the usage ledger reads', async () => {
    mockComplete.mockResolvedValue({ content: 'summary' });

    await compressForPrompt(oversized(), {
      maxChars: 2_000,
      attribution: ATTRIBUTION,
      purpose: 'workflow_step_output_compression',
    });

    const usageContext = mockComplete.mock.calls[0][2];
    // These four names are the llm_usage_log columns' sources. Renaming one here
    // does not break anything visibly — it just stops the cost being attributable.
    expect(usageContext).toEqual({
      purpose: 'workflow_step_output_compression',
      tenantId: ATTRIBUTION.tenantId,
      agentId: ATTRIBUTION.agentId,
      invocationId: ATTRIBUTION.invocationId,
    });
  });

  it('falls back to the deterministic bound when the model returns nothing', async () => {
    mockComplete.mockResolvedValue({ content: '   ' });
    const value = oversized();

    const result = await compressForPrompt(value, {
      maxChars: 2_000,
      attribution: ATTRIBUTION,
      purpose: 'test',
    });

    expect(result).toBe(truncateForPrompt(value, 2_000));
  });

  it('trims an over-budget summary rather than discarding it', async () => {
    // At the real 8,192 budget the model can return a few hundred characters
    // over (stop=max_tokens) while holding more identifiers than the
    // deterministic bound that would replace it. Discarding is a false
    // choice between blowing the budget and falling back — trimming is strictly
    // better than both, and costs about one record.
    mockComplete.mockResolvedValue({ content: 'x'.repeat(3_000) });
    const value = oversized();

    const result = await compressForPrompt(value, {
      maxChars: 2_000,
      attribution: ATTRIBUTION,
      purpose: 'test',
    });

    expect(result.length).toBeLessThanOrEqual(2_000);
    expect(result).not.toBe(truncateForPrompt(value, 2_000));
    // The cut announces itself: a record sliced mid-way reads as a whole one.
    expect(result).toContain('…[cut]');
  });

  it('falls back when the provider throws', async () => {
    mockComplete.mockRejectedValue(new Error('provider overloaded'));
    const value = oversized();

    const result = await compressForPrompt(value, {
      maxChars: 2_000,
      attribution: ATTRIBUTION,
      purpose: 'test',
    });

    expect(result).toBe(truncateForPrompt(value, 2_000));
  });

  it('falls back when a malformed response has no content field', async () => {
    mockComplete.mockResolvedValue({});
    const value = oversized();

    const result = await compressForPrompt(value, {
      maxChars: 2_000,
      attribution: ATTRIBUTION,
      purpose: 'test',
    });

    expect(result).toBe(truncateForPrompt(value, 2_000));
  });

  it('stops waiting on a hung provider instead of stalling the step', async () => {
    // Fail-open covers errors, not slowness. Without the timeout the step's own
    // timeout fires and a context optimisation becomes a step failure.
    jest.useFakeTimers();
    mockComplete.mockReturnValue(new Promise(() => { /* never settles */ }));
    const value = oversized();

    const pending = compressForPrompt(value, {
      maxChars: 2_000,
      attribution: ATTRIBUTION,
      purpose: 'test',
    });
    await jest.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBe(truncateForPrompt(value, 2_000));
    jest.useRealTimers();
  });

  it('decides "already fits" on the same serialization the bound uses', async () => {
    // The margin case. A value serializing to exactly the budget must not be
    // sent for compression, and must come back byte-identical — which only holds
    // if the fits-check and the bound serialize the same way.
    const value = { pad: 'p'.repeat(500) };
    const serialized = JSON.stringify(value);

    const result = await compressForPrompt(value, {
      maxChars: serialized.length,
      attribution: ATTRIBUTION,
      purpose: 'test',
    });

    expect(result).toBe(serialized);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('compresses when the value is one character over the budget', async () => {
    const value = { pad: 'p'.repeat(500) };
    const serialized = JSON.stringify(value);
    mockComplete.mockResolvedValue({ content: 'padded string of 500 p characters' });

    const result = await compressForPrompt(value, {
      maxChars: serialized.length - 1,
      attribution: ATTRIBUTION,
      purpose: 'test',
    });

    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(result).toBe('padded string of 500 p characters');
  });

  it('handles undefined and unserializable values without throwing', async () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    await expect(
      compressForPrompt(undefined, { maxChars: 100, attribution: ATTRIBUTION, purpose: 'test' }),
    ).resolves.toBe('undefined');
    await expect(
      compressForPrompt(circular, { maxChars: 100, attribution: ATTRIBUTION, purpose: 'test' }),
    ).resolves.toBe('"[unserializable]"');
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('asks the model to preserve facts and drop prose', async () => {
    // The prompt is the entire difference between this and a positional slice.
    // If it stops naming what must survive, the module degrades into a worse
    // truncation with a model call attached.
    //
    // Deliberately in-ratio: past 4x the budget "keep every record" is not
    // achievable and a different, honest instruction is sent instead (see
    // compress-lossy-honesty.test.ts). This asserts the prompt for the case it
    // was written for.
    mockComplete.mockResolvedValue({ content: 'summary' });

    await compressForPrompt(mildlyOversized(), {
      maxChars: 2_000,
      attribution: ATTRIBUTION,
      purpose: 'test',
    });

    const prompt = mockComplete.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toMatch(/ALWAYS PRESERVE/);
    expect(prompt).toMatch(/identifiers/i);
    expect(prompt).toMatch(/REMOVE ENTIRELY/);
    expect(prompt).toContain('at most 2000 characters');
  });
});
