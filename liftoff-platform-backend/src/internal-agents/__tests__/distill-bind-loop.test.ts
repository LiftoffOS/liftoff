// The bind rung inside the distill loop: it runs before the patch rung, a
// converging rebind ends the attempt with no regeneration and no patch call,
// its fields update exactly as the patch block's do, the patch rung runs on
// what remains, and a mixed rejection never enters the bind pass.

jest.mock('../capability-specs-cache', () => ({
  readCachedCapabilitySpecs: jest.fn().mockResolvedValue(null),
  deriveCapabilitySpecsWithin: jest.fn().mockResolvedValue(null),
  SPEC_DERIVATION_WAIT_MS: 0,
}));
jest.mock('../../llm/client', () => ({ llmClient: { complete: jest.fn() } }));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    getTenantManifests: jest.fn(),
    getToolCatalog: jest.fn(),
    getDataLandscape: jest.fn().mockResolvedValue(null),
  },
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../capability-discovery', () => ({
  discoverCapabilities: jest.fn().mockResolvedValue({ spec: {}, candidates: [], degraded: true }),
}));
jest.mock('../distill-cache', () => ({
  computePriorArtHash: jest.fn().mockReturnValue(''),
  computeCatalogHash: jest.fn().mockReturnValue('mock-catalog-hash'),
  computeFingerprint: jest.fn().mockReturnValue('mock-fingerprint'),
  getCachedDistillation: jest.fn().mockResolvedValue(null),
  setCachedDistillation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn().mockResolvedValue({ connectors: [] }),
  resetCatalogCache: jest.fn(),
}));
jest.mock('../distill-run-recorder', () => {
  const actual = jest.requireActual('../distill-run-recorder');
  return { ...actual, recordDistillCall: jest.fn().mockResolvedValue(undefined) };
});
jest.mock('../../typesafe/client', () => ({ ask: jest.fn() }));

import { distillInternalAgentWithProgress } from '../distill-service';
import { recordDistillCall } from '../distill-run-recorder';
import { llmClient } from '../../llm/client';
import { log } from '../../infrastructure/logging';
import { tenantRuntimeClient } from '../../connectors/tenant-runtime-client';
import { PATCH_TOOL_NAME } from '../distill-patch';
import { ask } from '../../typesafe/client';
import type { LLMCompletionResponse } from '../../llm/types';

const mockComplete = llmClient.complete as jest.MockedFunction<typeof llmClient.complete>;
const mockRecord = recordDistillCall as jest.MockedFunction<typeof recordDistillCall>;
const mockAsk = ask as jest.Mock;
const mockLog = log as unknown as { info: jest.Mock; warn: jest.Mock };
const mockGetManifests = tenantRuntimeClient.getTenantManifests as jest.MockedFunction<typeof tenantRuntimeClient.getTenantManifests>;
const mockGetCatalog = tenantRuntimeClient.getToolCatalog as jest.MockedFunction<typeof tenantRuntimeClient.getToolCatalog>;

const BASE_INPUT = {
  role: 'Sales Analyst',
  responsibilities: 'Analyze CRM data and generate weekly reports',
  integrations: [{ id: 'int-1', name: 'Salesforce', type: 'salesforce', selectedObjects: ['Contact', 'Opportunity'] }],
  tenantId: 'tenant-1',
};

function agentResponse(steps: Array<Record<string, unknown>>): LLMCompletionResponse {
  return {
    content: '', model: 'test-model', provider: 'anthropic', stopReason: 'tool_use',
    toolCalls: [{
      id: 'call-1', name: 'produce_agent',
      input: {
        summary: 'Automated CRM pipeline.',
        systemPrompt: 'You are a workflow executor for CRM sync.',
        userInstructions: 'Step 1: Read contacts. Step 2: Write report.',
        instructionsMd: '## Role\nWorkflow executor.\n\n## Tool-use guidance\nUse tools as specified.',
        triggerConfig: { type: 'cron', cronExpr: '0 9 * * 1', reasoning: 'Weekly Monday morning' },
        workflowSteps: steps,
      },
    }],
  };
}
function patchResponse(edits: unknown): LLMCompletionResponse {
  return {
    content: '', model: 'patch-model', provider: 'anthropic', stopReason: 'tool_use',
    usage: { inputTokens: 100, outputTokens: 20 },
    toolCalls: [{ id: 'p1', name: PATCH_TOOL_NAME, input: { edits } }],
  };
}
function setupCatalog() {
  mockGetManifests.mockResolvedValue({
    schemaVersion: 1 as const,
    manifests: [{ manifestId: 'mf-1', connectorType: 'salesforce', alias: 'salesforce_prod', displayName: 'Salesforce Prod' }],
  });
  mockGetCatalog.mockResolvedValue({
    schemaVersion: 1 as const, connectorType: 'salesforce', alias: 'salesforce_prod',
    tools: [
      { name: 'salesforce_prod__read_contacts', description: 'Read contacts', input_schema: { type: 'object', properties: {} } },
      { name: 'salesforce_prod__read_contracts', description: 'Read contracts', input_schema: { type: 'object', properties: {} } },
      { name: 'salesforce_prod__create_report', description: 'Create report', input_schema: { type: 'object', properties: {} } },
    ],
  });
}
const GOOD_STEP_2 = {
  stepId: 'step_2', description: 'Create report', type: 'tool_call', toolName: 'salesforce_prod__create_report',
  onSuccess: '', onFailure: '', expectedOutput: 'a short summary of what was done and what it found',
};
const rows = () => mockRecord.mock.calls.map((c) => c[0]);

