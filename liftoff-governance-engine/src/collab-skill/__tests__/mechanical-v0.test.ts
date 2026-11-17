import { mechanicalV0, matchPolarity } from '../updaters/mechanical-v0';
import { posteriorKey, type MatchRecord } from '../types';

function m(
  agentId: string,
  outcome: MatchRecord['outcome'],
  startedAt: string,
  terminalState?: MatchRecord['terminalState'],
): MatchRecord {
  return { tenantId: 't', sessionId: `${agentId}-${startedAt}`, agentId, humanId: null, backbone: 'anthropic:x', scope: 'global', y: null, outcome, terminalState, startedAt };
}

const keyFor = (agentId: string) => posteriorKey({ tenantId: 't', entityType: 'agent', entityId: agentId, scope: 'global' });

describe('mechanicalV0', () => {
  it('folds a running pass-rate mean with sigma = 1/sqrt(n)', () => {
    const out = mechanicalV0.update([
      m('a', 'success', '1'), m('a', 'error', '2'), m('a', 'success', '3'), m('a', 'success', '4'),
    ]);
    const p = out.get(posteriorKey({ tenantId: 't', entityType: 'agent', entityId: 'a', scope: 'global' }))!;
    expect(p.nObservations).toBe(4);
    expect(p.mu).toBeCloseTo(0.75); // 3 of 4 success
    expect(p.sigma).toBeCloseTo(0.5); // 1/sqrt(4)
    expect(p.lastMatchAt).toBe('4');
  });

  it('is deterministic and keeps agents separate', () => {
    const matches = [m('a', 'success', '1'), m('b', 'error', '2'), m('a', 'error', '3')];
    const first = mechanicalV0.update(matches);
    const second = mechanicalV0.update(matches);
    expect([...first.entries()]).toEqual([...second.entries()]);
    expect(first.get(posteriorKey({ tenantId: 't', entityType: 'agent', entityId: 'a', scope: 'global' }))!.mu).toBeCloseTo(0.5);
    expect(first.get(posteriorKey({ tenantId: 't', entityType: 'agent', entityId: 'b', scope: 'global' }))!.mu).toBe(0);
  });

  // 1.3b — polarity mirrors tenant-runtime's learningSignal(). A run the platform
  // stopped is not evidence the agent collaborates badly.
  it('does not score an escalated, gated or paused session as a failure', () => {
    const out = mechanicalV0.update([
      m('a', 'success', '1', 'success'),
      m('a', 'gated', '2', 'gated'),      // governance refused
      m('a', 'gated', '3', 'paused'),     // waiting on a person
      m('a', 'escalated', '4', 'escalated'),
    ]);
    const p = out.get(keyFor('a'))!;
    // Only the success is an observation. Under the old fold this read mu=0.25
    // over n=4: three marks against the agent for the platform's own decisions.
    expect(p.nObservations).toBe(1);
    expect(p.mu).toBe(1);
  });

  it('drops an entity entirely when every one of its matches carries no signal', () => {
    const out = mechanicalV0.update([m('a', 'gated', '1', 'paused'), m('a', 'escalated', '2', 'escalated')]);
    expect(out.get(keyFor('a'))).toBeUndefined();
    expect(out.size).toBe(0);
  });

  it('still counts real failures, and does not count a budget cut-off', () => {
    const out = mechanicalV0.update([
      m('a', 'success', '1', 'success'),
      m('a', 'error', '2', 'task_failed'),
      m('a', 'error', '3', 'engine_error'),
      m('a', 'error', '4', 'limit_reached'), // cut off, not misled — no signal
    ]);
    const p = out.get(keyFor('a'))!;
    expect(p.nObservations).toBe(3);
    expect(p.mu).toBeCloseTo(1 / 3);
  });

  it('a gated row now reaches the fold at all', () => {
    // The whole point of widening MatchRecord.outcome: before it, this value did
    // not exist in the consumer's type and the export never produced a row
    // carrying it.
    const out = mechanicalV0.update([m('a', 'success', '1'), m('a', 'gated', '2')]);
    expect(out.get(keyFor('a'))!.nObservations).toBe(1);
  });
});

describe('matchPolarity', () => {
  it('reads the terminal state when the row carries one', () => {
    expect(matchPolarity({ outcome: 'success', terminalState: 'success' })).toBe('positive');
    expect(matchPolarity({ outcome: 'error', terminalState: 'task_failed' })).toBe('negative');
    expect(matchPolarity({ outcome: 'error', terminalState: 'engine_error' })).toBe('negative');
    expect(matchPolarity({ outcome: 'error', terminalState: 'limit_reached' })).toBe('none');
    expect(matchPolarity({ outcome: 'gated', terminalState: 'gated' })).toBe('none');
    expect(matchPolarity({ outcome: 'gated', terminalState: 'paused' })).toBe('none');
    expect(matchPolarity({ outcome: 'escalated', terminalState: 'escalated' })).toBe('none');
    expect(matchPolarity({ outcome: 'success', terminalState: 'stopped' })).toBe('none');
  });

  it('falls back to the outcome for pre-v3 and backfilled rows', () => {
    // Exact for three of four: 'gated' projects only gated+paused, and
    // learningSignal scores both 'none'.
    expect(matchPolarity({ outcome: 'success', terminalState: null })).toBe('positive');
    expect(matchPolarity({ outcome: 'escalated', terminalState: null })).toBe('none');
    expect(matchPolarity({ outcome: 'gated', terminalState: undefined })).toBe('none');
    // The one imprecise case: 'error' also projects limit_reached.
    expect(matchPolarity({ outcome: 'error', terminalState: null })).toBe('negative');
  });
});
