/**
 * Phase 6 — Tier A hermetic smoke tests for distill classification.
 *
 * Record-and-replay LLM stubs: each scenario mocks the LLM response
 * to validate the classification path (agent vs workflow), trigger
 * configuration, and workflow step validation.
 */

// The prefetch's capability-spec derivation is its own LLM call, made before
// the distill's own; with the shared client mocked as an ordered sequence it
// would consume the response the distill expects. Cached specs miss and the
// derivation yields nothing, so the prefetch takes the keyword heuristic.
jest.mock('../../internal-agents/capability-specs-cache', () => ({
  readCachedCapabilitySpecs: jest.fn().mockResolvedValue(null),
  deriveCapabilitySpecsWithin: jest.fn().mockResolvedValue(null),
  SPEC_DERIVATION_WAIT_MS: 0,
}));

jest.mock('../../llm/client', () => ({
  llmClient: { complete: jest.fn() },
}));

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    getTenantManifests: jest.fn(),
    getToolCatalog: jest.fn(),
    // Distillation reads the tenant's data landscape alongside the tool
    // catalog. Null is the unreachable-runtime case.
    getDataLandscape: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn().mockResolvedValue({ connectors: [] }),
  resetCatalogCache: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { distillInternalAgentWithProgress } from '../../internal-agents/distill-service';
import { llmClient } from '../../llm/client';
import { tenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import { log } from '../../infrastructure/logging';
import type { LLMCompletionResponse } from '../../llm/types';

const mockComplete = llmClient.complete as jest.MockedFunction<typeof llmClient.complete>;
const mockGetManifests = tenantRuntimeClient.getTenantManifests as jest.MockedFunction<
  typeof tenantRuntimeClient.getTenantManifests
>;
const mockGetCatalog = tenantRuntimeClient.getToolCatalog as jest.MockedFunction<
  typeof tenantRuntimeClient.getToolCatalog
>;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no manifests (empty catalog)
  mockGetManifests.mockResolvedValue({ manifests: [] });
  mockGetCatalog.mockResolvedValue({ tools: [] });
});

// ── Helpers ──────────────────────────────────────────────────────────────

function makeAgentResponse(overrides?: Partial<LLMCompletionResponse>): LLMCompletionResponse {
  return {
    content: '',
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    stopReason: 'tool_use',
    usage: { inputTokens: 1200, outputTokens: 800 },
    toolCalls: [{
      id: 'call-agent-1',
      name: 'produce_agent',
      input: {
        summary: 'Monitors Salesforce for stalled negotiations and drafts follow-up plans.',
        systemPrompt: 'You are the Sales Follow-up Manager.',
        userInstructions: 'Step 1: Query Salesforce for deals stuck >7 days. Step 2: Draft follow-up plan.',
        instructionsMd: '## Role\nYou are the Sales Follow-up Manager.\n\n## Tool-use guidance\nUse salesforce tools.',
        triggerConfig: {
          type: 'cron',
          cronExpr: '0 * * * *',
          reasoning: 'Hourly check as described in responsibilities.',
        },
      },
    }],
    ...overrides,
  };
}

// ADR 022: there is no produce_workflow tool anymore. The "workflow" shape is
// a produce_agent call whose input carries a structured workflowSteps backbone.
function makeAgentWithWorkflowResponse(
  steps: Array<{ stepId: string; description: string; toolName: string; onSuccess?: string; onFailure?: string }>,
  triggerConfig: { type: string; cronExpr?: string; eventTopic?: string; reasoning: string },
  overrides?: Partial<LLMCompletionResponse>,
): LLMCompletionResponse {
  return {
    content: '',
    model: 'claude-sonnet-4-20250514',
    provider: 'anthropic',
    stopReason: 'tool_use',
    usage: { inputTokens: 1500, outputTokens: 1200 },
    toolCalls: [{
      id: 'call-wf-1',
      name: 'produce_agent',
      input: {
        summary: 'Automated workflow pipeline.',
        systemPrompt: 'You are a workflow executor.',
        userInstructions: 'Execute steps in sequence.',
        instructionsMd: '## Role\nWorkflow executor.\n\n## Tool-use guidance\nFollow step sequence.',
        triggerConfig,
        workflowSteps: steps.map(s => ({ ...s, type: 'tool_call' })),
      },
    }],
    ...overrides,
  };
}

// ── Scenario 1: Agent classification ────────────────────────────────────

