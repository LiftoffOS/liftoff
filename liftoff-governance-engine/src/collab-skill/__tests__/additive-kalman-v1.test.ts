import {
  additiveKalmanV1,
  skipReason,
  OBS_SIGMA,
  PRIOR_MU,
  PRIOR_SIGMA,
} from '../updaters/additive-kalman-v1';
import { posteriorKey, type MatchRecord } from '../types';

function m(over: Partial<MatchRecord> = {}): MatchRecord {
  return {
    tenantId: 't',
    sessionId: 's1',
    agentId: 'a',
    humanId: 'h',
    backbone: 'anthropic:x',
    scope: 'global',
    y: 80,
    outcome: 'success',
    terminalState: 'success',
    startedAt: '1',
    ...over,
  };
}

const agentKey = (id = 'a') => posteriorKey({ tenantId: 't', entityType: 'agent', entityId: id, scope: 'global' });
const humanKey = (id = 'h') => posteriorKey({ tenantId: 't', entityType: 'human', entityId: id, scope: 'global' });

describe('additiveKalmanV1', () => {
  it('emits a posterior for the operator as well as the agent', () => {
    const out = additiveKalmanV1.update([m()]);
    expect(out.get(agentKey())).toBeDefined();
    expect(out.get(humanKey())).toBeDefined();
  });

  it('splits the first observation evenly when both sides are equally uncertain', () => {
    const out = additiveKalmanV1.update([m({ y: 80 })]);
    // Both start at the same prior, so both gains are equal and each takes half
    // the residual. K = v / (2v + b^2) with v = 625, b = 15: 625/1475.
    const expected = PRIOR_MU + (625 / (2 * 625 + OBS_SIGMA * OBS_SIGMA)) * (80 - 2 * PRIOR_MU);
    expect(out.get(agentKey())!.mu).toBeCloseTo(expected, 6);
    expect(out.get(humanKey())!.mu).toBeCloseTo(expected, 6);
  });

  it('moves the less certain side further', () => {
    // The agent appears twice, so by the third match it is more certain than a
    // first-time operator and should absorb less of the residual.
    const out = additiveKalmanV1.update([
      m({ sessionId: 's1', humanId: 'h1', startedAt: '1' }),
      m({ sessionId: 's2', humanId: 'h2', startedAt: '2' }),
      m({ sessionId: 's3', humanId: 'h3', startedAt: '3' }),
    ]);
    const agent = out.get(agentKey())!;
    const freshOperator = out.get(humanKey('h3'))!;
    expect(agent.sigma).toBeLessThan(freshOperator.sigma);
  });

  it('reduces sigma with each observation and never below zero', () => {
    const out = additiveKalmanV1.update([
      m({ sessionId: 's1', startedAt: '1' }),
      m({ sessionId: 's2', startedAt: '2' }),
      m({ sessionId: 's3', startedAt: '3' }),
    ]);
    const p = out.get(agentKey())!;
    expect(p.sigma).toBeLessThan(PRIOR_SIGMA);
    expect(p.sigma).toBeGreaterThan(0);
    expect(p.nObservations).toBe(3);
    expect(p.lastMatchAt).toBe('3');
  });

  it('handles an unattended run as a single-party update', () => {
    const out = additiveKalmanV1.update([m({ humanId: null })]);
    expect(out.get(humanKey())).toBeUndefined();
    const agent = out.get(agentKey())!;
    // Sole participant, so it absorbs the whole gain: K = v / (v + b^2).
    const expected = PRIOR_MU + (625 / (625 + OBS_SIGMA * OBS_SIGMA)) * (80 - PRIOR_MU);
    expect(agent.mu).toBeCloseTo(expected, 6);
  });

  it('skips a match with no grade, since the model observes the grade', () => {
    expect(skipReason(m({ y: null }))).toBe('no_grade');
    expect(additiveKalmanV1.update([m({ y: null })]).size).toBe(0);
  });

  it('skips a run that carries no collaboration signal', () => {
    // gated and paused runs stopped for reasons that say nothing about the pair,
    // matching the rule mechanical-v0 owns.
    expect(skipReason(m({ outcome: 'gated', terminalState: 'gated' }))).toBe('no_signal');
    expect(skipReason(m({ outcome: 'escalated', terminalState: 'escalated' }))).toBe('no_signal');
    expect(additiveKalmanV1.update([m({ outcome: 'gated', terminalState: 'gated' })]).size).toBe(0);
  });

  it('folds a graded failure as evidence, unlike a governance stop', () => {
    expect(skipReason(m({ outcome: 'error', terminalState: 'task_failed', y: 10 }))).toBeNull();
  });

  it('is a pure fold: the same input yields the same output', () => {
    const input = [m({ sessionId: 's1', startedAt: '1' }), m({ sessionId: 's2', startedAt: '2' })];
    const a = additiveKalmanV1.update(input);
    const b = additiveKalmanV1.update(input);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('keeps the two sides summing toward the observed grade', () => {
    // With repeated observations of the same pair at the same grade, the two
    // posteriors should approach a split that predicts it.
    const matches = Array.from({ length: 40 }, (_, i) =>
      m({ sessionId: `s${i}`, startedAt: String(i + 1), y: 70 }),
    );
    const out = additiveKalmanV1.update(matches);
    const sum = out.get(agentKey())!.mu + out.get(humanKey())!.mu;
    expect(sum).toBeGreaterThan(60);
    expect(sum).toBeLessThan(80);
  });
});
