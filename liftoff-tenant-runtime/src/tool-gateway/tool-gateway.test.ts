// Tool Gateway Service Unit Tests
// Tests conflict policy enforcement, write path validation, and merge resolution

import { ToolGatewayService } from './service';
import { AdmissionDeniedError } from '../admission/types';
import { ConflictPolicyRegistry } from './conflict-policy-registry';
import {
  createMockExecuteInput,
  createMockConflictPolicy,
  createMockExternalState,
  createMockCredentialService,
} from '../test-utils/mocks';

// Mock dependencies
const mockDbQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockDbPool = { query: mockDbQuery };

jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(() => mockDbPool),
  getPoolForService: jest.fn(() => mockDbPool),
  pool: new Proxy({} as any, {
    get(_, prop) {
      return (mockDbPool as any)[prop];
    },
  }),
}));
jest.mock('../infrastructure/logging');
jest.mock('../admission/service');
jest.mock('../action-ledger/service');
jest.mock('./state-fetcher', () => ({
  stateFetcherRegistry: {
    fetchState: jest.fn().mockResolvedValue({
      data: {},
      fetchedAt: new Date(),
    }),
  },
  ExternalStateFetcherRegistry: jest.fn(),
}));
jest.mock('./permission-validator', () => ({
  permissionValidator: {
    validate: jest.fn().mockResolvedValue({
      allowed: true,
      appliedEntry: { id: 'mock-policy' },
      allowedFields: ['*'],
    }),
  },
}));

// Phase 2b: all connector dispatch flows through the connector-service RPC.
// The tool-gateway now imports connector-service-client lazily; mock the
// module to avoid requiring CONNECTOR_SERVICE_URL in unit tests.
const mockRpcExecute = jest.fn().mockResolvedValue({
  success: true,
  result: { id: 'created-123', success: true },
  error: '',
  vendorLatencyMs: 0n,
  costUsd: 0,
});
jest.mock('../connectors/connector-service-client', () => ({
  getConnectorServiceClient: jest.fn(() => ({
    execute: mockRpcExecute,
  })),
  createConnectorServiceClient: jest.fn(() => ({
    execute: mockRpcExecute,
  })),
  resetSharedConnectorServiceClient: jest.fn(),
  getConnectorServiceMode: jest.fn(() => 'on'),
  isConnectorServiceEnabled: jest.fn(() => true),
  isShadowMode: jest.fn(() => false),
}));

