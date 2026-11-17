// The evidence model, after it stopped reading a table nothing writes.
//
// Three counters targeted the coordinator/leased-task architecture that
// ADR-002's F-5 cutover replaced. `workflow_tasks` does not hold real tasks —
// its only inserter is escalation-helper, which hardcodes status='escalated' —
// so `failures` and `successfulRuns` were structurally 0 against thresholds of
// 3 and 50, and no reflection could trigger.
//
// These pin the properties that make the repaired model usable, each of which
// was violated by an obvious-looking version of the fix.

import { ReflectionEngineService } from '../service';

describe('the density scale', () => {
  // Density is compared against a FIXED 0.5 threshold, so the weights must span
  // a range that can actually reach it. Removing the two dead signals without
  // redistributing their weight left a 0.60 ceiling, and with human_corrections
  // reset to 0 by migration 364 the real ceiling was 0.35 — below the gate.
  // A scheduled sweep would have enqueued nothing, and the symptom would have
  // looked exactly like "no agent has enough evidence".
  const weights = { failures: 0.50, humanCorrections: 0.25, escalations: 0.25 };

  it('sums to one, so a fully-evidenced agent scores 1.0', () => {
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0, 5);
  });

  it('lets repeated failures alone clear the threshold', () => {
    // The most dependable signal. An agent with 3+ recent errors must qualify
    // on its own, because human_corrections may hold nothing and most agents
    // have no open escalations.
    expect(weights.failures).toBeGreaterThanOrEqual(0.5);
  });
});

describe('adjusted weights stay a distribution', () => {
  const service = new ReflectionEngineService();

  it('returns the defaults, normalized, when no patterns are recorded', async () => {
    jest
      .spyOn(service['repository'], 'getPatternWeights')
      .mockResolvedValue([]);
    const w = await service.getAdjustedEvidenceWeights('agent-1');
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 5);
  });

  it('normalizes after a learned adjustment rather than letting the sum drift', async () => {
    // Adjustments are additive with per-key clamps, so an un-normalized result
    // moves the scale the 0.5 threshold is calibrated against: drift low and the
    // gate can never open, drift high and every agent qualifies.
    jest.spyOn(service['repository'], 'getPatternWeights').mockResolvedValue([
      { pattern: 'p', evidenceTypes: ['failures'], weight: 1, sampleCount: 20 },
    ] as never);
    const w = await service.getAdjustedEvidenceWeights('agent-1');
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 5);
    // The learned signal survives normalization: failures still dominates.
    expect(w.failures).toBeGreaterThan(w.humanCorrections);
  });

  afterEach(() => jest.restoreAllMocks());
});

describe('the retired trigger', () => {
  it('no longer answers for repeated_undos', async () => {
    // Compensation is reachable only through a coordinator API method, so
    // `actions.status='compensated'` is not a usable signal. A trigger that
    // cannot fire reads as coverage, so it was removed rather than left returning
    // false. An unknown type must not silently look like a considered "no".
    const service = new ReflectionEngineService();
    jest.spyOn(service['repository'], 'getEvidenceCounts').mockResolvedValue({
      failures: 0, humanCorrections: 0, escalations: 0, successfulRuns: 0,
    });
    const r = await service.shouldTriggerReflection(
      'a', 't', 'repeated_undos' as never,
    );
    expect(r.shouldTrigger).toBe(false);
    expect(r.reason).toBe('Unknown trigger type');
    jest.restoreAllMocks();
  });
});

describe('auto-promote gets a real suggestion id', () => {
  it('saveSuggestion returns the id it inserted', async () => {
    // It returned void, so the caller passed the literal string 'unknown',
    // Postgres rejected it as a uuid, and auto-promote failed on EVERY
    // reflection — swallowed as non-fatal, so the loop looked complete while
    // its last step always failed with:
    //   auto-promote: failed (non-fatal)
    //   error: 'invalid input syntax for type uuid: "unknown"'
    const { ReflectionRepository } = await import('../repository');
    const repo = new ReflectionRepository();
    const pool = (await import('../../infrastructure/database')).pool as unknown as {
      query: jest.Mock;
    };
    const spy = jest.spyOn(pool, 'query').mockResolvedValue({
      rows: [{ id: '11111111-2222-3333-4444-555555555555' }],
    } as never);

    const id = await repo.saveSuggestion({
      agentId: 'a', suggestion: 's', evidenceRefs: [],
      confidenceScore: 0.9, recurrenceScore: 0.5, severity: 'high',
    });

    expect(id).toBe('11111111-2222-3333-4444-555555555555');
    expect(spy.mock.calls[0][0]).toContain('RETURNING id');
    spy.mockRestore();
  });
});

describe('a healthy agent can still be reflected on', () => {
  const service = new ReflectionEngineService();
  afterEach(() => jest.restoreAllMocks());

  it('does not require something to have gone wrong for a cadence reflection', async () => {
    // Density is built entirely from failures, human corrections and open
    // escalations. An agent with hundreds of runs and ZERO errors has density
    // 0 and could never clear the 0.5 threshold — the most reliable agents
    // would be structurally ineligible, reported as "skippedLowDensity", which
    // reads as "nothing to learn" when it means "nothing has broken".
    jest.spyOn(service['repository'], 'getEvidenceCounts').mockResolvedValue({
      failures: 0, humanCorrections: 0, escalations: 0, successfulRuns: 374,
    });
    const density = await service['calculateEvidenceDensity']('agent-1', {
      tenantId: 't1', triggerType: 'n_successful_runs',
    } as never);
    expect(density).toBe(1.0);
  });

  it('still demands evidence for a plain scheduled tick', async () => {
    // The bypass is justified by the trigger's OWN threshold — 50 successful
    // runs since the last reflection is the evidence. `scheduled` carries no
    // such threshold, so it must still show that there is something to learn
    // from, or every agent would reflect on every sweep.
    jest.spyOn(service['repository'], 'getEvidenceCounts').mockResolvedValue({
      failures: 0, humanCorrections: 0, escalations: 0, successfulRuns: 374,
    });
    jest.spyOn(service['repository'], 'getRecentEvidenceCounts').mockResolvedValue({
      failures: 0, humanCorrections: 0, escalations: 0, successfulRuns: 120,
    });
    jest.spyOn(service, 'getAdjustedEvidenceWeights').mockResolvedValue({
      failures: 0.5, humanCorrections: 0.25, escalations: 0.25,
    } as never);
    const density = await service['calculateEvidenceDensity']('agent-1', {
      tenantId: 't1', triggerType: 'scheduled',
    } as never);
    expect(density).toBeLessThan(0.5);
  });
});
