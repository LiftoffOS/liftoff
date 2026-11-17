// The reconciler attributes an Apify run to the executor call that made it.
//
// The executor's evidence row moved from (connector_registry, apify:run_actor)
// to (apify_store, <actorId>) so the ranking could find it; a reconciler that
// read only the old key would then hide every new actor run from cost
// reconciliation. These pin that BOTH keys are read, that the run id in the
// row's note is matched exactly before any time window, and that two runs
// close in time — two actors, two tenants — never take each other's row.

const queryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  initDatabase: jest.fn(),
  closePools: jest.fn(),
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (client: { query: jest.Mock }) => Promise<unknown>) =>
    fn({ query: queryMock })),
}));
jest.mock('../../cost-attribution/repository', () => ({
  ingestEventWithBuckets: jest.fn(),
  resolveAccountIdForTenant: jest.fn(),
}));
jest.mock('../../billing/apify-prepaid-token-service', () => ({
  listApifyPrepaidTokensForReads: jest.fn(async () => []),
}));

import {
  evidenceForRun,
  loadExecutorEvidence,
  LEGACY_EVIDENCE_KEY,
  STORE_EVIDENCE_SOURCE,
  type EvidenceRow,
} from '../apify-cost-trueup';

const T = (iso: string) => new Date(iso);

function row(overrides: Partial<EvidenceRow>): EvidenceRow {
  return {
    source: STORE_EVIDENCE_SOURCE,
    source_ref: 'someone/reddit-scraper',
    tenant_id: 'tenant-a',
    created_at: T('2026-09-18T10:00:05Z'),
    latency_ms: 5000,
    cost_usd: '0.0305',
    output_note: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('loading the executor evidence', () => {
  it('reads rows under the legacy key AND the actor key', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await loadExecutorEvidence(T('2026-09-16T00:00:00Z'));
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/source = \$2 AND source_ref = \$3/);
    expect(sql).toMatch(/OR source = \$4/);
    expect(sql).toMatch(/SELECT source, source_ref, tenant_id/);
    expect(params).toEqual([
      T('2026-09-16T00:00:00Z'),
      LEGACY_EVIDENCE_KEY.source,
      LEGACY_EVIDENCE_KEY.sourceRef,
      STORE_EVIDENCE_SOURCE,
    ]);
    expect(LEGACY_EVIDENCE_KEY).toEqual({ source: 'connector_registry', sourceRef: 'apify:run_actor' });
    expect(STORE_EVIDENCE_SOURCE).toBe('apify_store');
  });
});

describe('matching a run to its evidence', () => {
  const finished = '2026-09-18T10:00:00Z';

  it('a new-key run (actor id, run id in the note) matches exactly, whatever else is in the window', () => {
    const mine = row({ output_note: 'ok apify:run:RUN-1' });
    const neighbour = row({ source_ref: 'other/actor', tenant_id: 'tenant-b', output_note: 'ok apify:run:RUN-2' });
    const legacyNoId = row({ source: 'connector_registry', source_ref: 'apify:run_actor', output_note: 'ok' });
    const out = evidenceForRun({ id: 'RUN-1', finishedAt: finished }, [neighbour, legacyNoId, mine]);
    expect(out).toEqual({ kind: 'exact', rows: [mine] });
  });

  it('a legacy run (old key, run id in the note) matches exactly under the old key', () => {
    const legacyKeyed = row({
      source: 'connector_registry', source_ref: 'apify:run_actor', output_note: 'vendor failure apify:run:RUN-9',
    });
    const out = evidenceForRun({ id: 'RUN-9', finishedAt: finished }, [row({ output_note: 'ok apify:run:RUN-1' }), legacyKeyed]);
    expect(out).toEqual({ kind: 'exact', rows: [legacyKeyed] });
  });

  it('a pre-run-id legacy row is matched by the time window, and never a row that names another run', () => {
    const inWindow = row({ source: 'connector_registry', source_ref: 'apify:run_actor', output_note: 'ok', created_at: T('2026-09-18T10:00:06Z') });
    const outOfWindow = row({ source: 'connector_registry', source_ref: 'apify:run_actor', output_note: 'ok', created_at: T('2026-09-18T10:00:20Z') });
    const keyedElsewhere = row({ output_note: 'ok apify:run:RUN-2', created_at: T('2026-09-18T10:00:01Z') });
    const out = evidenceForRun({ id: 'RUN-1', finishedAt: finished }, [inWindow, outOfWindow, keyedElsewhere]);
    expect(out).toEqual({ kind: 'window', rows: [inWindow] });
  });

  it('two actors run for two tenants seconds apart each keep their own row', () => {
    const a = row({ source_ref: 'one/actor', tenant_id: 'tenant-a', output_note: 'ok apify:run:RUN-A', created_at: T('2026-09-18T10:00:03Z') });
    const b = row({ source_ref: 'two/actor', tenant_id: 'tenant-b', output_note: 'ok apify:run:RUN-B', created_at: T('2026-09-18T10:00:04Z') });
    expect(evidenceForRun({ id: 'RUN-A', finishedAt: finished }, [a, b]).rows).toEqual([a]);
    expect(evidenceForRun({ id: 'RUN-B', finishedAt: finished }, [a, b]).rows).toEqual([b]);
    // The same actor for two tenants, likewise: the run id decides, not the actor.
    const c = row({ source_ref: 'one/actor', tenant_id: 'tenant-c', output_note: 'ok apify:run:RUN-C', created_at: T('2026-09-18T10:00:03Z') });
    expect(evidenceForRun({ id: 'RUN-A', finishedAt: finished }, [a, c]).rows).toEqual([a]);
    expect(evidenceForRun({ id: 'RUN-C', finishedAt: finished }, [a, c]).rows).toEqual([c]);
  });

  it('two pre-run-id rows in one window are both returned, for the caller to report as ambiguous', () => {
    const x = row({ source: 'connector_registry', source_ref: 'apify:run_actor', output_note: 'ok', created_at: T('2026-09-18T10:00:02Z') });
    const y = row({ source: 'connector_registry', source_ref: 'apify:run_actor', output_note: 'ok', tenant_id: 'tenant-b', created_at: T('2026-09-18T10:00:04Z') });
    expect(evidenceForRun({ id: 'RUN-1', finishedAt: finished }, [x, y])).toEqual({ kind: 'window', rows: [x, y] });
  });

  it('a run nothing here recorded matches nothing', () => {
    expect(evidenceForRun({ id: 'RUN-Z', finishedAt: finished }, [row({ output_note: 'ok apify:run:RUN-1' })]).rows).toEqual([]);
  });
});
