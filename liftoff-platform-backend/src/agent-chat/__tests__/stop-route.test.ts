// POST /api/agent-chat/:agentId/stop — unit tests.
// Covers: auth/membership enforcement, TR delivery of the abort signal,
// deliveredAs passthrough (abort vs noop), validation, TR-failure mapping.

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const mockGetByFirebaseUid = jest.fn();
const mockGetMembership = jest.fn();
const mockSignalStop = jest.fn();

jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: mockGetByFirebaseUid,
  })),
}));
jest.mock('../../tenant-members', () => ({
  tenantMembersService: { getMembership: mockGetMembership },
}));
jest.mock('../../connectors/tenant-runtime-client', () => ({
  TenantRuntimeClient: jest.fn().mockImplementation(() => ({
    signalStopChatTurn: mockSignalStop,
  })),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: jest.fn() })),
  withTenantScope: jest.fn(async (_t: string, fn: (c: { query: jest.Mock }) => Promise<unknown>) =>
    fn({ query: jest.fn() })),
}));

import { agentChatRouter } from '../router';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const THREAD_ID = '22222222-2222-2222-2222-222222222222';
const AGENT_ID = '33333333-3333-3333-3333-333333333333';

function makeApp(firebaseUid: string | null = 'uid-1'): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { ctx?: { userId?: string } }).ctx = firebaseUid ? { userId: firebaseUid } : {};
    next();
  });
  app.use('/api/agent-chat', agentChatRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetByFirebaseUid.mockResolvedValue({ id: 'acc-1', firstName: 'Ada', lastName: 'L' });
  mockGetMembership.mockResolvedValue({ role: 'member' });
  mockSignalStop.mockResolvedValue({ acknowledged: true, deliveredAs: 'abort' });
});

describe('POST /api/agent-chat/:agentId/stop', () => {
  it('delivers the stop to TR and passes deliveredAs through', async () => {
    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/stop`)
      .send({ tenantId: TENANT_ID, threadId: THREAD_ID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ acknowledged: true, deliveredAs: 'abort' });
    expect(mockSignalStop).toHaveBeenCalledWith(TENANT_ID, expect.objectContaining({
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      senderAccountId: 'acc-1',
      userDisplayName: 'Ada L',
    }));
  });

  it("passes 'noop' through when nothing was running", async () => {
    mockSignalStop.mockResolvedValue({ acknowledged: true, deliveredAs: 'noop' });
    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/stop`)
      .send({ tenantId: TENANT_ID, threadId: THREAD_ID });
    expect(res.status).toBe(200);
    expect(res.body.deliveredAs).toBe('noop');
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await request(makeApp(null))
      .post(`/api/agent-chat/${AGENT_ID}/stop`)
      .send({ tenantId: TENANT_ID, threadId: THREAD_ID });
    expect(res.status).toBe(401);
    expect(mockSignalStop).not.toHaveBeenCalled();
  });

  it('answers 404 for a non-member without confirming tenant existence', async () => {
    mockGetMembership.mockResolvedValue(null);
    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/stop`)
      .send({ tenantId: TENANT_ID, threadId: THREAD_ID });
    expect(res.status).toBe(404);
    expect(mockSignalStop).not.toHaveBeenCalled();
  });

  it('rejects an invalid body', async () => {
    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/stop`)
      .send({ tenantId: 'not-a-uuid', threadId: THREAD_ID });
    expect(res.status).toBe(400);
  });

  it('maps a TR failure to 502', async () => {
    mockSignalStop.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = await request(makeApp())
      .post(`/api/agent-chat/${AGENT_ID}/stop`)
      .send({ tenantId: TENANT_ID, threadId: THREAD_ID });
    expect(res.status).toBe(502);
  });
});
