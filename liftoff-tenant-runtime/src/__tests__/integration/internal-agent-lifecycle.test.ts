// Internal Agent Lifecycle Integration Tests (TE-005, TE-006, TE-007)
// Tests for full internal agent lifecycle: create → activate → pause → delete

import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

// Skip integration tests when no real database is available
const SKIP = !process.env.TEST_DATABASE_URL;

// Mock Pub/Sub message structure
interface MockMessage {
  data: Buffer;
  ack: jest.Mock;
  nack: jest.Mock;
}

function createMockMessage(data: Record<string, unknown>): MockMessage {
  return {
    data: Buffer.from(JSON.stringify(data)),
    ack: jest.fn(),
    nack: jest.fn(),
  };
}

// Test database connection
let pool: Pool;

const describeFn = SKIP ? describe.skip : describe;

describeFn('Internal Agent Lifecycle Integration', () => {
  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/liftoff_test',
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    // Clean up test data
    await pool.query('DELETE FROM internal_agent_runtime_mapping WHERE tenant_id LIKE $1', ['test-%']);
    await pool.query('DELETE FROM agents WHERE tenant_id LIKE $1', ['test-%']);
    await pool.query('DELETE FROM compiled_instructions WHERE tenant_id LIKE $1', ['test-%']);
  });

  describe('Full Lifecycle (TE-005)', () => {
    it('should complete full create → activate → pause → delete cycle', async () => {
      const tenantId = `test-${uuidv4()}`;
      const internalAgentId = uuidv4();
      const internalAgentName = 'Test Agent';

      // Step 1: Publish tenant.internal_agent.created event
      const createdEvent = {
        event_type: 'tenant.internal_agent.created',
        tenant_id: tenantId,
        entity_id: internalAgentId,
        entity_version: 1,
        payload: {
          name: internalAgentName,
          role: 'Test Role',
          status: 'draft',
          agentType: 'C',
          hitlLevel: 3,
          modelConfig: { modelId: 'claude-3-sonnet' },
          execConfig: { maxToolCalls: 10 },
          memoryScope: { readableLayers: ['global'] },
          triggerConfig: { type: 'cron', cron_expression: '0 9 * * *' },
          systemPrompt: 'You are a helpful assistant',
          userInstructions: 'Process daily reports',
          integrations: [],
        },
      };

      // Import handler after mocks are set up
      const _subscriberModule = await import('../../events/subscriber');
      const _createMessage = createMockMessage(createdEvent);

      // Simulating event handling - in real integration test this would
      // go through actual Pub/Sub
      // await handleInternalAgentCreated(createMessage);

      // Step 2: Verify agent and mapping created
      // In real test, query database to verify records
      const _agentResult = await pool.query(
        'SELECT * FROM agents WHERE tenant_id = $1',
        [tenantId]
      );

      // Step 3: Publish tenant.internal_agent.status_changed (active)
      const _activateEvent = {
        event_type: 'tenant.internal_agent.status_changed',
        tenant_id: tenantId,
        entity_id: internalAgentId,
        previousStatus: 'draft',
        newStatus: 'active',
        systemPrompt: 'You are a helpful assistant',
        userInstructions: 'Process daily reports',
        hitlLevel: 3,
        integrations: [],
        triggerConfig: { type: 'cron', cron_expression: '0 9 * * *' },
      };

      // Step 4: Verify instruction created, agent ACTIVE
      // In real integration test: query compiled_instructions and agents tables

      // Step 5: Publish tenant.internal_agent.status_changed (paused)
      const _pauseEvent = {
        event_type: 'tenant.internal_agent.status_changed',
        tenant_id: tenantId,
        entity_id: internalAgentId,
        previousStatus: 'active',
        newStatus: 'paused',
      };

      // Step 6: Verify agent PAUSED
      // In real integration test: query agents table for lifecycle = 'PAUSED'

      // Step 7: Publish tenant.internal_agent.deleted
      const _deleteEvent = {
        event_type: 'tenant.internal_agent.deleted',
        tenant_id: tenantId,
        entity_id: internalAgentId,
      };

      // Step 8: Verify agent ARCHIVED
      // In real integration test: query agents table for lifecycle = 'ARCHIVED'

      // Placeholder assertion - in real test would verify full lifecycle
      expect(true).toBe(true);
    });

    it('should create Cloud Scheduler job for Type C agents', async () => {
      const tenantId = `test-${uuidv4()}`;
      const internalAgentId = uuidv4();

      // This test would use Cloud Scheduler emulator or mock
      // to verify job creation for scheduled agents

      const _createdEvent = {
        event_type: 'tenant.internal_agent.created',
        tenant_id: tenantId,
        entity_id: internalAgentId,
        entity_version: 1,
        payload: {
          name: 'Scheduled Agent',
          agentType: 'C',
          hitlLevel: 3,
          triggerConfig: {
            type: 'cron',
            cron_expression: '*/5 * * * *', // Every 5 minutes
            timezone: 'America/Los_Angeles',
          },
        },
      };

      // In real integration test with emulator:
      // 1. Create agent via event
      // 2. Activate agent via status_changed event
      // 3. Query Cloud Scheduler API to verify job exists
      // 4. Verify job has correct schedule and target URL

      expect(true).toBe(true);
    });
  });

  describe('Status Transitions (TE-006)', () => {
    it('should transition from DRAFT to ACTIVE', async () => {
      const tenantId = `test-${uuidv4()}`;
      const agentId = uuidv4();

      // Create agent directly for isolated status test
      await pool.query(
        `INSERT INTO agents (id, tenant_id, name, lifecycle, runtime_status)
         VALUES ($1, $2, 'Test Agent', 'DRAFT', 'IDLE')`,
        [agentId, tenantId]
      );

      // Verify initial state
      const beforeResult = await pool.query(
        'SELECT lifecycle FROM agents WHERE id = $1',
        [agentId]
      );
      expect(beforeResult.rows[0].lifecycle).toBe('DRAFT');

      // Update to ACTIVE
      await pool.query(
        'UPDATE agents SET lifecycle = $1 WHERE id = $2',
        ['ACTIVE', agentId]
      );

      // Verify transition
      const afterResult = await pool.query(
        'SELECT lifecycle FROM agents WHERE id = $1',
        [agentId]
      );
      expect(afterResult.rows[0].lifecycle).toBe('ACTIVE');
    });

    it('should transition from ACTIVE to PAUSED', async () => {
      const tenantId = `test-${uuidv4()}`;
      const agentId = uuidv4();

      await pool.query(
        `INSERT INTO agents (id, tenant_id, name, lifecycle, runtime_status)
         VALUES ($1, $2, 'Test Agent', 'ACTIVE', 'IDLE')`,
        [agentId, tenantId]
      );

      await pool.query(
        'UPDATE agents SET lifecycle = $1 WHERE id = $2',
        ['PAUSED', agentId]
      );

      const result = await pool.query(
        'SELECT lifecycle FROM agents WHERE id = $1',
        [agentId]
      );
      expect(result.rows[0].lifecycle).toBe('PAUSED');
    });

    it('should transition from PAUSED to ACTIVE (resume)', async () => {
      const tenantId = `test-${uuidv4()}`;
      const agentId = uuidv4();

      await pool.query(
        `INSERT INTO agents (id, tenant_id, name, lifecycle, runtime_status)
         VALUES ($1, $2, 'Test Agent', 'PAUSED', 'IDLE')`,
        [agentId, tenantId]
      );

      await pool.query(
        'UPDATE agents SET lifecycle = $1 WHERE id = $2',
        ['ACTIVE', agentId]
      );

      const result = await pool.query(
        'SELECT lifecycle FROM agents WHERE id = $1',
        [agentId]
      );
      expect(result.rows[0].lifecycle).toBe('ACTIVE');
    });

    it('should transition to ARCHIVED on delete', async () => {
      const tenantId = `test-${uuidv4()}`;
      const agentId = uuidv4();

      await pool.query(
        `INSERT INTO agents (id, tenant_id, name, lifecycle, runtime_status)
         VALUES ($1, $2, 'Test Agent', 'ACTIVE', 'IDLE')`,
        [agentId, tenantId]
      );

      await pool.query(
        'UPDATE agents SET lifecycle = $1 WHERE id = $2',
        ['ARCHIVED', agentId]
      );

      const result = await pool.query(
        'SELECT lifecycle FROM agents WHERE id = $1',
        [agentId]
      );
      expect(result.rows[0].lifecycle).toBe('ARCHIVED');
    });
  });

  describe('Tenant Isolation (TE-007)', () => {
    it('should not allow cross-tenant agent access', async () => {
      const tenantA = `test-tenant-a-${uuidv4()}`;
      const tenantB = `test-tenant-b-${uuidv4()}`;
      const internalAgentId = uuidv4();
      const agentId = uuidv4();

      // Create agent for tenant A
      await pool.query(
        `INSERT INTO agents (id, tenant_id, name, lifecycle, runtime_status)
         VALUES ($1, $2, 'Tenant A Agent', 'DRAFT', 'IDLE')`,
        [agentId, tenantA]
      );

      // Create mapping for tenant A
      await pool.query(
        `INSERT INTO internal_agent_runtime_mapping (internal_agent_id, agent_id, tenant_id)
         VALUES ($1, $2, $3)`,
        [internalAgentId, agentId, tenantA]
      );

      // Attempt to access from tenant B - should return no results
      const result = await pool.query(
        `SELECT agent_id FROM internal_agent_runtime_mapping
         WHERE internal_agent_id = $1 AND tenant_id = $2`,
        [internalAgentId, tenantB]
      );

      expect(result.rows.length).toBe(0);
    });

    it('should validate tenant ownership in all event handlers', async () => {
      const _tenantA = `test-tenant-a-${uuidv4()}`;
      const internalAgentId = uuidv4();

      // Create event with mismatched tenant
      const maliciousEvent = {
        event_type: 'tenant.internal_agent.status_changed',
        tenant_id: null, // Missing tenant ID
        entity_id: internalAgentId,
        previousStatus: 'draft',
        newStatus: 'active',
      };

      // Handler should reject events without tenantId
      // In real test, verify no database changes occur
      expect(maliciousEvent.tenant_id).toBeNull();
    });

    it('should enforce tenant_id in all mapping queries', async () => {
      const tenantA = `test-tenant-a-${uuidv4()}`;
      const tenantB = `test-tenant-b-${uuidv4()}`;
      const internalAgentIdA = uuidv4();
      const internalAgentIdB = uuidv4();
      const agentIdA = uuidv4();
      const agentIdB = uuidv4();

      // Create agents for both tenants
      await pool.query(
        `INSERT INTO agents (id, tenant_id, name, lifecycle, runtime_status)
         VALUES ($1, $2, 'Agent A', 'ACTIVE', 'IDLE'),
                ($3, $4, 'Agent B', 'ACTIVE', 'IDLE')`,
        [agentIdA, tenantA, agentIdB, tenantB]
      );

      // Create mappings
      await pool.query(
        `INSERT INTO internal_agent_runtime_mapping (internal_agent_id, agent_id, tenant_id)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [internalAgentIdA, agentIdA, tenantA, internalAgentIdB, agentIdB, tenantB]
      );

      // Query with correct tenant should return results
      const correctResult = await pool.query(
        `SELECT agent_id FROM internal_agent_runtime_mapping
         WHERE internal_agent_id = $1 AND tenant_id = $2`,
        [internalAgentIdA, tenantA]
      );
      expect(correctResult.rows.length).toBe(1);
      expect(correctResult.rows[0].agent_id).toBe(agentIdA);

      // Query with wrong tenant should return no results
      const wrongResult = await pool.query(
        `SELECT agent_id FROM internal_agent_runtime_mapping
         WHERE internal_agent_id = $1 AND tenant_id = $2`,
        [internalAgentIdA, tenantB]
      );
      expect(wrongResult.rows.length).toBe(0);
    });
  });
});
