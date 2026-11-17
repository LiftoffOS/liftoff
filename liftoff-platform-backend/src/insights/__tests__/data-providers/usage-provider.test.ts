// Usage Provider Tests
//
// Thin wrapper over tenantRuntimeClient.getBurnState. Tests cover the
// happy path, the null pass-through (Tenant Runtime returned null), and
// the error → null fallback.

const mockGetBurnState = jest.fn();
jest.mock('../../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    getBurnState: (...args: unknown[]) => mockGetBurnState(...args),
  },
}));

jest.mock('../../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { getUsageDashboard } from '../../data-providers/usage-provider';

const tenantId = '123e4567-e89b-12d3-a456-426614174000';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getUsageDashboard', () => {
  it('returns the burn state from the client', async () => {
    mockGetBurnState.mockResolvedValueOnce({
      totalCreditsUsed: 1234,
      remainingCredits: 8766,
      creditsPerHour: 12.5,
    });

    const result = await getUsageDashboard(tenantId);

    expect(mockGetBurnState).toHaveBeenCalledWith(tenantId);
    expect(result).toEqual({
      totalCreditsUsed: 1234,
      remainingCredits: 8766,
      creditsPerHour: 12.5,
    });
  });

  it('passes through null when the client returns null', async () => {
    mockGetBurnState.mockResolvedValueOnce(null);
    const result = await getUsageDashboard(tenantId);
    expect(result).toBeNull();
  });

  it('returns null when the client throws (Tenant Runtime unreachable)', async () => {
    mockGetBurnState.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
    const result = await getUsageDashboard(tenantId);
    expect(result).toBeNull();
  });
});
