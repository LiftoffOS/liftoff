import { insertAuditLog } from '../service';
import { pool } from '../../infrastructure/database';

jest.mock('../../infrastructure/database', () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));

describe('insertAuditLog — PII redaction across all fields', () => {
  beforeEach(() => jest.clearAllMocks());

  it('redacts PII in preActionSnapshot before insert', async () => {
    await insertAuditLog(null, 'tenant-1', {
      action: 'hris.update_employee',
      inputArgs: { employee_id: 42 },
      outcome: 'success',
      triggeredBy: 'agent-7',
      preActionSnapshot: { ssn: '123-45-6789', email: 'alice@x.com', name: 'Alice' },
    });

    const [, params] = (pool.query as jest.Mock).mock.calls[0];
    const preActionSnapshotIdx = 13; // see INSERT param order in service.ts
    const stored = JSON.parse(params[preActionSnapshotIdx]);
    expect(stored.ssn).toBe('[REDACTED_SSN]');
    expect(stored.email).toBe('[REDACTED_EMAIL]');
    expect(stored.name).toBe('Alice'); // names not caught — acknowledged
  });

  it('redacts PII in postActionSnapshot before insert', async () => {
    await insertAuditLog(null, 'tenant-1', {
      action: 'hris.update_employee',
      inputArgs: { employee_id: 42 },
      outcome: 'success',
      triggeredBy: 'agent-7',
      postActionSnapshot: { ssn: '123-45-6789' },
    });
    const [, params] = (pool.query as jest.Mock).mock.calls[0];
    expect(JSON.parse(params[14]).ssn).toBe('[REDACTED_SSN]');
  });

  it('redacts PII in externalResponse before insert', async () => {
    await insertAuditLog(null, 'tenant-1', {
      action: 'hris.lookup_employee',
      inputArgs: { employee_id: 42 },
      outcome: 'success',
      triggeredBy: 'agent-7',
      externalResponse: { ssn: '123-45-6789', notes: 'call 415-555-0123' },
    });
    const [, params] = (pool.query as jest.Mock).mock.calls[0];
    const stored = JSON.parse(params[15]);
    expect(stored.ssn).toBe('[REDACTED_SSN]');
    expect(stored.notes).toBe('call [REDACTED_PHONE]');
  });

  it('redacts PII in outputSummary string', async () => {
    await insertAuditLog(null, 'tenant-1', {
      action: 'hris.update_employee',
      inputArgs: { employee_id: 42 },
      outcome: 'success',
      triggeredBy: 'agent-7',
      outputSummary: 'Updated SSN 123-45-6789 for employee Alice',
    });
    const [, params] = (pool.query as jest.Mock).mock.calls[0];
    expect(params[8]).toBe('Updated SSN [REDACTED_SSN] for employee Alice');
  });
});
