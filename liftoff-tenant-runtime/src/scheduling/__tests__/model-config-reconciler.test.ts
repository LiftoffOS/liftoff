import { jest } from '@jest/globals';

const mockQuery = jest.fn();
const mockHandle = jest.fn();

jest.mock('../../events/subscriber', () => ({
  subscriberPool: { query: (...args: unknown[]) => mockQuery(...args) },
  handleModelConfigUpdated: (...args: unknown[]) => mockHandle(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { reconcileModelConfigs } from '../model-config-reconciler';

beforeEach(() => {
  mockQuery.mockReset();
  mockHandle.mockReset();
});

it('walks every tenant in cached_model_configs and reports success', async () => {
  mockQuery.mockResolvedValueOnce({
    rows: [
      { tenant_id: '11111111-1111-1111-1111-111111111111' },
      { tenant_id: '22222222-2222-2222-2222-222222222222' },
    ],
  });
  mockHandle.mockResolvedValue(undefined);

  const r = await reconcileModelConfigs();
  expect(r.tenantCount).toBe(2);
  expect(r.reconciled).toBe(2);
  expect(r.failed).toBe(0);
  expect(r.errors).toEqual([]);
  expect(mockHandle).toHaveBeenCalledTimes(2);

  for (const call of mockHandle.mock.calls) {
    const event = call[0] as { tenant_id: string; event_type: string; payload: { reconciler: boolean } };
    expect(event.event_type).toBe('tenant.model_config.updated');
    expect(event.payload).toEqual({ reconciler: true });
    expect(typeof event.tenant_id).toBe('string');
  }
});

it('continues after a per-tenant failure', async () => {
  mockQuery.mockResolvedValueOnce({
    rows: [
      { tenant_id: '11111111-1111-1111-1111-111111111111' },
      { tenant_id: '22222222-2222-2222-2222-222222222222' },
    ],
  });
  mockHandle
    .mockRejectedValueOnce(new Error('PB 503'))
    .mockResolvedValueOnce(undefined);

  const r = await reconcileModelConfigs();
  expect(r.tenantCount).toBe(2);
  expect(r.reconciled).toBe(1);
  expect(r.failed).toBe(1);
  expect(r.errors).toEqual([
    { tenantId: '11111111-1111-1111-1111-111111111111', err: 'PB 503' },
  ]);
});

it('returns counts of zero when no tenants are cached', async () => {
  mockQuery.mockResolvedValueOnce({ rows: [] });

  const r = await reconcileModelConfigs();
  expect(r.tenantCount).toBe(0);
  expect(r.reconciled).toBe(0);
  expect(r.failed).toBe(0);
  expect(mockHandle).not.toHaveBeenCalled();
});
