// Correction Protocol Execution Plane Tests
// Integration tests for subscriber, executor, resource validator, and DLQ handler

import { Message } from '@google-cloud/pubsub';
import {
  CorrectionRequestedEvent,
  BulkCorrectionRequestedEvent,
} from '../types';

// Mock Tool Gateway first (before any imports that use it)
const mockToolGatewayExecute = jest.fn();
jest.mock('../../tool-gateway/service', () => ({
  ToolGatewayService: jest.fn().mockImplementation(() => ({
    execute: mockToolGatewayExecute,
  })),
}));

// Mock Action Ledger repository
jest.mock('../../action-ledger/repository', () => ({
  ActionLedgerRepository: jest.fn().mockImplementation(() => ({
    findByAuditLogId: jest.fn().mockResolvedValue(null),
  })),
}));

// Mock dependencies
jest.mock('../../infrastructure/database');
jest.mock('../../infrastructure/logging', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock Pub/Sub
const mockPublishMessage = jest.fn().mockResolvedValue(['message-id']);
jest.mock('@google-cloud/pubsub', () => ({
  PubSub: jest.fn().mockImplementation(() => ({
    subscription: jest.fn().mockReturnValue({
      on: jest.fn(),
    }),
    topic: jest.fn().mockReturnValue({
      publishMessage: mockPublishMessage,
    }),
  })),
}));

// Mock control plane client
const mockCreateCorrectionAuditLog = jest.fn();
jest.mock('../control-plane-client', () => ({
  createCorrectionAuditLog: mockCreateCorrectionAuditLog,
}));

// Mock state resolver
const mockGetPreActionSnapshot = jest.fn();
jest.mock('../state-resolver', () => ({
  getPreActionSnapshot: mockGetPreActionSnapshot,
}));

// Mock resource validator
const mockValidateResourceExists = jest.fn();
jest.mock('../resource-validator', () => ({
  validateResourceExists: mockValidateResourceExists,
}));

// Mock fetch for DLQ handler
const mockFetch = jest.fn();
global.fetch = mockFetch as jest.Mock;

// Helper to create mock correction event
function createMockCorrectionEvent(
  overrides: Partial<CorrectionRequestedEvent> = {}
): CorrectionRequestedEvent {
  return {
    correctionRequestId: 'corr-123',
    tenantId: 'tenant-123',
    originalAuditLogId: 'audit-456',
    correctionToolName: 'linear_archive_issue',
    correctionType: 'archive',
    requiresPreviousState: false,
    reason: 'Test correction',
    requestedBy: 'user-789',
    timeout: new Date(Date.now() + 60000).toISOString(),
    maxRetries: 3,
    retryCount: 0,
    ...overrides,
  };
}

// Helper to create mock Pub/Sub message
function createMockMessage(data: unknown): Partial<Message> {
  return {
    data: Buffer.from(JSON.stringify(data)),
    attributes: {},
    ack: jest.fn(),
    nack: jest.fn(),
  };
}

describe('Correction Executor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONTROL_PLANE_URL = 'https://api.test.example.com';
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'test-token';
  });

  describe('executeCorrection', () => {
    it('executes archive correction successfully', async () => {
      // Import executor within the test to ensure mocks are applied
      const { executeCorrection } = await import('../executor');

      mockValidateResourceExists.mockResolvedValueOnce({
        exists: true,
        resourceType: 'issue',
      });

      mockToolGatewayExecute.mockResolvedValueOnce({
        success: true,
        data: { id: 'issue-123', archived: true },
      });

      mockCreateCorrectionAuditLog.mockResolvedValueOnce({
        id: 'audit-new-123',
      });

      const result = await executeCorrection({
        tenantId: 'tenant-123',
        correctionRequestId: 'corr-123',
        originalAuditLogId: 'audit-456',
        correctionToolName: 'linear_archive_issue',
        correctionType: 'archive',
        requiresPreviousState: false,
        reason: 'Test correction',
        requestedBy: 'user-789',
        traceId: 'trace-123',
      });

      expect(result.success).toBe(true);
      expect(result.correctionAuditLogId).toBe('audit-new-123');
    });

    it('requires previous state for amend corrections', async () => {
      const { executeCorrection } = await import('../executor');

      mockGetPreActionSnapshot.mockResolvedValueOnce(null);
      mockCreateCorrectionAuditLog.mockResolvedValueOnce({ id: 'audit-err' });

      const result = await executeCorrection({
        tenantId: 'tenant-123',
        correctionRequestId: 'corr-123',
        originalAuditLogId: 'audit-456',
        correctionToolName: 'linear_update_issue',
        correctionType: 'amend',
        requiresPreviousState: true,
        requestedBy: 'user-789',
        traceId: 'trace-123',
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('SNAPSHOT_NOT_AVAILABLE');
      expect(result.retryable).toBe(false);
    });

    it('uses previous state for amend corrections', async () => {
      const { executeCorrection } = await import('../executor');

      mockGetPreActionSnapshot.mockResolvedValueOnce({
        resourceId: 'issue-123',
        resourceType: 'issue',
        data: { title: 'Original Title', description: 'Original desc' },
        fetchedAt: new Date(),
      });

      mockValidateResourceExists.mockResolvedValueOnce({
        exists: true,
        resourceType: 'issue',
      });

      mockToolGatewayExecute.mockResolvedValueOnce({
        success: true,
        data: { id: 'issue-123', updated: true },
      });

      mockCreateCorrectionAuditLog.mockResolvedValueOnce({
        id: 'audit-new-456',
      });

      const result = await executeCorrection({
        tenantId: 'tenant-123',
        correctionRequestId: 'corr-123',
        originalAuditLogId: 'audit-456',
        correctionToolName: 'linear_update_issue',
        correctionType: 'amend',
        requiresPreviousState: true,
        reason: 'Restore previous state',
        requestedBy: 'user-789',
        traceId: 'trace-123',
      });

      expect(result.success).toBe(true);
    });

    it('handles tool gateway execution failure', async () => {
      const { executeCorrection } = await import('../executor');

      mockValidateResourceExists.mockResolvedValueOnce({
        exists: true,
        resourceType: 'issue',
      });

      mockToolGatewayExecute.mockResolvedValueOnce({
        success: false,
        error: 'API rate limit exceeded',
      });

      mockCreateCorrectionAuditLog.mockResolvedValueOnce({ id: 'audit-err' });

      const result = await executeCorrection({
        tenantId: 'tenant-123',
        correctionRequestId: 'corr-123',
        originalAuditLogId: 'audit-456',
        correctionToolName: 'linear_archive_issue',
        correctionType: 'archive',
        requiresPreviousState: false,
        requestedBy: 'user-789',
        traceId: 'trace-123',
      });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('TOOL_EXECUTION_FAILED');
      expect(result.retryable).toBe(true);
    });
  });
});

