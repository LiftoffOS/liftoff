/**
 * FeatureFlagRepository tests — focused on the value_num column wiring.
 *
 * Mocks the pg pool so we can assert SQL + parameter shape without a live DB.
 * Round-trip-against-real-DB coverage is provided by the migration step in
 * deploy CI.
 */

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { FeatureFlagRepository } from '../repository';

beforeEach(() => { jest.clearAllMocks(); });

describe('FeatureFlagRepository.create with valueNum', () => {
  it('writes value_num into the INSERT and maps numeric back into FeatureFlag.valueNum', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'f1', key: 'k', name: 'n', description: 'd', enabled: true,
        value_num: '30', tenant_overrides: {}, created_at: new Date(), updated_at: new Date(),
      }],
    });
    const repo = new FeatureFlagRepository();
    const flag = await repo.create({ key: 'k', name: 'n', description: 'd', enabled: true, valueNum: 30 });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/value_num/);
    expect(params).toEqual(['k', 'n', 'd', true, '{}', 30]);
    expect(flag.valueNum).toBe(30);
  });

  it('passes NULL when valueNum is omitted, returns null from mapRow', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'f1', key: 'k', name: 'n', description: 'd', enabled: true,
        value_num: null, tenant_overrides: {}, created_at: new Date(), updated_at: new Date(),
      }],
    });
    const repo = new FeatureFlagRepository();
    const flag = await repo.create({ key: 'k', name: 'n', description: 'd', enabled: true });
    const [, params] = mockQuery.mock.calls[0];
    expect(params[5]).toBeNull();
    expect(flag.valueNum).toBeNull();
  });
});

describe('FeatureFlagRepository.update with valueNum', () => {
  it('appends value_num=? to the dynamic UPDATE when valueNum is supplied', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'f1', key: 'k', name: 'n', description: 'd', enabled: true,
        value_num: '42', tenant_overrides: {}, created_at: new Date(), updated_at: new Date(),
      }],
    });
    const repo = new FeatureFlagRepository();
    await repo.update('f1', { enabled: true, valueNum: 42 });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/value_num =/);
    expect(params).toContain(42);
  });
});
