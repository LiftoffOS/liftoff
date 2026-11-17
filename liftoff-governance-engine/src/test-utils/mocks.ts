// Shared Mock Factories for Unit Tests
// Provides consistent mock objects for testing services

import { Pool, QueryResultRow } from 'pg';

// ==========================================
// Database Pool Mock Factory
// ==========================================

export interface MockQueryResult<T extends QueryResultRow = any> {
  rows: T[];
  rowCount: number;
}

export type MockQueryFn = jest.Mock<Promise<MockQueryResult>, [string, any[]?]>;

export function createMockPool(): {
  pool: jest.Mocked<Pool>;
  mockQuery: MockQueryFn;
} {
  const mockQuery: MockQueryFn = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

  const pool = {
    query: mockQuery,
    connect: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
  } as unknown as jest.Mocked<Pool>;

  return { pool, mockQuery };
}

// Configure mock query to return specific results based on query patterns
export function configureMockQuery(
  mockQuery: MockQueryFn,
  patterns: Array<{ pattern: RegExp | string; result: MockQueryResult }>
): void {
  mockQuery.mockImplementation(async (sql: string) => {
    for (const { pattern, result } of patterns) {
      if (typeof pattern === 'string' ? sql.includes(pattern) : pattern.test(sql)) {
        return result;
      }
    }
    return { rows: [], rowCount: 0 };
  });
}

// ==========================================
// Workflow Mock Factory
// ==========================================

export interface MockWorkflow {
  id: string;
  tenantId: string;
  agentId: string;
  objective: string;
  status: string;
  compensationState: any;
  finalOutcome: any;
  createdAt: Date;
  updatedAt: Date;
}

