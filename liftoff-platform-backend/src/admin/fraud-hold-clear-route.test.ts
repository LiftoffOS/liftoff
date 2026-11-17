// Lifting a fraud hold.
//
// An early fraud warning stops a workspace, and nothing automatic starts it
// again — that is the point of the column. So this route is the only way back,
// and two properties matter. It must actually clear the hold, and it must tell
// the runtime, because the snapshot the runtime admits work from is computed
// on read and its cached copy would otherwise keep refusing for a minute after
// the operator acted.
//
// What it must NOT do is hand back anything else. A held workspace can also be
// out of credit or suspended; clearing the hold leaves those exactly as they
// were, and the shared predicate keeps refusing on their terms.

const mockPoolQuery = jest.fn();

jest.mock('../infrastructure/database', () => ({
  withAdminScope: jest.fn(),
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
}));

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
}));

jest.mock('../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn(async () => 'sk_test_dummy'),
}));

jest.mock('../billing/billing-admin-client', () => ({
  getBillingAdminClient: jest.fn(() => ({})),
}));

jest.mock('./service', () => ({
  AdminService: jest.fn().mockImplementation(() => ({})),
}));

const mockLogAdminAction = jest.fn().mockResolvedValue({ id: 'audit-1' });
jest.mock('./middleware', () => ({
  adminAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  logAdminAction: (...args: unknown[]) => mockLogAdminAction(...args),
}));

const mockPublishBillingSuspensionChange = jest.fn().mockResolvedValue(undefined);
jest.mock('../billing/billing-suspension-publisher', () => ({
  publishBillingSuspensionChange: (...args: unknown[]) => mockPublishBillingSuspensionChange(...args),
}));

import { adminRouter } from './router';
import type { Request, Response } from 'express';

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111';
const EFW_REF = 'issfr_1Test00000000';

interface RouteLayer {
  route?: {
    path: string;
    methods: { [method: string]: boolean };
    stack: Array<{ handle: (req: Request, res: Response, next: (err?: unknown) => void) => unknown }>;
  };
}

function getHandler(method: string, path: string) {
  const stack = (adminRouter as unknown as { stack: RouteLayer[] }).stack;
  for (const layer of stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      const handlers = layer.route.stack;
      return handlers[handlers.length - 1].handle as (
        req: Request, res: Response, next: (err?: unknown) => void,
      ) => Promise<unknown>;
    }
  }
  throw new Error(`route ${method} ${path} not found`);
}

function mockReqRes() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const req = {
    params: { accountId: ACCOUNT_ID },
    query: {},
    ctx: { requestId: 'test', operation: 'test' },
    adminAccount: { id: 'admin-1', email: 'ops@example.com' },
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
  return { req, res };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLogAdminAction.mockResolvedValue({ id: 'audit-1' });
  mockPublishBillingSuspensionChange.mockResolvedValue(undefined);
});

const clearHold = () => getHandler('post', '/accounts/:accountId/fraud-hold/clear');

it('clears the hold and republishes the snapshot the runtime reads', async () => {
  mockPoolQuery
    .mockResolvedValueOnce({ rows: [{ fraud_hold_ref: EFW_REF }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });

  const { req, res } = mockReqRes();
  await clearHold()(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(200);

  const update = String(mockPoolQuery.mock.calls[1][0]);
  expect(update).toMatch(/SET fraud_hold_at = NULL, fraud_hold_ref = NULL/);

  // Lifting the hold restores nothing else. A workspace that is also out of
  // credit stays refused on that, which the shared predicate decides.
  expect(update).not.toMatch(/reload_balance_usd|suspended|agent_execution_allowed/);

  expect(mockPublishBillingSuspensionChange).toHaveBeenCalledWith(
    ACCOUNT_ID, 'unsuspended', 'fraud_hold_cleared',
  );
});

it('names the warning it dismissed in the audit record', async () => {
  mockPoolQuery
    .mockResolvedValueOnce({ rows: [{ fraud_hold_ref: EFW_REF }], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });

  const { req, res } = mockReqRes();
  await clearHold()(req, res, jest.fn());

  // Read before the UPDATE, because RETURNING would see the NULL it just wrote.
  expect(mockLogAdminAction).toHaveBeenCalledWith(
    'admin-1', 'billing.fraud_hold.clear', 'account', ACCOUNT_ID,
    { ref: EFW_REF }, expect.anything(),
  );
});

it('404s an account that is not held, without writing or publishing', async () => {
  mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

  const { req, res } = mockReqRes();
  await clearHold()(req, res, jest.fn());

  expect(res.status).toHaveBeenCalledWith(404);
  expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  expect(mockPublishBillingSuspensionChange).not.toHaveBeenCalled();
});
