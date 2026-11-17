// Concurrency tests for POST /api/admin/tenants/:id/upgrade-to-dedicated
//
// Verifies the fix for H4: the FOR UPDATE row lock is held across the GCP
// provisioning call so a second concurrent caller blocks, then short-circuits
// with 409 idempotent.

const mockProvisionTenantInfrastructure = jest.fn();
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockLogAudit = jest.fn();

// withAdminScope tracks invocations and serialises overlapping callbacks
// (one in flight at a time) so we can simulate a real FOR UPDATE row lock
// without spinning up Postgres.
let inFlight: Promise<unknown> = Promise.resolve();
const mockAdminQueries: Array<unknown[]> = [];

jest.mock('../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => unknown) => {
    // Serialise concurrent withAdminScope calls — emulating row-level lock
    // held by FOR UPDATE for the duration of the callback. This is the
    // critical bit the test asserts: the second caller MUST observe the
    // first caller's UPDATE before re-reading the row.
    const release = inFlight;
    let resolveNext: () => void = () => undefined;
    inFlight = new Promise<void>((r) => { resolveNext = r; });
    try {
      await release;
      const client = {
        query: jest.fn(async (...args: unknown[]) => {
          mockAdminQueries.push(args);
          return rowState.next(args);
        }),
      };
      return await fn(client as never);
    } finally {
      resolveNext();
    }
  }),
  // getPool() is used by logAdminAction for the admin_action_audit INSERT.
  // Returns RETURNING id + created_at so the helper can populate the audit
  // record in the response envelope.
  getPool: jest.fn(() => ({
    query: jest.fn().mockResolvedValue({
      rows: [{ id: 'audit_test', created_at: new Date('2026-05-17T00:00:00Z') }],
    }),
  })),
}));

jest.mock('../infrastructure/logging', () => ({
  log: mockLog,
  logAudit: mockLogAudit,
  createLogger: jest.fn(() => mockLog),
}));

jest.mock('../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn(async () => 'sk_test_dummy'),
}));

jest.mock('../billing/billing-admin-client', () => ({
  getBillingAdminClient: jest.fn(() => ({})),
}));

jest.mock('../accounts/service', () => ({
  AccountService: jest.fn(),
  AccountNotFoundError: class {},
}));

jest.mock('../infrastructure/provisioning', () => ({
  infrastructureProvisioningService: {
    provisionTenantInfrastructure: mockProvisionTenantInfrastructure,
  },
}));

jest.mock('./service', () => ({
  AdminService: jest.fn().mockImplementation(() => ({})),
}));

// In-test state machine that emulates the tenants row. The FOR UPDATE SELECT
// returns the current value of hosting_mode; UPDATE flips it to 'dedicated'.
const rowState = {
  hostingMode: 'shared' as 'shared' | 'dedicated',
  gcpProjectId: null as string | null,
  allowlisted: true,
  next(args: unknown[]): { rows: unknown[]; rowCount: number } {
    const sql = String(args[0]);
    if (sql.includes('FOR UPDATE')) {
      return {
        rows: [
          {
            id: 'tenant-1',
            account_id: 'acct-1',
            name: 'Tenant One',
            hosting_mode: this.hostingMode,
            gcp_project_id: this.gcpProjectId,
          },
        ],
        rowCount: 1,
      };
    }
    // The allowlist gate: dedicated hosting provisions billable infrastructure,
    // so the commercial decision is recorded before the route acts. These cases
    // are about the row LOCK, so the tenant is approved and the gate passes;
    // the refusal path has its own case below.
    if (sql.includes('dedicated_hosting_allowlist')) {
      return { rows: this.allowlisted ? [{ approved_by: 'admin@example.com' }] : [], rowCount: this.allowlisted ? 1 : 0 };
    }
    if (sql.includes('UPDATE tenants') && sql.includes("hosting_mode = 'dedicated'")) {
      this.hostingMode = 'dedicated';
      this.gcpProjectId = 'gcp-project-xyz';
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
  reset(): void {
    this.hostingMode = 'shared';
    this.gcpProjectId = null;
    this.allowlisted = true;
  },
};

import { adminRouter } from './router';
import type { Request, Response } from 'express';

interface RouteLayer {
  route?: {
    path: string;
    methods: { [method: string]: boolean };
    stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>;
  };
}

function getHandler(method: string, path: string): (req: Request, res: Response, next: (err?: unknown) => void) => Promise<unknown> {
  const stack = (adminRouter as unknown as { stack: RouteLayer[] }).stack;
  for (const layer of stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      const handlers = layer.route.stack;
      // The last function in the route's stack is the actual handler
      return handlers[handlers.length - 1].handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<unknown>;
    }
  }
  throw new Error(`route ${method} ${path} not found`);
}

function mockReqRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return { res } as { res: { status: jest.Mock; json: jest.Mock } };
}