describe('Smoke: distill classification', () => {
  it('Scenario 1 — classifies as agent with cron trigger', async () => {
    mockComplete.mockResolvedValueOnce(makeAgentResponse());

    const output = await distillInternalAgentWithProgress({
      role: 'Sales Follow-up Manager',
      responsibilities:
        'Every hour, check Salesforce for deals stuck in negotiation for more than 7 days and draft a follow-up plan',
      integrations: [
        { id: 'int-sf', name: 'Salesforce', type: 'salesforce', selectedObjects: ['Opportunity'] },
      ],
      tenantId: 'tenant-smoke-1',
    });

    expect(output.agentType).toBe('agent');
    expect(output.triggerConfig.type).toBe('cron');
    // Agent output must NOT have workflowSteps
    expect('workflowSteps' in output).toBe(false);

    // Verify metric log emission
    const logInfoCalls = (log.info as jest.Mock).mock.calls;
    const metricCall = logInfoCalls.find(
      (call: unknown[]) => call[0] && (call[0] as Record<string, unknown>).metric === 'distill.classification.decided'
    );
    expect(metricCall).toBeDefined();
    expect((metricCall![0] as Record<string, unknown>).agentType).toBe('agent');
  });

  // ── Scenario 2: Workflow classification ──────────────────────────────

  it('Scenario 2 — classifies as workflow with 3 steps and cron trigger', async () => {
    // Provide manifests and catalog so workflow validation passes
    mockGetManifests.mockResolvedValueOnce({
      manifests: [
        { manifestId: 'm-gs', connectorType: 'google_sheets', name: 'Google Sheets' },
        { manifestId: 'm-sl', connectorType: 'slack', name: 'Slack' },
      ],
    });
    mockGetCatalog
      .mockResolvedValueOnce({
        tools: [
          { name: 'google_sheets__read_rows', description: 'Read rows from a Google Sheet' },
        ],
      })
      .mockResolvedValueOnce({
        tools: [
          { name: 'slack__send_message', description: 'Post a message to a Slack channel' },
        ],
      });

    // First call: distill LLM → produce_workflow
    const workflowSteps = [
      { stepId: 'step_1', description: 'Read standup entries', toolName: 'google_sheets__read_rows', onSuccess: 'step_2', onFailure: 'step_3' },
      { stepId: 'step_2', description: 'Format as markdown', toolName: 'google_sheets__read_rows', onSuccess: 'step_3', onFailure: 'step_3' },
      { stepId: 'step_3', description: 'Post to #engineering', toolName: 'slack__send_message', onSuccess: '', expectedOutput: 'a short summary of the build failure and what to do about it' },
    ];
    const distillResponse = makeAgentWithWorkflowResponse(workflowSteps, {
      type: 'cron',
      cronExpr: '0 9 * * *',
      reasoning: 'Every morning at 9am as described.',
    });

    // ADR 022: no separate semantic-validator LLM call anymore — single mock.
    mockComplete.mockResolvedValueOnce(distillResponse);

    const output = await distillInternalAgentWithProgress({
      role: 'Daily Standup Reporter',
      responsibilities:
        'Every morning at 9am, read the \'Daily Standup\' Google Sheet, format entries as markdown, and post to #engineering on Slack',
      integrations: [
        { id: 'int-gs', name: 'Google Sheets', type: 'google_sheets', selectedObjects: [] },
        { id: 'int-sl', name: 'Slack', type: 'slack', selectedObjects: [] },
      ],
      tenantId: 'tenant-smoke-2',
    });

    expect(output.agentType).toBe('agent'); // ADR 022: always 'agent'
    expect(output.triggerConfig.type).toBe('cron');
    expect(output.triggerConfig.cronExpr).toContain('9');

    // Agent output carries workflowSteps backbone
    expect(output.workflowSteps).toHaveLength(3);

    // Every step's toolName must exist in the catalog we provided
    const catalogNames = new Set(['google_sheets__read_rows', 'slack__send_message']);
    for (const step of output.workflowSteps ?? []) {
      expect(catalogNames.has(step.toolName!)).toBe(true);
    }

    // Verify metric log emission — classification is now "agent with backbone"
    const logInfoCalls = (log.info as jest.Mock).mock.calls;
    const metricCall = logInfoCalls.find(
      (call: unknown[]) => call[0] && (call[0] as Record<string, unknown>).metric === 'distill.classification.decided'
    );
    expect(metricCall).toBeDefined();
    expect((metricCall![0] as Record<string, unknown>).agentType).toBe('agent');
  });

  // ── Scenario 3: Workflow with event trigger ──────────────────────────

  it('Scenario 3 — classifies as workflow with event trigger', async () => {
    // Provide manifests and catalog
    mockGetManifests.mockResolvedValueOnce({
      manifests: [
        { manifestId: 'm-stripe', connectorType: 'stripe', name: 'Stripe' },
        { manifestId: 'm-linear', connectorType: 'linear', name: 'Linear' },
      ],
    });
    mockGetCatalog
      .mockResolvedValueOnce({
        tools: [
          { name: 'stripe__lookup_customer', description: 'Look up a Stripe customer by ID' },
        ],
      })
      .mockResolvedValueOnce({
        tools: [
          { name: 'linear__create_ticket', description: 'Create a Linear issue' },
        ],
      });

    const workflowSteps = [
      { stepId: 'step_1', description: 'Look up customer from charge', toolName: 'stripe__lookup_customer', onSuccess: 'step_2', onFailure: 'step_2' },
      { stepId: 'step_2', description: 'Create Linear ticket', toolName: 'linear__create_ticket', onSuccess: '', expectedOutput: 'the ticket that was raised and what it covers' },
    ];
    const distillResponse = makeAgentWithWorkflowResponse(workflowSteps, {
      type: 'event',
      eventTopic: 'stripe.charge.completed',
      reasoning: 'Reacts to Stripe webhook events.',
    });

    // ADR 022: no separate semantic-validator LLM call anymore — single mock.
    mockComplete.mockResolvedValueOnce(distillResponse);

    const output = await distillInternalAgentWithProgress({
      role: 'Stripe Ticket Creator',
      responsibilities:
        'When a Stripe webhook fires for a completed charge, look up the customer and create a Linear ticket',
      integrations: [
        { id: 'int-stripe', name: 'Stripe', type: 'stripe', selectedObjects: [] },
        { id: 'int-linear', name: 'Linear', type: 'linear', selectedObjects: [] },
      ],
      tenantId: 'tenant-smoke-3',
    });

    expect(output.agentType).toBe('agent'); // ADR 022: always 'agent'
    expect(output.triggerConfig.type).toBe('event');
    expect(output.workflowSteps).toHaveLength(2);

    // Verify metric log emission — classification is now "agent with backbone"
    const logInfoCalls = (log.info as jest.Mock).mock.calls;
    const metricCall = logInfoCalls.find(
      (call: unknown[]) => call[0] && (call[0] as Record<string, unknown>).metric === 'distill.classification.decided'
    );
    expect(metricCall).toBeDefined();
    expect((metricCall![0] as Record<string, unknown>).agentType).toBe('agent');
  });
});
