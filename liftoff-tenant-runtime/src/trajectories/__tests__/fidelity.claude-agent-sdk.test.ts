// Canonical fidelity for the `claude-agent-sdk` engine.
//
// Canned raw event stream in, EXACT canonical block list out. One file per
// engine so a mapper regression names the engine that broke. The same fixture
// is asserted by the `trajectory_fidelity` certification category, so this
// cannot be skipped into irrelevance.

import { fidelityFixtureFor, runFidelityFixture, fixtureReproduces } from '../fidelity-fixtures';

describe('trajectory fidelity — claude-agent-sdk', () => {
  const fixture = fidelityFixtureFor('claude-agent-sdk');

  it('has a fidelity fixture', () => {
    expect(fixture).toBeDefined();
  });

  it('maps the canned raw stream to the exact expected canonical messages', () => {
    const result = runFidelityFixture(fixture!);
    expect(result.messages).toEqual(fixture!.expected);
  });

  it('drops nothing replay-relevant beyond what the fixture declares', () => {
    const result = runFidelityFixture(fixture!);
    expect([...result.replayRelevantDrops].sort()).toEqual([...fixture!.expectedReplayRelevantDrops].sort());
  });

  it('reproduces under the certification checker', () => {
    const verdict = fixtureReproduces(fixture!);
    expect(verdict.detail ?? '').toBe('');
    expect(verdict.ok).toBe(true);
  });
});
