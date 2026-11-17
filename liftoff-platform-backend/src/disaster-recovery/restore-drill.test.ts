// src/disaster-recovery/restore-drill.test.ts
import { RestoreDrillService } from './restore-drill'

// Create stable mock pool reference
const mockPoolQuery = jest.fn()
const mockPoolInstance = {
  query: mockPoolQuery,
}

// Mock dependencies. withAdminScope is now used by events/publisher.publishEvent
// (outbox pattern) — stub it so publishEvent's tx wrap
// resolves cleanly even though this test never inspects the outbox row.
jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(() => mockPoolInstance),
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'outbox-1', event_id: 'evt-1' }], rowCount: 1 }) };
    return fn(client);
  }),
}))

// publishEvent (events/publisher) now routes through the outbox. Stub it
// directly so this test doesn't depend on outbox/inline-publish wiring.
jest.mock('../events/publisher', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../infrastructure/logging', () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
  return {
    logger: mockLogger,
    log: mockLogger,
    createLogger: jest.fn(() => mockLogger),
  }
})

jest.mock('../infrastructure/pubsub', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@google-cloud/pubsub', () => ({
  PubSub: jest.fn().mockImplementation(() => ({
    topic: jest.fn().mockReturnValue({
      publishMessage: jest.fn().mockResolvedValue('message-id'),
    }),
  })),
}))

jest.mock('@google-cloud/run', () => ({
  JobsClient: jest.fn().mockImplementation(() => ({
    runJob: jest.fn().mockResolvedValue([{ name: 'test-execution' }]),
    getJob: jest.fn().mockResolvedValue([{ name: 'test-job' }]),
  })),
}))

jest.mock('googleapis', () => ({
  google: {
    sqladmin: jest.fn(() => ({
      instances: {
        restoreBackup: jest.fn().mockResolvedValue({ data: { status: 'RUNNING' } }),
        get: jest.fn().mockResolvedValue({ data: { state: 'RUNNABLE' } }),
      },
      backupRuns: {
        list: jest.fn().mockResolvedValue({
          data: {
            items: [
              { id: '123', status: 'SUCCESSFUL', endTime: new Date().toISOString() },
            ],
          },
        }),
      },
      operations: {
        get: jest.fn().mockResolvedValue({ data: { status: 'DONE' } }),
      },
    })),
    auth: {
      GoogleAuth: jest.fn().mockImplementation(() => ({
        getClient: jest.fn().mockResolvedValue({}),
      })),
    },
    options: jest.fn(),
  },
  Auth: {},
}))

describe('RestoreDrillService', () => {
  let service: RestoreDrillService

  beforeEach(() => {
    service = new RestoreDrillService()
    mockPoolQuery.mockReset()
  })

  describe('scheduleDrill', () => {
    it('should create a new drill record', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 'drill-123',
          drill_type: 'full',
          environment: 'staging',
          source_backup_id: 'backup-456',
          source_timestamp: new Date(),
          target_database: 'restore_drill_test',
          status: 'scheduled',
          started_at: new Date(),
          completed_at: null,
          results: {},
          verification_checks: [],
          rto_seconds: null,
          rpo_seconds: null,
          created_by: 'user-123',
          created_at: new Date(),
        }],
      })

      const result = await service.scheduleDrill({
        environment: 'staging',
        createdBy: 'user-123',
        drillType: 'full',
      })

      expect(result.id).toBe('drill-123')
      expect(mockPoolQuery).toHaveBeenCalled()
    })

    it('should reject production environment', async () => {
      await expect(
        service.scheduleDrill({
          // @ts-expect-error - testing runtime validation
          environment: 'production',
          createdBy: 'user-123',
          drillType: 'full',
        })
      ).rejects.toThrow('Restore drills cannot be run against production')
    })
  })

  describe('executeDrill', () => {
    it('should reject if drill not found', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] })

      await expect(
        service.executeDrill('nonexistent-drill')
      ).rejects.toThrow('Restore drill not found')
    })

    it('should reject if drill is not in scheduled status', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 'drill-123',
          status: 'running',
          drill_type: 'full',
          environment: 'staging',
          source_backup_id: 'backup-456',
          source_timestamp: new Date(),
          target_database: 'restore_drill_test',
          started_at: new Date(),
          completed_at: null,
          results: {},
          verification_checks: [],
          rto_seconds: null,
          rpo_seconds: null,
          created_by: 'user-123',
          created_at: new Date(),
        }],
      })

      await expect(
        service.executeDrill('drill-123')
      ).rejects.toThrow('Cannot execute drill with status: running')
    })
  })

  describe('getDrill', () => {
    it('should return drill by id', async () => {
      const mockDrill = {
        id: 'drill-123',
        drill_type: 'full',
        environment: 'staging',
        source_backup_id: 'backup-456',
        source_timestamp: new Date(),
        target_database: 'restore_drill_test',
        status: 'completed',
        started_at: new Date(),
        completed_at: new Date(),
        results: { restoreSuccessful: true },
        verification_checks: ['integrity_check'],
        rto_seconds: 300,
        rpo_seconds: 0,
        created_by: 'user-123',
        created_at: new Date(),
      }

      mockPoolQuery.mockResolvedValueOnce({ rows: [mockDrill] })

      const result = await service.getDrill('drill-123')

      expect(result).not.toBeNull()
      expect(result!.id).toBe('drill-123')
      expect(result!.status).toBe('completed')
    })

    it('should return null if drill not found', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] })

      const result = await service.getDrill('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('isDrillOverdue', () => {
    it('should return true if no recent successful drill', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] })

      const result = await service.isDrillOverdue('staging')

      expect(result).toBe(true)
    })

    it('should return false if drill was recent', async () => {
      const recentDate = new Date()
      recentDate.setDate(recentDate.getDate() - 30)

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 'drill-123',
          completed_at: recentDate,
          status: 'completed',
          drill_type: 'full',
          environment: 'staging',
          source_backup_id: 'backup-456',
          source_timestamp: new Date(),
          target_database: 'restore_drill_test',
          started_at: new Date(),
          results: { restoreSuccessful: true },
          verification_checks: [],
          rto_seconds: 300,
          rpo_seconds: 0,
          created_by: 'user-123',
          created_at: new Date(),
        }],
      })

      const result = await service.isDrillOverdue('staging')

      expect(result).toBe(false)
    })

    it('should return true if last drill was more than 90 days ago', async () => {
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 100)

      mockPoolQuery.mockResolvedValueOnce({
        rows: [{
          id: 'drill-123',
          completed_at: oldDate,
          status: 'completed',
          drill_type: 'full',
          environment: 'staging',
          source_backup_id: 'backup-456',
          source_timestamp: new Date(),
          target_database: 'restore_drill_test',
          started_at: new Date(),
          results: { restoreSuccessful: true },
          verification_checks: [],
          rto_seconds: 300,
          rpo_seconds: 0,
          created_by: 'user-123',
          created_at: new Date(),
        }],
      })

      const result = await service.isDrillOverdue('staging')

      expect(result).toBe(true)
    })
  })
})
