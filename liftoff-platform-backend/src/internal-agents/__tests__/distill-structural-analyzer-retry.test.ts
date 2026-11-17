// Integration test: distill-service ↔ trigger-config-analyzer retry path.
//
// Mocks the LLM client to return a structurally-violating output on the
// first attempt and a clean output on retry, then asserts that
// distillInternalAgentWithProgress returns the clean output (proving the
// analyzer drove a retry with feedback). A second test asserts that when
// the LLM returns violations on every attempt, the final state throws
// DistillationStructuralError. Together this covers Phase 2 step 5 of the
// implementation plan ("mock LLM produces specific violating outputs →
// analyzer rejects → retry succeeds with corrected output").

// The prefetch's capability-spec derivation is its own LLM call, made before
// the distill's own; with the shared client mocked as an ordered sequence it
// would consume the response the distill expects. Cached specs miss and the
// derivation yields nothing, so the prefetch takes the keyword heuristic.
jest.mock('../capability-specs-cache', () => ({
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
    // catalog. Null is the unreachable-runtime case, which is what these
    // suites exercise everywhere else too.
    getDataLandscape: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../distill-cache', () => ({
  computePriorArtHash: jest.fn().mockReturnValue(''),
  computeCatalogHash: jest.fn().mockReturnValue('mock-catalog-hash'),
  computeFingerprint: jest.fn().mockReturnValue('mock-fingerprint'),
  getCachedDistillation: jest.fn().mockResolvedValue(null),
  setCachedDistillation: jest.fn().mockResolvedValue(undefined),
}));

// Synthetic catalog: one connector (hubspot) declaring a Deal entity with
// a declared `stage` field but no `bogusField`. A predicate against
// `bogusField` will trip the reactive-predicate-undeclared-field rule.
jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn().mockResolvedValue({
    connectors: [{
      type: 'hubspot',
      displayName: 'HubSpot',
      category: 'crm',
      status: 'available',
      auth: { kind: 'none' },
      entitySchemas: {
        Deal: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            stage: { type: 'string' },
            closeDate: {
              type: 'string',
              description: 'Deal close date — anchor for "alert N days before close" patterns.',
            },
          },
        },
      },
    }],
    version: 'v1',
    categoryLabels: {},
  }),
  resetCatalogCache: jest.fn(),
}));

jest.mock('../../agent-chat/slack-adapter/repository', () => ({
  getInstalledSlackAppCount: jest.fn().mockResolvedValue(0),
}));

