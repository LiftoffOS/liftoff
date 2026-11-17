// A step must be able to tell a complete value from a partial one.
//
// Three states exist and only two ever had words. An oversized value with no
// workspace to park it in rendered exactly like a small one — a summary, no
// note — so a step deciding whether a record already exists read that summary as
// the set. Without a workspace that silent state is the common one, not the
// edge case.

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { renderPriorOutput, type PriorOutputView } from '../prior-output-view';

const base: PriorOutputView = {
  summary: 'SUMMARY-TEXT',
  offloaded: null,
  mustBeWhole: false,
  exceeded: false,
  chars: 100,
};

describe('a value that fits', () => {
  it('is rendered unchanged, with nothing added', () => {
    expect(renderPriorOutput(base)).toBe('SUMMARY-TEXT');
  });
});

describe('a value that was parked', () => {
  const parked = {
    ...base,
    offloaded: { path: 'run-values/step-output-s2.json', bytes: 300_745 },
    exceeded: true,
    chars: 300_745,
  };

  it('keeps the summary and says where the rest is', () => {
    const out = renderPriorOutput(parked);
    expect(out).toContain('SUMMARY-TEXT');
    expect(out).toContain('run-values/step-output-s2.json');
    expect(out).toContain('300745');
  });

  it('does not also claim the remainder is unrecoverable', () => {
    // The parked and gone notes are mutually exclusive; emitting both would tell
    // the model the file both exists and does not.
    expect(renderPriorOutput(parked)).not.toContain('cannot be recovered');
  });
});

describe('a value that exceeded the budget and could NOT be parked', () => {
  const gone = { ...base, exceeded: true, chars: 15_300 };

  it('says the remainder is gone, in the prompt, where the model will read it', () => {
    const out = renderPriorOutput(gone);
    expect(out).toContain('TRUNCATED');
    expect(out).toContain('15300');
    expect(out).toMatch(/cannot be recovered/i);
  });

  it('states the direction of the error rather than just the fact', () => {
    // "Something is missing" is not actionable. "Absence here is not evidence of
    // absence" is the sentence that stops a wrong dedup.
    expect(renderPriorOutput(gone)).toMatch(/missing from it may still\s+exist/);
  });

  it('tells a step whose answer needs completeness to stop rather than guess', () => {
    expect(renderPriorOutput(gone)).toMatch(/say so and stop/i);
  });

  it('never points at a workspace path that does not exist', () => {
    // The dead-path failure: directing a model to read a file nothing wrote.
    expect(renderPriorOutput(gone)).not.toContain('file_read');
    expect(renderPriorOutput(gone)).not.toContain('workspace at');
  });
});

describe('a completeness-required value that was parked', () => {
  const strict = {
    ...base,
    mustBeWhole: true,
    offloaded: { path: 'run-values/step-output-s2.json', bytes: 300_745 },
    exceeded: true,
    chars: 300_745,
    producedBy: 'google-sheets-2b820bc9__batch_get_values',
  };

  it('withholds the summary entirely', () => {
    // For this value a summary is not a convenience — it is the wrong answer,
    // pre-computed and sitting in the prompt where the model will use it.
    const out = renderPriorOutput(strict);
    expect(out).not.toContain('SUMMARY-TEXT');
  });

  it('names the file, the tool, and what to do with it', () => {
    const out = renderPriorOutput(strict);
    expect(out).toContain('run-values/step-output-s2.json');
    expect(out).toContain('google-sheets-2b820bc9__batch_get_values');
    expect(out).toMatch(/WHOLE result/);
  });

  it('points set-shaped work at code rather than at reading', () => {
    // Reading 1,181 records into a model to diff them is the problem restated.
    // An agent reaches for code_execute the moment the gateway refuses; this
    // says so up front instead of after a refusal.
    expect(renderPriorOutput(strict)).toMatch(/code-execution/);
    expect(renderPriorOutput(strict)).toMatch(/already exist/);
  });

  it('forbids answering from a remembered summary', () => {
    expect(renderPriorOutput(strict)).toMatch(/Do not answer from memory/i);
  });
});
