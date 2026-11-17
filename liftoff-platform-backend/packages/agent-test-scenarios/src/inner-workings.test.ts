import { NO_INNER_WORKINGS, withNoInnerWorkings } from './inner-workings.js';
import { CAIO_SCENARIOS } from './scenarios-caio.js';
import { INSIGHTS_SCENARIOS } from './scenarios-insights.js';

describe('NO_INNER_WORKINGS', () => {
  it('matches each thing the Chief AI Officer might say that a person must not read', () => {
    for (const leak of [
      'the paused "Support Triage" team (id 122662dd-de4e-4b0d-8873-50cd6a00daaf)',
      'I checked with github__list_pull_requests',
      'I will call team_update once you confirm',
      'a preview with a confirmation handle',
      'the note goes into the additional context field',
      'in the responsibilities text field',
      'This is preview-only, per the request.',
      'Let Alex know if he wants it applied.',
    ]) {
      expect(NO_INNER_WORKINGS.test(leak)).toBe(true);
    }
  });

  it('leaves ordinary product language alone', () => {
    for (const clean of [
      'The Support Triage team (paused, 48 tasks) ran the most in the last 30 days.',
      'Here is what would change. Say yes and I will apply it.',
      'Three agents and one connection are active. The Insights Manager can break down the cost.',
      'It will wait for your approval before posting.',
      'Total spend was $4,832 across 12 runs; the busiest day was Tuesday.',
    ]) {
      expect(NO_INNER_WORKINGS.test(clean)).toBe(false);
    }
  });
});

describe('withNoInnerWorkings', () => {
  it('is on every Chief AI Officer and Insights Manager scenario', () => {
    for (const scenario of [...CAIO_SCENARIOS, ...INSIGHTS_SCENARIOS]) {
      expect(scenario.forbidsTextMatching?.test('the team (id 122662dd-de4e-4b0d-8873-50cd6a00daaf)')).toBe(true);
    }
  });

  it('keeps a pattern a scenario already forbids, alongside', () => {
    const [scenario] = withNoInnerWorkings([{ id: 'x', description: 'x', prompt: 'x', forbidsTextMatching: /executable not found/ }]);
    expect(scenario.forbidsTextMatching!.test('executable not found')).toBe(true);
    expect(scenario.forbidsTextMatching!.test('call team_update')).toBe(true);
    expect(scenario.forbidsTextMatching!.test('all good')).toBe(false);
  });
});