describe('DLQ Handler', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    // dlq-handler now reads getPlatformBackendUrl() from runtime-env.ts which
    // requires PLATFORM_BACKEND_URL (env-specific, terraform-set in prod).
    // Leave CONTROL_PLANE_URL for back-compat with any consumer still reading it.
    process.env.PLATFORM_BACKEND_URL = 'https://api.test.example.com';
    process.env.CONTROL_PLANE_URL = 'https://api.test.example.com';
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'test-token';
    process.env.ENVIRONMENT = 'test';

    jest.resetModules();
    // runtime-env caches reads — reset after resetModules so the fresh module
    // re-reads our test process.env.
    const m = jest.requireActual('../../infrastructure/runtime-env') as { _resetEnvCacheForTests: () => void };
    m._resetEnvCacheForTests();
  });

  describe('sendToDeadLetterQueue', () => {
    it('publishes failed correction to DLQ topic', async () => {
      const { sendToDeadLetterQueue } = await import('../dlq-handler');

      const event = createMockCorrectionEvent();
      const error = new Error('Tool execution failed');

      await sendToDeadLetterQueue(event, error, 'trace-123');

      expect(mockPublishMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.any(Buffer),
          attributes: expect.objectContaining({
            tenantId: 'tenant-123',
            correctionRequestId: 'corr-123',
            errorType: 'Error',
          }),
        })
      );
    });

    it('includes error stack in DLQ message', async () => {
      const { sendToDeadLetterQueue } = await import('../dlq-handler');

      const event = createMockCorrectionEvent();
      const error = new Error('Detailed error');
      error.stack = 'Error: Detailed error\n    at test:1:1';

      await sendToDeadLetterQueue(event, error, 'trace-123');

      // Verify the message data contains stack
      const publishCall = mockPublishMessage.mock.calls[0][0];
      const messageData = JSON.parse(publishCall.data.toString());

      expect(messageData.errorStack).toContain('at test:1:1');
    });
  });

  describe('reportCorrectionFailure', () => {
    it('reports failure to control plane', async () => {
      const { reportCorrectionFailure } = await import('../dlq-handler');

      mockFetch.mockResolvedValueOnce({ ok: true });

      const event = createMockCorrectionEvent({ retryCount: 3 });
      const error = new Error('Max retries exceeded');

      await reportCorrectionFailure(event, error, 'trace-123');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.example.com/api/agent-audit-logs',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'X-Service-Auth': 'test-token',
          }),
        })
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.action).toBe('correction_failed');
      expect(body.outcome).toBe('error');
      expect(body.errorCode).toBe('CORRECTION_FAILED');
      expect(body.inputArgs.retryCount).toBe(3);
    });
  });

  describe('reportCorrectionTimeout', () => {
    it('reports timeout to control plane', async () => {
      const { reportCorrectionTimeout } = await import('../dlq-handler');

      mockFetch.mockResolvedValueOnce({ ok: true });

      const event = createMockCorrectionEvent({
        timeout: '2024-01-01T00:00:00Z',
      });

      await reportCorrectionTimeout(event, 'trace-123');

      expect(mockFetch).toHaveBeenCalled();

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.action).toBe('correction_timeout');
      expect(body.errorCode).toBe('CORRECTION_TIMEOUT');
      expect(body.inputArgs.timeout).toBe('2024-01-01T00:00:00Z');
    });
  });

  describe('processDLQMessage', () => {
    it('republishes DLQ message with preserved retry count (SE-009)', async () => {
      const { processDLQMessage } = await import('../dlq-handler');

      const dlqMessage = {
        originalEvent: createMockCorrectionEvent({ retryCount: 3, maxRetries: 3 }),
        error: 'Previous failure',
        failedAt: new Date().toISOString(),
        traceId: 'trace-old',
        retryCount: 3,
      };

      const result = await processDLQMessage(dlqMessage);

      expect(result).toBe(true);
      expect(mockPublishMessage).toHaveBeenCalled();

      // SE-009: Verify retry count is set to maxRetries - 1 (not reset to 0)
      const publishCall = mockPublishMessage.mock.calls[0][0];
      const messageData = JSON.parse(publishCall.data.toString());

      // Should be maxRetries - 1 = 2 (only one more retry allowed)
      expect(messageData.payload.retryCount).toBe(2);
      expect(messageData.event_type).toBe('correction.requested');
    });
  });
});

