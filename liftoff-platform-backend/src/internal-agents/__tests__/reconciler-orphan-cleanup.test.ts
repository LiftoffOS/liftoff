// Behavioral tests for the orphan_observations lifecycle (plan §6.2).
//
// Three regressions guarded:
//
//   1. Transient orphan (appears once, gone next pass) must NOT leave a stale
//      row that triggers a false synthetic delete when the same runtime_agent_id
//      reappears years later.
//   2. dryRun=true must NOT mutate orphan_observations — the CI integration
//      suite invokes the reconciler dry-run on every PR.
//   3. After a stable orphan is auto-tombstoned, the `republished` flag must
//      stop the reconciler from emitting the same synthetic delete on every
//      subsequent 5-min pass.

import type { PoolClient } from 'pg';

interface QueryRecord { sql: string; params?: unknown[] }
const queries: QueryRecord[] = [];

// Toggleable orphan_observations state. The test controls what the
// ON CONFLICT path returns so we can simulate fresh/stable/republished orphans.
interface FakeObservationRow { first_seen_at: Date; republished: boolean }
let observationRow: FakeObservationRow | null = null;

// Runtime returns a mapping for an internal_agent_id that PB doesn't know about.
const ORPHAN_INTERNAL_AGENT_ID = '00000000-0000-0000-0000-00000000ffff';
const ORPHAN_RUNTIME_AGENT_ID = 'aa000000-0000-0000-0000-00000000ffff';
const TENANT_ID = '00000000-0000-0000-0000-000000000001';
const RUNTIME_URL = 'https://agent-service.example';

jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: PoolClient) => Promise<unknown>) => {
    const client = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        // tenants list (joined with entitlements to filter out kill-switched)
        if (/FROM tenants t\s+JOIN entitlements e/i.test(sql)) {
          return { rows: [{ id: TENANT_ID, runtime_url: RUNTIME_URL }], rowCount: 1 };
        }
        // PB has NO agents (so the runtime mapping is an orphan)
        if (/SELECT \* FROM internal_agents WHERE tenant_id = \$1/i.test(sql)) {
          return { rows: [], rowCount: 0 };
        }
        // INSERT ... ON CONFLICT DO UPDATE … RETURNING first_seen_at, republished
        if (/INSERT INTO orphan_observations/i.test(sql)) {
          if (observationRow === null) {
            // First observation
            observationRow = { first_seen_at: new Date(), republished: false };
          }
          return { rows: [observationRow], rowCount: 1 };
        }
        if (/UPDATE orphan_observations SET republished/i.test(sql)) {
          if (observationRow) observationRow.republished = true;
          return { rows: [], rowCount: 1 };
        }
        if (/DELETE FROM orphan_observations/i.test(sql)) {
          // The cleanup query is `DELETE WHERE tenant_id = $1 AND runtime_agent_id <> ALL($2::uuid[])`
          // or, when no orphans observed, the unconditional `DELETE WHERE tenant_id = $1`.
          // Honor the exclusion list so the test mock matches production semantics.
          if (params && params.length === 2 && Array.isArray(params[1])) {
            const keepers = new Set(params[1] as string[]);
            if (observationRow && !keepers.has(ORPHAN_RUNTIME_AGENT_ID)) {
              observationRow = null;
            }
          } else {
            observationRow = null;
          }
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    };
    return fn(client as unknown as PoolClient);
  }),
}));

let listMappingsShouldFail = false;
jest.mock('../../infrastructure/oidc-fetch', () => ({
  fetchWithOidc: jest.fn(async (url: string) => {
    if (url.includes('/list-mappings')) {
      if (listMappingsShouldFail) {
        throw new Error('simulated network failure');
      }
      return {
        ok: true,
        json: async () => listMappingsResponse,
      } as Response;
    }
    // sync-state — no agents in PB so it shouldn't be called, but return safely.
    return { ok: true, json: async () => ({ hasMapping: false }) } as Response;
  }),
}));

jest.mock('../../infrastructure/monitoring', () => ({
  writeCustomMetric: jest.fn(async () => undefined),
}));

jest.mock('../outbox', () => ({
  enqueueInternalAgentOutbox: jest.fn(async () => ({
    outboxId: 'outbox-synthetic',
    eventId: 'event-synthetic',
    tenantId: TENANT_ID,
    internalAgentId: ORPHAN_INTERNAL_AGENT_ID,
    eventType: 'tenant.internal_agent.deleted',
    entityVersion: null,
    payload: {},
  })),
  publishOutboxRowInline: jest.fn(async () => ({ inlinePublished: true })),
}));

jest.mock('../../infrastructure/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, log: logger };
});

// Will be set per test to control the runtime's /list-mappings response.
let listMappingsResponse: Array<{ internalAgentId: string; runtimeAgentId: string }> = [];

import { runReconciliation } from '../reconciler';
import * as outbox from '../outbox';

beforeEach(() => {
  queries.length = 0;
  observationRow = null;
  listMappingsResponse = [];
  listMappingsShouldFail = false;
  (outbox.enqueueInternalAgentOutbox as jest.Mock).mockClear();
  (outbox.publishOutboxRowInline as jest.Mock).mockClear();
});

