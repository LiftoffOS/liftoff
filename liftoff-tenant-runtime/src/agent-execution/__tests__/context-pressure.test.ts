// B5 — the context-pressure assessment.
//
// The behaviour that matters is the boundary: below the pressure ratio nothing
// happens, above the hard ratio the run must end rather than call a provider
// that will reject it.

import {
  COMPACTION_SUMMARY_HEADER,
  CONTEXT_PRESSURE_NUDGE,
  CONTEXT_PRESSURE_RATIOS,
  assessContextPressure,
  estimateHistoryChars,
  isMidRunPlatformTurn,
  windowCharsForProvider,
} from '../context-pressure';

describe('estimateHistoryChars', () => {
  it('counts string content directly', () => {
    expect(estimateHistoryChars([{ content: 'abcde' }, { content: 'xy' }])).toBe(7);
  });

  it('serializes non-string content the way the invocation input does', () => {
    const obj = { a: 1 };
    expect(estimateHistoryChars([{ content: obj }])).toBe(JSON.stringify(obj).length);
  });

  it('survives content that will not serialize', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(estimateHistoryChars([{ content: circular }, { content: 'ok' }])).toBe(2);
  });

  it('is zero for an empty history', () => {
    expect(estimateHistoryChars([])).toBe(0);
  });
});

describe('windowCharsForProvider', () => {
  it('knows the providers we run', () => {
    expect(windowCharsForProvider('openai')).toBeGreaterThan(0);
    expect(windowCharsForProvider('google')).toBeGreaterThan(windowCharsForProvider('openai'));
  });

  it('falls back to a conservative default for an unknown provider', () => {
    // Erring small means an unrecognized engine is nudged early rather than
    // discovering its ceiling from a provider error.
    expect(windowCharsForProvider('some-new-engine')).toBe(windowCharsForProvider('openai'));
    expect(windowCharsForProvider(undefined)).toBe(windowCharsForProvider('openai'));
  });
});

describe('assessContextPressure', () => {
  const window = windowCharsForProvider('openai');

  it('says nothing for an ordinary conversation', () => {
    expect(assessContextPressure({ provider: 'openai', historyChars: 1000 }).level).toBe('ok');
  });

  it('stays quiet just under the pressure ratio', () => {
    const chars = Math.floor(window * (CONTEXT_PRESSURE_RATIOS.PRESSURE_RATIO - 0.01));
    expect(assessContextPressure({ provider: 'openai', historyChars: chars }).level).toBe('ok');
  });

  it('reports pressure at the ratio', () => {
    const chars = Math.ceil(window * CONTEXT_PRESSURE_RATIOS.PRESSURE_RATIO);
    expect(assessContextPressure({ provider: 'openai', historyChars: chars }).level).toBe('pressure');
  });

  it('reports exceeded at the hard ratio, before the provider would reject it', () => {
    const chars = Math.ceil(window * CONTEXT_PRESSURE_RATIOS.HARD_RATIO);
    expect(assessContextPressure({ provider: 'openai', historyChars: chars }).level).toBe('exceeded');
  });

  it('trips later on a provider with a larger window', () => {
    const chars = Math.ceil(window * CONTEXT_PRESSURE_RATIOS.HARD_RATIO);
    // The same history that exhausts OpenAI is unremarkable on Gemini.
    expect(assessContextPressure({ provider: 'google', historyChars: chars }).level).toBe('ok');
  });

  it('reports the numbers it judged on', () => {
    const a = assessContextPressure({ provider: 'openai', historyChars: window });
    expect(a.windowChars).toBe(window);
    expect(a.historyChars).toBe(window);
    expect(a.usedRatio).toBeCloseTo(1, 5);
  });
});

describe('the nudge', () => {
  it('tells the agent to summarize and keep working, not to stop', () => {
    expect(CONTEXT_PRESSURE_NUDGE).toMatch(/carry on/i);
    // Product voice: no contractions anywhere in text an agent may echo.
    expect(CONTEXT_PRESSURE_NUDGE).not.toMatch(/\w'(s|t|re|ll|ve|d)\b/);
  });
});

// The canonical record captures this run's user turn as the LAST user message of
// what is about to be sent (ADR-006 §3b), and both messages the platform appends
// mid-run are user-role and land immediately before that capture. Every run that
// crossed the pressure line has therefore recorded "this conversation has grown
// long" as the thing it was asked to do, for as long as the nudge has existed.
// Nothing about that depends on compaction, which is why the predicate and its
// tests live here rather than beside the compactor.
describe('isMidRunPlatformTurn', () => {
  it('knows both messages the platform appends mid-run', () => {
    expect(isMidRunPlatformTurn(CONTEXT_PRESSURE_NUDGE)).toBe(true);
    expect(isMidRunPlatformTurn(`${COMPACTION_SUMMARY_HEADER}\n\nwhat happened`)).toBe(true);
  });

  it('leaves a real turn alone, including one that talks about context', () => {
    expect(isMidRunPlatformTurn('Reconcile the July invoices')).toBe(false);
    expect(isMidRunPlatformTurn('This conversation has grown long, has it not?')).toBe(false);
  });

  it('does not claim the verify-on-stop continuation, which IS its run objective', () => {
    expect(isMidRunPlatformTurn(
      'The platform is continuing your current task, not starting a new one.\n\nRun the tests.',
    )).toBe(false);
  });
});
