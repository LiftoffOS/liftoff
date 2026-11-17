// Regression test for the reconciler republish version-gate bypass.
//
// Pre-fix bug: reconciler emitted republish events with entity_version =
// pbAgent.currentVersion. For drift modes where event_versions on the runtime
// already stored that exact version (most notably missed_delete, where
// service.delete doesn't bump current_version), the runtime's strict-`>`
// version gate dropped the event. Drift could never be cleared.
//
// Post-fix:
//   - Reconciler sets envelope entity_version=null + payload.entityVersion=N
//   - Runtime gate at handleEvent line 282 skips when entity_version is null
//   - Handlers update cached_internal_agents.entity_version from
//     COALESCE(payload.entityVersion, event.entity_version, existing)
//
// This test simulates the runtime side: receive an envelope without
// entity_version (matching reconciler emit shape), confirm gate skips,
// confirm handler still updates the cache to the right version.

type QueryRecord = { sql: string; params?: unknown[] };
const queries: QueryRecord[] = [];
let responder: (sql: string, params: unknown[] | undefined) => { rows: unknown[]; rowCount?: number } = () => ({ rows: [] });

jest.mock('../../infrastructure/database', () => {
  const sharedPool = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return responder(sql, params);
    }),
    connect: jest.fn(async () => ({
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return responder(sql, params);
      }),
      release: jest.fn(),
    })),
  };
  return {
    subscriberPool: sharedPool,
    getPoolForService: () => sharedPool,
    withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: unknown) => Promise<unknown>) =>
      fn(sharedPool),
    ),
  };
});

jest.mock('../../infrastructure/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, log: logger };
});

// Mock downstream services the handler dispatches to so we can observe whether
// the handler was REACHED without booting their dependency graphs (DB pools
// other than subscriberPool, instruction compiler, lifecycle, etc.).
jest.mock('../../agent-lifecycle/service', () => {
  const svcInstance = {
    archive: jest.fn(),
    activate: jest.fn(),
    pause: jest.fn(),
    ensureSchedulerJob: jest.fn(),
  };
  return {
    AgentLifecycleService: jest.fn().mockImplementation(() => svcInstance),
    agentLifecycleService: svcInstance,
  };
});

// Points at internal-agent-instruction-service, which is where
// internalAgentInstructionService actually lives and what subscriber.ts
// imports. It named instruction-compiler/service, a module that never
// exported this symbol — so the mock bound nothing and the test was
// exercising the real service by accident. Deleting that dead module is what
// surfaced it.
jest.mock('../../instruction-compiler/internal-agent-instruction-service', () => ({
  internalAgentInstructionService: {
    createAndActivateForInternalAgent: jest.fn(async () => 'instruction-1'),
    updateAgentSkillsOnly: jest.fn(),
  },
}));

jest.mock('../../agent-execution/engine/workspace-reaper', () => ({
  reapStaleChatWorkspaces: jest.fn(),
}));