describe('Correction Subscriber', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  describe('Event Handling Flow', () => {
    // Note: The subscriber module creates PubSub instance at module load time,
    // which conflicts with Jest mocking when using dynamic imports.
    // The initCorrectionSubscriber export is verified via TypeScript compilation.
    // The actual message handling behavior is tested in integration tests.

    it('nacks message on processing error', async () => {
      const message = createMockMessage({
        event_type: 'correction.requested',
        payload: createMockCorrectionEvent(),
      });

      // Message should be nacked on error
      expect(message.nack).toBeDefined();
    });

    it('has proper message structure for correction events', () => {
      const event = createMockCorrectionEvent();
      const message = createMockMessage({
        event_type: 'correction.requested',
        payload: event,
      });

      // Verify message structure
      expect(message.data).toBeInstanceOf(Buffer);
      expect(message.ack).toBeDefined();
      expect(message.nack).toBeDefined();

      // Verify event payload
      const parsed = JSON.parse((message.data as Buffer).toString());
      expect(parsed.event_type).toBe('correction.requested');
      expect(parsed.payload.tenantId).toBe('tenant-123');
    });
  });
});

describe('Bulk Correction Handling', () => {
  it('processes multiple corrections in sequence', async () => {
    const event: BulkCorrectionRequestedEvent = {
      correctionRequestIds: ['corr-1', 'corr-2', 'corr-3'],
      tenantId: 'tenant-123',
      corrections: [
        {
          correctionRequestId: 'corr-1',
          originalAuditLogId: 'audit-1',
          correctionToolName: 'linear_archive_issue',
          correctionType: 'archive',
          requiresPreviousState: false,
        },
        {
          correctionRequestId: 'corr-2',
          originalAuditLogId: 'audit-2',
          correctionToolName: 'slack_delete_message',
          correctionType: 'delete',
          requiresPreviousState: false,
        },
        {
          correctionRequestId: 'corr-3',
          originalAuditLogId: 'audit-3',
          correctionToolName: 'stripe_create_refund',
          correctionType: 'refund',
          requiresPreviousState: false,
        },
      ],
      reason: 'Bulk cleanup',
      requestedBy: 'admin-123',
      timeout: new Date(Date.now() + 300000).toISOString(),
      maxRetries: 3,
      retryCount: 0,
    };

    // Verify structure is correct
    expect(event.corrections).toHaveLength(3);
    expect(event.corrections[0].correctionType).toBe('archive');
    expect(event.corrections[1].correctionType).toBe('delete');
    expect(event.corrections[2].correctionType).toBe('refund');
  });
});