// Mock global fetch for HTTP calls
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('ToolGatewayService', () => {
  let service: ToolGatewayService;
  let mockAdmissionService: any;
  let mockActionLedger: any;
  let mockStateFetcher: any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ToolGatewayService();

    // Setup mock admission service
    mockAdmissionService = {
      checkAdmission: jest.fn().mockResolvedValue({ allowed: true }),
    };
    (service as any).admissionService = mockAdmissionService;

    // Setup mock action ledger
    mockActionLedger = {
      getByIdempotencyKey: jest.fn().mockResolvedValue(null),  // No existing action by default
      recordIntent: jest.fn().mockResolvedValue('action-123'),
      recordOutcome: jest.fn().mockResolvedValue(undefined),
      recordFailure: jest.fn().mockResolvedValue(undefined),
      recordPostActionSnapshot: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).actionLedger = mockActionLedger;

    // Setup mock state fetcher
    mockStateFetcher = {
      fetchState: jest.fn().mockResolvedValue(createMockExternalState()),
    };
    (service as any).stateFetcher = mockStateFetcher;

    // Setup credential service
    service.setCredentialService(createMockCredentialService());

    // Setup mock fetch for HTTP calls
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => name === 'Content-Type' ? 'application/json' : null,
      },
      json: jest.fn().mockResolvedValue({ id: 'created-123', success: true }),
    });
  });

  // ==========================================
  // Identity Validation Tests
  // ==========================================

  describe('validateIdentity', () => {
    it('should throw error when tenantId is missing', async () => {
      const input = createMockExecuteInput({ tenantId: '' });

      await expect(service.execute(input)).rejects.toThrow('Tenant ID required');
    });

    it('should throw error when agentId is missing', async () => {
      const input = createMockExecuteInput({ agentId: '' });

      await expect(service.execute(input)).rejects.toThrow('Agent ID required');
    });

    it('should throw error when instructionVersion is missing', async () => {
      const input = createMockExecuteInput({ instructionVersion: 0 });

      await expect(service.execute(input)).rejects.toThrow('Instruction version required');
    });
  });

  // ==========================================
  // Admission Control Tests
  // ==========================================

  describe('admission control', () => {
    it('should allow action when admission passes', async () => {
      const input = createMockExecuteInput({ actionType: 'read' });

      const result = await service.execute(input);

      expect(result.success).toBe(true);
      expect(mockAdmissionService.checkAdmission).toHaveBeenCalledWith({
        tenantId: input.tenantId,
        agentId: input.agentId,
        checkType: 'action',
        requiredCredits: undefined,
      });
    });

    it('should reject action when admission fails', async () => {
      mockAdmissionService.checkAdmission.mockResolvedValue({
        allowed: false,
        reason: 'Tenant is suspended',
        quotaType: 'operational_status',
      });

      const input = createMockExecuteInput();

      await expect(service.execute(input)).rejects.toThrow('Action admission denied');
    });

    it('throws a typed AdmissionDeniedError on the connector path too', async () => {
      // Every admission gate throws the same type. When only the sandbox path
      // was typed, a connector denial still reached the model through the
      // message heuristic as `internal_error` — the same defect, one route over.
      mockAdmissionService.checkAdmission.mockResolvedValue({
        allowed: false,
        reason: 'Tenant is suspended for billing',
        quotaType: 'billing_suspended',
      });

      const input = createMockExecuteInput();

      await expect(service.execute(input)).rejects.toBeInstanceOf(AdmissionDeniedError);
      await expect(service.execute(input)).rejects.toMatchObject({
        reason: 'Tenant is suspended for billing',
        quotaType: 'billing_suspended',
        code: 'admission_denied',
      });
    });

    it('throws a typed AdmissionDeniedError on the sandbox path, carrying the reason', async () => {
      // The sandbox denial used to be a bare Error, so the model-facing
      // envelope classified it `internal_error` and the recovery LLM read a
      // policy decision as an infrastructure outage.
      mockAdmissionService.checkAdmission.mockResolvedValue({
        allowed: false,
        reason: 'Global freeze active: incident-4412',
        quotaType: 'global_freeze',
      });
      (service as any).sandboxExecutor = { execute: jest.fn() };

      const input = createMockExecuteInput({ connector: 'execution_environment' });

      await expect(service.execute(input)).rejects.toBeInstanceOf(AdmissionDeniedError);
      await expect(service.execute(input)).rejects.toMatchObject({
        reason: 'Global freeze active: incident-4412',
        quotaType: 'global_freeze',
        code: 'admission_denied',
      });
    });

    it('should pass estimated credits to admission check', async () => {
      const input = createMockExecuteInput({
        estimatedCredits: 100,
        actionType: 'read',
      });

      await service.execute(input);

      expect(mockAdmissionService.checkAdmission).toHaveBeenCalledWith(
        expect.objectContaining({
          requiredCredits: 100,
        })
      );
    });
  });

  // ==========================================
  // Conflict Policy Tests
  // ==========================================

  describe('getConflictPolicy', () => {
    it('should return specific policy for known connector/entity/action', async () => {
      const policy = await service.getConflictPolicy('salesforce', 'Account', 'update');

      expect(policy.connector).toBe('salesforce');
      expect(policy.entityType).toBe('Account');
      expect(policy.conflictResolutionMode).toBe('compare-and-set');
      expect(policy.versionTokenField).toBe('SystemModstamp');
    });

    it('should return default restrictive policy for unknown combinations', async () => {
      const policy = await service.getConflictPolicy('unknown', 'Unknown', 'update');

      expect(policy.connector).toBe('unknown');
      expect(policy.conflictResolutionMode).toBe('escalate-on-conflict');
      expect(policy.escalateOnConflict).toBe(true);
    });

    it('should return Slack policy with last-write-wins for messages', async () => {
      const policy = await service.getConflictPolicy('slack', 'Message', 'create');

      expect(policy.conflictResolutionMode).toBe('last-write-wins');
      expect(policy.freshReadBeforeWriteRequired).toBe(false);
    });
  });

  // ==========================================
  // Write Path Tests
  // ==========================================

  describe('executeWritePath', () => {
    it('should skip write path for read actions', async () => {
      const input = createMockExecuteInput({ actionType: 'read' });

      const result = await service.execute(input);

      expect(mockStateFetcher.fetchState).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should fetch external state for write actions', async () => {
      const input = createMockExecuteInput({ actionType: 'update' });
      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: { Name: 'Old Name', SystemModstamp: '2024-01-01T00:00:00Z' },
        })
      );

      await service.execute(input);

      expect(mockStateFetcher.fetchState).toHaveBeenCalled();
    });

    it('should throw error when snapshot is stale', async () => {
      const input = createMockExecuteInput({
        actionType: 'update',
        snapshot: { Name: 'Snapshot Name', SystemModstamp: '2024-01-01T00:00:00Z' },
      });

      // External state fetched 2 minutes ago (stale for 60s TTL)
      const staleDate = new Date(Date.now() - 120000);
      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: { Name: 'Current Name', SystemModstamp: '2024-01-02T00:00:00Z' },
          fetchedAt: staleDate,
        })
      );

      await expect(service.execute(input)).rejects.toThrow('Snapshot is stale');
    });
  });

  // ==========================================
  // Conflict Detection Tests
  // ==========================================

  describe('conflict detection', () => {
    it('should detect no conflict when remote unchanged', async () => {
      const input = createMockExecuteInput({
        actionType: 'update',
        payload: { Name: 'New Name', id: 'account-123' },
        snapshot: { Name: 'Old Name', SystemModstamp: '2024-01-01T00:00:00Z' },
      });

      // Remote state matches snapshot
      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: { Name: 'Old Name', SystemModstamp: '2024-01-01T00:00:00Z' },
          fetchedAt: new Date(),
        })
      );

      const result = await service.execute(input);

      expect(result.success).toBe(true);
    });

    it('should detect conflict when same field changed locally and remotely', async () => {
      const input = createMockExecuteInput({
        actionType: 'update',
        payload: { Name: 'Local New Name', id: 'account-123' },
        snapshot: { Name: 'Old Name', Industry: 'Tech', SystemModstamp: '2024-01-01T00:00:00Z' },
      });

      // Remote changed Name to different value
      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: { Name: 'Remote New Name', Industry: 'Tech', SystemModstamp: '2024-01-02T00:00:00Z' },
          fetchedAt: new Date(),
        })
      );

      // With compare-and-set policy, should throw
      await expect(service.execute(input)).rejects.toThrow('Conflict detected');
    });

    it('should not conflict when different fields changed', async () => {
      const input = createMockExecuteInput({
        actionType: 'update',
        payload: { Name: 'New Name', id: 'account-123' },
        snapshot: { Name: 'Old Name', Industry: 'Tech', SystemModstamp: '2024-01-01T00:00:00Z' },
      });

      // Remote only changed Industry (not in comparison set or different field)
      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: { Name: 'Old Name', Industry: 'Finance', SystemModstamp: '2024-01-02T00:00:00Z' },
          fetchedAt: new Date(),
        })
      );

      const result = await service.execute(input);

      expect(result.success).toBe(true);
    });
  });

  // ==========================================
  // Conflict Resolution Mode Tests
  // ==========================================

  describe('conflict resolution modes', () => {
    it('should fail on compare-and-set when conflict detected', async () => {
      // Override registry to use compare-and-set
      const mockRegistry = {
        get: jest.fn().mockReturnValue(
          createMockConflictPolicy({
            conflictResolutionMode: 'compare-and-set',
            freshReadBeforeWriteRequired: true,
          })
        ),
      };
      (service as any).registry = mockRegistry;

      const input = createMockExecuteInput({
        actionType: 'update',
        payload: { Name: 'Local', id: 'account-123' },
        snapshot: { Name: 'Old', SystemModstamp: '2024-01-01T00:00:00Z' },
      });

      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: { Name: 'Remote', SystemModstamp: '2024-01-02T00:00:00Z' },
          fetchedAt: new Date(),
        })
      );

      await expect(service.execute(input)).rejects.toThrow('version mismatch');
    });

    it('should proceed on last-write-wins when conflict detected', async () => {
      const mockRegistry = {
        get: jest.fn().mockReturnValue(
          createMockConflictPolicy({
            conflictResolutionMode: 'last-write-wins',
            freshReadBeforeWriteRequired: true,
          })
        ),
      };
      (service as any).registry = mockRegistry;

      const input = createMockExecuteInput({
        actionType: 'update',
        payload: { Name: 'Local', id: 'account-123' },
        snapshot: { Name: 'Old', SystemModstamp: '2024-01-01T00:00:00Z' },
      });

      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: { Name: 'Remote', SystemModstamp: '2024-01-02T00:00:00Z' },
          fetchedAt: new Date(),
        })
      );

      const result = await service.execute(input);

      expect(result.success).toBe(true);
    });

    it('should escalate on escalate-on-conflict mode', async () => {
      const mockRegistry = {
        get: jest.fn().mockReturnValue(
          createMockConflictPolicy({
            conflictResolutionMode: 'escalate-on-conflict',
            freshReadBeforeWriteRequired: true,
          })
        ),
      };
      (service as any).registry = mockRegistry;

      const input = createMockExecuteInput({
        actionType: 'update',
        payload: { Name: 'Local', id: 'account-123' },
        snapshot: { Name: 'Old', SystemModstamp: '2024-01-01T00:00:00Z' },
      });

      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: { Name: 'Remote', SystemModstamp: '2024-01-02T00:00:00Z' },
          fetchedAt: new Date(),
        })
      );

      await expect(service.execute(input)).rejects.toThrow('Conflict escalated to human review');
    });
  });

  // ==========================================
  // Merge Resolution Tests
  // ==========================================

  describe('merge resolution', () => {
    beforeEach(() => {
      const mockRegistry = {
        get: jest.fn().mockReturnValue(
          createMockConflictPolicy({
            conflictResolutionMode: 'merge',
            freshReadBeforeWriteRequired: true,
            escalateOnConflict: false,
            fieldComparisonSet: ['Name', 'Amount', 'Tags'],
          })
        ),
      };
      (service as any).registry = mockRegistry;
    });

    it('should merge non-conflicting field changes', async () => {
      const input = createMockExecuteInput({
        actionType: 'update',
        payload: { Name: 'New Name', id: 'account-123' },
        snapshot: { Name: 'Old Name', Amount: 100, SystemModstamp: '2024-01-01T00:00:00Z' },
      });

      // Remote changed Amount, local changed Name
      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: { Name: 'Old Name', Amount: 200, SystemModstamp: '2024-01-02T00:00:00Z' },
          fetchedAt: new Date(),
        })
      );

      const result = await service.execute(input);

      expect(result.success).toBe(true);
    });

    it('should merge numeric fields with additive changes', async () => {
      const input = createMockExecuteInput({
        actionType: 'update',
        payload: { Amount: 150, id: 'account-123' },
        snapshot: { Amount: 100, SystemModstamp: '2024-01-01T00:00:00Z' },
      });

      // Both increased Amount
      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: { Amount: 125, SystemModstamp: '2024-01-02T00:00:00Z' },
          fetchedAt: new Date(),
        })
      );

      const result = await service.execute(input);

      expect(result.success).toBe(true);
    });

    it('should merge array fields with union of additions', async () => {
      const input = createMockExecuteInput({
        actionType: 'update',
        payload: { Tags: ['a', 'b', 'c'], id: 'account-123' },
        snapshot: { Tags: ['a', 'b'], SystemModstamp: '2024-01-01T00:00:00Z' },
      });

      // Remote added 'd', local added 'c'
      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: { Tags: ['a', 'b', 'd'], SystemModstamp: '2024-01-02T00:00:00Z' },
          fetchedAt: new Date(),
        })
      );

      const result = await service.execute(input);

      expect(result.success).toBe(true);
    });

    it('should merge string fields when both are appending', async () => {
      const input = createMockExecuteInput({
        actionType: 'update',
        payload: { Name: 'Hello World', id: 'account-123' },
        snapshot: { Name: 'Hello', SystemModstamp: '2024-01-01T00:00:00Z' },
      });

      // Local appended ' World', remote appended ' There'
      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: { Name: 'Hello There', SystemModstamp: '2024-01-02T00:00:00Z' },
          fetchedAt: new Date(),
        })
      );

      const result = await service.execute(input);

      expect(result.success).toBe(true);
    });
  });

  // ==========================================
  // Action Ledger Integration Tests
  // ==========================================

  describe('action ledger integration', () => {
    it('should record intent before execution', async () => {
      const input = createMockExecuteInput({ actionType: 'read' });

      await service.execute(input);

      // recordIntent receives a structured object with specific fields
      expect(mockActionLedger.recordIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: input.tenantId,
          agentId: input.agentId,
          connector: input.connector,
          entityType: input.entityType,
          actionType: input.actionType,
        })
      );
    });

    it('should record outcome on success', async () => {
      const input = createMockExecuteInput({ actionType: 'read' });

      await service.execute(input);

      expect(mockActionLedger.recordOutcome).toHaveBeenCalledWith(
        'action-123',
        expect.objectContaining({ success: true }),
        // The call that produced the result, so recordOutcome can recover a
        // target from the RESPONSE when the intent could not name one. A create
        // has no id in its payload, so without this every artifact an agent
        // produced was recorded unkeyed and invisible to every reader that
        // looks up by target.
        expect.objectContaining({ connector: 'salesforce', actionType: 'read' })
      );
    });

    it('should record failure on error', async () => {
      mockAdmissionService.checkAdmission.mockResolvedValue({
        allowed: false,
        reason: 'Rate limit exceeded',
      });

      const input = createMockExecuteInput();

      await expect(service.execute(input)).rejects.toThrow();

      // Note: Failure recording happens before the action is recorded
      // so recordIntent won't be called when admission fails
    });
  });

  // ==========================================
  // Pre-Action Snapshot Capture Tests
  // ==========================================

  describe('pre-action snapshot capture', () => {
    it('should skip snapshot capture for CREATE operations', async () => {
      const input = createMockExecuteInput({
        actionType: 'create',
        payload: { Name: 'New Account' },
        snapshot: undefined,  // Explicitly no snapshot
      });

      await service.execute(input);

      // Snapshot is null for create operations; status reflects the skip reason
      expect(mockActionLedger.recordIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: null,
          snapshotStatus: 'skipped_create',
        })
      );
    });

    it('should capture snapshot for UPDATE operations', async () => {
      const existingState = { Name: 'Old Name', Industry: 'Tech', SystemModstamp: '2024-01-01T00:00:00Z' };

      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: existingState,
          fetchedAt: new Date(),
        })
      );

      const input = createMockExecuteInput({
        actionType: 'update',
        payload: { Name: 'New Name', id: 'account-123' },
        snapshot: undefined,  // Don't provide snapshot - should be captured
      });

      await service.execute(input);

      // Snapshot should contain the pre-action state
      expect(mockActionLedger.recordIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: existingState,
        })
      );
    });

    it('should capture snapshot for DELETE operations', async () => {
      const existingState = { Name: 'Account To Delete', id: 'account-123' };

      // Use last-write-wins policy to avoid conflict issues with delete
      const mockRegistry = {
        get: jest.fn().mockReturnValue(
          createMockConflictPolicy({
            conflictResolutionMode: 'last-write-wins',
            freshReadBeforeWriteRequired: true,
          })
        ),
      };
      (service as any).registry = mockRegistry;

      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: existingState,
          fetchedAt: new Date(),
        })
      );

      const input = createMockExecuteInput({
        actionType: 'delete',
        payload: { id: 'account-123' },
        snapshot: undefined,  // Don't provide snapshot - should be captured
      });

      await service.execute(input);

      // Snapshot should contain the entity state before deletion
      expect(mockActionLedger.recordIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: existingState,
        })
      );
    });

    it('should trust caller-provided snapshot if present', async () => {
      const callerSnapshot = { Name: 'Caller Provided', customField: 'value' };

      // Mock external state to match caller snapshot to avoid conflicts
      mockStateFetcher.fetchState.mockResolvedValue(
        createMockExternalState({
          data: callerSnapshot,
          fetchedAt: new Date(),
        })
      );

      const input = createMockExecuteInput({
        actionType: 'update',
        payload: { Name: 'New Name', id: 'account-123' },
        snapshot: callerSnapshot,
      });

      await service.execute(input);

      // Should use the caller-provided snapshot, not fetch a new one for storage
      // (but will still fetch for conflict detection)
      expect(mockActionLedger.recordIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: callerSnapshot,
        })
      );
    });

    it('should block write and throw SnapshotUnavailableError when capture fails after retries', async () => {
      // Use a policy that doesn't require fresh read (skips executeWritePath)
      const mockRegistry = {
        get: jest.fn().mockReturnValue(
          createMockConflictPolicy({
            conflictResolutionMode: 'last-write-wins',
            freshReadBeforeWriteRequired: false,  // Skip write path
          })
        ),
      };
      (service as any).registry = mockRegistry;

      // Snapshot capture always fails (all retries)
      mockStateFetcher.fetchState.mockRejectedValue(new Error('Network error'));

      const input = createMockExecuteInput({
        actionType: 'update',
        payload: { Name: 'New Name', id: 'account-123' },
        snapshot: undefined,
      });

      // Audit Log Hardening: write is now BLOCKED when snapshot capture fails
      await expect(service.execute(input)).rejects.toThrow('Write blocked to preserve audit integrity');

      // A refusal is a thing that happened, and it is now recorded as one.
      //
      // This used to assert recordIntent was NOT called, which described where
      // the code put the record rather than a property worth having: the block
      // fires before the intent write in the execution body, so the attempt
      // left no trace at all. `execute()` already states the opposite principle
      // for governance — "admission denials and guardrail blocks throw, they
      // are security-relevant refusals and belong in the ledger" — and a write
      // refused for want of an audit trail is exactly that.
      //
      // It is recorded as FAILED, never completed, so nothing that asks what
      // the agent has actually done can mistake it for work. That is what makes
      // this safe to record rather than a new way to lie.
      expect(mockActionLedger.recordIntent).toHaveBeenCalledTimes(1);
      expect(mockActionLedger.recordFailure).toHaveBeenCalledTimes(1);
      expect(mockActionLedger.recordOutcome).not.toHaveBeenCalled();
    });

    it('should proceed without snapshot if no entity ID in payload for create-like operations', async () => {
      // Use a create action type (which skips snapshot capture AND write path)
      const input = createMockExecuteInput({
        actionType: 'create',
        payload: { Name: 'New Name' },  // No id needed for create
        snapshot: undefined,
      });

      const result = await service.execute(input);

      expect(result.success).toBe(true);
      expect(mockActionLedger.recordIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: null,
          snapshotStatus: 'skipped_create',
        })
      );
    });

    it('should use captured snapshot for conflict detection', async () => {
      const capturedState = { Name: 'Original', Amount: 100, SystemModstamp: '2024-01-01T00:00:00Z' };
      const currentState = { Name: 'Changed By Someone Else', Amount: 100, SystemModstamp: '2024-01-02T00:00:00Z' };

      // First call captures snapshot, second call gets current state for conflict detection
      mockStateFetcher.fetchState
        .mockResolvedValueOnce(createMockExternalState({ data: capturedState, fetchedAt: new Date() }))
        .mockResolvedValueOnce(createMockExternalState({ data: currentState, fetchedAt: new Date() }));

      const input = createMockExecuteInput({
        actionType: 'update',
        payload: { Name: 'My New Name', id: 'account-123' },
        snapshot: undefined,  // Don't provide - should be captured
      });

      // Should detect conflict since Name changed between snapshot and current state
      await expect(service.execute(input)).rejects.toThrow('Conflict detected');
    });
  });
});

