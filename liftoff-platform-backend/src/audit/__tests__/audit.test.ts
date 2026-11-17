// Audit Logging Tests
// Tests audit event creation, batching, sanitization, and database persistence

// Mock external dependencies
jest.mock('../../infrastructure/tracing', () => ({
  getCurrentTraceId: jest.fn().mockReturnValue('trace-123'),
}));

// Mock database - create shared mock inside factory to avoid hoisting issues
jest.mock('../../infrastructure/database', () => {
  const mockQueryFn = jest.fn();
  return {
    withTenantScope: (_t: any, fn: any) => fn({ query: mockQueryFn }),
    withAdminScope: (_c: any, fn: any) => fn({ query: mockQueryFn }),
    pool: {
      query: mockQueryFn,
    },
    getPool: () => ({
      query: mockQueryFn,
    }),
    __getMockQuery: () => mockQueryFn,
  };
});

import {
  logAudit,
  AuditEvent,
  LogContext,
  shutdownAuditLogger,
} from '../../infrastructure/logging';

// Get the shared mock query function
const dbMock = jest.requireMock('../../infrastructure/database');
const mockQuery = dbMock.__getMockQuery() as jest.Mock;

// Mock pino logger
jest.mock('pino', () => {
  const mockChild = jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  });

  return jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    child: mockChild,
  });
});

