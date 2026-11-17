// Verifies that ConnectError-shaped errors from client.resolveApproval are
// mapped to HitlError with the correct errorCode + status. Each of the four
// known server-side error message shapes maps to one of:
//   NOT_FOUND        → 404
//   TAMPER_DETECTED  → 409
//   EXPIRED          → 410
//   ALREADY_DECIDED  → 409
// Unrelated errors (network, etc) re-throw unchanged.

const resolveApprovalMock = jest.fn();

jest.mock('../tenant-runtime-service-client', () => ({
  getTenantRuntimeServiceClient: jest.fn().mockResolvedValue({
    resolveApproval: (...args: unknown[]) => resolveApprovalMock(...args),
  }),
}));

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

import { tenantRuntimeClient, HitlError } from '../tenant-runtime-client';

const TENANT = '11111111-1111-1111-1111-111111111111';
const APPROVAL = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('mapResolveApprovalError (via approveRequest)', () => {
  it('maps "Approval request not found" → HitlError NOT_FOUND 404', async () => {
    resolveApprovalMock.mockRejectedValueOnce(new Error('Approval request not found: foo'));
    await expect(
      tenantRuntimeClient.approveRequest(TENANT, APPROVAL, 'u', 'admin'),
    ).rejects.toMatchObject({
      name: 'HitlError',
      errorCode: 'NOT_FOUND',
      status: 404,
    });
  });

  it('maps "TAMPER_DETECTED:" → HitlError TAMPER_DETECTED 409', async () => {
    resolveApprovalMock.mockRejectedValueOnce(new Error('TAMPER_DETECTED: hash mismatch'));
    await expect(
      tenantRuntimeClient.approveRequest(TENANT, APPROVAL, 'u', 'admin'),
    ).rejects.toMatchObject({
      errorCode: 'TAMPER_DETECTED',
      status: 409,
    });
  });

  it('maps "has expired" → HitlError EXPIRED 410', async () => {
    resolveApprovalMock.mockRejectedValueOnce(new Error('Cannot approve: request has expired'));
    await expect(
      tenantRuntimeClient.approveRequest(TENANT, APPROVAL, 'u', 'admin'),
    ).rejects.toMatchObject({
      errorCode: 'EXPIRED',
      status: 410,
    });
  });

  it('maps "request status is" → HitlError ALREADY_DECIDED 409', async () => {
    resolveApprovalMock.mockRejectedValueOnce(new Error('Cannot approve: request status is rejected'));
    await expect(
      tenantRuntimeClient.approveRequest(TENANT, APPROVAL, 'u', 'admin'),
    ).rejects.toMatchObject({
      errorCode: 'ALREADY_DECIDED',
      status: 409,
    });
  });

  it('rethrows unrelated errors unchanged', async () => {
    const orig = new Error('network failure ENETUNREACH');
    resolveApprovalMock.mockRejectedValueOnce(orig);
    await expect(
      tenantRuntimeClient.approveRequest(TENANT, APPROVAL, 'u', 'admin'),
    ).rejects.toBe(orig);
  });
});

describe('mapResolveApprovalError (via rejectRequest)', () => {
  it('maps "Approval request not found" → HitlError NOT_FOUND 404', async () => {
    resolveApprovalMock.mockRejectedValueOnce(new Error('Approval request not found'));
    await expect(
      tenantRuntimeClient.rejectRequest(TENANT, APPROVAL, 'u', 'admin', 'r'),
    ).rejects.toBeInstanceOf(HitlError);
  });

  it('rethrows unrelated errors unchanged', async () => {
    const orig = new Error('connection reset');
    resolveApprovalMock.mockRejectedValueOnce(orig);
    await expect(
      tenantRuntimeClient.rejectRequest(TENANT, APPROVAL, 'u', 'admin', 'r'),
    ).rejects.toBe(orig);
  });
});
