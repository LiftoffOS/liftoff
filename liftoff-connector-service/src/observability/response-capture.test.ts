// Unit tests for the Phase 4 capture path: reads-only guard, PII redaction, first-write-wins
// short-circuit, and never-throws. The DB pool is mocked.
jest.mock('../db/pool.js', () => ({ getAdminPool: jest.fn() }));

import { getAdminPool } from '../db/pool.js';
import { captureResponseSample, _resetCaptured } from './response-capture';

const query = jest.fn().mockResolvedValue({ rows: [] });

beforeEach(() => {
  query.mockClear();
  _resetCaptured();
  (getAdminPool as jest.Mock).mockResolvedValue({ query });
});

describe('captureResponseSample', () => {
  it('inserts a redacted sample for a read', async () => {
    await captureResponseSample('personio', 'get_employees', { categories: ['read'] }, { email: 'jane@acme.com', id: '42' });
    expect(query).toHaveBeenCalledTimes(1);
    const [ct, fnName, sampleJson] = query.mock.calls[0][1] as [string, string, string];
    expect(ct).toBe('personio');
    expect(fnName).toBe('get_employees');
    const sample = JSON.parse(sampleJson);
    expect(sample.id).toBe('42');
    expect(sample.email).not.toBe('jane@acme.com'); // PII redacted
  });

  it('stores the unwrapped raw vendor body (drops the adapter {id,data} read envelope)', async () => {
    await captureResponseSample('personio', 'get_x', { categories: ['read'] }, { id: 'generated', data: { data: [{ id: '1' }] } });
    expect(JSON.parse((query.mock.calls[0][1] as string[])[2])).toEqual({ data: [{ id: '1' }] });
  });

  it('captures multi-category reads (read + sensitive)', async () => {
    await captureResponseSample('hibob', 'get_people', { categories: ['read', 'sensitive'] }, { id: '1' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('skips writes', async () => {
    await captureResponseSample('personio', 'create_employee', { categories: ['write'] }, { id: '1' });
    expect(query).not.toHaveBeenCalled();
  });

  it('skips a tool tagged with any write/destructive/outbound category', async () => {
    await captureResponseSample('personio', 'x', { categories: ['read', 'destructive'] }, {});
    expect(query).not.toHaveBeenCalled();
  });

  it('skips when the tool is unresolved', async () => {
    await captureResponseSample('personio', 'unknown', undefined, {});
    expect(query).not.toHaveBeenCalled();
  });

  it('short-circuits repeat captures of the same action (first-write-wins)', async () => {
    await captureResponseSample('personio', 'get_employees', { categories: ['read'] }, { id: '1' });
    await captureResponseSample('personio', 'get_employees', { categories: ['read'] }, { id: '2' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('never throws when the DB errors', async () => {
    (getAdminPool as jest.Mock).mockResolvedValue({ query: jest.fn().mockRejectedValue(new Error('db down')) });
    await expect(captureResponseSample('personio', 'get_x', { categories: ['read'] }, {})).resolves.toBeUndefined();
  });
});
