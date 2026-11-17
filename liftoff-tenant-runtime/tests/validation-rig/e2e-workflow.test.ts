// Validation Rig - End-to-End Workflow Test
// Per Section 23: Before the entire platform is declared "done," run one real
// design-partner workflow end to end

import { describe, it, beforeAll, afterAll, expect } from '@jest/globals';
import request from 'supertest';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080';

/**
 * Per Section 23: Validation rig must test:
 * - instruction compile
 * - preview/approval
 * - activation
 * - tool gateway
 * - action ledger
 * - undo
 * - escalation
 * - reflection
 *
 * This tests the two biggest unknowns:
 * - whether compilation matches real customer intent
 * - whether connector/tool behavior is correct against real external systems
 */

describe('E2E Workflow Validation', () => {
  let tenantId: string;
  let agentId: string;
  let workflowId: string;
  let instructionId: string;
  let actionId: string;

  const api = request(API_BASE_URL);

  beforeAll(async () => {
    // Setup test tenant and agent
    tenantId = 'test-tenant-' + Date.now();
    agentId = 'test-agent-' + Date.now();

    // Ensure test entitlements are cached
    await api.post('/api/tenant-api/cache/entitlements').send({
      tenantId,
      entitlements: {
        maxActiveAgents: 10,
        maxActiveWorkflows: 100,
        maxActionsPerMinute: 1000,
        includedCredits: 10000,
        overageAllowed: true,
      },
    });
  });

  afterAll(async () => {
    // Cleanup test data
    if (workflowId) {
      await api.delete(`/api/coordinator/workflows/${workflowId}`);
    }
    if (agentId) {
      await api.delete(`/api/agents/${agentId}`);
    }
  });

  describe('Instruction Compile', () => {
    it('should compile customer instructions into internal DSL', async () => {
      // Per Section 9: Customer submits JSON + free text
      const input = {
        tenantId,
        agentId,
        structuredInput: {
          triggers: [{ type: 'webhook', config: { path: '/api/incoming' } }],
          connectors: ['salesforce'],
          actions: ['read', 'update'],
        },
        freeTextInstructions: 'When a new lead comes in, update the CRM record with the qualification status',
      };

      const response = await api
        .post('/api/instruction-compiler/compile')
        .send(input)
        .expect(200);

      expect(response.body.version).toBe(1);
      expect(response.body.triggers).toHaveLength(1);
      expect(response.body.triggers[0].type).toBe('webhook');
      expect(response.body.allowedConnectors).toContain('salesforce');
      expect(response.body.allowedActions).toContain('read');
      expect(response.body.allowedActions).toContain('update');

      instructionId = response.body.id;
    });

    it('should validate instruction schema', async () => {
      const response = await api
        .post('/api/instruction-compiler/validate')
        .send({ instructionId })
        .expect(200);

      expect(response.body.valid).toBe(true);
      expect(response.body.errors).toHaveLength(0);
    });
  });

  describe('Preview and Approval', () => {
    it('should generate preview with progressive disclosure', async () => {
      // Per Section 10: Preview UX contract with 4 levels
      const response = await api
        .post('/api/instruction-compiler/preview')
        .send({ instructionId })
        .expect(200);

      // Level 1: Plain-language summary
      expect(response.body.summary).toBeDefined();
      expect(typeof response.body.summary).toBe('string');
      expect(response.body.summary.length).toBeGreaterThan(10);

      // Level 2: Systems accessed/written, key triggers
      expect(response.body.systemsAccessed).toBeDefined();
      expect(Array.isArray(response.body.systemsAccessed)).toBe(true);
      expect(response.body.systemsWrittenTo).toBeDefined();
      expect(response.body.keyTriggers).toBeDefined();

      // Level 3: Detailed scopes, escalation, approval rules
      expect(response.body.detailedScopes).toBeDefined();
      expect(response.body.escalationRules).toBeDefined();
      expect(response.body.approvalRules).toBeDefined();

      // Level 4: Concrete example scenarios
      expect(response.body.exampleScenarios).toBeDefined();
      expect(Array.isArray(response.body.exampleScenarios)).toBe(true);
    });

    it('should submit for approval', async () => {
      const response = await api
        .post(`/api/instruction-compiler/${instructionId}/submit-for-approval`)
        .expect(200);

      expect(response.body.status).toBe('pending_approval');
    });

    it('should allow customer approval', async () => {
      // Per Section 9: Step 7 - customer approves
      const response = await api
        .post(`/api/instruction-compiler/${instructionId}/approve`)
        .set('x-user-id', 'test-approver')
        .expect(200);

      expect(response.body.status).toBe('approved');
    });
  });

  describe('Agent Activation', () => {
    it('should create agent in DRAFT state', async () => {
      const response = await api
        .post('/api/agents')
        .send({
          tenantId,
          name: 'Test Sales Agent',
          instructionId,
        })
        .expect(201);

      expect(response.body.lifecycleState).toBe('DRAFT');
      expect(response.body.runtimeStatus).toBe('IDLE');
      agentId = response.body.id;
    });

    it('should activate agent after approval', async () => {
      // Per Section 8: Agent may move from DRAFT to ACTIVE
      const response = await api
        .post(`/api/agents/${agentId}/activate`)
        .expect(200);

      expect(response.body.lifecycleState).toBe('ACTIVE');
    });

    it('should verify audit log for activation', async () => {
      const response = await api
        .get(`/api/agents/${agentId}/audit-log`)
        .expect(200);

      const activationLog = response.body.find(
        (log: { field?: string; newValue?: string }) => log.field === 'lifecycleState' && log.newValue === 'ACTIVE'
      );
      expect(activationLog).toBeDefined();
    });
  });

  describe('Workflow Creation and Execution', () => {
    it('should create a workflow', async () => {
      const response = await api
        .post('/api/v1/workflows')
        .send({
          tenantId,
          agentId,
          objective: 'Update CRM lead qualification',
          triggerContext: {
            type: 'webhook',
            payload: { leadId: 'lead-123', status: 'qualified' },
          },
        })
        .expect(201);

      expect(response.body.status).toBe('pending');
      workflowId = response.body.id;
    });

    it('should start workflow execution', async () => {
      const response = await api
        .post(`/api/coordinator/workflows/${workflowId}/start`)
        .expect(200);

      expect(response.body.status).toBe('running');
    });
  });

  describe('Tool Gateway Execution', () => {
    it('should execute action through tool gateway with conflict checking', async () => {
      // Per Section 11: All external reads and writes go through tool-gateway
      const action = {
        tenantId,
        agentId,
        workflowId,
        instructionVersion: 1,
        traceId: `trace-${Date.now()}`,
        idempotencyKey: `idem-${Date.now()}`,
        connector: 'salesforce',
        entityType: 'Lead',
        actionType: 'update',
        entityId: 'lead-123',
        payload: { Status: 'Qualified' },
        preActionSnapshot: { Status: 'New' },
      };

      const response = await api
        .post('/api/v1/tool-calls')
        .send(action)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.actionId).toBeDefined();
      actionId = response.body.actionId;
    });

    it('should handle idempotent retry', async () => {
      // Per Section 7: Handlers must be idempotent
      const duplicateAction = {
        tenantId,
        agentId,
        workflowId,
        instructionVersion: 1,
        traceId: `trace-${Date.now()}`,
        idempotencyKey: `idem-duplicate-${Date.now()}`,
        connector: 'salesforce',
        entityType: 'Lead',
        actionType: 'update',
        entityId: 'lead-123',
        payload: { Status: 'Qualified' },
      };

      // First call
      const response1 = await api
        .post('/api/v1/tool-calls')
        .send(duplicateAction)
        .expect(200);

      // Second call with same idempotency key
      const response2 = await api
        .post('/api/v1/tool-calls')
        .send(duplicateAction)
        .expect(200);

      // Should return same result
      expect(response2.body.actionId).toBe(response1.body.actionId);
    });
  });

  describe('Action Ledger', () => {
    it('should record action in ledger', async () => {
      // Per Section 7: Persist action intent, idempotency key, outcome
      const response = await api
        .get(`/api/action-ledger/${actionId}`)
        .expect(200);

      expect(response.body.status).toBe('completed');
      expect(response.body.idempotencyKey).toBeDefined();
      expect(response.body.preActionSnapshot).toBeDefined();
      expect(response.body.externalResponse).toBeDefined();
    });

    it('should track action in workflow context', async () => {
      const response = await api
        .get(`/api/action-ledger/workflow/${workflowId}`)
        .expect(200);

      expect(response.body.length).toBeGreaterThan(0);
      const action = response.body.find((a: { id?: string }) => a.id === actionId);
      expect(action).toBeDefined();
    });
  });

  describe('Undo/Compensation', () => {
    it('should build compensation plan', async () => {
      // Per Section 7: Build compensation plan for a workflow
      const response = await api
        .post(`/api/action-ledger/workflows/${workflowId}/compensation/plan`)
        .send({ reason: 'Test undo operation' })
        .expect(201);

      expect(response.body.workflowId).toBe(workflowId);
      expect(response.body.actions).toBeDefined();
      expect(Array.isArray(response.body.actions)).toBe(true);
    });

    it('should support single action undo', async () => {
      // Per Section 11: Reversibility metadata, undo support mode
      const response = await api
        .post(`/api/action-ledger/${actionId}/compensate`)
        .send({ reason: 'Reverting test change' })
        .expect(200);

      expect(response.body.success).toBeDefined();
      expect(response.body.compensationType).toBeDefined();
    });
  });

  describe('Escalation', () => {
    let escalationId: string;

    it('should escalate to human when needed', async () => {
      // Per Section 6: Agents may escalate to humans
      // Per Section 7: workflow_escalations table
      const response = await api
        .post(`/api/coordinator/workflows/${workflowId}/escalate`)
        .send({
          reason: 'Approval required for high-value change',
          context: {
            changeValue: 50000,
            requiresApproval: true,
          },
        })
        .expect(201);

      expect(response.body.status).toBe('pending');
      expect(response.body.reason).toBe('Approval required for high-value change');
      escalationId = response.body.id;
    });

    it('should fetch pending escalations', async () => {
      const response = await api
        .get(`/api/coordinator/escalations/pending?tenantId=${tenantId}`)
        .expect(200);

      const escalation = response.body.find((e: { id?: string; eventType?: string }) => e.id === escalationId);
      expect(escalation).toBeDefined();
    });

    it('should handle human response', async () => {
      // Per Section 22 Phase 3: human response flow
      const response = await api
        .post(`/api/coordinator/escalations/${escalationId}/resolve`)
        .set('x-user-id', 'human-reviewer')
        .send({
          decision: 'approved',
          comment: 'Looks good, proceed with the change',
        })
        .expect(200);

      expect(response.body.status).toBe('resolved');
      expect(response.body.resolution).toBe('approved');
    });
  });

  describe('Evaluations', () => {
    it('should create an evaluation after workflow completion', async () => {
      // Complete the workflow first — POST /workflows/{id}/completions.
      await api
        .post(`/api/v1/workflows/${workflowId}/completions`)
        .send({ outcome: { success: true } })
        .expect(201);

      // Per Section 16: evaluations run after N successful runs.
      const response = await api
        .post('/api/v1/evaluations')
        .send({
          agentId,
          tenantId,
          triggerType: 'n_successful_runs',
        })
        .expect(201);

      expect(response.body.started).toBe(true);
      expect(response.body.reflectionId).toBeDefined();
    });

    it('should generate suggestions without auto-applying', async () => {
      // Per Section 16: it never auto-applies changes.
      await new Promise(resolve => setTimeout(resolve, 1000));

      const response = await api
        .get(`/api/v1/evaluations/suggestions?agentId=${agentId}`)
        .expect(200);

      // Response shape: { items: [...] }.
      for (const suggestion of response.body.items) {
        expect(suggestion.status).toBe('pending');
        expect(suggestion.appliedAt).toBeNull();
      }
    });

    it('should respect evaluation quotas', async () => {
      // Per Section 16: max evaluation runs per day per tenant.
      const response = await api
        .get(`/api/v1/evaluations/quotas/${tenantId}`)
        .expect(200);

      expect(response.body.dailyRunsLimit).toBeDefined();
      expect(response.body.dailyRunsUsed).toBeDefined();
      expect(response.body.dailyRunsUsed).toBeLessThanOrEqual(response.body.dailyRunsLimit);
    });
  });

  describe('Full Workflow Completion', () => {
    it('should have complete audit trail', async () => {
      const response = await api
        .get(`/api/coordinator/workflows/${workflowId}/audit`)
        .expect(200);

      // Verify complete lifecycle tracked
      const events = response.body.map((e: { id?: string; eventType?: string }) => e.eventType);
      expect(events).toContain('workflow.created');
      expect(events).toContain('workflow.started');
      expect(events).toContain('workflow.completed');
    });

    it('should have accurate usage tracking', async () => {
      const response = await api
        .get(`/api/usage-ledger/workflow/${workflowId}`)
        .expect(200);

      expect(response.body.totalCredits).toBeGreaterThan(0);
      expect(response.body.events.length).toBeGreaterThan(0);
    });
  });
});
