// Test that handleInternalAgentSkillsUpdated translates the payload's
// platform-backend internal_agent_id to the runtime agent_id via the
// internal_agent_runtime_mapping table before invoking
// updateAgentSkillsOnly.
//
// Without this mapping lookup, updateAgentSkillsOnly silently no-ops with
// "no active instruction" because compiled_instructions.agent_id references
// the runtime agents.id, not the platform-backend internal_agent_id.

import { jest } from '@jest/globals';

type Row = Record<string, unknown>;
const subscriberQueryMock = jest.fn();
const updateAgentSkillsOnlyMock = jest.fn();
const warnMock = jest.fn();

jest.mock('../../infrastructure/database', () => {
  const sharedPool = { query: subscriberQueryMock };
  return {
    subscriberPool: sharedPool,
    pool: sharedPool,
    getPoolForService: () => sharedPool,
    withAdminScope: jest.fn(),
  };
});

jest.mock('../../instruction-compiler/internal-agent-instruction-service', () => ({
  internalAgentInstructionService: {
    updateAgentSkillsOnly: updateAgentSkillsOnlyMock,
  },
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: warnMock, error: jest.fn() },
  setTraceContext: jest.fn(),
  clearTraceContext: jest.fn(),
}));

// Pull the dispatcher entry point via require so the mocks above bind first.
// We don't import the named export `handleInternalAgentSkillsUpdated` because
// it's not exported; instead we drive it via processValidatedEvent which is.
// Easier: import the file and invoke its exported subscriberInternals.handleEvent.
const subscriberMod = require('../subscriber');

const PB_AGENT_ID = '11111111-1111-1111-1111-111111111111';
const RUNTIME_AGENT_ID = '22222222-2222-2222-2222-222222222222';
const TENANT_ID = '33333333-3333-3333-3333-333333333333';

afterEach(() => {
  jest.clearAllMocks();
});

function skillsUpdatedEvent() {
  return {
    event_id: 'evt-1',
    event_type: 'tenant.internal_agent.skills_updated',
    entity_type: 'internal_agent',
    entity_id: PB_AGENT_ID,
    entity_version: null,
    tenant_id: TENANT_ID,
    payload: {
      agentId: PB_AGENT_ID,
      skills: [{ name: 'S', description: 'd', instruction: 'i' }],
      updatedAt: '2026-06-09T20:00:00Z',
      source: 'backfill:test',
    },
  };
}

function setSubscriberResponses(opts: { mappingFound: boolean }): void {
  subscriberQueryMock.mockImplementation(async (sql: string) => {
    if (typeof sql !== 'string') return { rows: [] };

    // Stale-after-delete gate consults cached_internal_agents; return 'active'
    // so the event isn't dropped by the gate.
    if (sql.includes('SELECT status FROM cached_internal_agents')) {
      return { rows: [{ status: 'active' }] };
    }

    // event_versions / processed_versions writes — no-op.
    if (sql.includes('event_versions') || sql.includes('processed')) {
      return { rows: [] };
    }

    // The mapping lookup we care about.
    if (sql.includes('FROM internal_agent_runtime_mapping')) {
      return opts.mappingFound ? { rows: [{ agent_id: RUNTIME_AGENT_ID }] } : { rows: [] };
    }

    return { rows: [] };
  });
}

describe('handleInternalAgentSkillsUpdated mapping lookup', () => {
  it('calls updateAgentSkillsOnly with the RUNTIME agent_id, not the platform-backend internal_agent_id', async () => {
    setSubscriberResponses({ mappingFound: true });

    await subscriberMod.subscriberInternals.handleEvent(skillsUpdatedEvent());

    expect(updateAgentSkillsOnlyMock).toHaveBeenCalledTimes(1);
    const arg = updateAgentSkillsOnlyMock.mock.calls[0][0] as { agentId: string; tenantId: string };
    expect(arg.agentId).toBe(RUNTIME_AGENT_ID);
    expect(arg.tenantId).toBe(TENANT_ID);
  });

  it('skips updateAgentSkillsOnly when no internal_agent_runtime_mapping row exists', async () => {
    setSubscriberResponses({ mappingFound: false });

    await subscriberMod.subscriberInternals.handleEvent(skillsUpdatedEvent());

    expect(updateAgentSkillsOnlyMock).not.toHaveBeenCalled();
    // Surfaces an operator-visible warning so the silent-no-op failure mode is
    // distinguishable from "the agent legitimately has no skills."
    const warnCalls = warnMock.mock.calls.map(c => JSON.stringify(c));
    expect(warnCalls.some(s => s.includes('no internal_agent_runtime_mapping'))).toBe(true);
  });
});