export function createMockWorkflow(overrides: Partial<MockWorkflow> = {}): MockWorkflow {
  return {
    id: 'wf-test-123',
    tenantId: 'tenant-test-456',
    agentId: 'agent-test-789',
    objective: 'Test workflow objective',
    status: 'pending',
    compensationState: null,
    finalOutcome: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

// Convert to database row format
export function workflowToDbRow(workflow: MockWorkflow): Record<string, any> {
  return {
    id: workflow.id,
    tenant_id: workflow.tenantId,
    agent_id: workflow.agentId,
    objective: workflow.objective,
    status: workflow.status,
    compensation_state: workflow.compensationState,
    final_outcome: workflow.finalOutcome,
    created_at: workflow.createdAt,
    updated_at: workflow.updatedAt,
  };
}

// ==========================================
// Agent Mock Factory
// ==========================================

export interface MockAgent {
  id: string;
  tenantId: string;
  name: string;
  instructionId: string | null;
  lifecycle: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  runtimeStatus: 'IDLE' | 'RUNNING' | 'WAITING_FOR_EVENT' | 'WAITING_FOR_HUMAN' | 'STOPPING' | 'FAILED';
  triggerConfig?: { type: 'cron' | 'event' | 'manual'; cronExpr?: string; eventTopic?: string; [key: string]: any } | null;
  createdAt: Date;
  updatedAt: Date;
}

export function createMockAgent(overrides: Partial<MockAgent> = {}): MockAgent {
  return {
    id: 'agent-test-123',
    tenantId: 'tenant-test-456',
    name: 'Test Agent',
    instructionId: null,
    lifecycle: 'DRAFT',
    runtimeStatus: 'IDLE',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function agentToDbRow(agent: MockAgent): Record<string, any> {
  return {
    id: agent.id,
    tenant_id: agent.tenantId,
    name: agent.name,
    instruction_id: agent.instructionId,
    lifecycle: agent.lifecycle,
    runtime_status: agent.runtimeStatus,
    trigger_config: agent.triggerConfig ?? null,
    created_at: agent.createdAt,
    updated_at: agent.updatedAt,
  };
}

// ==========================================
// Action Mock Factory
// ==========================================

export interface MockAction {
  id: string;
  tenantId: string;
  agentId: string;
  workflowId: string;
  taskId: string;
  idempotencyKey: string;
  connector: string;
  entityType: string;
  actionType: string;
  targetRef: string;
  preActionSnapshot: any;
  externalResponse: any;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'compensated';
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export function createMockAction(overrides: Partial<MockAction> = {}): MockAction {
  return {
    id: 'action-test-123',
    tenantId: 'tenant-test-456',
    agentId: 'agent-test-789',
    workflowId: 'wf-test-123',
    taskId: 'task-test-456',
    idempotencyKey: 'idem-key-123',
    connector: 'salesforce',
    entityType: 'Account',
    actionType: 'update',
    targetRef: 'account-ref-123',
    preActionSnapshot: { Name: 'Old Name' },
    externalResponse: null,
    status: 'pending',
    error: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    completedAt: null,
    ...overrides,
  };
}

export function actionToDbRow(action: MockAction): Record<string, any> {
  return {
    id: action.id,
    tenant_id: action.tenantId,
    agent_id: action.agentId,
    workflow_id: action.workflowId,
    task_id: action.taskId,
    idempotency_key: action.idempotencyKey,
    connector: action.connector,
    entity_type: action.entityType,
    action_type: action.actionType,
    target_ref: action.targetRef,
    pre_action_snapshot: action.preActionSnapshot,
    external_response: action.externalResponse,
    status: action.status,
    error: action.error,
    created_at: action.createdAt,
    completed_at: action.completedAt,
  };
}

// ==========================================
// Task Mock Factory
// ==========================================

export interface MockTask {
  id: string;
  workflowId: string;
  agentId: string;
  status: 'pending' | 'leased' | 'running' | 'completed' | 'failed' | 'compensated';
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

export function createMockTask(overrides: Partial<MockTask> = {}): MockTask {
  return {
    id: 'task-test-123',
    workflowId: 'wf-test-123',
    agentId: 'agent-test-789',
    status: 'pending',
    leaseId: null,
    leaseExpiresAt: null,
    idempotencyKey: 'task-idem-123',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function taskToDbRow(task: MockTask): Record<string, any> {
  return {
    id: task.id,
    workflow_id: task.workflowId,
    agent_id: task.agentId,
    status: task.status,
    lease_id: task.leaseId,
    lease_expires_at: task.leaseExpiresAt,
    idempotency_key: task.idempotencyKey,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  };
}

// ==========================================
// Child Task Mock Factory
// ==========================================

export interface MockChildTask {
  id: string;
  parentTaskId: string;
  workflowId: string;
  taskType: 'subtask' | 'subworkflow';
  objective: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result: any;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export function createMockChildTask(overrides: Partial<MockChildTask> = {}): MockChildTask {
  return {
    id: 'child-task-test-123',
    parentTaskId: 'task-test-123',
    workflowId: 'wf-test-123',
    taskType: 'subtask',
    objective: 'Child task objective',
    status: 'pending',
    result: null,
    error: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    completedAt: null,
    ...overrides,
  };
}

export function childTaskToDbRow(childTask: MockChildTask): Record<string, any> {
  return {
    id: childTask.id,
    parent_task_id: childTask.parentTaskId,
    workflow_id: childTask.workflowId,
    task_type: childTask.taskType,
    objective: childTask.objective,
    status: childTask.status,
    result: childTask.result,
    error: childTask.error,
    created_at: childTask.createdAt,
    updated_at: childTask.updatedAt,
    completed_at: childTask.completedAt,
  };
}

// ==========================================
// Workflow Hierarchy Mock Factory
// ==========================================

export interface MockWorkflowHierarchy {
  workflowId: string;
  parentWorkflowId: string | null;
  depth: number;
  rootWorkflowId: string;
}

export function createMockWorkflowHierarchy(overrides: Partial<MockWorkflowHierarchy> = {}): MockWorkflowHierarchy {
  return {
    workflowId: 'wf-test-123',
    parentWorkflowId: null,
    depth: 0,
    rootWorkflowId: 'wf-test-123',
    ...overrides,
  };
}

export function workflowHierarchyToDbRow(hierarchy: MockWorkflowHierarchy): Record<string, any> {
  return {
    workflow_id: hierarchy.workflowId,
    parent_workflow_id: hierarchy.parentWorkflowId,
    depth: hierarchy.depth,
    root_workflow_id: hierarchy.rootWorkflowId,
  };
}

// ==========================================
// Tenant Quotas Mock Factory
// Phase 2: credit-only fields, capacity caps removed
// ==========================================

export interface MockTenantQuotas {
  remainingCredits: number;
  overageAllowed: boolean;
  overageCeiling: number;
  includedMonthlyCredits: number;
}

export function createMockTenantQuotas(overrides: Partial<MockTenantQuotas> = {}): MockTenantQuotas {
  return {
    includedMonthlyCredits: 10000,
    overageCeiling: 5000,
    remainingCredits: 5000,
    overageAllowed: true,
    ...overrides,
  };
}

export function tenantQuotasToDbRow(quotas: MockTenantQuotas): Record<string, any> {
  return {
    included_monthly_credits: quotas.includedMonthlyCredits,
    overage_ceiling: quotas.overageCeiling,
    remaining_credits: quotas.remainingCredits,
    overage_allowed: quotas.overageAllowed,
  };
}

// ==========================================
// Execute Input Mock Factory (Tool Gateway)
// ==========================================

export interface MockExecuteInput {
  tenantId: string;
  agentId: string;
  instructionVersion: number;
  traceId: string;
  idempotencyKey: string;
  connector: string;
  entityType: string;
  actionType: string;
  payload: any;
  snapshot?: any;
  estimatedCredits?: number;
}

export function createMockExecuteInput(overrides: Partial<MockExecuteInput> = {}): MockExecuteInput {
  return {
    tenantId: 'tenant-test-456',
    agentId: 'agent-test-789',
    instructionVersion: 1,
    traceId: 'trace-test-123',
    idempotencyKey: 'idem-key-123',
    connector: 'salesforce',
    entityType: 'Account',
    actionType: 'update',
    payload: { Name: 'New Name', id: 'account-123' },
    snapshot: { Name: 'Old Name', SystemModstamp: '2024-01-01T00:00:00Z' },
    ...overrides,
  };
}

// ==========================================
// Conflict Policy Mock Factory
// ==========================================

export interface MockConflictPolicy {
  connector: string;
  entityType: string;
  actionType: string;
  freshnessTTL: number | null;
  freshReadBeforeWriteRequired: boolean;
  versionTokenField: string | null;
  fieldComparisonSet: string[];
  conflictResolutionMode: 'compare-and-set' | 'fresh-read-before-write' | 'last-write-wins' | 'escalate-on-conflict' | 'merge';
  escalateOnConflict: boolean;
  undoSupportMode: 'full' | 'partial' | 'none';
}

export function createMockConflictPolicy(overrides: Partial<MockConflictPolicy> = {}): MockConflictPolicy {
  return {
    connector: 'salesforce',
    entityType: 'Account',
    actionType: 'update',
    freshnessTTL: 60,
    freshReadBeforeWriteRequired: true,
    versionTokenField: 'SystemModstamp',
    fieldComparisonSet: ['Name', 'Industry', 'AnnualRevenue'],
    conflictResolutionMode: 'compare-and-set',
    escalateOnConflict: true,
    undoSupportMode: 'partial',
    ...overrides,
  };
}

// ==========================================
// Compensation Plan Mock Factory
// ==========================================

export interface MockCompensationPlan {
  workflowId: string;
  reason: string;
  actions: Array<{
    actionId: string;
    compensationType: 'reverse' | 'restore' | 'semantic' | 'manual';
    order: number;
    status: 'pending' | 'executing' | 'completed' | 'failed' | 'skipped';
  }>;
  status: 'pending' | 'executing' | 'completed' | 'partial' | 'failed';
  createdAt: Date;
  completedAt: Date | null;
}

export function createMockCompensationPlan(overrides: Partial<MockCompensationPlan> = {}): MockCompensationPlan {
  return {
    workflowId: 'wf-test-123',
    reason: 'Test compensation',
    actions: [
      {
        actionId: 'action-test-123',
        compensationType: 'restore',
        order: 0,
        status: 'pending',
      },
    ],
    status: 'pending',
    createdAt: new Date('2024-01-01T00:00:00Z'),
    completedAt: null,
    ...overrides,
  };
}

// ==========================================
// Entitlement Mock Factory
// ==========================================

export interface MockEntitlement {
  operationalStatus: string;
  agentExecutionAllowed: boolean;
}

export function createMockEntitlement(overrides: Partial<MockEntitlement> = {}): MockEntitlement {
  return {
    operationalStatus: 'active',
    agentExecutionAllowed: true,
    ...overrides,
  };
}

export function entitlementToDbRow(entitlement: MockEntitlement): Record<string, any> {
  return {
    operational_status: entitlement.operationalStatus,
    agent_execution_allowed: entitlement.agentExecutionAllowed,
  };
}

// ==========================================
// Logger Mock
// ==========================================

export function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

// ==========================================
// Pub/Sub Mock
// ==========================================

export function createMockPubSub() {
  const mockMessage = {
    ack: jest.fn(),
    nack: jest.fn(),
  };

  const mockSubscription = {
    on: jest.fn(),
    close: jest.fn(),
  };

  const mockTopic = {
    publish: jest.fn().mockResolvedValue('message-id-123'),
    publishMessage: jest.fn().mockResolvedValue('message-id-123'),
    subscription: jest.fn().mockReturnValue(mockSubscription),
  };

  const pubsub = {
    topic: jest.fn().mockReturnValue(mockTopic),
    subscription: jest.fn().mockReturnValue(mockSubscription),
    createTopic: jest.fn().mockResolvedValue([mockTopic]),
    createSubscription: jest.fn().mockResolvedValue([mockSubscription]),
  };

  return { pubsub, mockTopic, mockSubscription, mockMessage };
}

// ==========================================
// Cloud Tasks Mock
// ==========================================

export function createMockCloudTasks() {
  const mockTask = {
    name: 'projects/test/locations/us-central1/queues/test-queue/tasks/task-123',
  };

  const client = {
    createTask: jest.fn().mockResolvedValue([mockTask]),
    deleteTask: jest.fn().mockResolvedValue([]),
    queuePath: jest.fn().mockReturnValue('projects/test/locations/us-central1/queues/test-queue'),
  };

  return { client, mockTask };
}

// ==========================================
// Vertex AI Mock
// ==========================================

export function createMockVertexAI() {
  const mockResponse = {
    response: {
      candidates: [
        {
          content: {
            parts: [{ text: 'Mock AI response' }],
          },
        },
      ],
    },
  };

  const mockGenerativeModel = {
    generateContent: jest.fn().mockResolvedValue(mockResponse),
    generateContentStream: jest.fn().mockResolvedValue({
      stream: [],
      response: mockResponse.response,
    }),
  };

  const client = {
    preview: {
      getGenerativeModel: jest.fn().mockReturnValue(mockGenerativeModel),
    },
    getGenerativeModel: jest.fn().mockReturnValue(mockGenerativeModel),
  };

  return { client, mockGenerativeModel, mockResponse };
}

// ==========================================
// External State Mock Factory
// ==========================================

export interface MockExternalState {
  data: any;
  fetchedAt: Date;
  versionToken?: string;
  etag?: string;
}

export function createMockExternalState(overrides: Partial<MockExternalState> = {}): MockExternalState {
  return {
    data: { Name: 'Current Name', SystemModstamp: '2024-01-02T00:00:00Z' },
    fetchedAt: new Date(),
    versionToken: '2024-01-02T00:00:00Z',
    ...overrides,
  };
}

// ==========================================
// Credential Service Mock
// ==========================================

export function createMockCredentialService() {
  return {
    getCredentials: jest.fn().mockResolvedValue({
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      instanceUrl: 'https://mock.salesforce.com',
      expiresAt: new Date(Date.now() + 3600000),
    }),
  };
}