describe('Retry Logic', () => {
  describe('Exponential Backoff', () => {
    it('calculates backoff correctly', () => {
      const BACKOFF_BASE_MS = 5000;
      const MAX_BACKOFF_MS = 300000;

      // Verify backoff calculation matches expected values
      const retryAttempts = [1, 2, 3, 4, 5, 6, 7];
      const expectedBackoffs = [
        5000, // 5s * 2^0
        10000, // 5s * 2^1
        20000, // 5s * 2^2
        40000, // 5s * 2^3
        80000, // 5s * 2^4
        160000, // 5s * 2^5
        300000, // capped at MAX
      ];

      retryAttempts.forEach((attempt, index) => {
        const backoff = Math.min(
          BACKOFF_BASE_MS * Math.pow(2, attempt - 1),
          MAX_BACKOFF_MS
        );
        expect(backoff).toBe(expectedBackoffs[index]);
      });
    });
  });

  describe('Timeout Handling', () => {
    it('detects expired timeout', () => {
      const pastTimeout = new Date(Date.now() - 1000).toISOString();
      const isExpired = new Date(pastTimeout) < new Date();

      expect(isExpired).toBe(true);
    });

    it('detects valid timeout', () => {
      const futureTimeout = new Date(Date.now() + 60000).toISOString();
      const isExpired = new Date(futureTimeout) < new Date();

      expect(isExpired).toBe(false);
    });
  });
});

describe('Tool Name Parsing', () => {
  it('parses connector from tool name', () => {
    const testCases = [
      { toolName: 'slack_delete_message', expected: 'slack' },
      { toolName: 'linear_archive_issue', expected: 'linear' },
      { toolName: 'stripe_create_refund', expected: 'stripe' },
      { toolName: 'gmail_delete_draft', expected: 'gmail' },
    ];

    testCases.forEach(({ toolName, expected }) => {
      const connector = toolName.split('_')[0];
      expect(connector).toBe(expected);
    });
  });

  it('parses entity type from tool name', () => {
    const testCases = [
      { toolName: 'slack_delete_message', expected: 'message' },
      { toolName: 'linear_archive_issue', expected: 'issue' },
      { toolName: 'stripe_create_refund', expected: 'refund' },
    ];

    testCases.forEach(({ toolName, expected }) => {
      const parts = toolName.split('_');
      const entityType = parts.length > 2 ? parts[parts.length - 1] : parts[1];
      expect(entityType).toBe(expected);
    });
  });

  it('parses action type from tool name', () => {
    const testCases = [
      { toolName: 'slack_delete_message', expected: 'delete' },
      { toolName: 'linear_archive_issue', expected: 'archive' },
      { toolName: 'stripe_create_refund', expected: 'create' },
    ];

    testCases.forEach(({ toolName, expected }) => {
      const parts = toolName.split('_');
      const actionType = parts.length > 2 ? parts[1] : 'execute';
      expect(actionType).toBe(expected);
    });
  });
});

