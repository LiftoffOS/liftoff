// Fixture refresh-cadence gate.
//
// Composio + vendor APIs evolve silently. Without a forced re-capture
// cadence, the fixtures we record today drift away from what production
// receives in 6 months, the response-shape tests pass with stale data,
// and a real regression slips through.
//
// Rule: every fixture must have been touched within the last 120 days.
// CI fails on day 121 unless an operator runs capture-fixtures.ts (or
// `touch`es the file knowingly). The quarterly Slack alert (GHA workflow
// + Cloud Scheduler dispatcher) gives 30 days of warning before this
// gate trips.

import { loadAllFixtures } from './__lib__/load-fixtures';
import { DOC_SOURCED_CONNECTORS } from './__lib__/doc-sourced';

const MAX_FIXTURE_AGE_MS = 120 * 24 * 60 * 60 * 1000;

describe('fixture refresh-cadence gate', () => {
  const fixtures = loadAllFixtures();
  // Doc-sourced / captured native-HRIS fixtures have no live tenant to re-capture from, so they
  // are exempt from the live-recapture age gate (they are contract-gated on their tool's
  // responseSchema instead — see native-hris-actions.test.ts).
  const agedFixtures = fixtures.filter((f) => !DOC_SOURCED_CONNECTORS.has(f.connectorType));

  it('has at least one fixture (catches accidental directory deletion)', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(agedFixtures.map(f => [f.filePath.split('/__fixtures__/')[1] ?? f.filePath, f] as const))(
    '%s is younger than 120 days',
    (_label, fixture) => {
      const days = Math.floor(fixture.ageMs / (24 * 60 * 60 * 1000));
      if (fixture.ageMs > MAX_FIXTURE_AGE_MS) {
        throw new Error(
          `fixture ${fixture.filePath} is ${days} days old (max 120). ` +
          `Run src/contract-tests/response-shapes/__tools__/capture-fixtures.ts ` +
          `--action=${fixture.action} --connector=${fixture.connectorType} ` +
          `--tenant=<staging-tenant-uuid> to refresh.`,
        );
      }
      expect(days).toBeLessThanOrEqual(120);
    },
  );
});
