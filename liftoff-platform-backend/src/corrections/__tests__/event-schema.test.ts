// Correction Protocol Event Schema Tests
// [TE-008/TE-P2-003] Event serialization and contract tests

import { z } from 'zod';

// Define event schemas for contract testing
const correctionEventPayloadSchema = z.object({
  originalAuditLogId: z.string().uuid(),
  correctionToolName: z.string(),
  correctionType: z.enum(['archive', 'amend', 'delete', 'refund', 'credit', 'void', 'follow_up', 'not_correctable']),
  requiresPreviousState: z.boolean(),
  timeout: z.string().datetime().optional(),
  maxRetries: z.number().int().min(0).optional(),
  retryCount: z.number().int().min(0).optional(),
  reason: z.string().optional(),
  requestedBy: z.string(),
  traceContext: z.record(z.string()).optional(),
});

const correctionRequestedEventSchema = z.object({
  entityType: z.literal('correction_request'),
  entityId: z.string().uuid(),
  eventType: z.literal('correction.requested'),
  entityVersion: z.number().int().positive(),
  eventVersion: z.number().int().positive(),
  tenantId: z.string().uuid(),
  payload: correctionEventPayloadSchema,
});

const correctionBulkRequestedEventSchema = z.object({
  entityType: z.literal('correction_request'),
  entityId: z.string().uuid(),
  eventType: z.literal('correction.bulk_requested'),
  entityVersion: z.number().int().positive(),
  eventVersion: z.number().int().positive(),
  tenantId: z.string().uuid(),
  payload: z.object({
    correctionRequests: z.array(correctionEventPayloadSchema),
    stopOnError: z.boolean(),
    totalCount: z.number().int().positive(),
  }),
});