describe('orphan_observations cleanup (plan §6.2)', () => {
  it('deletes stale rows for orphans absent from the current pass', async () => {
    // Seed: an existing observation row (transient orphan from a prior pass).
    observationRow = { first_seen_at: new Date(Date.now() - 25 * 3600_000), republished: false };
    // Current runtime pass reports ZERO mappings — the orphan disappeared.
    listMappingsResponse = [];

    await runReconciliation({ dryRun: false });

    // The cleanup query must have deleted the stale row.
    const deleteQuery = queries.find((q) => /DELETE FROM orphan_observations/i.test(q.sql));
    expect(deleteQuery).toBeDefined();
    // No synthetic delete should have been published — the orphan is gone.
    expect(outbox.enqueueInternalAgentOutbox).not.toHaveBeenCalled();
  });

  it('REGRESSION: transient orphan that disappears then reappears does NOT trigger false synthetic delete', async () => {
    // Pass 1: orphan observed for the first time.
    listMappingsResponse = [
      { internalAgentId: ORPHAN_INTERNAL_AGENT_ID, runtimeAgentId: ORPHAN_RUNTIME_AGENT_ID },
    ];
    await runReconciliation({ dryRun: false });
    // First observation: row inserted, fresh first_seen_at, not stable yet.
    expect(observationRow).not.toBeNull();
    expect(observationRow!.republished).toBe(false);
    expect(outbox.enqueueInternalAgentOutbox).not.toHaveBeenCalled();

    // Pass 2: orphan disappears. Cleanup must remove the row.
    listMappingsResponse = [];
    await runReconciliation({ dryRun: false });
    expect(observationRow).toBeNull();

    // Pass 3: NEW orphan with the SAME runtime_agent_id reappears (e.g. operator
    // recreated the mapping). Before the fix, the stale row from pass 1 would
    // have caused first_seen_at to remain in the past — observation would have
    // been "stable" on first reappearance and a synthetic delete would fire.
    // With the cleanup, the orphan is observed fresh and is NOT stable.
    listMappingsResponse = [
      { internalAgentId: ORPHAN_INTERNAL_AGENT_ID, runtimeAgentId: ORPHAN_RUNTIME_AGENT_ID },
    ];
    await runReconciliation({ dryRun: false });
    expect(outbox.enqueueInternalAgentOutbox).not.toHaveBeenCalled();
  });
});

describe('orphan_observations dry-run isolation (plan §6.2)', () => {
  it('dryRun=true does NOT INSERT, UPDATE, or DELETE orphan_observations', async () => {
    listMappingsResponse = [
      { internalAgentId: ORPHAN_INTERNAL_AGENT_ID, runtimeAgentId: ORPHAN_RUNTIME_AGENT_ID },
    ];

    await runReconciliation({ dryRun: true });

    const mutatingSql = queries.filter((q) =>
      /INSERT INTO orphan_observations|UPDATE orphan_observations|DELETE FROM orphan_observations/i.test(q.sql),
    );
    expect(mutatingSql).toEqual([]);
    expect(outbox.enqueueInternalAgentOutbox).not.toHaveBeenCalled();
    expect(outbox.publishOutboxRowInline).not.toHaveBeenCalled();
  });
});

describe('orphan_observations safety against list-mappings failure', () => {
  it('REGRESSION: list-mappings fetch failure does NOT delete observation rows', async () => {
    // Seed: a real, stable observation we must preserve through a transient runtime outage.
    observationRow = { first_seen_at: new Date(Date.now() - 30 * 3600_000), republished: false };
    listMappingsShouldFail = true; // runtime briefly unavailable

    await runReconciliation({ dryRun: false });

    // Without listMappingsSucceeded gating, the empty current set would
    // unconditionally DELETE FROM orphan_observations and wipe the stable
    // observation we built up over the prior 30 hours. Assert the row is
    // still there.
    expect(observationRow).not.toBeNull();
    // No DELETE should have been issued either.
    const deleteIssued = queries.find((q) => /DELETE FROM orphan_observations/i.test(q.sql));
    expect(deleteIssued).toBeUndefined();
  });
});

describe('orphan_observations republished flag (plan §6.2)', () => {
  it('stable orphan: publishes synthetic delete ONCE, marks republished=true', async () => {
    // Pre-seed an observation that is already stable (>24h old, not yet republished).
    observationRow = { first_seen_at: new Date(Date.now() - 25 * 3600_000), republished: false };
    listMappingsResponse = [
      { internalAgentId: ORPHAN_INTERNAL_AGENT_ID, runtimeAgentId: ORPHAN_RUNTIME_AGENT_ID },
    ];

    await runReconciliation({ dryRun: false });

    expect(outbox.enqueueInternalAgentOutbox).toHaveBeenCalledTimes(1);
    expect(outbox.publishOutboxRowInline).toHaveBeenCalledTimes(1);
    // republished flag flipped
    expect(observationRow!.republished).toBe(true);
  });

  it('REGRESSION: stable orphan that already published does NOT re-emit on subsequent passes', async () => {
    // The observation was already marked republished by a prior pass. Mapping
    // is still in the runtime's list (cleanup hasn't propagated yet). Without
    // the alreadyRepublished gate, the reconciler would re-emit every 5 min.
    observationRow = { first_seen_at: new Date(Date.now() - 30 * 3600_000), republished: true };
    listMappingsResponse = [
      { internalAgentId: ORPHAN_INTERNAL_AGENT_ID, runtimeAgentId: ORPHAN_RUNTIME_AGENT_ID },
    ];

    await runReconciliation({ dryRun: false });

    expect(outbox.enqueueInternalAgentOutbox).not.toHaveBeenCalled();
    expect(outbox.publishOutboxRowInline).not.toHaveBeenCalled();
  });
});
