// The redistill canary.
//
// Three properties are load-bearing, and the first one is the reason this
// exists rather than a simple rate comparison: a provider outage must never
// revert a redistill. The other two are that "not enough data" is reported as
// itself rather than as a pass, and that the bar is honest about what it
// cannot see.

import {
  AGENT_QUALITY_FAILURE_CLASSES,
  DEFAULT_CANARY_CONFIG,
  NON_AGENT_FAILURE_CLASSES,
  countsAsAgentQualityFailure,
  evaluateRedistillCanary,
  type CanaryWindow,
} from '../redistill-canary';

const window = (over: Partial<CanaryWindow> = {}): CanaryWindow => ({
  runs: 100,
  agentQualityFailures: 5,
  escalations: 0,
  hitlRejections: 0,
  ...over,
});

describe('what counts as evidence about the agent', () => {
  it.each([...AGENT_QUALITY_FAILURE_CLASSES])('counts %s', (fc) => {
    expect(countsAsAgentQualityFailure(fc)).toBe(true);
  });

  it.each([...NON_AGENT_FAILURE_CLASSES])('does NOT count %s', (fc) => {
    // Rolling back a redistill because a provider was down would revert good
    // work over somebody else's outage, and the rollback would look correct.
    expect(countsAsAgentQualityFailure(fc)).toBe(false);
  });

  it('treats a successful run as no failure', () => {
    expect(countsAsAgentQualityFailure(null)).toBe(false);
    expect(countsAsAgentQualityFailure(undefined)).toBe(false);
  });

  it('does not count a class it has never heard of', () => {
    // A new class added to the taxonomy must be enrolled deliberately, not by
    // defaulting into auto-rollback.
    expect(countsAsAgentQualityFailure('some_future_class')).toBe(false);
  });

  it('keeps the two sets disjoint', () => {
    for (const fc of AGENT_QUALITY_FAILURE_CLASSES) {
      expect(NON_AGENT_FAILURE_CLASSES.has(fc)).toBe(false);
    }
  });
});

describe('evidence thresholds', () => {
  it('reports insufficient evidence rather than a pass when runs are few', () => {
    const v = evaluateRedistillCanary(window(), window({ runs: 4, agentQualityFailures: 4 }));
    expect(v.decision).toBe('insufficient_evidence');
    expect(v.rationale).toMatch(/[Nn]ot a pass/);
  });

  it('does not act on a brand-new agent with no history', () => {
    const v = evaluateRedistillCanary(
      window({ runs: 0, agentQualityFailures: 0 }),
      window({ runs: 3, agentQualityFailures: 1 }),
    );
    expect(v.decision).toBe('insufficient_evidence');
  });
});

describe('the decision', () => {
  it('rolls back a redistill that clearly broke the agent', () => {
    const v = evaluateRedistillCanary(
      window({ runs: 200, agentQualityFailures: 10 }),   // 5%
      window({ runs: 60, agentQualityFailures: 45 }),    // 75%
    );
    expect(v.decision).toBe('rollback');
    expect(v.posteriorProbability).toBeGreaterThanOrEqual(0.99);
    expect(v.rationale).toContain('75.0%');
  });

  it('passes a redistill that changed nothing', () => {
    const v = evaluateRedistillCanary(
      window({ runs: 200, agentQualityFailures: 10 }),
      window({ runs: 100, agentQualityFailures: 5 }),
    );
    expect(v.decision).toBe('pass');
  });

  it('passes a redistill that improved the agent', () => {
    const v = evaluateRedistillCanary(
      window({ runs: 200, agentQualityFailures: 40 }),
      window({ runs: 100, agentQualityFailures: 2 }),
    );
    expect(v.decision).toBe('pass');
    expect(v.posteriorProbability).toBeLessThan(0.5);
  });

  it('does not roll back on a small rise that could be noise', () => {
    // 5% -> 8% over 50 runs is well inside binomial noise, and rolling back
    // here would teach operators to switch the gate off.
    const v = evaluateRedistillCanary(
      window({ runs: 200, agentQualityFailures: 10 }),
      window({ runs: 50, agentQualityFailures: 4 }),
    );
    expect(v.decision).toBe('pass');
  });

  it('counts escalations and rejections alongside failures', () => {
    // A redistill that stopped failing but started handing everything to a
    // human has not improved anything.
    const v = evaluateRedistillCanary(
      window({ runs: 200, agentQualityFailures: 10, escalations: 0, hitlRejections: 0 }),
      window({ runs: 60, agentQualityFailures: 0, escalations: 30, hitlRejections: 15 }),
    );
    expect(v.decision).toBe('rollback');
  });

  it('states what the bar cannot see', () => {
    const v = evaluateRedistillCanary(
      window({ runs: 200, agentQualityFailures: 10 }),
      window({ runs: 100, agentQualityFailures: 5 }),
    );
    expect(v.rationale).toMatch(/not subtle drift/);
  });
});

describe('configuration', () => {
  it('ships the stated defaults', () => {
    expect(DEFAULT_CANARY_CONFIG).toEqual({
      mdeMultiple: 3,
      posteriorThreshold: 0.99,
      minAfterRuns: 10,
    });
  });

  it('a lower threshold acts on weaker evidence', () => {
    const before = window({ runs: 200, agentQualityFailures: 10 });
    const after = window({ runs: 40, agentQualityFailures: 8 });
    const strict = evaluateRedistillCanary(before, after);
    const loose = evaluateRedistillCanary(before, after, {
      ...DEFAULT_CANARY_CONFIG,
      posteriorThreshold: 0.5,
      mdeMultiple: 1,
    });
    expect(strict.decision).toBe('pass');
    expect(loose.decision).toBe('rollback');
  });

  it('reports a probability in [0, 1] across the range', () => {
    for (const failures of [0, 1, 5, 25, 50]) {
      const v = evaluateRedistillCanary(
        window({ runs: 100, agentQualityFailures: 5 }),
        window({ runs: 50, agentQualityFailures: failures }),
      );
      expect(v.posteriorProbability).toBeGreaterThanOrEqual(0);
      expect(v.posteriorProbability).toBeLessThanOrEqual(1);
    }
  });
});
