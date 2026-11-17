// Fault Injection Tests
// Per Section 22 Phase 3: Explicitly test fault scenarios

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import { pool } from '../../src/infrastructure/database';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8080';

/**
 * Per Section 22 Phase 3: And explicitly test:
 * - worker dies before checkpoint commit
 * - worker dies after external write but before internal commit
 * - Cloud Tasks duplicate delivery
 * - stale or out-of-order entitlement event
 * - lease expiry race
 * - connector conflict during writeback
 * - timeout with unknown external side-effect state
 */

describe('Fault Injection Tests', () => {
  const api = request(API_BASE_URL);
  let testTenantId: string;
  let testWorkflowId: string;
  let testTaskId: string;

  beforeEach(async () => {
    testTenantId = `test-tenant-${Date.now()}`;

    // Create test workflow
    const response = await api
      .post('/api/v1/workflows')
      .send({
        tenantId: testTenantId,
        agentId: 'test-agent',
        objective: 'Test fault injection',
      });
    testWorkflowId = response.body.id;

    // Create test task
    const taskResponse = await api
      .post(`/api/coordinator/workflows/${testWorkflowId}/tasks`)
      .send({
        type: 'execute',
        description: 'Test task',
      });
    testTaskId = taskResponse.body.id;
  });

  afterEach(async () => {
    // Cleanup
    if (testWorkflowId) {
      await pool.query('DELETE FROM workflows WHERE id = $1', [testWorkflowId]);
    }
  });

  describe('Worker Crash Scenarios', () => {
    it('should recover when worker dies before checkpoint commit', async () => {
      // Per Section 7: On crash or restart, coordinator scans leased and incomplete tasks

      // Step 1: Acquire lease on task
      const leaseResponse = await api
        .post(`/api/coordinator/tasks/${testTaskId}/lease`)
        .send({ workerId: 'worker-1' })
        .expect(200);

      expect(leaseResponse.body.leaseId).toBeDefined();

      // Step 2: Simulate work in progress (no checkpoint saved)
      await pool.query(
        `UPDATE workflow_tasks SET status = 'running', lease_id = $1 WHERE id = $2`,
        [leaseResponse.body.leaseId, testTaskId]
      );

      // Step 3: Simulate worker crash by expiring the lease
      await pool.query(
        `UPDATE workflow_tasks SET lease_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`,
        [testTaskId]
      );

      // Step 4: Run recovery/reconciliation
      const recoveryResponse = await api
        .post('/api/v1/reconciliations')
        .expect(200);

      expect(recoveryResponse.body.recoveredTasks).toContain(testTaskId);

      // Step 5: Verify task is back to pending state
      const taskResponse = await api
        .get(`/api/coordinator/tasks/${testTaskId}`)
        .expect(200);

      expect(taskResponse.body.status).toBe('pending');
      expect(taskResponse.body.leaseId).toBeNull();
    });

    it('should recover when worker dies after external write but before internal commit', async () => {
      // Per Section 7: Reconciles by idempotency key and persisted action state
      // Per Section 7: Determines whether the side effect already happened

      const idempotencyKey = `idem-${Date.now()}`;

      // Step 1: Create action intent
      const actionResponse = await api
        .post('/api/action-ledger/intent')
        .send({
          tenantId: testTenantId,
          workflowId: testWorkflowId,
          taskId: testTaskId,
          idempotencyKey,
          connector: 'salesforce',
          entityType: 'Lead',
          actionType: 'update',
          payload: { Status: 'Contacted' },
        })
        .expect(201);

      const actionId = actionResponse.body.id;

      // Step 2: Simulate external write succeeded but internal commit failed
      await pool.query(
        `UPDATE actions SET
         external_response = $1,
         status = 'external_completed'
         WHERE id = $2`,
        [JSON.stringify({ success: true, recordId: 'sf-123' }), actionId]
      );

      // Step 3: Run reconciliation
      await api
        .post('/api/v1/reconciliations')
        .expect(200);

      // Step 4: Verify action was completed correctly
      const finalActionResponse = await api
        .get(`/api/action-ledger/${actionId}`)
        .expect(200);

      expect(finalActionResponse.body.status).toBe('completed');
      expect(finalActionResponse.body.externalResponse.success).toBe(true);

      // Step 5: Verify idempotent retry doesn't execute again
      const retryResponse = await api
        .post('/api/v1/tool-calls')
        .send({
          tenantId: testTenantId,
          agentId: 'test-agent',
          workflowId: testWorkflowId,
          idempotencyKey,
          connector: 'salesforce',
          entityType: 'Lead',
          actionType: 'update',
          payload: { Status: 'Contacted' },
        })
        .expect(200);

      // Should return existing action, not create new one
      expect(retryResponse.body.actionId).toBe(actionId);
      expect(retryResponse.body.idempotentHit).toBe(true);
    });
  });

  describe('Cloud Tasks Duplicate Delivery', () => {
    it('should handle duplicate task delivery idempotently', async () => {
      // Per Section 7: Handlers must be idempotent

      const idempotencyKey = `task-delivery-${Date.now()}`;

      // Deliver same task twice with same idempotency key
      const delivery1 = await api
        .post('/api/coordinator/tasks/deliver')
        .send({
          taskId: testTaskId,
          idempotencyKey,
          deliveryAttempt: 1,
        })
        .expect(200);

      const delivery2 = await api
        .post('/api/coordinator/tasks/deliver')
        .send({
          taskId: testTaskId,
          idempotencyKey,
          deliveryAttempt: 2, // Simulating Cloud Tasks retry
        })
        .expect(200);

      // Both should succeed but only one execution
      expect(delivery1.body.executionId).toBeDefined();
      expect(delivery2.body.executionId).toBe(delivery1.body.executionId);
      expect(delivery2.body.duplicate).toBe(true);

      // Verify task was only executed once
      const taskHistory = await api
        .get(`/api/coordinator/tasks/${testTaskId}/history`)
        .expect(200);

      const executions = taskHistory.body.filter(
        (h: Record<string, unknown>) => h.eventType === 'task.executed'
      );
      expect(executions.length).toBe(1);
    });
  });

  describe('Entitlement Event Handling', () => {
    it('should reject stale entitlement events', async () => {
      // Per Section 4: The runtime stores the latest applied entity_version
      // and discards stale events

      // First, apply a newer version
      await api
        .post('/api/events/entitlement')
        .send({
          tenantId: testTenantId,
          entityVersion: 5,
          entitlements: { maxActiveAgents: 10 },
        })
        .expect(200);

      // Now try to apply an older version
      const staleResponse = await api
        .post('/api/events/entitlement')
        .send({
          tenantId: testTenantId,
          entityVersion: 3, // Older version
          entitlements: { maxActiveAgents: 5 },
        })
        .expect(200);

      expect(staleResponse.body.applied).toBe(false);
      expect(staleResponse.body.reason).toBe('stale_version');

      // Verify current entitlements are from version 5
      const currentResponse = await api
        .get(`/api/tenant-api/entitlements?tenantId=${testTenantId}`)
        .expect(200);

      expect(currentResponse.body.maxActiveAgents).toBe(10);
      expect(currentResponse.body.entityVersion).toBe(5);
    });

    it('should handle out-of-order entitlement events', async () => {
      // Per Section 4: That is the mechanism that protects you from
      // out-of-order or redelivered Pub/Sub messages

      const tenant = `out-of-order-${Date.now()}`;

      // Receive v3 first (out of order)
      await api
        .post('/api/events/entitlement')
        .send({
          tenantId: tenant,
          entityVersion: 3,
          entitlements: { maxActiveWorkflows: 30 },
        })
        .expect(200);

      // Receive v2 (should be discarded)
      const v2Response = await api
        .post('/api/events/entitlement')
        .send({
          tenantId: tenant,
          entityVersion: 2,
          entitlements: { maxActiveWorkflows: 20 },
        })
        .expect(200);

      expect(v2Response.body.applied).toBe(false);

      // Receive v1 (should be discarded)
      const v1Response = await api
        .post('/api/events/entitlement')
        .send({
          tenantId: tenant,
          entityVersion: 1,
          entitlements: { maxActiveWorkflows: 10 },
        })
        .expect(200);

      expect(v1Response.body.applied).toBe(false);

      // Verify v3 is still active
      const currentResponse = await api
        .get(`/api/tenant-api/entitlements?tenantId=${tenant}`)
        .expect(200);

      expect(currentResponse.body.maxActiveWorkflows).toBe(30);
    });
  });

  describe('Lease Expiry', () => {
    it('should handle lease expiry race conditions', async () => {
      // Per Section 7: Leases protect against concurrent execution

      // Step 1: Worker A acquires lease
      const leaseA = await api
        .post(`/api/coordinator/tasks/${testTaskId}/lease`)
        .send({ workerId: 'worker-A', leaseDurationMs: 1000 })
        .expect(200);

      // Step 2: Wait for lease to expire
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Step 3: Worker B acquires lease (should succeed)
      const leaseB = await api
        .post(`/api/coordinator/tasks/${testTaskId}/lease`)
        .send({ workerId: 'worker-B' })
        .expect(200);

      expect(leaseB.body.leaseId).not.toBe(leaseA.body.leaseId);

      // Step 4: Worker A tries to commit (should fail)
      const commitA = await api
        .post(`/api/coordinator/tasks/${testTaskId}/complete`)
        .send({
          leaseId: leaseA.body.leaseId,
          result: { success: true },
        })
        .expect(409); // Conflict

      expect(commitA.body.error).toContain('lease');

      // Step 5: Worker B can still commit successfully
      const commitB = await api
        .post(`/api/coordinator/tasks/${testTaskId}/complete`)
        .send({
          leaseId: leaseB.body.leaseId,
          result: { success: true },
        })
        .expect(200);

      expect(commitB.body.status).toBe('completed');
    });
  });

  describe('Connector Conflicts', () => {
    it('should handle connector conflict during writeback with compare-and-set', async () => {
      // Per Section 11: Conflict-policy registry

      const entityId = `sf-lead-${Date.now()}`;

      // Step 1: Read record and get version
      const readResponse = await api
        .post('/api/v1/tool-calls')
        .send({
          tenantId: testTenantId,
          agentId: 'test-agent',
          workflowId: testWorkflowId,
          idempotencyKey: `read-${Date.now()}`,
          connector: 'salesforce',
          entityType: 'Lead',
          actionType: 'read',
          entityId,
        })
        .expect(200);

      const originalVersion = readResponse.body.versionToken;

      // Step 2: Simulate external modification (version bump)
      // In real test, this would be done via Salesforce API
      await pool.query(
        `UPDATE connector_records
         SET version_token = $1, updated_at = NOW()
         WHERE external_id = $2`,
        ['new-version-token', entityId]
      );

      // Step 3: Write with stale version
      const writeResponse = await api
        .post('/api/v1/tool-calls')
        .send({
          tenantId: testTenantId,
          agentId: 'test-agent',
          workflowId: testWorkflowId,
          idempotencyKey: `write-${Date.now()}`,
          connector: 'salesforce',
          entityType: 'Lead',
          actionType: 'update',
          entityId,
          payload: { Status: 'Qualified' },
          versionToken: originalVersion, // Stale version
        })
        .expect(200);

      // Should detect conflict and handle per policy
      expect(writeResponse.body.conflict).toBe(true);
      expect(['escalated', 'retried', 'merged']).toContain(writeResponse.body.resolution);
    });

    it('should escalate on conflict when policy requires', async () => {
      const entityId = `conflict-escalate-${Date.now()}`;

      // Create conflict scenario
      const response = await api
        .post('/api/v1/tool-calls')
        .send({
          tenantId: testTenantId,
          agentId: 'test-agent',
          workflowId: testWorkflowId,
          idempotencyKey: `conflict-${Date.now()}`,
          connector: 'hubspot',
          entityType: 'Deal',
          actionType: 'update',
          entityId,
          payload: { amount: 50000 },
          simulateConflict: true, // Test flag
        })
        .expect(200);

      if (response.body.conflict) {
        // Verify escalation was created
        const escalations = await api
          .get(`/api/coordinator/workflows/${testWorkflowId}/escalations`)
          .expect(200);

        const conflictEscalation = escalations.body.find(
          (e: { reason?: string }) => e.reason?.includes('conflict') ?? false
        );
        expect(conflictEscalation).toBeDefined();
      }
    });
  });

  describe('Timeout Scenarios', () => {
    it('should handle timeout with unknown external side-effect state', async () => {
      // Per Section 19: Verify external-system state before resuming unfinished work

      const idempotencyKey = `timeout-${Date.now()}`;

      // Step 1: Start action that will timeout
      const actionResponse = await api
        .post('/api/action-ledger/intent')
        .send({
          tenantId: testTenantId,
          workflowId: testWorkflowId,
          taskId: testTaskId,
          idempotencyKey,
          connector: 'salesforce',
          entityType: 'Lead',
          actionType: 'create',
          payload: { Name: 'Timeout Test Lead' },
        })
        .expect(201);

      const actionId = actionResponse.body.id;

      // Step 2: Simulate timeout (mark as unknown state)
      await pool.query(
        `UPDATE actions SET status = 'unknown', error = 'Timeout waiting for external response' WHERE id = $1`,
        [actionId]
      );

      // Step 3: Run recovery with external state verification
      await api
        .post('/api/v1/reconciliations')
        .send({ verifyExternalState: true })
        .expect(200);

      // Step 4: Check that external state was verified
      const actionAfterRecovery = await api
        .get(`/api/action-ledger/${actionId}`)
        .expect(200);

      // Action should now have definitive status
      expect(['completed', 'failed']).toContain(actionAfterRecovery.body.status);
      expect(actionAfterRecovery.body.externalStateVerified).toBe(true);
    });

    it('should not retry if external write already succeeded', async () => {
      const idempotencyKey = `timeout-success-${Date.now()}`;

      // Create action in unknown state but simulate external success
      const actionResponse = await api
        .post('/api/action-ledger/intent')
        .send({
          tenantId: testTenantId,
          workflowId: testWorkflowId,
          taskId: testTaskId,
          idempotencyKey,
          connector: 'salesforce',
          entityType: 'Lead',
          actionType: 'create',
          payload: { Name: 'Already Created Lead' },
        })
        .expect(201);

      const actionId = actionResponse.body.id;

      // Simulate: timeout occurred but external write actually succeeded
      await pool.query(
        `UPDATE actions SET
         status = 'unknown',
         external_response = $1
         WHERE id = $2`,
        [JSON.stringify({ success: true, recordId: 'sf-already-created' }), actionId]
      );

      // Recovery should recognize the write succeeded
      await api.post('/api/v1/reconciliations').expect(200);

      const finalAction = await api
        .get(`/api/action-ledger/${actionId}`)
        .expect(200);

      expect(finalAction.body.status).toBe('completed');
      expect(finalAction.body.retryCount).toBe(0); // No retry needed
    });
  });
});
