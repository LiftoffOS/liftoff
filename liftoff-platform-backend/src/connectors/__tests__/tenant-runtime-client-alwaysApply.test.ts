// Verifies that approveRequest/rejectRequest forward `alwaysApply` to
// the Connect-RPC resolveApproval call.

const resolveApprovalMock = jest.fn();

jest.mock('../tenant-runtime-service-client', () => ({
  getTenantRuntimeServiceClient: jest.fn().mockResolvedValue({
    resolveApproval: (...args: unknown[]) => resolveApprovalMock(...args),
  }),
}));

// getApproval is called after resolveApproval; mock the breaker to fast-fall
// back so we don't need real HTTP.
jest.mock('../tenant-runtime-circuit-breaker', () => ({
  tenantRuntimeBreaker: {
    executeOrFallback: jest.fn(async (_ctx: unknown, _fn: unknown, fallback: unknown) => fallback),
  },
}));

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getIdTokenClient: jest.fn().mockRejectedValue(new Error('no metadata server')),
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { tenantRuntimeClient } from '../tenant-runtime-client';

const TENANT = '11111111-1111-1111-1111-111111111111';
const APPROVAL = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  jest.clearAllMocks();
  resolveApprovalMock.mockResolvedValue({});
});

describe('approveRequest forwards alwaysApply', () => {
  it('passes alwaysApply: true through to resolveApproval', async () => {
    await tenantRuntimeClient.approveRequest(TENANT, APPROVAL, 'u1', 'admin', true);
    expect(resolveApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({ alwaysApply: true }),
    );
  });

  it('defaults to alwaysApply: false when omitted', async () => {
    await tenantRuntimeClient.approveRequest(TENANT, APPROVAL, 'u1', 'admin');
    expect(resolveApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({ alwaysApply: false }),
    );
  });
});

describe('rejectRequest forwards alwaysApply', () => {
  it('passes alwaysApply: true through to resolveApproval', async () => {
    await tenantRuntimeClient.rejectRequest(TENANT, APPROVAL, 'u1', 'admin', 'because', true);
    expect(resolveApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        alwaysApply: true,
        rejectionReason: 'because',
      }),
    );
  });

  it('defaults to alwaysApply: false when omitted', async () => {
    await tenantRuntimeClient.rejectRequest(TENANT, APPROVAL, 'u1', 'admin', 'r');
    expect(resolveApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({ alwaysApply: false }),
    );
  });
});