beforeEach(() => {
  jest.clearAllMocks();
  mockComplete.mockReset();
  mockAsk.mockReset();
  delete process.env.DISTILL_BIND_ENABLED;
  delete process.env.DISTILL_PATCH_ENABLED;
});

describe('the bind rung inside the distill loop', () => {
  it('a deterministic rebind ends the attempt: no ask, no patch call, no bind row, the log line', async () => {
    setupCatalog();
    mockComplete.mockResolvedValueOnce(agentResponse([
      // Case and separators differ from the catalog key; everything else is valid.
      { stepId: 'step_1', description: 'Read contacts', type: 'tool_call', toolName: 'Salesforce_Prod__Read-Contacts', onSuccess: 'step_2', onFailure: 'step_2' },
      GOOD_STEP_2,
    ]));

    const result = await distillInternalAgentWithProgress(BASE_INPUT);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(mockAsk).not.toHaveBeenCalled();
    expect(result.workflowSteps?.[0].toolName).toBe('salesforce_prod__read_contacts');
    expect(rows().find((r) => r.phase === 'bind')).toBeUndefined();
    expect(rows().find((r) => r.phase === 'patch')).toBeUndefined();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'distill.rebind', stepId: 'step_1', from: 'Salesforce_Prod__Read-Contacts', to: 'salesforce_prod__read_contacts', by: 'exact', attempt: 1 }),
      expect.any(String),
    );
  });

  it('fuzzy candidates go to Jev; a confident answer rebinds and one bind row is written with provider typesafe', async () => {
    setupCatalog();
    mockComplete.mockResolvedValueOnce(agentResponse([
      // One edit from read_contacts AND within two of read_contracts: two candidates.
      { stepId: 'step_1', description: 'Read contacts', type: 'tool_call', toolName: 'salesforce_prod__read_contact', onSuccess: 'step_2', onFailure: 'step_2' },
      GOOD_STEP_2,
    ]));
    mockAsk.mockResolvedValueOnce({
      answers: { binding: { type: 'choice', choice: 'salesforce_prod__read_contacts', confidence: 1, probabilities: { 'salesforce_prod__read_contacts': 0.9, 'salesforce_prod__read_contracts': 0.08, none: 0.02 } } },
      model: 'jev-1.13.0', usage: { inputTokens: 400, outputTokens: 0 }, callId: 'c', attempts: 1, latencyMs: 90,
    });

    const result = await distillInternalAgentWithProgress(BASE_INPUT);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(result.workflowSteps?.[0].toolName).toBe('salesforce_prod__read_contacts');
    const bindRow = rows().find((r) => r.phase === 'bind');
    expect(bindRow).toMatchObject({
      phase: 'bind', branch: 'graph', outcome: 'ok', attempt: 1, provider: 'typesafe', model: 'jev-1.13.0',
      usage: { inputTokens: 400, outputTokens: 0 },
    });
    expect(bindRow?.runId).toBe(rows().find((r) => r.phase === 'single')?.runId);
    expect(rows().find((r) => r.phase === 'patch')).toBeUndefined();
  });

  it('the patch rung runs on what remains after a bind', async () => {
    setupCatalog();
    mockComplete
      .mockResolvedValueOnce(agentResponse([
        // A rebindable name AND a missing onFailure: the rejection is mixed, so
        // the bind pass does not run; the patch rung handles the whole rejection.
        { stepId: 'step_1', description: 'Read contacts', type: 'tool_call', toolName: 'Salesforce_Prod__Read_Contacts', onSuccess: 'step_2' },
        GOOD_STEP_2,
      ]))
      .mockResolvedValueOnce(patchResponse([
        { stepId: 'step_1', field: 'onFailure', value: 'step_2' },
        { stepId: 'step_1', field: 'toolName', value: 'salesforce_prod__read_contacts' },
      ]));

    const result = await distillInternalAgentWithProgress(BASE_INPUT);

    expect(mockAsk).not.toHaveBeenCalled();
    expect(mockLog.info).not.toHaveBeenCalledWith(expect.objectContaining({ metric: 'distill.rebind' }), expect.any(String));
    expect(mockComplete.mock.calls[1][0].tools?.[0].name).toBe(PATCH_TOOL_NAME);
    expect(result.workflowSteps?.[0].toolName).toBe('salesforce_prod__read_contacts');
    expect(result.workflowSteps?.[0].onFailure).toBe('step_2');
  });

  it('DISTILL_BIND_ENABLED=0 takes today\'s path: the patch rung sees the unknown tool', async () => {
    process.env.DISTILL_BIND_ENABLED = '0';
    setupCatalog();
    mockComplete
      .mockResolvedValueOnce(agentResponse([
        { stepId: 'step_1', description: 'Read contacts', type: 'tool_call', toolName: 'Salesforce_Prod__Read_Contacts', onSuccess: 'step_2', onFailure: 'step_2' },
        GOOD_STEP_2,
      ]))
      .mockResolvedValueOnce(patchResponse([{ stepId: 'step_1', field: 'toolName', value: 'salesforce_prod__read_contacts' }]));

    await distillInternalAgentWithProgress(BASE_INPUT);

    expect(mockAsk).not.toHaveBeenCalled();
    expect(mockLog.info).not.toHaveBeenCalledWith(expect.objectContaining({ metric: 'distill.rebind' }), expect.any(String));
    expect(mockComplete).toHaveBeenCalledTimes(2);
    expect(mockComplete.mock.calls[1][0].tools?.[0].name).toBe(PATCH_TOOL_NAME);
  });
});
