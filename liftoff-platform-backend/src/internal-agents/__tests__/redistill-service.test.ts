// Unit tests for redistill-service. Mocks pull external deps (distill LLM
// calls, DB pool, connector catalog) so the tests exercise the shape-
// translation + persist-payload logic, not the LLM or DB.

const mockGetById = jest.fn();
const mockUpdate = jest.fn();
const mockListAllByTenant = jest.fn();
const mockDistill = jest.fn();
const mockGetCatalog = jest.fn();

jest.mock('../service', () => ({
  internalAgentService: {
    getById: mockGetById,
    update: mockUpdate,
    listAllByTenant: mockListAllByTenant,
  },
}));

jest.mock('../distill-service', () => ({
  distillInternalAgent: mockDistill,
  MAX_RETRIES: 3,
}));

jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: mockGetCatalog,
}));

import {
  redistillAgent,
  redistillAllAgents,
  RedistillNotFoundError,
  RedistillTooManyAgentsError,
} from '../redistill-service';

const TENANT_ID = 't1';
const ACTOR_ID = 'actor-1';
const AGENT_ID = 'agent-1';

const baseAgent = {
  id: AGENT_ID,
  tenantId: TENANT_ID,
  role: 'Customer Success Manager',
  responsibilities: '## Responsibilities\n- monitor accounts',
  integrations: [
    { id: '11111111-1111-1111-1111-111111111111', type: 'salesforce', selectedObjects: ['Account', 'Opportunity'] },
    { id: '22222222-2222-2222-2222-222222222222', type: 'google_mail', integrationId: 'google_mail', selectedObjects: [], config: {} },
  ],
  pendingIntegrations: [],
  additionalContext: '## Rules\n- never delete records',
  summary: 'old summary',
  systemPrompt: 'old system prompt',
  userInstructions: 'old user instructions',
  instructionsMd: 'old md',
  instructions: null,
  temperature: 0.2,
  status: 'active',
  currentVersion: 3,
  tasksCompleted: 12,
  tasks30d: 4,
  monthlyCost: 1.5,
  lastActive: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  agentType: 'agent',
  modelConfig: {},
  memoryScope: {},
  execConfig: {},
  workflowSteps: null,
  triggerConfig: { type: 'cron', cronExpr: '0 9 * * *', reasoning: 'old' },
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
};

const distilledAgentResult = {
  agentType: 'agent' as const,
  summary: 'NEW summary',
  systemPrompt: 'NEW system prompt with reactive triggers',
  userInstructions: 'NEW user instructions',
  instructionsMd: 'NEW md',
  triggerConfig: { type: 'cron' as const, cronExpr: '0 8 * * *', reasoning: 'new' },
  skills: [{ name: 'sk1', description: 'desc', instruction: 'do thing' }],
  capabilityTier: 'connector_only' as const,
};

// ADR 022 (collapse): agentType is always 'agent'; the "workflow" shape is now
// a produce_agent output with workflowSteps populated. Kept the name for test
// readability — it's "an agent result that carries a workflowSteps backbone".
const distilledWorkflowResult = {
  agentType: 'agent' as const,
  summary: 'workflow summary',
  systemPrompt: 'workflow system prompt',
  userInstructions: 'workflow user instructions',
  instructionsMd: 'workflow md',
  triggerConfig: { type: 'manual' as const, reasoning: 'workflow' },
  workflowSteps: [{ stepId: 's1', description: 'first step', type: 'tool_call', toolName: 'gmail_send' }],
  skills: [],
};

const catalogResponse = {
  connectors: [
    { type: 'salesforce', displayName: 'Salesforce', status: 'available' },
    { type: 'google_mail', displayName: 'Gmail', status: 'available' },
  ],
  version: 'v1',
  categoryLabels: {},
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCatalog.mockResolvedValue(catalogResponse);
});