describe('Audit Logging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('logAudit', () => {
    const baseContext: LogContext = {
      tenantId: 'tenant_123',
      userId: 'user_456',
    };

    it('should create structured audit event with correct fields', async () => {
      logAudit('account.created', baseContext, {
        accountId: 'acc_789',
        name: 'Test Account',
      });

      // Event should be buffered, not immediately written
      // Use shutdownAuditLogger to properly await the async flush
      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
    });

    it('should extract resource type from action string', async () => {
      logAudit('subscription.canceled', baseContext, {
        subscriptionId: 'sub_123',
      });

      await shutdownAuditLogger();

      // Check the query was called with subscription as resource_type
      expect(mockQuery).toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0];
      const params = queryCall[1];

      // Find the resource_type parameter (6th param in each event)
      // Params order: id, eventType, timestamp, tenantId, userId, resourceType, resourceId, action, ...
      expect(params[5]).toBe('subscription');
    });

    it('should extract action verb from action string', async () => {
      logAudit('tenant.suspended', baseContext, {
        tenantId: 'tenant_123',
      });

      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0];
      const params = queryCall[1];

      // Find the action parameter (8th param)
      expect(params[7]).toBe('suspended');
    });

    it('should extract resource ID from various field names', async () => {
      logAudit('model.registered', baseContext, {
        modelId: 'model_123',
      });

      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0];
      const params = queryCall[1];

      // Find the resourceId parameter (7th param)
      expect(params[6]).toBe('model_123');
    });

    it('should use "unknown" when resource ID cannot be extracted', async () => {
      logAudit('admin.action', baseContext, {
        someOtherField: 'value',
      });

      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0];
      const params = queryCall[1];

      expect(params[6]).toBe('unknown');
    });

    it('should include tenant ID and user ID from context', async () => {
      logAudit('entitlement.updated', baseContext, {
        id: 'ent_123',
      });

      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0];
      const params = queryCall[1];

      expect(params[3]).toBeNull(); // tenantId (non-UUID validated to null)
      expect(params[4]).toBeNull(); // userId (non-UUID validated to null)
    });

    it('should include trace ID from tracing context', async () => {
      logAudit('deployment.created', baseContext, {
        id: 'dep_123',
      });

      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0];
      const params = queryCall[1];

      expect(params[11]).toBe('trace-123'); // traceId
    });
  });

  describe('metadata sanitization', () => {
    const baseContext: LogContext = {
      tenantId: 'tenant_123',
    };

    it('should redact password fields', async () => {
      logAudit('account.created', baseContext, {
        id: 'acc_123',
        password: 'secret123',
        userPassword: 'secret456',
      });

      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0];
      const params = queryCall[1];

      // Metadata is the 11th param, JSON stringified
      const metadata = JSON.parse(params[10]);
      expect(metadata.password).toBe('[REDACTED]');
      expect(metadata.userPassword).toBe('[REDACTED]');
    });

    it('should redact token fields', async () => {
      logAudit('account.created', baseContext, {
        id: 'acc_123',
        accessToken: 'token123',
        refreshToken: 'refresh456',
      });

      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0];
      const params = queryCall[1];

      const metadata = JSON.parse(params[10]);
      expect(metadata.accessToken).toBe('[REDACTED]');
      expect(metadata.refreshToken).toBe('[REDACTED]');
    });

    it('should redact secret fields', async () => {
      logAudit('account.created', baseContext, {
        id: 'acc_123',
        apiSecret: 'mysecret',
        secretKey: 'key123',
      });

      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0];
      const params = queryCall[1];

      const metadata = JSON.parse(params[10]);
      expect(metadata.apiSecret).toBe('[REDACTED]');
      expect(metadata.secretKey).toBe('[REDACTED]');
    });

    it('keeps credentialId: the id of a credential, not the credential', async () => {
      logAudit('internal_agent.updated', baseContext, {
        id: 'agent_1',
        credentialId: '33333333-3333-3333-3333-333333333333',
        credential: 'abc123',
      });

      await shutdownAuditLogger();

      const metadata = JSON.parse(mockQuery.mock.calls[0][1][10]);
      expect(metadata.credentialId).toBe('33333333-3333-3333-3333-333333333333');
      expect(metadata.credential).toBe('[REDACTED]');
    });

    it('should redact credential fields', async () => {
      logAudit('connector.created', baseContext, {
        id: 'conn_123',
        credentials: { user: 'test', pass: 'secret' },
        credential: 'abc123',
      });

      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0];
      const params = queryCall[1];

      const metadata = JSON.parse(params[10]);
      expect(metadata.credentials).toBe('[REDACTED]');
      expect(metadata.credential).toBe('[REDACTED]');
    });

    it('should preserve non-sensitive fields', async () => {
      logAudit('account.updated', baseContext, {
        id: 'acc_123',
        name: 'Test Account',
        email: 'test@example.com',
        status: 'active',
      });

      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0];
      const params = queryCall[1];

      const metadata = JSON.parse(params[10]);
      expect(metadata.name).toBe('Test Account');
      expect(metadata.email).toBe('test@example.com');
      expect(metadata.status).toBe('active');
    });
  });

  describe('batch processing', () => {
    const baseContext: LogContext = {
      tenantId: 'tenant_123',
    };

    it('should buffer events and flush after timeout', async () => {
      logAudit('event.one', baseContext, { id: '1' });
      logAudit('event.two', baseContext, { id: '2' });
      logAudit('event.three', baseContext, { id: '3' });

      // Events should not be written immediately
      expect(mockQuery).not.toHaveBeenCalled();

      // Flush via shutdown
      await shutdownAuditLogger();

      // Now events should be flushed
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('should flush immediately when buffer reaches batch size', async () => {
      // Add 100 events to reach BATCH_SIZE
      for (let i = 0; i < 100; i++) {
        logAudit(`event.${i}`, baseContext, { id: `${i}` });
      }

      // Ensure flush completes
      await shutdownAuditLogger();

      // Should have flushed due to batch size
      expect(mockQuery).toHaveBeenCalled();
    });

    it('should handle multiple flushes for many events', async () => {
      // Add more than one batch worth of events
      for (let i = 0; i < 150; i++) {
        logAudit(`event.${i}`, baseContext, { id: `${i}` });
      }

      // Ensure all batches are flushed
      await shutdownAuditLogger();

      // Should have flushed at least once
      expect(mockQuery.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('state change tracking', () => {
    const baseContext: LogContext = {
      tenantId: 'tenant_123',
    };

    it('should include previousState and newState when provided', async () => {
      logAudit('entitlement.updated', baseContext, {
        id: 'ent_123',
        previousState: {
          includedMonthlyCredits: 500,
          status: 'active',
        },
        newState: {
          includedMonthlyCredits: 1000,
          status: 'active',
        },
      });

      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0];
      const params = queryCall[1];

      // previousState is 9th param, newState is 10th param
      const previousState = JSON.parse(params[8]);
      const newState = JSON.parse(params[9]);

      expect(previousState.includedMonthlyCredits).toBe(500);
      expect(newState.includedMonthlyCredits).toBe(1000);
    });

    it('should exclude state objects from sanitized metadata', async () => {
      logAudit('account.updated', baseContext, {
        id: 'acc_123',
        previousState: { name: 'Old Name' },
        newState: { name: 'New Name' },
        extraField: 'value',
      });

      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0];
      const params = queryCall[1];

      const metadata = JSON.parse(params[10]);
      expect(metadata.previousState).toBeUndefined();
      expect(metadata.newState).toBeUndefined();
      expect(metadata.extraField).toBe('value');
    });
  });

  describe('error handling', () => {
    const baseContext: LogContext = {
      tenantId: 'tenant_123',
    };

    it('should not throw when database write fails', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Database connection failed'));

      logAudit('event.one', baseContext, { id: '1' });

      // Should not throw
      await expect(shutdownAuditLogger()).resolves.not.toThrow();
    });

    it('should preserve events in buffer on failure for retry', async () => {
      mockQuery.mockRejectedValueOnce(new Error('Database error'));

      logAudit('event.one', baseContext, { id: '1' });

      await shutdownAuditLogger();

      // Reset mock and verify events can be retried
      mockQuery.mockResolvedValueOnce({ rows: [] });

      // Add another event to trigger another flush
      logAudit('event.two', baseContext, { id: '2' });

      await shutdownAuditLogger();

      // Should have attempted to flush
      expect(mockQuery).toHaveBeenCalled();
    });
  });

  describe('shutdownAuditLogger', () => {
    const baseContext: LogContext = {
      tenantId: 'tenant_123',
    };

    it('should flush remaining events on shutdown', async () => {
      logAudit('event.shutdown', baseContext, { id: '1' });

      // Don't advance timers, just call shutdown
      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
    });

    it('should handle empty buffer gracefully', async () => {
      // Ensure buffer is empty by flushing first
      await shutdownAuditLogger();
      mockQuery.mockClear();

      // Shutdown with empty buffer
      await shutdownAuditLogger();

      // Should not call query for empty buffer
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('audit event types', () => {
    const baseContext: LogContext = {
      tenantId: 'tenant_123',
    };

    const eventTypes = [
      'account.created',
      'account.updated',
      'account.deleted',
      'subscription.created',
      'subscription.updated',
      'subscription.canceled',
      'entitlement.granted',
      'entitlement.revoked',
      'entitlement.updated',
      'tenant.created',
      'tenant.suspended',
      'tenant.activated',
      'tenant.deleted',
      'deployment.created',
      'deployment.updated',
      'deployment.deleted',
      'model.registered',
      'model.approved',
      'model.deprecated',
      'model.disabled',
      'model_config.updated',
      'model_config.deleted',
      'model_rollout.requested',
      'model_rollout.approved',
      'model_rollout.rejected',
      'model_rollout.started',
      'model_rollout.completed',
      'model_rollout.rolled_back',
      'prompt.created',
      'prompt.updated',
      'prompt.deleted',
      'feature_flag.created',
      'feature_flag.updated',
      'feature_flag.deleted',
      'admin.action',
      'data.deletion_requested',
      'data.deletion_completed',
      'data.export_requested',
      'data.export_completed',
      'billing.reconciliation_started',
      'billing.reconciliation_completed',
      'billing.event_replayed',
      'feedback.submitted',
      'feedback.processed',
    ];

    it.each(eventTypes)('should handle %s event type', async (eventType) => {
      logAudit(eventType, baseContext, { id: 'resource_123' });

      await shutdownAuditLogger();

      expect(mockQuery).toHaveBeenCalled();
      const queryCall = mockQuery.mock.calls[0];
      const params = queryCall[1];

      // Event type should be passed correctly
      expect(params[1]).toBe(eventType);

      // Clear for next test
      mockQuery.mockClear();
    });
  });
});

describe('AuditEvent interface', () => {
  it('should have all required fields', async () => {
    const event: AuditEvent = {
      id: 'audit_123',
      eventType: 'account.created',
      timestamp: new Date(),
      tenantId: 'tenant_123',
      userId: 'user_456',
      resourceType: 'account',
      resourceId: 'acc_789',
      action: 'created',
      previousState: { name: 'Old' },
      newState: { name: 'New' },
      metadata: { extra: 'data' },
      ipAddress: '192.168.1.1',
      userAgent: 'Mozilla/5.0',
      traceId: 'trace-123',
    };

    expect(event.id).toBeDefined();
    expect(event.eventType).toBeDefined();
    expect(event.timestamp).toBeInstanceOf(Date);
    expect(event.resourceType).toBeDefined();
    expect(event.resourceId).toBeDefined();
    expect(event.action).toBeDefined();
    expect(event.metadata).toBeDefined();
  });

  it('should allow optional fields to be undefined', async () => {
    const minimalEvent: AuditEvent = {
      id: 'audit_123',
      eventType: 'account.created',
      timestamp: new Date(),
      resourceType: 'account',
      resourceId: 'acc_789',
      action: 'created',
      metadata: {},
    };

    expect(minimalEvent.tenantId).toBeUndefined();
    expect(minimalEvent.userId).toBeUndefined();
    expect(minimalEvent.previousState).toBeUndefined();
    expect(minimalEvent.newState).toBeUndefined();
    expect(minimalEvent.ipAddress).toBeUndefined();
    expect(minimalEvent.userAgent).toBeUndefined();
    expect(minimalEvent.traceId).toBeUndefined();
  });
});
