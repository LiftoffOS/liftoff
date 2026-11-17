// EventProcessor Tests
// Comprehensive parameterized tests for claim/resume/DLQ, step tracking, and concurrency.

import { EventProcessor, DlqRoutedError, StepDefinition } from '../event-processor';
import type { ControlPlaneEvent } from '../types';

// --- Mock Pool ---

const mockQuery = jest.fn();
const mockPool = { query: mockQuery } as any;

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// --- Helpers ---

function buildEvent(overrides: Partial<ControlPlaneEvent> = {}): ControlPlaneEvent {
  return {
    event_id: 'evt-001',
    tenant_id: 'tenant-001',
    entity_type: 'internal_agent',
    entity_id: 'entity-001',
    event_type: 'tenant.internal_agent.status_changed',
    entity_version: 1,
    event_version: 1,
    occurred_at: new Date().toISOString(),
    payload: { newStatus: 'active' },
    ...overrides,
  } as ControlPlaneEvent;
}

function buildLedgerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: 'evt-001',
    tenant_id: 'tenant-001',
    status: 'processing',
    steps_completed: [],
    result_metadata: null,
    attempt_count: 1,
    error: null,
    first_seen_at: new Date(),
    ...overrides,
  };
}

const ACTIVATION_STEPS: StepDefinition[] = [
  { name: 'create_instruction', execute: jest.fn() },
  { name: 'persist_trigger_config', execute: jest.fn() },
  { name: 'activate_lifecycle', execute: jest.fn() },
  { name: 'ensure_scheduler', execute: jest.fn() },
  { name: 'update_cache', execute: jest.fn() },
];

const PAUSE_STEPS: StepDefinition[] = [
  { name: 'pause_lifecycle', execute: jest.fn() },
  { name: 'cancel_tasks', execute: jest.fn() },
  { name: 'update_cache', execute: jest.fn() },
];