jest.mock('../../observability/scrub-logger', () => ({
  scrubLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../event-processor', () => {
  class DlqRoutedErrorCls extends Error {
    constructor(public eventId: string) { super(`Event ${eventId} routed to DLQ`); }
  }
  class EntityBusyErrorCls extends Error {
    constructor(public eventId: string, public entityId: string) { super('busy'); }
  }
  return {
    EventProcessor: jest.fn().mockImplementation(() => ({
      process: jest.fn(async (_event: unknown, steps: Array<{ execute: (ctx: { pool: unknown; metadata: Record<string, unknown> }) => Promise<void> }>) => {
        const ctx = {
          pool: (jest.requireMock('../../infrastructure/database') as { subscriberPool: unknown }).subscriberPool,
          metadata: {} as Record<string, unknown>,
        };
        for (const step of steps) {
          await step.execute(ctx);
        }
        return true;
      }),
    })),
    eventProcessor: { process: jest.fn(async (_event: unknown, steps: Array<{ execute: (ctx: { pool: unknown; metadata: Record<string, unknown> }) => Promise<void> }>) => {
      const ctx = {
        pool: (jest.requireMock('../../infrastructure/database') as { subscriberPool: unknown }).subscriberPool,
        metadata: {} as Record<string, unknown>,
      };
      for (const step of steps) {
        await step.execute(ctx);
      }
      return true;
    }) },
    DlqRoutedError: DlqRoutedErrorCls,
    EntityBusyError: EntityBusyErrorCls,
    MULTI_STEP_EVENT_TYPES: new Set(),
  };
});

import { dispatchEvent } from '../subscriber';

beforeEach(() => {
  queries.length = 0;
  responder = () => ({ rows: [] });
});

describe('reconciler republishes — version gate bypass via envelope entity_version=null', () => {
  it('REGRESSION: missed_delete republish (envelope omits entity_version) reaches handler even when event_versions = current_version', async () => {
    // Simulates: PB.internal_agents has deleted_at set at current_version=10.
    // event_versions in runtime stores the LAST processed event's version = 10
    // (e.g. from the prior `updated` event). With the old reconciler emit
    // (entity_version=10), gate would compare 10 > 10 → false → DROPPED →
    // missed_delete drift persists indefinitely.
    responder = (sql) => {
      if (/SELECT entity_version FROM event_versions/i.test(sql)) {
        return { rows: [{ entity_version: 10 }] };
      }
      // Stale-after-delete gate: cached_status NOT 'deleted' yet
      // (that's why we have missed_delete drift in the first place).
      if (/SELECT status FROM cached_internal_agents/i.test(sql)) {
        return { rows: [{ status: 'active' }] };
      }
      if (/SELECT agent_id FROM internal_agent_runtime_mapping/i.test(sql)) {
        return { rows: [{ agent_id: 'runtime-agent-1' }] };
      }
      return { rows: [], rowCount: 0 };
    };

    const reconcilerEmittedEnvelope = {
      event_id: 'evt-missed-delete-republish',
      event_type: 'tenant.internal_agent.deleted',
      entity_type: 'internal_agent',
      entity_id: 'agent-1',
      tenant_id: 'tenant-1',
      // entity_version INTENTIONALLY OMITTED — bypasses version gate.
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      event_version: 1,
      payload: { id: 'agent-1', entityVersion: 10, synthetic: true, reason: 'reconciler-missed-delete' },
    };

    await dispatchEvent(reconcilerEmittedEnvelope, 1, "test-sub");

    // Gate did NOT fire — no SELECT against event_versions at the top.
    const gateQuery = queries.find((q) =>
      /SELECT entity_version FROM event_versions/i.test(q.sql),
    );
    expect(gateQuery).toBeUndefined();

    // Handler reached: it looked up the mapping and ran the delete cache update.
    const mappingLookup = queries.find((q) =>
      /SELECT agent_id FROM internal_agent_runtime_mapping/i.test(q.sql),
    );
    expect(mappingLookup).toBeDefined();

    const cacheStatusUpdate = queries.find((q) =>
      /UPDATE cached_internal_agents SET status = 'deleted'/i.test(q.sql),
    );
    expect(cacheStatusUpdate).toBeDefined();
  });

  it('REGRESSION: stale_update republish reaches handler; cached entity_version is set to payload.entityVersion (not null)', async () => {
    responder = (sql) => {
      if (/SELECT entity_version FROM event_versions/i.test(sql)) {
        return { rows: [{ entity_version: 5 }] };
      }
      if (/SELECT status FROM cached_internal_agents/i.test(sql)) {
        return { rows: [{ status: 'active' }] };
      }
      // handleInternalAgentUpdated looks up mapping after the cache update.
      if (/SELECT agent_id FROM internal_agent_runtime_mapping/i.test(sql)) {
        return { rows: [{ agent_id: 'runtime-agent-1' }] };
      }
      return { rows: [], rowCount: 0 };
    };

    const reconcilerEnvelope = {
      event_id: 'evt-stale-update-republish',
      event_type: 'tenant.internal_agent.updated',
      entity_type: 'internal_agent',
      entity_id: 'agent-1',
      tenant_id: 'tenant-1',
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      event_version: 1,
      payload: {
        id: 'agent-1',
        role: 'reviewer',
        entityVersion: 7,
      },
    };

    await dispatchEvent(reconcilerEnvelope, 1, "test-sub");

    // The handler's UPDATE cached_internal_agents must have fired with
    // entity_version COALESCE'd to 7 (from payload), not null.
    const cacheUpdate = queries.find((q) =>
      /UPDATE cached_internal_agents SET .*entity_version = COALESCE\(\$\d+, entity_version\)/i.test(q.sql),
    );
    expect(cacheUpdate).toBeDefined();
    // Find which param maps to entity_version. The UPDATE statement uses
    // a positional param; locate it from the params array.
    expect(cacheUpdate!.params).toContain(7);
  });

  it('back-compat: live publisher with envelope entity_version (no payload.entityVersion) still writes the right version', async () => {
    responder = (sql) => {
      if (/SELECT entity_version FROM event_versions/i.test(sql)) {
        return { rows: [] };
      }
      if (/SELECT status FROM cached_internal_agents/i.test(sql)) {
        return { rows: [{ status: 'active' }] };
      }
      if (/SELECT agent_id FROM internal_agent_runtime_mapping/i.test(sql)) {
        return { rows: [{ agent_id: 'runtime-agent-1' }] };
      }
      return { rows: [], rowCount: 0 };
    };

    const liveEnvelope = {
      event_id: 'evt-live-updated',
      event_type: 'tenant.internal_agent.updated',
      entity_type: 'internal_agent',
      entity_id: 'agent-1',
      tenant_id: 'tenant-1',
      entity_version: 12,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
      event_version: 1,
      payload: { id: 'agent-1', role: 'reviewer' },
    };

    await dispatchEvent(liveEnvelope, 1, "test-sub");

    const cacheUpdate = queries.find((q) =>
      /UPDATE cached_internal_agents SET .*entity_version = COALESCE/i.test(q.sql),
    );
    expect(cacheUpdate).toBeDefined();
    expect(cacheUpdate!.params).toContain(12);
  });
});