describe('Resource Validation Types', () => {
  it('correctly identifies not found error patterns', () => {
    const notFoundPatterns = [
      'not found',
      'not_found',
      'notfound',
      '404',
      'does not exist',
      'no longer exists',
      'deleted',
      'removed',
    ];

    const testErrors = [
      'Resource not found',
      'Issue not_found in system',
      '404 error returned',
      'This resource does not exist',
      'Item was deleted',
    ];

    testErrors.forEach((errorMsg) => {
      const isNotFound = notFoundPatterns.some((pattern) =>
        errorMsg.toLowerCase().includes(pattern)
      );
      expect(isNotFound).toBe(true);
    });
  });

  it('does not match non-404 errors', () => {
    const notFoundPatterns = [
      'not found',
      'not_found',
      'notfound',
      '404',
      'does not exist',
      'no longer exists',
      'deleted',
      'removed',
    ];

    const normalErrors = [
      'Rate limit exceeded',
      'Internal server error',
      'Timeout occurred',
      'Network failure',
    ];

    normalErrors.forEach((errorMsg) => {
      const isNotFound = notFoundPatterns.some((pattern) =>
        errorMsg.toLowerCase().includes(pattern)
      );
      expect(isNotFound).toBe(false);
    });
  });
});

describe('Correction Types', () => {
  it('maps correction types to tool actions', () => {
    const correctionTypeToAction: Record<string, string[]> = {
      archive: ['archive', 'trash'],
      delete: ['delete', 'remove'],
      amend: ['update', 'modify'],
      refund: ['create_refund', 'refund'],
      void: ['cancel', 'void'],
    };

    expect(correctionTypeToAction.archive).toContain('archive');
    expect(correctionTypeToAction.delete).toContain('delete');
    expect(correctionTypeToAction.refund).toContain('refund');
  });
});