import { distillInternalAgentWithProgress } from '../distill-service';
import { llmClient } from '../../llm/client';
import { tenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import { DistillationStructuralError } from '../trigger-config-analyzer';
import type { LLMCompletionResponse } from '../../llm/types';

const mockComplete = llmClient.complete as jest.MockedFunction<typeof llmClient.complete>;
const mockGetManifests = tenantRuntimeClient.getTenantManifests as jest.MockedFunction<typeof tenantRuntimeClient.getTenantManifests>;
const mockGetCatalog = tenantRuntimeClient.getToolCatalog as jest.MockedFunction<typeof tenantRuntimeClient.getToolCatalog>;

const INPUT = {
  role: 'Sales analyst',
  responsibilities: 'Alert on high-value deal stage changes.',
  integrations: [{ id: 'int-1', name: 'HubSpot', type: 'hubspot', selectedObjects: ['Deal'] }],
  tenantId: 'tenant-1',
};

function ghostFieldResponse(): LLMCompletionResponse {
  // Subscription filter references `bogusField` — undeclared in the catalog.
  return {
    content: '',
    model: 'test-model',
    provider: 'anthropic',
    stopReason: 'tool_use',
    toolCalls: [{
      id: 'call-bad',
      name: 'produce_agent',
      input: {
        summary: 'Alerts on HubSpot deal stage changes.',
        systemPrompt: 'You are the Sales Analyst.',
        userInstructions: 'Subscribe to deal updates and alert.',
        instructionsMd: '## Role\n## Tool-use guidance\n## Escalation rules\n## Output format\n## Pitfalls and gotchas\nPlaceholder.',
        triggerConfig: {
          type: 'event',
          eventTopic: 'connector_event.hubspot.deal.updated',
          reasoning: 'react',
          reactiveSubscriptions: [{
            label: 'ghost-field-watch',
            source: { kind: 'connector_event', connectorRef: 'hubspot', entityType: 'Deal' },
            filter: { op: 'gt', path: 'data.deal.bogusField', value: 100 },
            objective: 'fire when bogusField > 100',
          }],
        },
        skills: [{ name: 'alert', description: 'Use when deal stage changes.', instruction: 'Send a Slack alert.' }],
      },
    }],
  };
}

function cleanResponse(): LLMCompletionResponse {
  // Same agent, filter rewritten to reference a declared field (`stage`).
  return {
    content: '',
    model: 'test-model',
    provider: 'anthropic',
    stopReason: 'tool_use',
    toolCalls: [{
      id: 'call-good',
      name: 'produce_agent',
      input: {
        summary: 'Alerts on HubSpot deal stage changes.',
        systemPrompt: 'You are the Sales Analyst.',
        userInstructions: 'Subscribe to deal updates and alert.',
        instructionsMd: '## Role\n## Tool-use guidance\n## Escalation rules\n## Output format\n## Pitfalls and gotchas\nPlaceholder.',
        triggerConfig: {
          type: 'event',
          eventTopic: 'connector_event.hubspot.deal.updated',
          reasoning: 'react',
          reactiveSubscriptions: [{
            label: 'stage-watch',
            source: { kind: 'connector_event', connectorRef: 'hubspot', entityType: 'Deal' },
            filter: { op: 'eq', path: 'stage', value: 'closed_won' },
            objective: 'celebrate closed deals',
          }],
        },
        skills: [{ name: 'alert', description: 'Use when deal stage changes.', instruction: 'Send a Slack alert.' }],
      },
    }],
  };
}

describe('Distill structural analyzer — retry path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetManifests.mockResolvedValue({ manifests: [] } as never);
    mockGetCatalog.mockResolvedValue({ aliasedTools: {} } as never);
  });

  it('retries once with feedback when the first LLM call emits a ghost-field predicate, then returns the clean output', async () => {
    mockComplete
      .mockResolvedValueOnce(ghostFieldResponse())
      .mockResolvedValueOnce(cleanResponse());

    const out = await distillInternalAgentWithProgress(INPUT);

    expect(out.agentType).toBe('agent');
    expect(mockComplete).toHaveBeenCalledTimes(2);

    // The second call is a CORRECTION TURN, not a bare complaint: the rejected
    // artifact is replayed as the model's own assistant tool_use turn and the
    // feedback comes back as the matching tool_result. A retry that cannot see
    // what it wrote re-authors the whole artifact and does not converge.
    const secondCallArgs = mockComplete.mock.calls[1]?.[0] as {
      messages: Array<{
        role: string;
        content: string;
        toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
        toolResults?: Array<{ toolCallId: string; content: string }>;
      }>;
    };

    const replay = secondCallArgs.messages.find(m => m.role === 'assistant' && !!m.toolCalls?.length);
    expect(replay).toBeDefined();
    expect(replay?.toolCalls?.[0].name).toBe('produce_agent');
    // It must be the REJECTED artifact, so the model has the ghost-field
    // predicate in front of it while being told about it.
    // `bogusField` is the undeclared path the analyzer rejected. Its presence
    // here is the whole point: the model is looking at the exact predicate the
    // tool_result complains about, rather than being asked to guess which of
    // its subscriptions was wrong.
    expect(JSON.stringify(replay?.toolCalls?.[0].input)).toContain('bogusField');

    const feedback = secondCallArgs.messages.find(m =>
      m.role === 'user'
      && m.toolResults?.some(r => r.content.includes('reactive_predicate_undeclared_field')),
    );
    expect(feedback).toBeDefined();
    // Keyed to the replayed call, or the provider drops the pairing.
    expect(feedback?.toolResults?.[0].toolCallId).toBe(replay?.toolCalls?.[0].id);
  });

  it('throws DistillationStructuralError when every retry attempt produces a blocking violation', async () => {
    mockComplete
      .mockResolvedValueOnce(ghostFieldResponse())
      .mockResolvedValueOnce(ghostFieldResponse())
      .mockResolvedValueOnce(ghostFieldResponse());

    await expect(distillInternalAgentWithProgress(INPUT)).rejects.toBeInstanceOf(DistillationStructuralError);
    // Three attempts = first call + two retries, per plan §5.3.
    expect(mockComplete).toHaveBeenCalledTimes(3);
  });
});
