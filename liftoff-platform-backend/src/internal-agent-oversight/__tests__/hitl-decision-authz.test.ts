// Authorization on the two HITL decision routes (approve / reject).
//
// The check used to live inside `if (approvalToCheck)`. `getApproval` returns
// null both for a genuine 404 and as the circuit breaker's fallback when the
// tenant runtime is unreachable, so a degraded runtime skipped the membership
// AND level checks entirely and forwarded the decision with decidedByRole
// defaulted to 'user'. `tenantId` is a query parameter, so that window also
// admitted a caller deciding approvals in a tenant they do not belong to.
//
// These tests pin the fail-CLOSED behaviour: no readable approval means
// authorize against level 1, and a non-member is refused whether or not the
// approval could be read.

import type { Request, Response } from 'express';

jest.mock('../../infrastructure/database');
jest.mock('../../infrastructure/logging', () => ({
  logAudit: jest.fn(),
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockGetApproval = jest.fn();
const mockApproveRequest = jest.fn();
const mockRejectRequest = jest.fn();

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    getApproval: (...args: unknown[]) => mockGetApproval(...args),
    approveRequest: (...args: unknown[]) => mockApproveRequest(...args),
    rejectRequest: (...args: unknown[]) => mockRejectRequest(...args),
  },
  HitlError: class HitlError extends Error {
    constructor(
      message: string,
      public readonly status: number,
      public readonly errorCode: string,
    ) {
      super(message);
      this.name = 'HitlError';
    }
  },
}));

const mockGetByFirebaseUid = jest.fn();
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: (...args: unknown[]) => mockGetByFirebaseUid(...args),
  })),
}));

const mockGetMembership = jest.fn();
jest.mock('../../tenant-members/service', () => ({
  tenantMembersService: {
    getMembership: (...args: unknown[]) => mockGetMembership(...args),
  },
}));

import { oversightRouter } from '../router';

function mockReq(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    params: { approvalId: 'rev_1' },
    query: { tenantId: 'ten_1' },
    body: {},
    ctx: { userId: 'firebase_uid' },
    ...overrides,
  };
}

function mockRes(): Partial<Response> & { json: jest.Mock; status: jest.Mock } {
  const r: Partial<Response> & { json: jest.Mock; status: jest.Mock } = {
    json: jest.fn(),
    status: jest.fn(),
  };
  r.status.mockReturnValue(r);
  r.json.mockReturnValue(r);
  return r;
}

type Layer = { route?: { path?: string; methods?: Record<string, boolean> }; handle: (...a: unknown[]) => unknown };

function findRoute(path: string) {
  const stack = (oversightRouter as any).stack as Layer[];
  const found = stack.find((l) => l.route?.path === path && (l.route?.methods ?? {}).post);
  if (!found || !found.route) throw new Error(`route post ${path} not found`);
  return (found.route as any).stack as Array<{ handle: Layer['handle'] }>;
}

/** The terminal handler — what the existing suites drive directly. */
function findHandler(path: string) {
  const s = findRoute(path);
  return s[s.length - 1].handle;
}

const APPROVE = '/hitl-approvals/:approvalId/approve';
const REJECT = '/hitl-approvals/:approvalId/reject';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetByFirebaseUid.mockResolvedValue({ id: 'user_123' });
  mockGetMembership.mockResolvedValue({ role: 'admin' });
  mockApproveRequest.mockResolvedValue({ id: 'rev_1', status: 'approved' });
  mockRejectRequest.mockResolvedValue({ id: 'rev_1', status: 'rejected' });
  mockGetApproval.mockResolvedValue({ id: 'rev_1', hitlLevel: 2, status: 'pending' });
});

describe.each([
  ['approve', APPROVE, () => mockApproveRequest],
  ['reject', REJECT, () => mockRejectRequest],
])('HITL %s decision — authorization', (_name, path, forwarded) => {
  it('carries the route-level tenant membership guard', () => {
    // Two entries before the terminal handler would mean something else was
    // added; one is verifyHitlTenantMembership. The read routes have had it
    // since SE-007 and these writes did not.
    expect(findRoute(path).length).toBeGreaterThan(1);
  });

  it('refuses a caller who is not a member of the named tenant', async () => {
    mockGetMembership.mockResolvedValue(null);
    const res = mockRes();
    await findHandler(path)(mockReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(forwarded()).not.toHaveBeenCalled();
  });

  it('when the approval cannot be read, authorizes against level 1 and refuses a member', async () => {
    // The breaker fallback shape: null, indistinguishable from a 404.
    mockGetApproval.mockResolvedValue(null);
    mockGetMembership.mockResolvedValue({ role: 'member' });
    const res = mockRes();
    await findHandler(path)(mockReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Level 1') }),
    );
    expect(forwarded()).not.toHaveBeenCalled();
  });

  it('when the approval cannot be read, still allows an admin', async () => {
    mockGetApproval.mockResolvedValue(null);
    mockGetMembership.mockResolvedValue({ role: 'admin' });
    const res = mockRes();
    await findHandler(path)(mockReq(), res, jest.fn());

    expect(forwarded()).toHaveBeenCalled();
  });

  it('never records the decider as the literal "user"', async () => {
    mockGetApproval.mockResolvedValue(null);
    mockGetMembership.mockResolvedValue({ role: 'owner' });
    const res = mockRes();
    await findHandler(path)(mockReq(), res, jest.fn());

    const args = forwarded().mock.calls[0];
    expect(args[2]).toBe('user_123'); // decidedBy = account id, not 'unknown'
    expect(args[3]).toBe('owner');    // decidedByRole = real role, not 'user'
  });

  it('refuses when the account cannot be resolved', async () => {
    mockGetByFirebaseUid.mockResolvedValue(null);
    const res = mockRes();
    await findHandler(path)(mockReq(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(401);
    expect(forwarded()).not.toHaveBeenCalled();
  });

  it('a level-2 approval still admits a member', async () => {
    mockGetApproval.mockResolvedValue({ id: 'rev_1', hitlLevel: 2, status: 'pending' });
    mockGetMembership.mockResolvedValue({ role: 'member' });
    const res = mockRes();
    await findHandler(path)(mockReq(), res, jest.fn());

    expect(forwarded()).toHaveBeenCalled();
  });
});