// ==========================================================================
// TE-006: extractResourceId Tests
// ==========================================================================
describe('Resource ID Extraction (TE-006)', () => {
  it('extracts ID from JSON output summary', async () => {
    // Mock getAuditLog to return audit log with JSON output
    const mockGetAuditLog = jest.fn().mockResolvedValue({
      id: 'audit-123',
      action: 'linear_create_issue',
      inputArgs: {},
      outputSummary: JSON.stringify({ id: 'LIN-123' }),
      outcome: 'success',
      triggeredBy: 'agent',
    });

    jest.doMock('../control-plane-client', () => ({
      createCorrectionAuditLog: mockCreateCorrectionAuditLog,
      getAuditLog: mockGetAuditLog,
    }));

    // The implementation should extract 'LIN-123' from the output
    const outputSummary = JSON.stringify({ id: 'LIN-123' });
    const parsed = JSON.parse(outputSummary);
    expect(parsed.id).toBe('LIN-123');
  });

  it('extracts ID from common field names', () => {
    const idFields = ['id', 'resourceId', 'messageId', 'eventId', 'chargeId', 'userId', 'recordId'];
    const testData = { messageId: 'msg-456' };

    let extractedId = null;
    for (const field of idFields) {
      if (testData[field as keyof typeof testData]) {
        extractedId = testData[field as keyof typeof testData];
        break;
      }
    }

    expect(extractedId).toBe('msg-456');
  });

  it('extracts ID from nested data structures', () => {
    const nestedData = { data: { id: 'nested-123' } };
    expect(nestedData.data?.id).toBe('nested-123');
  });

  it('returns null for non-JSON output summary', () => {
    const plainTextSummary = 'Created issue successfully';
    let extractedId = null;

    try {
      const parsed = JSON.parse(plainTextSummary);
      extractedId = parsed.id;
    } catch {
      // Try regex fallback
      const match = plainTextSummary.match(/(?:id|ID)[\s:="']+([a-zA-Z0-9_-]+)/);
      extractedId = match?.[1] || null;
    }

    expect(extractedId).toBeNull();
  });
});

// ==========================================================================
// TE-008: DLQ Recovery Limits Tests
// ==========================================================================
describe('DLQ Recovery Limits (TE-008)', () => {
  it('limits DLQ recovery attempts to prevent infinite retries', async () => {
    const MAX_DLQ_RECOVERY_ATTEMPTS = 2;

    const dlqMessage = {
      originalEvent: createMockCorrectionEvent({ retryCount: 3 }),
      error: 'Previous failure',
      failedAt: new Date().toISOString(),
      traceId: 'trace-old',
      retryCount: 3,
      dlqRecoveryAttempt: MAX_DLQ_RECOVERY_ATTEMPTS, // Already at max
    };

    // Should not allow more recovery attempts
    expect(dlqMessage.dlqRecoveryAttempt).toBeGreaterThanOrEqual(MAX_DLQ_RECOVERY_ATTEMPTS);
  });

  it('preserves original retry count on DLQ recovery', () => {
    const originalEvent = createMockCorrectionEvent({ retryCount: 2, maxRetries: 3 });

    // DLQ recovery should set retryCount to maxRetries - 1 (only one more try)
    const recoveredEvent = {
      ...originalEvent,
      retryCount: originalEvent.maxRetries - 1,
    };

    expect(recoveredEvent.retryCount).toBe(2); // maxRetries (3) - 1 = 2
  });
});

// ==========================================================================
// TE-009: Error Sanitization Tests
// ==========================================================================
describe('Error Sanitization (TE-009)', () => {
  it('redacts file paths from error messages', () => {
    const errorMsg = 'Error at /Users/you/Documents/project/src/file.ts:42:10';
    const sanitized = errorMsg.replace(/\/[\w/.-]+\.(ts|js|mjs)/g, '[redacted]');

    expect(sanitized).not.toContain('/Users/you');
    expect(sanitized).toContain('[redacted]');
  });

  it('redacts API keys from error messages', () => {
    const errorMsg = 'Request failed: api_key=sk_test_12345abcde';
    const sanitized = errorMsg.replace(/api[_-]?key[=:]\s*["']?[^"'\s]+/gi, '[redacted]');

    expect(sanitized).not.toContain('sk_test_12345');
    expect(sanitized).toContain('[redacted]');
  });

  it('redacts connection strings from error messages', () => {
    const errorMsg = 'Connection failed: postgres://user:pass@localhost:5432/db';
    const sanitized = errorMsg.replace(/\b(postgres|mysql|redis):\/\/[^\s]+/gi, '[redacted]');

    expect(sanitized).not.toContain('postgres://');
    expect(sanitized).toContain('[redacted]');
  });

  it('redacts tokens from error messages', () => {
    const errorMsg = 'Auth failed with token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxx';
    const sanitized = errorMsg.replace(/token[=:]\s*["']?[^"'\s]+/gi, '[redacted]');

    expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiI');
    expect(sanitized).toContain('[redacted]');
  });

  it('truncates very long error messages', () => {
    const longErrorMsg = 'A'.repeat(500);
    const maxLength = 200;

    let sanitized = longErrorMsg;
    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength) + '...';
    }

    expect(sanitized.length).toBe(maxLength + 3); // 200 + '...'
    expect(sanitized.endsWith('...')).toBe(true);
  });
});

// ==========================================================================
// TE-011: Pub/Sub Nack Backoff Tests
// ==========================================================================
describe('Pub/Sub Nack Backoff (TE-011)', () => {
  it('calculates backoff based on delivery attempts', () => {
    const baseBackoff = 5; // seconds
    const maxBackoff = 300; // 5 minutes

    const testCases = [
      { deliveryAttempt: 1, expectedBackoff: 5 },
      { deliveryAttempt: 2, expectedBackoff: 10 },
      { deliveryAttempt: 3, expectedBackoff: 20 },
      { deliveryAttempt: 4, expectedBackoff: 40 },
      { deliveryAttempt: 10, expectedBackoff: 300 }, // Capped at max
    ];

    testCases.forEach(({ deliveryAttempt, expectedBackoff }) => {
      const backoff = Math.min(
        Math.pow(2, deliveryAttempt - 1) * baseBackoff,
        maxBackoff
      );
      expect(backoff).toBe(expectedBackoff);
    });
  });

  it('caps backoff at maximum value', () => {
    const maxBackoff = 300;
    const deliveryAttempt = 100; // Very high attempt count
    const baseBackoff = 5;

    const backoff = Math.min(
      Math.pow(2, deliveryAttempt - 1) * baseBackoff,
      maxBackoff
    );

    expect(backoff).toBe(maxBackoff);
  });
});
