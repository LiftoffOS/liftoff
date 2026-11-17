// Agent Lifecycle Service Unit Tests
// Tests state transitions: DRAFT -> ACTIVE, ACTIVE -> PAUSED, etc.

import { AgentLifecycleService } from './service';
import { AgentRepository } from './repository';
import { pool } from '../infrastructure/database';
import {
  createMockAgent,
  agentToDbRow,
} from '../test-utils/mocks';

// Mock dependencies
jest.mock('../infrastructure/database');
jest.mock('../infrastructure/logging');
jest.mock('../scheduling/cloud-scheduler');
jest.mock('../scheduling/event-trigger');

import { pauseJob, deleteJob } from '../scheduling/cloud-scheduler';
import { deregisterEventAgent } from '../scheduling/event-trigger';

const mockPauseJob = pauseJob as jest.MockedFunction<typeof pauseJob>;
const mockDeleteJob = deleteJob as jest.MockedFunction<typeof deleteJob>;
const mockDeregisterEventAgent = deregisterEventAgent as jest.MockedFunction<typeof deregisterEventAgent>;

const mockPool = pool as jest.Mocked<typeof pool>;

// Mock client for pool.connect() transactions
const mockClient = {
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  release: jest.fn(),
};

describe('AgentLifecycleService', () => {
  let service: AgentLifecycleService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockClient.release.mockReset();
    (mockPool.connect as jest.Mock).mockResolvedValue(mockClient);
    mockPauseJob.mockResolvedValue(undefined);
    mockDeleteJob.mockResolvedValue(undefined);
    mockDeregisterEventAgent.mockReturnValue(undefined);
    service = new AgentLifecycleService();
  });

  // ==========================================
  // Agent Creation Tests
  // ==========================================

  describe('create', () => {
    it('should create agent in DRAFT lifecycle state', async () => {
      const mockAgent = createMockAgent({ lifecycle: 'DRAFT' });

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [agentToDbRow(mockAgent)],
        rowCount: 1,
      } as any);

      const result = await service.create({
        tenantId: 'tenant-123',
        name: 'Test Agent',
      });

      expect(result.lifecycle).toBe('DRAFT');
      expect(result.runtimeStatus).toBe('IDLE');
      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agents'),
        expect.arrayContaining(['tenant-123', 'Test Agent'])
      );
    });

    it('should create agent with IDLE runtime status', async () => {
      const mockAgent = createMockAgent({
        lifecycle: 'DRAFT',
        runtimeStatus: 'IDLE',
      });

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [agentToDbRow(mockAgent)],
        rowCount: 1,
      } as any);

      const result = await service.create({
        tenantId: 'tenant-123',
        name: 'New Agent',
      });

      expect(result.runtimeStatus).toBe('IDLE');
    });

    it('should set proper timestamps on creation', async () => {
      const now = new Date();
      const mockAgent = createMockAgent({
        createdAt: now,
        updatedAt: now,
      });

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [agentToDbRow(mockAgent)],
        rowCount: 1,
      } as any);

      const result = await service.create({
        tenantId: 'tenant-123',
        name: 'New Agent',
      });

      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });
  });

  // ==========================================
  // Agent Retrieval Tests
  // ==========================================

  describe('getById', () => {
    it('should return agent when found', async () => {
      const mockAgent = createMockAgent();

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [agentToDbRow(mockAgent)],
        rowCount: 1,
      } as any);

      const result = await service.getById('agent-test-123');

      expect(result).toBeDefined();
      expect(result?.id).toBe(mockAgent.id);
      expect(result?.name).toBe('Test Agent');
    });

    it('should return null when agent not found', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      const result = await service.getById('non-existent');

      expect(result).toBeNull();
    });

    it('should include all agent properties', async () => {
      const mockAgent = createMockAgent({
        id: 'agent-full-123',
        tenantId: 'tenant-456',
        name: 'Full Agent',
        instructionId: 'instruction-789',
        lifecycle: 'ACTIVE',
        runtimeStatus: 'RUNNING',
      });

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [agentToDbRow(mockAgent)],
        rowCount: 1,
      } as any);

      const result = await service.getById('agent-full-123');

      expect(result?.tenantId).toBe('tenant-456');
      expect(result?.instructionId).toBe('instruction-789');
      expect(result?.lifecycle).toBe('ACTIVE');
      expect(result?.runtimeStatus).toBe('RUNNING');
    });
  });

  // ==========================================
  // Lifecycle State Transition Tests
  // ==========================================

  describe('activate', () => {
    // Mock instruction row for findActiveByAgentId
    const mockInstructionRow = {
      id: 'instr-test-1',
      tenant_id: 'tenant-test-456',
      agent_id: 'agent-test-123',
      version: 1,
      status: 'active',
      instruction: '{}',
      validation_result: null,
      preview: null,
      created_at: new Date(),
      updated_at: new Date(),
      approved_at: null,
      approved_by: null,
      activated_at: new Date(),
      rejection_reason: null,
    };

    it('should transition agent from DRAFT to ACTIVE', async () => {
      const draftAgent = createMockAgent({ lifecycle: 'DRAFT' });

      (mockPool.query as jest.Mock)
        // Find agent
        .mockResolvedValueOnce({
          rows: [agentToDbRow(draftAgent)],
          rowCount: 1,
        } as any)
        // findActiveByAgentId (instruction check)
        .mockResolvedValueOnce({
          rows: [mockInstructionRow],
          rowCount: 1,
        } as any);

      // Transaction queries go through pool.connect() -> client
      (mockClient.query as jest.Mock)
        // BEGIN
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // Get current lifecycle
        .mockResolvedValueOnce({ rows: [{ lifecycle: 'DRAFT' }], rowCount: 1 })
        // Update lifecycle
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        // Audit log
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        // COMMIT
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await service.activate('agent-test-123');

      // Verify the UPDATE was called on the transaction client
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE agents SET lifecycle'),
        expect.arrayContaining(['agent-test-123', 'ACTIVE'])
      );
    });

    it('should throw error when agent not found', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      await expect(service.activate('non-existent')).rejects.toThrow('Agent not found');
    });

    it('should audit log the transition', async () => {
      const draftAgent = createMockAgent({ lifecycle: 'DRAFT' });

      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [agentToDbRow(draftAgent)], rowCount: 1 } as any)
        // findActiveByAgentId (instruction check)
        .mockResolvedValueOnce({ rows: [mockInstructionRow], rowCount: 1 } as any);

      (mockClient.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // BEGIN
        .mockResolvedValueOnce({ rows: [{ lifecycle: 'DRAFT' }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // UPDATE
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // AUDIT
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // COMMIT

      await service.activate('agent-test-123');

      // Verify audit log was inserted
      expect((mockClient.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agent_audit_log'),
        expect.arrayContaining(['agent-test-123', 'DRAFT', 'ACTIVE'])
      );
    });
  });

  describe('pause', () => {
    it('should transition agent to PAUSED state', async () => {
      const activeAgent = createMockAgent({ lifecycle: 'ACTIVE' });

      (mockPool.query as jest.Mock)
        // findById
        .mockResolvedValueOnce({ rows: [agentToDbRow(activeAgent)], rowCount: 1 } as any);

      (mockClient.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // BEGIN
        .mockResolvedValueOnce({ rows: [{ lifecycle: 'ACTIVE' }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // UPDATE
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // AUDIT
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // COMMIT

      await service.pause('agent-test-123');

      expect((mockClient.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE agents SET lifecycle'),
        expect.arrayContaining(['agent-test-123', 'PAUSED'])
      );
    });

    it('should audit log pause transition', async () => {
      const activeAgent = createMockAgent({ lifecycle: 'ACTIVE' });

      (mockPool.query as jest.Mock)
        // findById
        .mockResolvedValueOnce({ rows: [agentToDbRow(activeAgent)], rowCount: 1 } as any);

      (mockClient.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // BEGIN
        .mockResolvedValueOnce({ rows: [{ lifecycle: 'ACTIVE' }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // UPDATE
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // AUDIT
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // COMMIT

      await service.pause('agent-test-123');

      expect((mockClient.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agent_audit_log'),
        expect.arrayContaining(['agent-test-123', 'ACTIVE', 'PAUSED'])
      );
    });
  });

  describe('archive', () => {
    it('should transition agent to ARCHIVED state', async () => {
      const pausedAgent = createMockAgent({ lifecycle: 'PAUSED' });

      (mockPool.query as jest.Mock)
        // findById
        .mockResolvedValueOnce({ rows: [agentToDbRow(pausedAgent)], rowCount: 1 } as any);

      (mockClient.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // BEGIN
        .mockResolvedValueOnce({ rows: [{ lifecycle: 'PAUSED' }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // UPDATE
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // AUDIT
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // COMMIT

      await service.archive('agent-test-123');

      expect((mockClient.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE agents SET lifecycle'),
        expect.arrayContaining(['agent-test-123', 'ARCHIVED'])
      );
    });

    it('should audit log archive transition', async () => {
      const activeAgent = createMockAgent({ lifecycle: 'ACTIVE' });

      (mockPool.query as jest.Mock)
        // findById
        .mockResolvedValueOnce({ rows: [agentToDbRow(activeAgent)], rowCount: 1 } as any);

      (mockClient.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // BEGIN
        .mockResolvedValueOnce({ rows: [{ lifecycle: 'ACTIVE' }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // UPDATE
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // AUDIT
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // COMMIT

      await service.archive('agent-test-123');

      expect((mockClient.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agent_audit_log'),
        expect.arrayContaining(['agent-test-123', 'ACTIVE', 'ARCHIVED'])
      );
    });

    it('is an idempotent no-op (does not throw) when the agent is already tombstoned as DELETED', async () => {
      // Regression: the canonical-reconciler tombstones orphaned agents as
      // lifecycle='DELETED' (upstream internal agent deleted), then the
      // event-driven handleInternalAgentDeleted archives the same agent.
      // 'DELETED' is terminal (no outgoing transition), so archive() must
      // treat it as a no-op instead of throwing. Previously 'DELETED' had no
      // entry in VALID_LIFECYCLE_TRANSITIONS, so the validator did
      // undefined.includes(...) and threw — 500ing the shared
      // control-plane-events push subscription into an endless nack→DLQ→replay
      // loop.
      const deletedAgent = createMockAgent({ lifecycle: 'DELETED' });

      (mockPool.query as jest.Mock)
        // findById
        .mockResolvedValueOnce({ rows: [agentToDbRow(deletedAgent)], rowCount: 1 } as any);

      await expect(service.archive('agent-test-123')).resolves.toBeUndefined();

      // No lifecycle transition is written for an already-terminal agent —
      // the DB update transaction (on the pinned client) must not run.
      expect((mockClient.query as jest.Mock)).not.toHaveBeenCalledWith(
        expect.stringContaining('UPDATE agents SET lifecycle'),
        expect.anything()
      );
    });
  });

  // ==========================================
  // Runtime Status Tests
  // ==========================================

  describe('updateRuntimeStatus', () => {
    it('should update runtime status to RUNNING', async () => {
      const activeAgent = createMockAgent({ lifecycle: 'ACTIVE', runtimeStatus: 'IDLE' });

      (mockPool.query as jest.Mock)
        // findById
        .mockResolvedValueOnce({ rows: [agentToDbRow(activeAgent)], rowCount: 1 } as any)
        // updateRuntimeStatus
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await service.updateRuntimeStatus('agent-test-123', 'RUNNING');

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE agents SET runtime_status'),
        expect.arrayContaining(['agent-test-123', 'RUNNING'])
      );
    });

    it('should update runtime status to WAITING_FOR_EVENT', async () => {
      const activeAgent = createMockAgent({ lifecycle: 'ACTIVE', runtimeStatus: 'RUNNING' });

      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [agentToDbRow(activeAgent)], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await service.updateRuntimeStatus('agent-test-123', 'WAITING_FOR_EVENT');

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['WAITING_FOR_EVENT'])
      );
    });

    it('should update runtime status to WAITING_FOR_HUMAN', async () => {
      const activeAgent = createMockAgent({ lifecycle: 'ACTIVE', runtimeStatus: 'RUNNING' });

      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [agentToDbRow(activeAgent)], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await service.updateRuntimeStatus('agent-test-123', 'WAITING_FOR_HUMAN');

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['WAITING_FOR_HUMAN'])
      );
    });

    it('should update runtime status to STOPPING', async () => {
      const activeAgent = createMockAgent({ lifecycle: 'ACTIVE', runtimeStatus: 'RUNNING' });

      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [agentToDbRow(activeAgent)], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await service.updateRuntimeStatus('agent-test-123', 'STOPPING');

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['STOPPING'])
      );
    });

    it('should update runtime status to FAILED', async () => {
      const activeAgent = createMockAgent({ lifecycle: 'ACTIVE', runtimeStatus: 'RUNNING' });

      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [agentToDbRow(activeAgent)], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await service.updateRuntimeStatus('agent-test-123', 'FAILED');

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['FAILED'])
      );
    });

    it('should update runtime status to IDLE', async () => {
      const activeAgent = createMockAgent({ lifecycle: 'ACTIVE', runtimeStatus: 'STOPPING' });

      (mockPool.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [agentToDbRow(activeAgent)], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await service.updateRuntimeStatus('agent-test-123', 'IDLE');

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['IDLE'])
      );
    });
  });
});

// ==========================================
// AgentRepository Unit Tests
// ==========================================

describe('AgentRepository', () => {
  let repository: AgentRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockClient.release.mockReset();
    (mockPool.connect as jest.Mock).mockResolvedValue(mockClient);
    repository = new AgentRepository();
  });

  describe('create', () => {
    it('should insert agent with DRAFT lifecycle', async () => {
      const mockAgent = createMockAgent({ lifecycle: 'DRAFT' });

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [agentToDbRow(mockAgent)],
        rowCount: 1,
      } as any);

      const result = await repository.create({
        tenantId: 'tenant-123',
        name: 'New Agent',
      });

      expect(result.lifecycle).toBe('DRAFT');
      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining("'DRAFT'"),
        expect.any(Array)
      );
    });

    it('should insert agent with IDLE runtime status', async () => {
      const mockAgent = createMockAgent({ runtimeStatus: 'IDLE' });

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [agentToDbRow(mockAgent)],
        rowCount: 1,
      } as any);

      const result = await repository.create({
        tenantId: 'tenant-123',
        name: 'New Agent',
      });

      expect(result.runtimeStatus).toBe('IDLE');
      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining("'IDLE'"),
        expect.any(Array)
      );
    });
  });

  describe('findById', () => {
    it('should map database row to Agent type', async () => {
      const dbRow = {
        id: 'agent-123',
        tenant_id: 'tenant-456',
        name: 'Test Agent',
        instruction_id: 'inst-789',
        lifecycle: 'ACTIVE',
        runtime_status: 'RUNNING',
        created_at: new Date('2024-01-01'),
        updated_at: new Date('2024-01-02'),
      };

      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [dbRow],
        rowCount: 1,
      } as any);

      const result = await repository.findById('agent-123');

      expect(result?.id).toBe('agent-123');
      expect(result?.tenantId).toBe('tenant-456');
      expect(result?.instructionId).toBe('inst-789');
      expect(result?.lifecycle).toBe('ACTIVE');
      expect(result?.runtimeStatus).toBe('RUNNING');
      expect(result?.createdAt).toEqual(new Date('2024-01-01'));
      expect(result?.updatedAt).toEqual(new Date('2024-01-02'));
    });

    it('should return null for missing agent', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as any);

      const result = await repository.findById('missing');

      expect(result).toBeNull();
    });
  });

  describe('updateLifecycle', () => {
    it('should wrap update in transaction', async () => {
      const calls: string[] = [];

      (mockClient.query as jest.Mock).mockImplementation(async (sql: string) => {
        calls.push(sql);
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('SELECT lifecycle')) {
          return { rows: [{ lifecycle: 'DRAFT' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });

      await repository.updateLifecycle('agent-123', 'ACTIVE');

      expect(calls[0]).toBe('BEGIN');
      expect(calls[calls.length - 1]).toBe('COMMIT');
    });

    it('should rollback on error', async () => {
      const calls: string[] = [];

      (mockClient.query as jest.Mock).mockImplementation(async (sql: string) => {
        calls.push(sql);
        if (sql === 'BEGIN') {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('SELECT lifecycle')) {
          return { rows: [{ lifecycle: 'DRAFT' }], rowCount: 1 };
        }
        if (sql.includes('UPDATE agents')) {
          throw new Error('Database error');
        }
        if (sql === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(repository.updateLifecycle('agent-123', 'ACTIVE')).rejects.toThrow('Database error');

      expect(calls).toContain('ROLLBACK');
    });

    it('should record previous lifecycle in audit', async () => {
      (mockClient.query as jest.Mock)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // BEGIN
        .mockResolvedValueOnce({ rows: [{ lifecycle: 'PAUSED' }], rowCount: 1 } as any)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // UPDATE
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any) // AUDIT
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // COMMIT

      await repository.updateLifecycle('agent-123', 'ACTIVE');

      expect((mockClient.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agent_audit_log'),
        ['agent-123', 'PAUSED', 'ACTIVE']
      );
    });
  });

  describe('updateRuntimeStatus', () => {
    it('should update runtime status and timestamp', async () => {
      (mockPool.query as jest.Mock).mockResolvedValueOnce({
        rows: [],
        rowCount: 1,
      } as any);

      await repository.updateRuntimeStatus('agent-123', 'RUNNING');

      expect((mockPool.query as jest.Mock)).toHaveBeenCalledWith(
        expect.stringContaining('updated_at = NOW()'),
        ['agent-123', 'RUNNING']
      );
    });
  });
});

// ==========================================
// Agent Lifecycle State Machine Tests
// ==========================================

describe('Agent Lifecycle State Machine', () => {
  let service: AgentLifecycleService;

  // Mock instruction row for findActiveByAgentId
  const mockInstructionRow = {
    id: 'instr-test-1',
    tenant_id: 'tenant-test-456',
    agent_id: 'agent-123',
    version: 1,
    status: 'active',
    instruction: '{}',
    validation_result: null,
    preview: null,
    created_at: new Date(),
    updated_at: new Date(),
    approved_at: null,
    approved_by: null,
    activated_at: new Date(),
    rejection_reason: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockClient.release.mockReset();
    (mockPool.connect as jest.Mock).mockResolvedValue(mockClient);
    service = new AgentLifecycleService();
  });

  it('should follow DRAFT -> ACTIVE transition', async () => {
    const draftAgent = createMockAgent({ lifecycle: 'DRAFT' });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(draftAgent)], rowCount: 1 } as any) // findById
      .mockResolvedValueOnce({ rows: [mockInstructionRow], rowCount: 1 } as any); // findActiveByAgentId

    (mockClient.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // BEGIN
      .mockResolvedValueOnce({ rows: [{ lifecycle: 'DRAFT' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // COMMIT

    await expect(service.activate('agent-123')).resolves.not.toThrow();
  });

  it('should follow ACTIVE -> PAUSED transition', async () => {
    const activeAgent = createMockAgent({ lifecycle: 'ACTIVE' });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(activeAgent)], rowCount: 1 } as any); // findById

    (mockClient.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // BEGIN
      .mockResolvedValueOnce({ rows: [{ lifecycle: 'ACTIVE' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // COMMIT

    await expect(service.pause('agent-123')).resolves.not.toThrow();
  });

  it('should follow PAUSED -> ARCHIVED transition', async () => {
    const pausedAgent = createMockAgent({ lifecycle: 'PAUSED' });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(pausedAgent)], rowCount: 1 } as any); // findById

    (mockClient.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // BEGIN
      .mockResolvedValueOnce({ rows: [{ lifecycle: 'PAUSED' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // COMMIT

    await expect(service.archive('agent-123')).resolves.not.toThrow();
  });

  it('should support direct ACTIVE -> ARCHIVED transition', async () => {
    const activeAgent = createMockAgent({ lifecycle: 'ACTIVE' });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(activeAgent)], rowCount: 1 } as any); // findById

    (mockClient.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // BEGIN
      .mockResolvedValueOnce({ rows: [{ lifecycle: 'ACTIVE' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // COMMIT

    await expect(service.archive('agent-123')).resolves.not.toThrow();
  });
});

// ==========================================
// Runtime Status Transition Tests
// ==========================================

describe('Runtime Status Transitions', () => {
  let service: AgentLifecycleService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AgentLifecycleService();
  });

  it('should transition IDLE -> RUNNING', async () => {
    const agent = createMockAgent({ lifecycle: 'ACTIVE', runtimeStatus: 'IDLE' });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(agent)], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    await expect(
      service.updateRuntimeStatus('agent-123', 'RUNNING')
    ).resolves.not.toThrow();
  });

  it('should transition RUNNING -> WAITING_FOR_EVENT', async () => {
    const agent = createMockAgent({ lifecycle: 'ACTIVE', runtimeStatus: 'RUNNING' });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(agent)], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    await expect(
      service.updateRuntimeStatus('agent-123', 'WAITING_FOR_EVENT')
    ).resolves.not.toThrow();
  });

  it('should transition RUNNING -> WAITING_FOR_HUMAN', async () => {
    const agent = createMockAgent({ lifecycle: 'ACTIVE', runtimeStatus: 'RUNNING' });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(agent)], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    await expect(
      service.updateRuntimeStatus('agent-123', 'WAITING_FOR_HUMAN')
    ).resolves.not.toThrow();
  });

  it('should transition RUNNING -> STOPPING', async () => {
    const agent = createMockAgent({ lifecycle: 'ACTIVE', runtimeStatus: 'RUNNING' });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(agent)], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    await expect(
      service.updateRuntimeStatus('agent-123', 'STOPPING')
    ).resolves.not.toThrow();
  });

  it('should transition STOPPING -> IDLE', async () => {
    const agent = createMockAgent({ lifecycle: 'ACTIVE', runtimeStatus: 'STOPPING' });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(agent)], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    await expect(
      service.updateRuntimeStatus('agent-123', 'IDLE')
    ).resolves.not.toThrow();
  });

  it('should transition any state -> FAILED', async () => {
    const agent = createMockAgent({ lifecycle: 'ACTIVE', runtimeStatus: 'RUNNING' });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(agent)], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    await expect(
      service.updateRuntimeStatus('agent-123', 'FAILED')
    ).resolves.not.toThrow();
  });
});

// ==========================================
// Infrastructure Reconciliation on Retry
// Regression: pause/archive must reconcile Cloud Scheduler even on same-state no-ops.
// Previously, if DB committed PAUSED but pauseJob() threw, a Pub/Sub redelivery
// would see lifecycle=PAUSED→PAUSED (no-op) and skip pauseJob(), leaving the
// Cloud Scheduler job ENABLED indefinitely.
// ==========================================

describe('Infrastructure reconciliation on idempotent retries', () => {
  let service: AgentLifecycleService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
    mockClient.release.mockReset();
    (mockPool.connect as jest.Mock).mockResolvedValue(mockClient);
    mockPauseJob.mockResolvedValue(undefined);
    mockDeleteJob.mockResolvedValue(undefined);
    mockDeregisterEventAgent.mockReturnValue(undefined);
    service = new AgentLifecycleService();
  });

  it('pause() should call pauseJob even when agent is already PAUSED (cron)', async () => {
    const alreadyPausedAgent = createMockAgent({
      lifecycle: 'PAUSED',
      triggerConfig: { type: 'cron', cronExpr: '*/1 * * * *' },
    });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(alreadyPausedAgent)], rowCount: 1 } as any);

    await service.pause('agent-test-123');

    expect(mockPauseJob).toHaveBeenCalledWith('tenant-test-456', 'agent-test-123');
  });

  it('pause() should deregister event trigger even when agent is already PAUSED', async () => {
    const alreadyPausedAgent = createMockAgent({
      lifecycle: 'PAUSED',
      triggerConfig: { type: 'event', eventTopic: 'price.updated' },
    });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(alreadyPausedAgent)], rowCount: 1 } as any);

    await service.pause('agent-test-123');

    expect(mockDeregisterEventAgent).toHaveBeenCalledWith(
      'agent-test-123', 'tenant-test-456', 'price.updated'
    );
  });

  it('pause() should NOT update DB lifecycle when already PAUSED', async () => {
    const alreadyPausedAgent = createMockAgent({
      lifecycle: 'PAUSED',
      triggerConfig: { type: 'cron', cronExpr: '*/1 * * * *' },
    });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(alreadyPausedAgent)], rowCount: 1 } as any);

    await service.pause('agent-test-123');

    // Transaction client should NOT have been used (no DB update on no-op)
    expect(mockClient.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE agents SET lifecycle'),
      expect.anything()
    );
    // But pauseJob should still have been called
    expect(mockPauseJob).toHaveBeenCalledTimes(1);
  });

  it('archive() should call deleteJob even when agent is already ARCHIVED (cron)', async () => {
    const alreadyArchivedAgent = createMockAgent({
      lifecycle: 'ARCHIVED',
      triggerConfig: { type: 'cron', cronExpr: '*/1 * * * *' },
    });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(alreadyArchivedAgent)], rowCount: 1 } as any);

    await service.archive('agent-test-123');

    expect(mockDeleteJob).toHaveBeenCalledWith('tenant-test-456', 'agent-test-123');
  });

  it('archive() should deregister event trigger even when already ARCHIVED', async () => {
    const alreadyArchivedAgent = createMockAgent({
      lifecycle: 'ARCHIVED',
      triggerConfig: { type: 'event', eventTopic: 'price.updated' },
    });

    (mockPool.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [agentToDbRow(alreadyArchivedAgent)], rowCount: 1 } as any);

    await service.archive('agent-test-123');

    expect(mockDeregisterEventAgent).toHaveBeenCalledWith(
      'agent-test-123', 'tenant-test-456', 'price.updated'
    );
  });
});
