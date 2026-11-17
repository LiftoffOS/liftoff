/**
 * FeatureFlagService tests — focused on the event payload shape contract.
 *
 * Verifies:
 *  - delete() looks up the flag, then publishes deleted with payload.key
 *  - delete() throws when the flag doesn't exist (no event emitted)
 *  - create() / update() include value_num in the event payload when set
 */

const mockFindById = jest.fn();
const mockCreateRepo = jest.fn();
const mockUpdateRepo = jest.fn();
const mockDeleteRepo = jest.fn();
const mockSetOverrideInTx = jest.fn();
const mockRemoveOverrideInTx = jest.fn();

jest.mock('../repository', () => ({
  FeatureFlagRepository: jest.fn().mockImplementation(() => ({
    findById: mockFindById,
    create: mockCreateRepo,
    update: mockUpdateRepo,
    delete: mockDeleteRepo,
    setTenantOverrideInTx: mockSetOverrideInTx,
    removeTenantOverrideInTx: mockRemoveOverrideInTx,
  })),
}));

const mockPublishEvent = jest.fn();
// mutateAndPublishEvent runs the mutate callback (with a fake client), captures the
// eventInput it returns, and returns the entity — mirroring the real atomic helper.
let capturedEventInput: unknown = null;
const mockMutateAndPublish = jest.fn(async (_ctx: unknown, mutate: (c: unknown) => Promise<{ entity: unknown; eventInput: unknown }>) => {
  const { entity, eventInput } = await mutate({ query: jest.fn() });
  capturedEventInput = eventInput;
  return entity;
});
jest.mock('../../events/publisher', () => ({
  publishEvent: (...args: unknown[]) => mockPublishEvent(...args),
  mutateAndPublishEvent: (...args: unknown[]) => (mockMutateAndPublish as (...a: unknown[]) => unknown)(...args),
}));

import { FeatureFlagService } from '../service';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('FeatureFlagService.delete', () => {
  it('looks up the flag and publishes deleted with payload.key', async () => {
    const svc = new FeatureFlagService();
    mockFindById.mockResolvedValueOnce({
      id: 'f1', key: 'my_flag', name: 'n', description: 'd', enabled: true, valueNum: null, tenantOverrides: {},
    });
    mockDeleteRepo.mockResolvedValueOnce(undefined);
    await svc.delete('f1');
    expect(mockPublishEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'tenant.feature_flag.deleted',
      entityType: 'feature_flag',
      entityId: 'f1',
      payload: { key: 'my_flag' },
    }));
  });

  it('throws when the flag does not exist and never publishes', async () => {
    const svc = new FeatureFlagService();
    mockFindById.mockResolvedValueOnce(null);
    await expect(svc.delete('missing')).rejects.toThrow(/Feature flag not found/);
    expect(mockPublishEvent).not.toHaveBeenCalled();
    expect(mockDeleteRepo).not.toHaveBeenCalled();
  });
});

describe('FeatureFlagService.create event payload', () => {
  it('omits value_num from payload when valueNum is null', async () => {
    const svc = new FeatureFlagService();
    mockCreateRepo.mockResolvedValueOnce({
      id: 'f1', key: 'k', name: 'n', description: 'd', enabled: true, valueNum: null, tenantOverrides: {},
    });
    await svc.create({ key: 'k', name: 'n', description: 'd', enabled: true });
    expect(mockPublishEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'tenant.feature_flag.created',
      payload: { key: 'k', enabled: true },
    }));
  });

  it('includes value_num in payload when valueNum is set', async () => {
    const svc = new FeatureFlagService();
    mockCreateRepo.mockResolvedValueOnce({
      id: 'f2', key: 'k2', name: 'n', description: 'd', enabled: true, valueNum: 30, tenantOverrides: {},
    });
    await svc.create({ key: 'k2', name: 'n', description: 'd', enabled: true, valueNum: 30 });
    expect(mockPublishEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'tenant.feature_flag.created',
      payload: { key: 'k2', enabled: true, value_num: 30 },
    }));
  });
});

describe('FeatureFlagService.update event payload', () => {
  it('includes value_num in payload when valueNum is set on the updated row', async () => {
    const svc = new FeatureFlagService();
    mockUpdateRepo.mockResolvedValueOnce({
      id: 'f3', key: 'k3', name: 'n', description: 'd', enabled: true, valueNum: 42, tenantOverrides: {},
    });
    await svc.update('f3', { enabled: true, valueNum: 42 });
    expect(mockPublishEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'tenant.feature_flag.updated',
      payload: { key: 'k3', enabled: true, value_num: 42 },
    }));
  });

  it('omits value_num from payload when the updated row has valueNum null', async () => {
    const svc = new FeatureFlagService();
    mockUpdateRepo.mockResolvedValueOnce({
      id: 'f4', key: 'k4', name: 'n', description: 'd', enabled: true, valueNum: null, tenantOverrides: {},
    });
    await svc.update('f4', { enabled: true });
    expect(mockPublishEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'tenant.feature_flag.updated',
      payload: { key: 'k4', enabled: true },
    }));
  });
});

describe('FeatureFlagService tenant overrides — atomic mutation + tenant-scoped event', () => {
  beforeEach(() => { capturedEventInput = null; });

  it('setTenantOverride mutates atomically and publishes a tenant-scoped event (tenantId set, payload key only)', async () => {
    const svc = new FeatureFlagService();
    mockSetOverrideInTx.mockResolvedValueOnce({
      id: 'f9', key: 'external_content_write_gate_disabled', name: 'n', description: 'd', enabled: false, valueNum: null, tenantOverrides: { 't1': true },
    });
    const flag = await svc.setTenantOverride('external_content_write_gate_disabled', 't1', true);

    expect(mockSetOverrideInTx).toHaveBeenCalledWith(expect.anything(), 'external_content_write_gate_disabled', 't1', true);
    expect(flag.tenantOverrides).toEqual({ t1: true });
    // The event carries tenantId (so TR refreshes THIS tenant) and payload { key } with
    // NO `enabled` (so TR's global-sentinel mirror is skipped).
    expect(capturedEventInput).toEqual(expect.objectContaining({
      eventType: 'tenant.feature_flag.updated',
      entityType: 'feature_flag',
      tenantId: 't1',
      payload: { key: 'external_content_write_gate_disabled' },
    }));
    expect((capturedEventInput as { payload: Record<string, unknown> }).payload).not.toHaveProperty('enabled');
  });

  it('removeTenantOverride publishes the same tenant-scoped refresh event', async () => {
    const svc = new FeatureFlagService();
    mockRemoveOverrideInTx.mockResolvedValueOnce({
      id: 'f9', key: 'external_content_write_gate_disabled', name: 'n', description: 'd', enabled: false, valueNum: null, tenantOverrides: {},
    });
    await svc.removeTenantOverride('external_content_write_gate_disabled', 't1');
    expect(mockRemoveOverrideInTx).toHaveBeenCalledWith(expect.anything(), 'external_content_write_gate_disabled', 't1');
    expect(capturedEventInput).toEqual(expect.objectContaining({ tenantId: 't1', payload: { key: 'external_content_write_gate_disabled' } }));
  });

  it('throws when the flag row is absent (mutation returns null)', async () => {
    const svc = new FeatureFlagService();
    mockSetOverrideInTx.mockResolvedValueOnce(null);
    await expect(svc.setTenantOverride('missing', 't1', true)).rejects.toThrow(/Feature flag not found/);
  });
});
