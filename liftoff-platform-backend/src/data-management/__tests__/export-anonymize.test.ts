import { ExportService } from '../export-service';
import { pool } from '../../infrastructure/database';
import { logAudit } from '../../infrastructure/logging';
import type { ExportJob } from '../types';

jest.mock('../../infrastructure/database', () => {
  // Per-tenant export queries run under withTenantScope (RLS-force); route the
  // client to the same pool.query mock so mockResolvedValueOnce sequences hold.
  const q = jest.fn();
  return {
    pool: { query: q },
    withTenantScope: (_tenantId: string, cb: (c: { query: typeof q }) => unknown) => cb({ query: q }),
    withAdminScope: (_opts: unknown, cb: (c: { query: typeof q }) => unknown) => cb({ query: q }),
  };
});

jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  logAudit: jest.fn(),
}));

jest.mock('../../events/publisher', () => ({
  publishEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: jest.fn().mockResolvedValue(null),
  })),
}));

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({
    bucket: () => ({
      file: () => ({
        save: jest.fn().mockResolvedValue(undefined),
        getSignedUrl: jest.fn().mockResolvedValue(['https://signed/url']),
      }),
    }),
  })),
}));

describe('ExportService — anonymize flag', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = process.env.EXPORT_ANONYMIZE_ENABLED;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.EXPORT_ANONYMIZE_ENABLED;
    else process.env.EXPORT_ANONYMIZE_ENABLED = originalEnv;
  });

  // Helper: produce a fully-typed ExportJob in the 'pending' state.
  function stubExportFlow(opts: { anonymize: boolean }): ExportJob {
    return {
      id: 'job-1',
      tenantId: 'tenant-1',
      requestedBy: 'user-1',
      exportType: 'audit_log_export',
      format: 'json',
      scope: { entityTypes: ['audit_log'] },
      filters: { anonymize: opts.anonymize },
      status: 'pending',
      progress: 0,
      totalRecords: 0,
      exportedRecords: 0,
      outputPath: null,
      downloadUrl: null,
      downloadExpiresAt: null,
      errorMessage: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    };
  }

  it('refuses anonymize=true when EXPORT_ANONYMIZE_ENABLED is unset', async () => {
    delete process.env.EXPORT_ANONYMIZE_ENABLED;
    const job = stubExportFlow({ anonymize: true });
    const service = new ExportService();
    const repo = (service as any).repository;
    repo.findExportJobById = jest.fn().mockResolvedValue(job);
    repo.updateExportJobStatus = jest.fn().mockResolvedValue(job);

    await expect(service.executeExport('job-1')).rejects.toThrow(
      /EXPORT_ANONYMIZE_ENABLED is not "true"/,
    );
    expect(repo.updateExportJobStatus).toHaveBeenCalledWith(
      'job-1',
      'failed',
      expect.objectContaining({
        errorMessage: expect.stringMatching(/EXPORT_ANONYMIZE_ENABLED unset/),
      }),
    );
  });

  it('proceeds when EXPORT_ANONYMIZE_ENABLED is "true"', async () => {
    process.env.EXPORT_ANONYMIZE_ENABLED = 'true';
    const job = stubExportFlow({ anonymize: true });
    const service = new ExportService();
    const repo = (service as any).repository;
    repo.findExportJobById = jest.fn().mockResolvedValue(job);
    repo.updateExportJobStatus = jest.fn().mockResolvedValue(job);

    // information_schema.columns returns expected columns for audit_log,
    // then SELECT COUNT for countRecords, then SELECT * for fetchEntityData.
    (pool.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes('information_schema.columns')) {
        return Promise.resolve({
          rows: [{ column_name: 'ip_address' }, { column_name: 'user_agent' }],
        });
      }
      if (sql.includes('SELECT COUNT')) return Promise.resolve({ rows: [{ count: '1' }] });
      // SELECT * — row with PII
      return Promise.resolve({
        rows: [
          {
            ip_address: '10.0.0.1',
            user_agent: 'Mozilla',
            note: 'contact alice@example.com',
          },
        ],
      });
    });

    await service.executeExport('job-1');
    // No specific assertion on save here — the integration test asserts
    // blob metadata. This test just verifies the env-gate allows proceeding.
    expect(repo.updateExportJobStatus).toHaveBeenCalledWith(
      'job-1',
      'completed',
      expect.any(Object),
    );
  });

  it('emits compliance.export_anonymized audit on success', async () => {
    process.env.EXPORT_ANONYMIZE_ENABLED = 'true';
    const job = stubExportFlow({ anonymize: true });
    const service = new ExportService();
    const repo = (service as any).repository;
    repo.findExportJobById = jest.fn().mockResolvedValue(job);
    repo.updateExportJobStatus = jest.fn().mockResolvedValue(job);

    (pool.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes('information_schema.columns')) {
        return Promise.resolve({
          rows: [{ column_name: 'ip_address' }, { column_name: 'user_agent' }],
        });
      }
      if (sql.includes('SELECT COUNT')) return Promise.resolve({ rows: [{ count: '0' }] });
      return Promise.resolve({ rows: [] });
    });

    await service.executeExport('job-1');

    expect(logAudit).toHaveBeenCalledWith(
      'compliance.export_anonymized',
      expect.objectContaining({ tenantId: 'tenant-1' }),
      expect.objectContaining({
        newState: expect.objectContaining({
          redactionVersion: expect.any(String),
          layer1Kills: expect.any(Number),
          layer2Counters: expect.any(Object),
        }),
      }),
    );
  });

  it('fails loudly when a PII_COLUMNS column does not exist on the table', async () => {
    process.env.EXPORT_ANONYMIZE_ENABLED = 'true';
    const job = stubExportFlow({ anonymize: true });
    const service = new ExportService();
    const repo = (service as any).repository;
    repo.findExportJobById = jest.fn().mockResolvedValue(job);
    repo.updateExportJobStatus = jest.fn().mockResolvedValue(job);

    // information_schema returns a set MISSING 'user_agent'.
    (pool.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes('information_schema.columns')) {
        return Promise.resolve({ rows: [{ column_name: 'ip_address' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.executeExport('job-1')).rejects.toThrow(
      /PII_COLUMNS schema drift/,
    );
    // Schema-drift must mark the job 'failed' so processPendingExports
    // doesn't retry it every poll cycle.
    expect(repo.updateExportJobStatus).toHaveBeenCalledWith(
      'job-1',
      'failed',
      expect.objectContaining({
        errorMessage: expect.stringMatching(/schema drift/i),
      }),
    );
  });

  it('reports a clear error when the table is entirely missing', async () => {
    process.env.EXPORT_ANONYMIZE_ENABLED = 'true';
    const job = stubExportFlow({ anonymize: true });
    const service = new ExportService();
    const repo = (service as any).repository;
    repo.findExportJobById = jest.fn().mockResolvedValue(job);
    repo.updateExportJobStatus = jest.fn().mockResolvedValue(job);

    // information_schema returns nothing — table does not exist.
    (pool.query as jest.Mock).mockImplementation((sql: string) => {
      if (sql.includes('information_schema.columns')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(service.executeExport('job-1')).rejects.toThrow(
      /does not exist in the database/,
    );
  });
});

describe('anonymizeData — pattern coverage (unit)', () => {
  it('Layer 1 nulls structured columns and bumps the layer1Kills counter', () => {
    const service = new ExportService();
    const counters = { layer1Kills: 0, layer2: {} as Record<string, number> };
    const result = (service as any).anonymizeData(
      [{ email: 'alice@x.com', name: 'Alice', count: 7 }],
      'account',
      counters,
    );
    expect(result[0].email).toBe('[REDACTED]');
    expect(result[0].name).toBe('[REDACTED]');
    expect(result[0].count).toBe(7);
    expect(counters.layer1Kills).toBe(2);
  });

  it('Layer 2 scrubs PII inside a JSONB-shaped field', () => {
    const service = new ExportService();
    const counters = { layer1Kills: 0, layer2: {} as Record<string, number> };
    const result = (service as any).anonymizeData(
      [
        {
          data: {
            employee: { ssn: '123-45-6789' },
            notes: 'card 4111 1111 1111 1111',
          },
        },
      ],
      'connector_record',
      counters,
    );
    expect(result[0].data.employee.ssn).toBe('[REDACTED_SSN]');
    expect(result[0].data.notes).toContain('[REDACTED_CC]');
  });

  it('leaves non-string primitives untouched', () => {
    const service = new ExportService();
    const counters = { layer1Kills: 0, layer2: {} as Record<string, number> };
    const result = (service as any).anonymizeData(
      [{ count: 42, active: true, deleted_at: null }],
      'workflow',
      counters,
    );
    expect(result[0]).toEqual({ count: 42, active: true, deleted_at: null });
  });
});