describe('redistillAgent (single)', () => {
  it('throws RedistillNotFoundError when agent does not exist', async () => {
    mockGetById.mockResolvedValueOnce(null);
    await expect(redistillAgent(AGENT_ID, TENANT_ID, ACTOR_ID)).rejects.toBeInstanceOf(RedistillNotFoundError);
    expect(mockDistill).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('feeds agent fields into distillInternalAgent and persists the result with VersionSource=distill', async () => {
    mockGetById.mockResolvedValueOnce(baseAgent);
    mockDistill.mockResolvedValueOnce(distilledAgentResult);
    mockUpdate.mockResolvedValueOnce({ ...baseAgent, ...distilledAgentResult, currentVersion: 4 });

    const result = await redistillAgent(AGENT_ID, TENANT_ID, ACTOR_ID);

    // Distill called with stored source fields + enriched integration names from catalog
    expect(mockDistill).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      agentId: AGENT_ID,
      role: baseAgent.role,
      responsibilities: baseAgent.responsibilities,
      additionalContext: baseAgent.additionalContext,
      integrations: [
        { id: '11111111-1111-1111-1111-111111111111', type: 'salesforce', name: 'Salesforce', selectedObjects: ['Account', 'Opportunity'] },
        { id: '22222222-2222-2222-2222-222222222222', type: 'google_mail', name: 'Gmail', selectedObjects: [] },
      ],
      // Carried through so a redistill sees the same guidance attachments the
      // agent was built from; undefined when the agent has none.
      attachments: undefined,
      // The scope the agent ACTUALLY has, so the memory-layer check asks the
      // question dispatch asks. Validating against the TEMPLATE instead — which
      // can grant `role` where the agent does not — lets a `memory_save` on
      // `role` pass authoring and be refused at runtime.
      currentMemoryScope: {},
      // P1.2: the preference-recurrence aggregator now feeds this seam. It was
      // wired into DistillInput but never populated by anything, so the
      // preference-contract section it drives could never appear. Empty here
      // because this agent has no preference-tagged memories.
      recurringPreferences: [],
      // Recovered from the bindings, since templatePicks is an input to
      // distillation and not a stored field. Empty here: neither binding in
      // this fixture carries a destination.
      templatePicks: {},
    });

    // Update called with only the LLM-derived fields, no role/responsibilities/integrations
    expect(mockUpdate).toHaveBeenCalledWith(
      AGENT_ID,
      TENANT_ID,
      expect.objectContaining({
        agentType: 'agent',
        summary: 'NEW summary',
        systemPrompt: 'NEW system prompt with reactive triggers',
        userInstructions: 'NEW user instructions',
        instructionsMd: 'NEW md',
        triggerConfig: distilledAgentResult.triggerConfig,
        workflowSteps: null,
      }),
      ACTOR_ID,
      'distill',
    );

    expect(result.currentVersion).toBe(4);
  });

  it('writes workflowSteps when distill returns an agent with a workflow backbone (ADR 022)', async () => {
    mockGetById.mockResolvedValueOnce(baseAgent);
    mockDistill.mockResolvedValueOnce(distilledWorkflowResult);
    mockUpdate.mockResolvedValueOnce({ ...baseAgent, currentVersion: 4 });

    await redistillAgent(AGENT_ID, TENANT_ID, ACTOR_ID);

    expect(mockUpdate).toHaveBeenCalledWith(
      AGENT_ID,
      TENANT_ID,
      expect.objectContaining({
        agentType: 'agent', // ADR 022: always 'agent'
        workflowSteps: distilledWorkflowResult.workflowSteps,
      }),
      ACTOR_ID,
      'distill',
    );
  });

  it('persists skills + capabilityTier and merges integrationConfigs onto integrations[i].config', async () => {
    mockGetById.mockResolvedValueOnce(baseAgent);
    const distilled = {
      ...distilledAgentResult,
      capabilityTier: 'execution_enabled' as const,
      integrationConfigs: {
        google_mail: { gmailQuery: 'label:support', sendAs: 'help@x.com' },
      },
    };
    mockDistill.mockResolvedValueOnce(distilled);
    mockUpdate.mockResolvedValueOnce({ ...baseAgent, currentVersion: 4 });

    await redistillAgent(AGENT_ID, TENANT_ID, ACTOR_ID);

    expect(mockUpdate).toHaveBeenCalledWith(
      AGENT_ID,
      TENANT_ID,
      expect.objectContaining({
        skills: distilled.skills,
        capabilityTier: 'execution_enabled',
        integrations: expect.arrayContaining([
          expect.objectContaining({
            id: '22222222-2222-2222-2222-222222222222',
            type: 'google_mail',
            config: expect.objectContaining({
              gmailQuery: 'label:support',
              sendAs: 'help@x.com',
            }),
          }),
        ]),
      }),
      ACTOR_ID,
      'distill',
    );
  });

  it('clears workflowSteps when redistill of an agent-with-backbone produces no backbone (ADR 022)', async () => {
    // ADR 022 contract: agentType is always 'agent'. The pre-collapse
    // workflow->agent flip is now expressed as "stored agent has workflowSteps;
    // redistill returns no workflowSteps → DB write nulls them out".
    const agentWithBackbone = {
      ...baseAgent,
      agentType: 'agent' as const,
      workflowSteps: [{ stepId: 's1', type: 'tool_call', toolName: 'gmail_send' }],
    };
    mockGetById.mockResolvedValueOnce(agentWithBackbone);
    mockDistill.mockResolvedValueOnce(distilledAgentResult); // no workflowSteps
    mockUpdate.mockResolvedValueOnce({ ...baseAgent, ...distilledAgentResult, currentVersion: 4 });

    await redistillAgent(AGENT_ID, TENANT_ID, ACTOR_ID);

    expect(mockUpdate).toHaveBeenCalledWith(
      AGENT_ID,
      TENANT_ID,
      expect.objectContaining({
        agentType: 'agent',
        workflowSteps: null,
      }),
      ACTOR_ID,
      'distill',
    );
  });

  it('applies nothing when the rebuild lost its graph: the incumbent configuration stays whole', async () => {
    // A rebuild whose graph was dropped ships no steps and says so. Applying
    // its prompts, trigger and integrations while keeping the old steps (or
    // none) would leave yesterday's graph under today's instructions; the
    // rebuild fails as one unit instead and the agent is untouched.
    const { DistillationGraphNotConvergedError } = await import('../distill-errors');
    const agentWithBackbone = {
      ...baseAgent,
      agentType: 'agent' as const,
      workflowSteps: [{ stepId: 's1', type: 'tool_call', toolName: 'gmail_send' }],
    };
    mockGetById.mockResolvedValueOnce(agentWithBackbone);
    mockDistill.mockResolvedValueOnce({
      ...distilledAgentResult,
      graphDropped: { reasons: ['tool_call_without_failure_edge'], stepCount: 7 },
    });

    await expect(redistillAgent(AGENT_ID, TENANT_ID, ACTOR_ID)).rejects.toBeInstanceOf(DistillationGraphNotConvergedError);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('falls back to integration type as name when catalog has no displayName', async () => {
    mockGetById.mockResolvedValueOnce({
      ...baseAgent,
      integrations: [{ id: '33333333-3333-3333-3333-333333333333', type: 'obscure_connector', selectedObjects: [] }],
    });
    mockDistill.mockResolvedValueOnce(distilledAgentResult);
    mockUpdate.mockResolvedValueOnce({ ...baseAgent, currentVersion: 4 });

    await redistillAgent(AGENT_ID, TENANT_ID, ACTOR_ID);

    expect(mockDistill).toHaveBeenCalledWith(expect.objectContaining({
      integrations: [{ id: '33333333-3333-3333-3333-333333333333', type: 'obscure_connector', name: 'obscure_connector', selectedObjects: [] }],
    }));
  });

  it('surfaces RedistillNotFoundError when the row was soft-deleted between read and write', async () => {
    mockGetById.mockResolvedValueOnce(baseAgent);
    mockDistill.mockResolvedValueOnce(distilledAgentResult);
    mockUpdate.mockResolvedValueOnce(null); // soft-delete race
    await expect(redistillAgent(AGENT_ID, TENANT_ID, ACTOR_ID)).rejects.toBeInstanceOf(RedistillNotFoundError);
  });

  it('a scoped rebuild persists BOTH the trigger AND the rederived decision record', async () => {
    // The decision record describes the trigger the scoped run changed.
    // Persisting only the trigger left the stored record describing the
    // pre-change trigger, and a later FULL redistill rendered that stale
    // record into the prompt and regenerated routines a scoped stop removed.
    const prevAgent = {
      ...baseAgent,
      decisionRecord: {
        trigger: { type: 'cron', reason: 'Monday AND a Friday note' },
        distilledOverrideTools: ['open_chat_thread'],
        flowSubjects: { f1: ['digest'] },
      },
    };
    mockGetById.mockResolvedValueOnce(prevAgent);
    // The scoped distill returns a trigger WITHOUT the Friday note and a
    // freshly-derived record that matches it (applyScopedCarryOver keeps it).
    mockDistill.mockResolvedValueOnce({
      ...distilledAgentResult,
      triggerConfig: { type: 'cron' as const, cronExpr: '0 9 * * 1', reasoning: 'Monday only' },
      decisionRecord: { trigger: { type: 'cron', reason: 'Monday only, no Friday' } },
    });
    mockUpdate.mockResolvedValueOnce({ ...prevAgent, currentVersion: 4 });

    await redistillAgent(AGENT_ID, TENANT_ID, ACTOR_ID, { scope: 'triggers' });

    const [, , payload] = mockUpdate.mock.calls[0];
    // Trigger written, and the record rederived from it — not the stale one.
    expect((payload.triggerConfig as { cronExpr?: string }).cronExpr).toBe('0 9 * * 1');
    expect((payload.decisionRecord as { trigger?: { reason?: string } })?.trigger?.reason)
      .toBe('Monday only, no Friday');
    // Tool/flow metadata a trigger-only rebuild does not recompute is carried
    // from the current record.
    expect((payload.decisionRecord as { distilledOverrideTools?: string[] })?.distilledOverrideTools)
      .toEqual(['open_chat_thread']);
    // The scoped write stays narrow: it must not push the prose sections.
    expect(payload.systemPrompt).toBeUndefined();
    expect(payload.summary).toBeUndefined();
  });
});

describe('redistillAllAgents (batch)', () => {
  it('runs distill+update for every non-deleted agent', async () => {
    const agents = [1, 2, 3].map((n) => ({ ...baseAgent, id: `agent-${n}`, role: `Role ${n}` }));
    mockListAllByTenant.mockResolvedValueOnce(agents);
    mockGetById.mockImplementation(async (id: string) => agents.find((a) => a.id === id) ?? null);
    mockDistill.mockResolvedValue(distilledAgentResult);
    mockUpdate.mockImplementation(async (id: string) => ({ ...baseAgent, id, currentVersion: 4 }));

    const result = await redistillAllAgents(TENANT_ID, ACTOR_ID);

    expect(result.totalAgents).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.results.map((r) => r.agentId).sort()).toEqual(['agent-1', 'agent-2', 'agent-3']);
    expect(mockDistill).toHaveBeenCalledTimes(3);
    expect(mockUpdate).toHaveBeenCalledTimes(3);
  });

  it('continues the batch when one agent fails; records the failure', async () => {
    const agents = [1, 2, 3].map((n) => ({ ...baseAgent, id: `agent-${n}`, role: `Role ${n}` }));
    mockListAllByTenant.mockResolvedValueOnce(agents);
    mockGetById.mockImplementation(async (id: string) => agents.find((a) => a.id === id) ?? null);
    mockDistill.mockImplementation(async (input: { agentId: string }) => {
      if (input.agentId === 'agent-2') throw new Error('LLM rate-limited');
      return distilledAgentResult;
    });
    mockUpdate.mockImplementation(async (id: string) => ({ ...baseAgent, id, currentVersion: 4 }));

    const result = await redistillAllAgents(TENANT_ID, ACTOR_ID);

    expect(result.totalAgents).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    const failed = result.results.find((r) => r.agentId === 'agent-2');
    expect(failed).toMatchObject({ success: false, error: 'LLM rate-limited' });
  });

  it('rejects with RedistillTooManyAgentsError when tenant has >50 agents', async () => {
    const agents = Array.from({ length: 51 }, (_, i) => ({ ...baseAgent, id: `agent-${i}` }));
    mockListAllByTenant.mockResolvedValueOnce(agents);
    await expect(redistillAllAgents(TENANT_ID, ACTOR_ID)).rejects.toBeInstanceOf(RedistillTooManyAgentsError);
    expect(mockDistill).not.toHaveBeenCalled();
  });

  it('handles empty tenant cleanly', async () => {
    mockListAllByTenant.mockResolvedValueOnce([]);
    const result = await redistillAllAgents(TENANT_ID, ACTOR_ID);
    expect(result).toEqual({ totalAgents: 0, succeeded: 0, failed: 0, dryRun: false, results: [] });
    expect(mockDistill).not.toHaveBeenCalled();
  });

  it('dryRun=true returns a per-agent diff array and never calls service.update', async () => {
    const agents = [1, 2].map((n) => ({ ...baseAgent, id: `agent-${n}`, role: `Role ${n}` }));
    mockListAllByTenant.mockResolvedValueOnce(agents);
    mockGetById.mockImplementation(async (id: string) => agents.find((a) => a.id === id) ?? null);
    mockDistill.mockResolvedValue({
      ...distilledAgentResult,
      capabilityTier: 'execution_enabled',
    });

    const result = await redistillAllAgents(TENANT_ID, ACTOR_ID, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.succeeded).toBe(2);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(result.results[0].diff).toMatchObject({
      agentId: expect.any(String),
      role: expect.any(String),
      currentAgentType: 'agent',
      newAgentType: 'agent',
      currentTriggerSummary: expect.any(String),
      newTriggerSummary: expect.any(String),
      currentSkillCount: 0,
      newSkillCount: 1,
      integrationConfigDelta: expect.any(Number),
      integrationConfigChanges: expect.any(Array),
    });
  });

  it('dryRun integrationConfigChanges enumerates per-binding before/after for changed bindings', async () => {
    const agents = [{ ...baseAgent, id: 'agent-x' }];
    mockListAllByTenant.mockResolvedValueOnce(agents);
    mockGetById.mockImplementation(async (id: string) => agents.find((a) => a.id === id) ?? null);
    mockDistill.mockResolvedValueOnce({
      ...distilledAgentResult,
      integrationConfigs: {
        google_mail: { gmailQuery: 'label:support' },
      },
    });

    const result = await redistillAllAgents(TENANT_ID, ACTOR_ID, { dryRun: true });

    const diff = result.results[0].diff!;
    expect(diff.integrationConfigDelta).toBe(1);
    expect(diff.integrationConfigChanges).toEqual([
      expect.objectContaining({
        integrationId: '22222222-2222-2222-2222-222222222222',
        type: 'google_mail',
        before: {},
        after: { gmailQuery: 'label:support' },
      }),
    ]);
  });
});

// The obligations must reach the distiller even when the seed does not.
//
// `templateIdForRedistill` returns null once an owner has edited a hire's text,
// and until this it was the only route to the template's declarations. Every
// fence reads its obligation off the template, so a null id skipped all of them
// at once — must deliver, must not act twice, must produce the artifact.
//
// An edited hire with only Google Docs bound can be redistilled with no
// `open_chat_thread` step. That step is its only route to a person, so it then
// writes a digest and tells nobody, while unedited siblings still carry theirs.
//
// The accessor is unit-tested next door. This asserts the WIRING, because a
// correct accessor nothing passes is the defect this repo keeps paying for.
describe('what a redistill hands the distiller about its template', () => {
  const templated = {
    ...baseAgent,
    templateId: 'competitive-intelligence-analyst',
    // A hash that cannot match the current text: the owner has edited it.
    templateSourceHash: 'f'.repeat(64),
  };

  it('sends the obligations id even when the prose seed is withheld', async () => {
    mockGetById.mockResolvedValueOnce(templated);
    mockDistill.mockResolvedValueOnce(distilledAgentResult);
    mockUpdate.mockResolvedValueOnce({ ...templated, ...distilledAgentResult, currentVersion: 4 });

    await redistillAgent(AGENT_ID, TENANT_ID, ACTOR_ID);

    const arg = mockDistill.mock.calls[0][0];
    // Seed withheld: the owner's wording is theirs and must not be pulled back.
    expect(arg.templateId).toBeUndefined();
    // Obligations kept: an owner asking for different words is not asking for
    // the work to stop being delivered.
    expect(arg.obligationTemplateId).toBe('competitive-intelligence-analyst');
  });

  it('sends both when the text still matches what the hire recorded', async () => {
    const { templateSourceHash } = await import('../template-provenance');
    const untouched = {
      ...baseAgent,
      templateId: 'competitive-intelligence-analyst',
      templateSourceHash: templateSourceHash(baseAgent.responsibilities, baseAgent.additionalContext),
    };
    mockGetById.mockResolvedValueOnce(untouched);
    mockDistill.mockResolvedValueOnce(distilledAgentResult);
    mockUpdate.mockResolvedValueOnce({ ...untouched, ...distilledAgentResult, currentVersion: 4 });

    await redistillAgent(AGENT_ID, TENANT_ID, ACTOR_ID);

    const arg = mockDistill.mock.calls[0][0];
    expect(arg.templateId).toBe('competitive-intelligence-analyst');
    expect(arg.obligationTemplateId).toBe('competitive-intelligence-analyst');
  });

  it('sends neither for an agent that came from no template', async () => {
    mockGetById.mockResolvedValueOnce(baseAgent);
    mockDistill.mockResolvedValueOnce(distilledAgentResult);
    mockUpdate.mockResolvedValueOnce({ ...baseAgent, ...distilledAgentResult, currentVersion: 4 });

    await redistillAgent(AGENT_ID, TENANT_ID, ACTOR_ID);

    const arg = mockDistill.mock.calls[0][0];
    expect(arg.templateId).toBeUndefined();
    // Null here means "there is no obligation to read", not "it lapsed".
    expect(arg.obligationTemplateId).toBeUndefined();
  });
});
