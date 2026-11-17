// Tests for buildInternalAgentEventPayload — Phase 1 ensures pinnedKnowledgeIds
// is included on every created/updated event so tenant-runtime can populate
// StandardToolContext.pinnedKnowledgeIds.

jest.mock('../effective-instructions-md', () => ({
  buildEffectiveInstructionsMd: jest.fn(async () => 'effective-md'),
}));
jest.mock('../integration-enrichment', () => ({
  enrichIntegrationsWithType: jest.fn(async (_t: string, i: unknown) => i),
}));

import type { InternalAgent } from '../types';
import { buildInternalAgentEventPayload } from '../event-payload';

function makeAgent(overrides: Partial<InternalAgent> = {}): InternalAgent {
  return {
    id: 'a1',
    tenantId: 't1',
    role: 'role',
    responsibilities: null,
    integrations: [],
    pendingIntegrations: [],
    additionalContext: null,
    summary: null,
    systemPrompt: null,
    userInstructions: null,
    instructionsMd: null,
    instructions: null,
    temperature: 0.3,
    status: 'draft',
    currentVersion: 1,
    tasksCompleted: 0,
    tasks30d: 0,
    monthlyCost: 0,
    lastActive: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    agentType: 'agent',
    modelConfig: {},
    memoryScope: {},
    execConfig: {},
    workflowSteps: null,
    triggerConfig: null,
    delegates: [],
    workforcePlanId: null,
    pinnedKnowledgeIds: [],
    reviewedAt: null,
    reviewedBy: null,
    workflowStepsHash: null,
    messagingNickname: null,
    lastActivity: null,
    lastActivityAction: null,
    workflowVisualizationSteps: null,
    autonomyOverride: null,
    skills: [],
    capabilityTier: 'connector_only',
    ...overrides,
  };
}

describe('buildInternalAgentEventPayload', () => {
  it('includes pinnedKnowledgeIds on created event', async () => {
    const agent = makeAgent({ pinnedKnowledgeIds: ['k1', 'k2'] });
    const payload = await buildInternalAgentEventPayload(agent, 'tenant.internal_agent.created');
    expect((payload as Record<string, unknown>).pinnedKnowledgeIds).toEqual(['k1', 'k2']);
  });

  it('defaults to empty array when undefined on the agent', async () => {
    const agent = makeAgent();
    delete (agent as Partial<InternalAgent>).pinnedKnowledgeIds;
    const payload = await buildInternalAgentEventPayload(agent, 'tenant.internal_agent.updated');
    expect((payload as Record<string, unknown>).pinnedKnowledgeIds).toEqual([]);
  });

  it('omits pinnedKnowledgeIds on deleted event (envelope only)', async () => {
    const agent = makeAgent({ pinnedKnowledgeIds: ['k1'] });
    const payload = await buildInternalAgentEventPayload(agent, 'tenant.internal_agent.deleted');
    expect((payload as Record<string, unknown>).pinnedKnowledgeIds).toBeUndefined();
  });

  it('reads capabilityTier from the agent column, not a substring heuristic', async () => {
    // The agent's persisted column wins. Even when systemPrompt contains the
    // legacy "sandbox__" needle, capabilityTier on the row is the source of
    // truth.
    const agent = makeAgent({
      capabilityTier: 'connector_only',
      systemPrompt: 'you may invoke sandbox__exec when needed',
    });
    const payload = await buildInternalAgentEventPayload(agent, 'tenant.internal_agent.created');
    expect((payload as Record<string, unknown>).capabilityTier).toBe('connector_only');
  });

  it('emits skills from the agent column without the unsafe cast', async () => {
    const agent = makeAgent({
      skills: [{ name: 'sk1', description: 'd', instruction: 'i' }],
    });
    const payload = await buildInternalAgentEventPayload(agent, 'tenant.internal_agent.updated');
    expect((payload as Record<string, unknown>).skills).toEqual([
      { name: 'sk1', description: 'd', instruction: 'i' },
    ]);
  });
});