describe('POST /api/admin/tenants/:id/upgrade-to-dedicated — concurrency', () => {
  const tenantId = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    inFlight = Promise.resolve();
    mockAdminQueries.length = 0;
    rowState.reset();
    jest.clearAllMocks();
  });

  it('two concurrent callers: first succeeds, second short-circuits with 409 (idempotent)', async () => {
    // First caller's GCP provisioning takes time. While it's awaiting, the
    // second caller invokes upgrade. Thanks to the serialised withAdminScope
    // mock (emulating FOR UPDATE), the second caller blocks until the first
    // has UPDATEd hosting_mode='dedicated' and committed.
    let resolveFirstGcp: () => void = () => undefined;
    const firstGcpStarted = new Promise<void>((r) => { resolveFirstGcp = r; });
    mockProvisionTenantInfrastructure
      .mockImplementationOnce(async () => {
        const p = new Promise<void>((resolve) => {
          // signal that we've reached the GCP call, then wait
          setImmediate(() => {
            resolveFirstGcp();
            // hold until released
            setTimeout(resolve, 10);
          });
        });
        await p;
        return { success: true, buildId: 'build-1', gcpProjectId: 'gcp-project-xyz' };
      })
      // Second caller should never reach provisionTenantInfrastructure because
      // it short-circuits on hosting_mode='dedicated'.
      .mockImplementationOnce(async () => {
        throw new Error('second caller should not reach GCP provisioning');
      });

    const handler = getHandler('post', '/tenants/:id/upgrade-to-dedicated');

    const first = mockReqRes();
    const second = mockReqRes();
    const req1 = {
      params: { id: tenantId },
      ctx: { adminId: 'admin-1' },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const req2 = {
      params: { id: tenantId },
      ctx: { adminId: 'admin-2' },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;

    const p1 = handler(req1, first.res as unknown as Response, () => undefined);
    // Wait for the first to enter the GCP call before kicking off the second.
    await firstGcpStarted;
    const p2 = handler(req2, second.res as unknown as Response, () => undefined);

    await Promise.all([p1, p2]);

    // First call succeeded (200), wrapped in PR-0 admin envelope.
    expect(first.res.status).toHaveBeenCalledWith(200);
    expect(first.res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tenantId, gcpProjectId: 'gcp-project-xyz' }),
        audit: expect.objectContaining({ action: 'tenant.upgrade_to_dedicated' }),
      }),
    );

    // Second call short-circuited with 409 idempotent (new error envelope).
    expect(second.res.status).toHaveBeenCalledWith(409);
    expect(second.res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'tenant_already_dedicated',
      }),
    );

    // GCP provisioning was invoked exactly once (the second caller bailed).
    expect(mockProvisionTenantInfrastructure).toHaveBeenCalledTimes(1);
  });

  it('refuses a tenant that is not on the dedicated-hosting allowlist, without provisioning', async () => {
    // Admin auth says the CALLER may run admin routes. It does not say this
    // customer was sold a dedicated project. Dedicated provisioning creates
    // real billable infrastructure that is awkward to unwind, so the commercial
    // decision is recorded separately and read inside the same row lock.
    rowState.reset();
    rowState.allowlisted = false;

    const handler = getHandler('post', '/tenants/:id/upgrade-to-dedicated');
    const { res } = mockReqRes();
    const req = {
      params: { id: tenantId },
      ctx: { adminId: 'admin-1' },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    await handler(req, res as unknown as Response, () => undefined);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'tenant_not_allowlisted_for_dedicated' }),
    );
    // The point of the gate: nothing was built.
    expect(mockProvisionTenantInfrastructure).not.toHaveBeenCalled();
    expect(rowState.hostingMode).toBe('shared');
  });

  it('returns 404 when tenant not found', async () => {
    rowState.reset();
    const handler = getHandler('post', '/tenants/:id/upgrade-to-dedicated');

    // Override the rowState SELECT to return no rows.
    const origNext = rowState.next.bind(rowState);
    rowState.next = (args: unknown[]) => {
      const sql = String(args[0]);
      if (sql.includes('FOR UPDATE')) {
        return { rows: [], rowCount: 0 };
      }
      return origNext(args);
    };

    const { res } = mockReqRes();
    const req = {
      params: { id: tenantId },
      ctx: { adminId: 'admin-1' },
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    await handler(req, res as unknown as Response, () => undefined);
    expect(res.status).toHaveBeenCalledWith(404);

    rowState.next = origNext;
  });
});
