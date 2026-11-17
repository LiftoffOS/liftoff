/**
 * Phase 0 — shared-types package build + type surface smoke tests.
 *
 * These import from @liftoffos/shared-types as a consumer would. If the
 * package doesn't build or a canonical type is missing/renamed, these tests
 * fail and block the deploy.
 */

import {
  AGENT_TYPE_VALUES,
  isWorkflowDistillOutput,
  type AgentType,
  type DistillOutput,
  type ExecConfig,
  type MemoryScope,
  type ModelConfig,
  type TriggerConfig,
  type WorkflowStep,
  type WorkflowStepLoop,
  type WorkflowStepRetry,
  type ConnectorFunction,
  type ToolCategory,
  type LLMTool,
  type ToolCatalogResponse,
  type ManifestSummary,
  type TenantManifestsResponse,
  type DistillStage,
  type DistillProgressEvent,
  type DistillCompleteEvent,
  type DistillErrorEvent,
  type DistillErrorCode,
  type DistillStreamEvent,
  type InternalAgentCreatedPayload,
  type InternalAgentStatusChangedPayload,
  type InternalAgentRuntimeConfigUpdatedPayload,
} from '@liftoffos/shared-types';

describe('Phase 0 — @liftoffos/shared-types', () => {
  it('exposes the canonical AgentType values', () => {
    expect(AGENT_TYPE_VALUES).toEqual(['agent', 'workflow']);
  });

  it('AgentType literal union is { agent, workflow }', () => {
    // Compile-time check via assignability.
    const agent: AgentType = 'agent';
    const workflow: AgentType = 'workflow';
    expect(agent).toBe('agent');
    expect(workflow).toBe('workflow');
  });

  it('WorkflowStep uses camelCase field names', () => {
    const step: WorkflowStep = {
      stepId: 's1',
      description: 'read a record',
      toolName: 'salesforce_prod__read_record',
      toolInput: { id: 'abc' },
      onSuccess: 's2',
    };
    // These must exist at the type level.
    expect(step.stepId).toBe('s1');
    expect(step.toolName).toBe('salesforce_prod__read_record');
    expect(step.onSuccess).toBe('s2');
  });

  it('WorkflowStep supports loop configuration', () => {
    const loop: WorkflowStepLoop = { over: 'items', maxIterations: 10, collect: true };
    const retry: WorkflowStepRetry = { maxAttempts: 3, backoffMs: 1000 };
    const step: WorkflowStep = {
      stepId: 'map',
      description: 'iterate',
      toolName: 'slack__send',
      loop,
      retry,
      timeoutMs: 60000,
    };
    expect(step.loop?.over).toBe('items');
    expect(step.retry?.maxAttempts).toBe(3);
  });

  it('DistillOutput is a discriminated union — agent variant has no workflowSteps', () => {
    const agentOutput: DistillOutput = {
      agentType: 'agent',
      summary: 'x',
      systemPrompt: 'y',
      userInstructions: 'z',
      triggerConfig: { type: 'manual' },
    };
    expect(agentOutput.agentType).toBe('agent');
    expect(isWorkflowDistillOutput(agentOutput)).toBe(false);
    // @ts-expect-error — workflowSteps does not exist on the agent variant.
    const hasSteps = agentOutput.workflowSteps;
    expect(hasSteps).toBeUndefined();
  });

  it('DistillOutput is a discriminated union — workflow variant requires workflowSteps', () => {
    const workflowOutput: DistillOutput = {
      agentType: 'workflow',
      summary: 'x',
      systemPrompt: 'y',
      userInstructions: 'z',
      triggerConfig: { type: 'cron', cronExpr: '0 9 * * *' },
      workflowSteps: [
        { stepId: 's1', description: 'read', toolName: 'sheet__read' },
      ],
    };
    expect(workflowOutput.agentType).toBe('workflow');
    expect(isWorkflowDistillOutput(workflowOutput)).toBe(true);
    if (workflowOutput.agentType === 'workflow') {
      // TypeScript narrows here.
      expect(workflowOutput.workflowSteps).toHaveLength(1);
    }
  });

  it('ConnectorFunction categories enum has no legacy "sensitive" reference removed (per plan verification)', () => {
    const categories: ToolCategory[] = ['read', 'write', 'destructive', 'outbound', 'sensitive'];
    expect(categories).toContain('destructive');
  });

  it('SSE DistillErrorCode enumerates all planned error codes', () => {
    const codes: DistillErrorCode[] = [
      'validation_failed',
      'semantic_validation_failed',
      'llm_unavailable',
      'llm_budget_exhausted',
      'catalog_fetch_failed',
      'rate_limited',
      'too_many_integrations',
      'prompt_injection_detected',
      'unknown',
    ];
    expect(codes).toHaveLength(9);
  });

  it('Pub/Sub envelope payloads type-check', () => {
    const created: InternalAgentCreatedPayload = {
      internalAgentId: 'id',
      name: 'n',
      agentType: 'workflow',
      workflowSteps: [{ stepId: 's1', description: 'x' }],
      triggerConfig: { type: 'cron', cronExpr: '0 9 * * *' },
    };
    const changed: InternalAgentStatusChangedPayload = {
      internalAgentId: 'id',
      previousStatus: 'draft',
      newStatus: 'active',
      agentType: 'agent',
    };
    const updated: InternalAgentRuntimeConfigUpdatedPayload = {
      internalAgentId: 'id',
      agentType: 'agent',
    };
    expect(created.internalAgentId).toBe('id');
    expect(changed.newStatus).toBe('active');
    expect(updated.agentType).toBe('agent');
  });

  // Silence unused-warning for types referenced purely at the type level.
  it('covers all type-only exports in compilation', () => {
    const noop = <T>(): T => undefined as unknown as T;
    noop<ModelConfig>();
    noop<MemoryScope>();
    noop<ExecConfig>();
    noop<TriggerConfig>();
    noop<ConnectorFunction>();
    noop<LLMTool>();
    noop<ToolCatalogResponse>();
    noop<ManifestSummary>();
    noop<TenantManifestsResponse>();
    noop<DistillStage>();
    noop<DistillProgressEvent>();
    noop<DistillCompleteEvent>();
    noop<DistillErrorEvent>();
    noop<DistillStreamEvent>();
    expect(true).toBe(true);
  });
});
