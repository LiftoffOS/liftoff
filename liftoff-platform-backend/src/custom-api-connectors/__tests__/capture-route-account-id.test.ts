/**
 * The account id these routes hand downstream is an `accounts.id`, not the
 * caller's Firebase uid.
 *
 * They are two different id spaces and one of them is not a uuid. Every column
 * the id reaches is `uuid` — `claimed_by_account_id` on the capture token, the
 * audit row's actor — so passing the uid through does not quietly mismatch a
 * row: Postgres raises 22P02 from `string_to_uuid` and the request 500s with
 * `capture_submit_failed`. That breaks every submit, for every provider:
 * nobody can finish connecting an API at all.
 *
 * The module's other tests call the service directly, which is exactly why
 * this is invisible to them — `ctx.userId` is read in the ROUTER. These cases
 * go through the route.
 */
import express from 'express';
import request from 'supertest';

const FIREBASE_UID = 'GDzq3Kx9PLc0aBcDeFgHiJkLmNo2';
const ACCOUNT_ID = 'b9594e6f-3855-4d12-8b49-d5004ee4a0f6';
const TENANT_ID = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';

const submitCaptureMock = jest.fn();
const getByFirebaseUidMock = jest.fn();
const getCallerRoleMock = jest.fn();

// The route's own guard is exercised by that middleware's tests. Standing it
// in here sets the tenant the way the real one does, and leaves these cases
// about which id the handler resolves.
jest.mock('../../infrastructure/middleware', () => ({
  tenantAuthMiddleware: () => (req: { ctx: Record<string, unknown> }, _res: unknown, next: () => void) => {
    req.ctx = { ...req.ctx, tenantId: TENANT_ID, userId: FIREBASE_UID };
    next();
  },
}));
jest.mock('../../accounts/service', () => ({
  AccountService: class {
    getByFirebaseUid(uid: string) { return getByFirebaseUidMock(uid); }
  },
}));
jest.mock('../../insights/chat-repository', () => ({
  getCallerRole: (...a: unknown[]) => getCallerRoleMock(...a),
}));
jest.mock('../service', () => ({
  readCapture: jest.fn(),
  submitCapture: (...a: unknown[]) => submitCaptureMock(...a),
  getCustomApiConnection: jest.fn(),
  updateCustomApiConnection: jest.fn(),
  reverifyCustomApiConnection: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { customApiConnectorsRouter } from '../router';

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { (req as unknown as { ctx: object }).ctx = {}; next(); });
  a.use('/api/custom-api-connectors', customApiConnectorsRouter);
  return a;
}

beforeEach(() => {
  jest.clearAllMocks();
  getByFirebaseUidMock.mockResolvedValue({ id: ACCOUNT_ID });
  getCallerRoleMock.mockResolvedValue('owner');
  submitCaptureMock.mockResolvedValue({
    kind: 'connected', connectorId: 'conn-1', status: 'active', operationCount: 1,
  });
});

describe('the capture route resolves the caller to an account id', () => {
  it('hands the service the account uuid, never the Firebase uid it was called with', async () => {
    const res = await request(app())
      .post('/api/custom-api-connectors/capture/liftoff_cap_abc')
      .send({ tenantId: TENANT_ID, credential: 'a-key' });

    expect(res.status).toBe(200);
    expect(getByFirebaseUidMock).toHaveBeenCalledWith(FIREBASE_UID);

    const [args] = submitCaptureMock.mock.calls[0] as [{ accountId: string }];
    expect(args.accountId).toBe(ACCOUNT_ID);
    // The assertion that fails when the uid is passed straight through: the
    // column it lands in is a uuid, and this one is not.
    expect(args.accountId).not.toBe(FIREBASE_UID);
    expect(args.accountId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('refuses with 401 when the caller has no account, rather than reaching the service', async () => {
    getByFirebaseUidMock.mockResolvedValue(null);

    const res = await request(app())
      .post('/api/custom-api-connectors/capture/liftoff_cap_abc')
      .send({ tenantId: TENANT_ID, credential: 'a-key' });

    expect(res.status).toBe(401);
    expect(submitCaptureMock).not.toHaveBeenCalled();
  });
});