// ==========================================
// ConflictPolicyRegistry Unit Tests
// ==========================================

describe('ConflictPolicyRegistry', () => {
  let registry: ConflictPolicyRegistry;

  beforeEach(() => {
    registry = new ConflictPolicyRegistry();
  });

  it('should return Salesforce Account update policy', () => {
    const policy = registry.get('salesforce', 'Account', 'update');

    expect(policy.connector).toBe('salesforce');
    expect(policy.entityType).toBe('Account');
    expect(policy.freshnessTTL).toBe(60);
    expect(policy.versionTokenField).toBe('SystemModstamp');
    expect(policy.conflictResolutionMode).toBe('compare-and-set');
  });

  it('should return Salesforce Opportunity update policy', () => {
    const policy = registry.get('salesforce', 'Opportunity', 'update');

    expect(policy.entityType).toBe('Opportunity');
    expect(policy.freshnessTTL).toBe(30);
    expect(policy.fieldComparisonSet).toContain('Amount');
    expect(policy.fieldComparisonSet).toContain('StageName');
  });

  it('should return HubSpot Contact update policy', () => {
    const policy = registry.get('hubspot', 'Contact', 'update');

    expect(policy.connector).toBe('hubspot');
    expect(policy.versionTokenField).toBe('hs_object_version_number');
    expect(policy.conflictResolutionMode).toBe('fresh-read-before-write');
  });

  it('should return Jira Issue update policy', () => {
    const policy = registry.get('atlassian_jira', 'Issue', 'update');

    expect(policy.connector).toBe('atlassian_jira');
    expect(policy.versionTokenField).toBeNull(); // Uses ETags
    expect(policy.fieldComparisonSet).toContain('summary');
  });

  it('should return Slack Message create policy', () => {
    const policy = registry.get('slack', 'Message', 'create');

    expect(policy.connector).toBe('slack');
    expect(policy.freshReadBeforeWriteRequired).toBe(false);
    expect(policy.conflictResolutionMode).toBe('last-write-wins');
    expect(policy.undoSupportMode).toBe('full');
  });

  it('should return default restrictive policy for unknown combinations', () => {
    const policy = registry.get('unknown-connector', 'UnknownEntity', 'unknown-action');

    expect(policy.connector).toBe('unknown-connector');
    expect(policy.entityType).toBe('UnknownEntity');
    expect(policy.freshnessTTL).toBe(30);
    expect(policy.freshReadBeforeWriteRequired).toBe(true);
    expect(policy.conflictResolutionMode).toBe('escalate-on-conflict');
    expect(policy.escalateOnConflict).toBe(true);
    expect(policy.undoSupportMode).toBe('none');
  });

  it('should match policy with exact connector, entity, and action', () => {
    // Ensure no partial matching
    const salesforceContactUpdate = registry.get('salesforce', 'Contact', 'update');

    // Salesforce Contact update is defined with compare-and-set
    expect(salesforceContactUpdate.conflictResolutionMode).toBe('compare-and-set');
  });
});