describe('Correction Event Schema', () => {
  const validTenantId = '550e8400-e29b-41d4-a716-446655440000';
  const validAuditLogId = '550e8400-e29b-41d4-a716-446655440001';
  const validEntityId = '550e8400-e29b-41d4-a716-446655440002';

  // [TE-008] Serialize correction.requested event correctly
  it('should serialize correction.requested event correctly', () => {
    const event = {
      entityType: 'correction_request' as const,
      entityId: validEntityId,
      eventType: 'correction.requested' as const,
      entityVersion: 1,
      eventVersion: 1,
      tenantId: validTenantId,
      payload: {
        originalAuditLogId: validAuditLogId,
        correctionToolName: 'linear_archive_issue',
        correctionType: 'archive' as const,
        requiresPreviousState: false,
        timeout: new Date().toISOString(),
        maxRetries: 3,
        retryCount: 0,
        requestedBy: 'user-123',
      },
    };

    // Should match expected schema
    expect(() => correctionRequestedEventSchema.parse(event)).not.toThrow();
  });

  // [TE-008] Reject malformed event payload
  it('should reject malformed event payload', () => {
    const malformedEvent = {
      entityType: 'correction_request',
      // Missing required fields
    };

    expect(() => correctionRequestedEventSchema.parse(malformedEvent)).toThrow();
  });

  // [TE-008] Validate all required fields
  it('should require all mandatory fields', () => {
    const missingPayload = {
      entityType: 'correction_request',
      entityId: validEntityId,
      eventType: 'correction.requested',
      entityVersion: 1,
      eventVersion: 1,
      tenantId: validTenantId,
      // Missing payload
    };

    expect(() => correctionRequestedEventSchema.parse(missingPayload)).toThrow();
  });

  // [TE-008] Validate correction type enum
  it('should validate correction type enum values', () => {
    const validTypes = ['archive', 'amend', 'delete', 'refund', 'credit', 'void', 'follow_up', 'not_correctable'];

    for (const correctionType of validTypes) {
      const event = {
        entityType: 'correction_request' as const,
        entityId: validEntityId,
        eventType: 'correction.requested' as const,
        entityVersion: 1,
        eventVersion: 1,
        tenantId: validTenantId,
        payload: {
          originalAuditLogId: validAuditLogId,
          correctionToolName: 'test_tool',
          correctionType: correctionType as any,
          requiresPreviousState: false,
          requestedBy: 'user-123',
        },
      };

      expect(() => correctionRequestedEventSchema.parse(event)).not.toThrow();
    }

    // Invalid type should fail
    const invalidEvent = {
      entityType: 'correction_request' as const,
      entityId: validEntityId,
      eventType: 'correction.requested' as const,
      entityVersion: 1,
      eventVersion: 1,
      tenantId: validTenantId,
      payload: {
        originalAuditLogId: validAuditLogId,
        correctionToolName: 'test_tool',
        correctionType: 'invalid_type',
        requiresPreviousState: false,
        requestedBy: 'user-123',
      },
    };

    expect(() => correctionRequestedEventSchema.parse(invalidEvent)).toThrow();
  });

  // [TE-008] Validate UUID formats
  it('should validate UUID formats', () => {
    const invalidUuidEvent = {
      entityType: 'correction_request' as const,
      entityId: 'not-a-uuid',
      eventType: 'correction.requested' as const,
      entityVersion: 1,
      eventVersion: 1,
      tenantId: validTenantId,
      payload: {
        originalAuditLogId: validAuditLogId,
        correctionToolName: 'test_tool',
        correctionType: 'archive' as const,
        requiresPreviousState: false,
        requestedBy: 'user-123',
      },
    };

    expect(() => correctionRequestedEventSchema.parse(invalidUuidEvent)).toThrow();
  });

  // [TE-P2-003] Preserve retry metadata on republish
  it('should preserve retry metadata on republish', () => {
    const originalEvent = {
      entityType: 'correction_request' as const,
      entityId: validEntityId,
      eventType: 'correction.requested' as const,
      entityVersion: 1,
      eventVersion: 1,
      tenantId: validTenantId,
      payload: {
        originalAuditLogId: validAuditLogId,
        correctionToolName: 'linear_archive_issue',
        correctionType: 'archive' as const,
        requiresPreviousState: false,
        timeout: '2024-06-15T12:00:00Z',
        maxRetries: 3,
        retryCount: 1,
        requestedBy: 'user-123',
      },
    };

    // Simulate republish with incremented retry count
    const republishedEvent = {
      ...originalEvent,
      payload: {
        ...originalEvent.payload,
        retryCount: originalEvent.payload.retryCount + 1,
      },
    };

    expect(() => correctionRequestedEventSchema.parse(republishedEvent)).not.toThrow();
    expect(republishedEvent.payload.retryCount).toBe(2);
    expect(republishedEvent.payload.timeout).toBe(originalEvent.payload.timeout);
    expect(republishedEvent.payload.maxRetries).toBe(originalEvent.payload.maxRetries);
  });

  // [TE-P2-003] Bulk correction event schema
  it('should validate bulk correction event schema', () => {
    const bulkEvent = {
      entityType: 'correction_request' as const,
      entityId: validEntityId,
      eventType: 'correction.bulk_requested' as const,
      entityVersion: 1,
      eventVersion: 1,
      tenantId: validTenantId,
      payload: {
        correctionRequests: [
          {
            originalAuditLogId: validAuditLogId,
            correctionToolName: 'linear_archive_issue',
            correctionType: 'archive' as const,
            requiresPreviousState: false,
            requestedBy: 'user-123',
          },
          {
            originalAuditLogId: '550e8400-e29b-41d4-a716-446655440003',
            correctionToolName: 'slack_delete_message',
            correctionType: 'delete' as const,
            requiresPreviousState: false,
            requestedBy: 'user-123',
          },
        ],
        stopOnError: false,
        totalCount: 2,
      },
    };

    expect(() => correctionBulkRequestedEventSchema.parse(bulkEvent)).not.toThrow();
  });

  // [TE-P2-003] Trace context preservation
  it('should preserve trace context in event payload', () => {
    const eventWithTraceContext = {
      entityType: 'correction_request' as const,
      entityId: validEntityId,
      eventType: 'correction.requested' as const,
      entityVersion: 1,
      eventVersion: 1,
      tenantId: validTenantId,
      payload: {
        originalAuditLogId: validAuditLogId,
        correctionToolName: 'linear_archive_issue',
        correctionType: 'archive' as const,
        requiresPreviousState: false,
        requestedBy: 'user-123',
        traceContext: {
          traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
          tracestate: 'congo=ucfJifl5GOE,rojo=00f067aa0ba902b7',
        },
      },
    };

    expect(() => correctionRequestedEventSchema.parse(eventWithTraceContext)).not.toThrow();
    expect(eventWithTraceContext.payload.traceContext?.traceparent).toBeDefined();
  });

  // [TE-P2-003] Version numbers must be positive
  it('should require positive version numbers', () => {
    const zeroVersion = {
      entityType: 'correction_request' as const,
      entityId: validEntityId,
      eventType: 'correction.requested' as const,
      entityVersion: 0, // Invalid
      eventVersion: 1,
      tenantId: validTenantId,
      payload: {
        originalAuditLogId: validAuditLogId,
        correctionToolName: 'test_tool',
        correctionType: 'archive' as const,
        requiresPreviousState: false,
        requestedBy: 'user-123',
      },
    };

    expect(() => correctionRequestedEventSchema.parse(zeroVersion)).toThrow();
  });

  // [TE-P2-003] Datetime format validation
  it('should validate ISO 8601 datetime format for timeout', () => {
    const validDatetimeEvent = {
      entityType: 'correction_request' as const,
      entityId: validEntityId,
      eventType: 'correction.requested' as const,
      entityVersion: 1,
      eventVersion: 1,
      tenantId: validTenantId,
      payload: {
        originalAuditLogId: validAuditLogId,
        correctionToolName: 'test_tool',
        correctionType: 'archive' as const,
        requiresPreviousState: false,
        timeout: '2024-06-15T12:00:00.000Z',
        requestedBy: 'user-123',
      },
    };

    expect(() => correctionRequestedEventSchema.parse(validDatetimeEvent)).not.toThrow();

    const invalidDatetimeEvent = {
      ...validDatetimeEvent,
      payload: {
        ...validDatetimeEvent.payload,
        timeout: 'not-a-datetime',
      },
    };

    expect(() => correctionRequestedEventSchema.parse(invalidDatetimeEvent)).toThrow();
  });

  // [TE-P2-003] Backward compatibility
  it('should handle events without optional fields', () => {
    const minimalEvent = {
      entityType: 'correction_request' as const,
      entityId: validEntityId,
      eventType: 'correction.requested' as const,
      entityVersion: 1,
      eventVersion: 1,
      tenantId: validTenantId,
      payload: {
        originalAuditLogId: validAuditLogId,
        correctionToolName: 'linear_archive_issue',
        correctionType: 'archive' as const,
        requiresPreviousState: false,
        requestedBy: 'user-123',
        // No timeout, maxRetries, retryCount, reason, or traceContext
      },
    };

    expect(() => correctionRequestedEventSchema.parse(minimalEvent)).not.toThrow();
  });
});