describe('EventProcessor', () => {
  let processor: EventProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new EventProcessor(mockPool, 5);
    // Reset step mocks
    for (const step of [...ACTIVATION_STEPS, ...PAUSE_STEPS]) {
      (step.execute as jest.Mock).mockReset();
      (step.execute as jest.Mock).mockResolvedValue(undefined);
    }
  });

  // ============================================================
  // 1. Claim tests
  // ============================================================

  describe('claimEvent', () => {
    it('first delivery should insert and return status=processing', async () => {
      // INSERT succeeds (first delivery)
      mockQuery
        .mockResolvedValueOnce({ rows: [buildLedgerRow()], rowCount: 1 })  // INSERT RETURNING
        .mockResolvedValueOnce({ rows: [] })  // version ordering check
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // step CAS
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // step CAS
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // step CAS
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // step CAS
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // step CAS
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // mark completed

      const result = await processor.process(buildEvent(), ACTIVATION_STEPS);
      expect(result).toBe(true);

      // Verify INSERT was called
      const insertCall = mockQuery.mock.calls[0][0];
      expect(insertCall).toContain('INSERT INTO event_processing_ledger');
    });

    it('redelivery of completed event should return true without processing', async () => {
      // INSERT conflicts, RETURNING empty (completed)
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // INSERT: no RETURNING
        .mockResolvedValueOnce({ rows: [buildLedgerRow({ status: 'completed' })], rowCount: 1 }); // SELECT: completed

      const result = await processor.process(buildEvent(), ACTIVATION_STEPS);
      expect(result).toBe(true);

      // No step should have been called
      for (const step of ACTIVATION_STEPS) {
        expect(step.execute).not.toHaveBeenCalled();
      }
    });

    it('concurrent delivery while processing should return false', async () => {
      // INSERT conflicts, RETURNING empty (actively processing)
      mockQuery
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // INSERT: no RETURNING
        .mockResolvedValueOnce({ rows: [buildLedgerRow({ status: 'processing' })], rowCount: 1 }); // SELECT: processing

      const result = await processor.process(buildEvent(), ACTIVATION_STEPS);
      expect(result).toBe(false);

      // No steps called
      for (const step of ACTIVATION_STEPS) {
        expect(step.execute).not.toHaveBeenCalled();
      }
    });

    it('redelivery after crash (stale >5 min) should allow resume', async () => {
      // INSERT conflicts, ON CONFLICT WHERE matches stale row → updates and RETURNS
      mockQuery
        .mockResolvedValueOnce({
          rows: [buildLedgerRow({ attempt_count: 2, steps_completed: ['create_instruction'] })],
          rowCount: 1,
        })  // INSERT RETURNING (stale reclaim)
        .mockResolvedValueOnce({ rows: [] })  // version ordering
        // Only steps 2-5 should execute (step 1 already completed)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // step CAS
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // step CAS
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // step CAS
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // step CAS
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // mark completed

      const result = await processor.process(buildEvent(), ACTIVATION_STEPS);
      expect(result).toBe(true);

      // Step 1 should NOT have been called (already completed)
      expect(ACTIVATION_STEPS[0].execute).not.toHaveBeenCalled();
      // Steps 2-5 should have been called
      expect(ACTIVATION_STEPS[1].execute).toHaveBeenCalled();
      expect(ACTIVATION_STEPS[2].execute).toHaveBeenCalled();
      expect(ACTIVATION_STEPS[3].execute).toHaveBeenCalled();
      expect(ACTIVATION_STEPS[4].execute).toHaveBeenCalled();
    });

    it('redelivery of failed event should reset to processing', async () => {
      // INSERT conflicts, ON CONFLICT WHERE matches failed → resets to processing
      mockQuery
        .mockResolvedValueOnce({
          rows: [buildLedgerRow({ status: 'processing', attempt_count: 3 })],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [] })  // version ordering
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await processor.process(buildEvent(), ACTIVATION_STEPS);
      expect(result).toBe(true);
    });

    it('different event_id for same entity while processing should throw EntityBusyError (23505)', async () => {
      // INSERT throws unique violation on idx_epl_entity_processing.
      // The processor must throw EntityBusyError so the subscriber nacks
      // the Pub/Sub message and Pub/Sub redelivers it after the ack
      // deadline. Returning false silently dropped the message and lost
      // every fast-arriving second event for the same entity (e.g. a
      // pause+resume pair in <1s).
      const uniqueError: any = new Error('unique_violation');
      uniqueError.code = '23505';
      uniqueError.constraint = 'idx_epl_entity_processing';

      mockQuery
        .mockRejectedValueOnce(uniqueError)
        // Stale lock cleanup query returns 0 rows (lock is fresh)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const event = buildEvent();
      await expect(processor.process(event, ACTIVATION_STEPS)).rejects.toMatchObject({
        name: 'EntityBusyError',
        eventId: event.event_id,
        entityId: event.entity_id,
      });
    });

    it('should clear stale processing lock and retry claim on 23505', async () => {
      const uniqueError: any = new Error('unique_violation');
      uniqueError.code = '23505';
      uniqueError.constraint = 'idx_epl_entity_processing';

      mockQuery
        // First INSERT throws unique violation
        .mockRejectedValueOnce(uniqueError)
        // Stale lock cleanup returns 1 cleared row
        .mockResolvedValueOnce({ rows: [{ event_id: 'old-stuck-event' }], rowCount: 1 })
        // Retry claim INSERT succeeds (first delivery)
        .mockResolvedValueOnce({
          rows: [{ event_id: 'evt-001', tenant_id: 'tenant-001', status: 'processing',
                   steps_completed: [], result_metadata: null, attempt_count: 1,
                   error: null, first_seen_at: new Date() }],
          rowCount: 1,
        })
        // Version guard (no later completed)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // Step executions + CAS appends (5 steps × 1 CAS each)
        .mockResolvedValue({ rows: [{ event_id: 'evt-001' }], rowCount: 1 });

      const steps = ACTIVATION_STEPS.map(s => ({ ...s, execute: jest.fn() }));
      const result = await processor.process(buildEvent(), steps);

      expect(result).toBe(true);
      // All 5 steps should have executed
      for (const step of steps) {
        expect(step.execute).toHaveBeenCalledTimes(1);
      }
    });
  });

  // ============================================================
  // 2. Step-resume tests (parameterized)
  // ============================================================

  describe('step-resume — activation path (5 steps)', () => {
    const stepNames = ['create_instruction', 'persist_trigger_config', 'activate_lifecycle', 'ensure_scheduler', 'update_cache'];

    for (let completedCount = 0; completedCount <= 4; completedCount++) {
      const completed = stepNames.slice(0, completedCount);
      const remaining = stepNames.slice(completedCount);

      it(`should skip ${completedCount} completed steps and execute remaining ${remaining.length}`, async () => {
        mockQuery
          .mockResolvedValueOnce({
            rows: [buildLedgerRow({ steps_completed: completed })],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [] }); // version ordering

        // Mock CAS append + markCompleted for each remaining step
        for (let i = 0; i < remaining.length + 1; i++) {
          mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        }

        await processor.process(buildEvent(), ACTIVATION_STEPS);

        // Completed steps should NOT be called
        for (let i = 0; i < completedCount; i++) {
          expect(ACTIVATION_STEPS[i].execute).not.toHaveBeenCalled();
        }
        // Remaining steps should be called
        for (let i = completedCount; i < 5; i++) {
          expect(ACTIVATION_STEPS[i].execute).toHaveBeenCalled();
        }
      });
    }
  });

  describe('step-resume — pause path (3 steps)', () => {
    const stepNames = ['pause_lifecycle', 'cancel_tasks', 'update_cache'];

    for (let completedCount = 0; completedCount <= 2; completedCount++) {
      const completed = stepNames.slice(0, completedCount);
      const remaining = stepNames.slice(completedCount);

      it(`should skip ${completedCount} completed steps and execute remaining ${remaining.length}`, async () => {
        const event = buildEvent({ payload: { newStatus: 'paused' } });

        mockQuery
          .mockResolvedValueOnce({
            rows: [buildLedgerRow({ steps_completed: completed })],
            rowCount: 1,
          })
          .mockResolvedValueOnce({ rows: [] }); // version ordering

        for (let i = 0; i < remaining.length + 1; i++) {
          mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        }

        await processor.process(event, PAUSE_STEPS);

        for (let i = 0; i < completedCount; i++) {
          expect(PAUSE_STEPS[i].execute).not.toHaveBeenCalled();
        }
        for (let i = completedCount; i < 3; i++) {
          expect(PAUSE_STEPS[i].execute).toHaveBeenCalled();
        }
      });
    }
  });

  // ============================================================
  // 3. Version ordering tests
  // ============================================================

  describe('version ordering', () => {
    it('should skip event when a later version has completed', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [buildLedgerRow()], rowCount: 1 })  // claim
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })  // later version exists
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });  // markCompleted

      const event = buildEvent({ entity_version: 5 });
      const result = await processor.process(event, ACTIVATION_STEPS);
      expect(result).toBe(true);

      // No steps should execute
      for (const step of ACTIVATION_STEPS) {
        expect(step.execute).not.toHaveBeenCalled();
      }
    });

    it('should process normally when no later version exists', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [buildLedgerRow()], rowCount: 1 })  // claim
        .mockResolvedValueOnce({ rows: [] });  // no later version

      // Steps + markCompleted
      for (let i = 0; i < 6; i++) {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      }

      const result = await processor.process(buildEvent(), ACTIVATION_STEPS);
      expect(result).toBe(true);
      expect(ACTIVATION_STEPS[0].execute).toHaveBeenCalled();
    });
  });

  // ============================================================
  // 4. DLQ routing tests
  // ============================================================

  describe('DLQ routing', () => {
    it('should route to DLQ after maxAttempts', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [buildLedgerRow({ attempt_count: 6 })], // > maxAttempts (5)
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // INSERT dlq_messages
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE ledger status=failed

      await expect(processor.process(buildEvent(), ACTIVATION_STEPS))
        .rejects.toThrow(DlqRoutedError);

      // Verify DLQ INSERT was called
      const dlqCall = mockQuery.mock.calls[1][0];
      expect(dlqCall).toContain('INSERT INTO dlq_messages');
    });

    it('should NOT throw DlqRoutedError when DLQ write fails', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [buildLedgerRow({ attempt_count: 6 })],
          rowCount: 1,
        })
        .mockRejectedValueOnce(new Error('DB connection lost')); // DLQ write fails

      await expect(processor.process(buildEvent(), ACTIVATION_STEPS))
        .rejects.toThrow('DLQ write failed');

      // Should NOT be DlqRoutedError
      try {
        await processor.process(buildEvent(), ACTIVATION_STEPS);
      } catch (e) {
        expect(e).not.toBeInstanceOf(DlqRoutedError);
      }
    });
  });

  // ============================================================
  // 5. DlqRoutedError contract tests
  // ============================================================

  describe('DlqRoutedError', () => {
    it('should be identifiable by instanceof', () => {
      const error = new DlqRoutedError('evt-001');
      expect(error).toBeInstanceOf(DlqRoutedError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('DlqRoutedError');
    });
  });

  // ============================================================
  // 6. Step name validation
  // ============================================================

  describe('step name validation', () => {
    it('should reject invalid step names for known event types', async () => {
      const badSteps: StepDefinition[] = [
        { name: 'drop_all_tables', execute: jest.fn() },
      ];

      await expect(processor.process(buildEvent(), badSteps))
        .rejects.toThrow("Invalid step name 'drop_all_tables'");
    });

    it('should accept valid step names', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [buildLedgerRow()], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] });

      for (let i = 0; i < 6; i++) {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      }

      // Should not throw
      await processor.process(buildEvent(), ACTIVATION_STEPS);
    });
  });

  // ============================================================
  // 7. Step failure sets status to 'failed'
  // ============================================================

  describe('step failure', () => {
    it('should set status to failed when a step throws', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [buildLedgerRow()], rowCount: 1 })  // claim
        .mockResolvedValueOnce({ rows: [] });  // version ordering

      // Step 1 fails
      (ACTIVATION_STEPS[0].execute as jest.Mock).mockRejectedValue(new Error('step failed'));

      // Expect the error UPDATE to set status='failed'
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });  // error UPDATE

      await expect(processor.process(buildEvent(), ACTIVATION_STEPS))
        .rejects.toThrow('step failed');

      // Verify the UPDATE set status = 'failed'
      const errorUpdateCall = mockQuery.mock.calls[2];
      expect(errorUpdateCall[0]).toContain("status = 'failed'");
    });
  });

  // ============================================================
  // 8. tenant_id required
  // ============================================================

  describe('tenant_id validation', () => {
    it('should throw when tenant_id is missing', async () => {
      const event = buildEvent({ tenant_id: undefined });
      await expect(processor.process(event, ACTIVATION_STEPS))
        .rejects.toThrow('tenant_id required');
    });
  });

  // ============================================================
  // 9. Error sanitization
  // ============================================================

  describe('error sanitization', () => {
    it('should redact connection strings in error messages', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [buildLedgerRow()], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] });

      (ACTIVATION_STEPS[0].execute as jest.Mock).mockRejectedValue(
        new Error('Connection failed: postgresql://user:pass@host:5432/db')
      );

      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      try {
        await processor.process(buildEvent(), ACTIVATION_STEPS);
      } catch {
        // Expected
      }

      // Verify the stored error was sanitized
      const errorUpdateCall = mockQuery.mock.calls[2];
      const storedError = errorUpdateCall[1][2]; // $3 parameter
      expect(storedError).toContain('[REDACTED_CONN]');
      expect(storedError).not.toContain('user:pass');
    });
  });
});
