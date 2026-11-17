// Behavioral test for the runtime_config_updated handler + version-gate
// bypass (fix D in the second re-verification round).
//
// Pre-fix behavior: the platform-backend service emitted runtime_config_updated
// with envelope entity_version = N (same as the primary `updated` event). The
// version gate at handleEvent stored N after processing the first of the two
// events; the second was dropped because checkVersion uses strict >.
// Consequence: agent_type, hitl_level, model_config, exec_config, memory_scope,
// workflow_steps_hash silently failed to update on the runtime.
//
// Post-fix behavior:
//   1. envelope entity_version IS null for runtime_config_updated
//   2. handleEvent skips checkVersion (the `if (event.entity_version != null)` gate)
//   3. handleEvent skips updateProcessedVersion (same gate)
//   4. handleInternalAgentRuntimeConfigUpdated reads payload.entityVersion and
//      writes it to agents.entity_version via COALESCE
//
// This test exercises ALL FOUR invariants against the real dispatchEvent.

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

import { dispatchEvent } from '../subscriber';

const baseEnvelope = {
  event_id: 'evt-rc-1',
  event_type: 'tenant.internal_agent.runtime_config_updated',
  entity_type: 'internal_agent',
  entity_id: 'agent-1',
  tenant_id: 'tenant-1',
  occurred_at: new Date().toISOString(),
  schema_version: 1,
  event_version: 1,
};

beforeEach(() => {
  queries.length = 0;
  responder = () => ({ rows: [] });
});

describe('runtime_config_updated — version-gate bypass + payload.entityVersion', () => {
  it('REGRESSION: envelope entity_version=null SKIPS the version gate even when stored version exists', async () => {
    // Storage already has version=10 (e.g. a prior `updated` event landed first).
    // With the old code, envelope.entity_version=10 would equal stored=10 →
    // strict > returns false → DROPPED. With the fix, envelope.entity_version=null
    // means the gate at handleEvent line 282 is skipped entirely.
    responder = (sql) => {
      if (/SELECT entity_version FROM event_versions/i.test(sql)) {
        return { rows: [{ entity_version: 10 }] };
      }
      if (/SELECT status FROM cached_internal_agents/i.test(sql)) {
        return { rows: [{ status: 'active' }] };
      }
      return { rows: [] };
    };

    const envelope = {
      ...baseEnvelope,
      // entity_version intentionally OMITTED — matches publishEventWithExplicitId
      // which drops the field when input.entityVersion === null (publisher.ts:186) // explicit bypass
      payload: {
        entityVersion: 11,
        agentType: 'agent',
        modelConfig: { tier: 'medium' },
        execConfig: {},
        memoryScope: {},
      },
    };
    await dispatchEvent(envelope, 1, "test-sub");

    // The handler's UPDATE on agents MUST have fired (gate didn't drop us).
    const agentUpdate = queries.find((q) => /UPDATE agents SET/i.test(q.sql));
    expect(agentUpdate).toBeDefined();

    // The SELECT entity_version gate query MUST NOT have fired — entity_version=null
    // short-circuits at handleEvent line 282.
    const versionGateQuery = queries.find((q) => /SELECT entity_version FROM event_versions/i.test(q.sql));
    expect(versionGateQuery).toBeUndefined();
  });

  it('handler reads entityVersion from PAYLOAD and writes it to agents.entity_version', async () => {
    responder = (sql) => {
      if (/SELECT status FROM cached_internal_agents/i.test(sql)) {
        return { rows: [{ status: 'active' }] };
      }
      return { rows: [] };
    };

    const envelope = {
      ...baseEnvelope,
      // entity_version intentionally OMITTED — matches publishEventWithExplicitId
      // which drops the field when input.entityVersion === null (publisher.ts:186)
      payload: {
        entityVersion: 42,
        agentType: 'workflow' as const,
        hitlLevel: 3,
        modelConfig: { tier: 'medium' },
        execConfig: { timeoutMs: 5000 },
        memoryScope: { readableLayers: ['individual'] },
      },
    };
    await dispatchEvent(envelope, 1, "test-sub");

    const agentUpdate = queries.find((q) => /UPDATE agents SET/i.test(q.sql));
    expect(agentUpdate).toBeDefined();
    // Param 8 is the effectiveEntityVersion. Must be 42 (from payload), not null.
    expect(agentUpdate!.params![7]).toBe(42);
    // Param 3 is agentType. Must be 'workflow'.
    expect(agentUpdate!.params![2]).toBe('workflow');
  });

  it('null envelope entity_version does NOT bump event_versions (no updateProcessedVersion)', async () => {
    responder = (sql) => {
      if (/SELECT status FROM cached_internal_agents/i.test(sql)) {
        return { rows: [{ status: 'active' }] };
      }
      return { rows: [] };
    };

    const envelope = {
      ...baseEnvelope,
      // entity_version intentionally OMITTED — matches publishEventWithExplicitId
      // which drops the field when input.entityVersion === null (publisher.ts:186)
      payload: {
        entityVersion: 5,
        agentType: 'agent' as const,
        modelConfig: {},
        execConfig: {},
        memoryScope: {},
      },
    };
    await dispatchEvent(envelope, 1, "test-sub");

    // updateProcessedVersion writes to event_versions via INSERT ... ON CONFLICT.
    // With envelope.entity_version=null, that branch is skipped at handleEvent line 421.
    const eventVersionsWrite = queries.find((q) =>
      /INSERT INTO event_versions|UPDATE event_versions/i.test(q.sql),
    );
    expect(eventVersionsWrite).toBeUndefined();
  });

  it('back-compat: legacy publisher with envelope entity_version (and no payload.entityVersion) still works', async () => {
    // Older versions of platform-backend may still emit envelope.entity_version
    // until they redeploy. Handler must keep working with the legacy shape.
    responder = (sql) => {
      if (/SELECT entity_version FROM event_versions/i.test(sql)) {
        return { rows: [] }; // first event
      }
      if (/SELECT status FROM cached_internal_agents/i.test(sql)) {
        return { rows: [{ status: 'active' }] };
      }
      return { rows: [] };
    };
    const envelope = {
      ...baseEnvelope,
      entity_version: 7,
      payload: {
        agentType: 'agent' as const,
        modelConfig: {},
        execConfig: {},
        memoryScope: {},
      },
    };
    await dispatchEvent(envelope, 1, "test-sub");

    const agentUpdate = queries.find((q) => /UPDATE agents SET/i.test(q.sql));
    expect(agentUpdate).toBeDefined();
    // Legacy: falls back to event.entity_version
    expect(agentUpdate!.params![7]).toBe(7);
  });
});
