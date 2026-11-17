/**
 * The service-auth surface the tenant runtime calls, and the query behind it.
 *
 * `/tenant/:tenantId/approved` is new: the runtime has always called it and
 * always got a 404, because no such route existed. Its client reads 404 as
 * "this tenant has no approved deployment", so a missing endpoint was
 * indistinguishable from a legitimate empty answer.
 */
const findLatestApprovedMock = jest.fn();
const findByIdMock = jest.fn();

jest.mock('../repository', () => ({
  DeploymentRepository: jest.fn().mockImplementation(() => ({
    findLatestApproved: (...a: unknown[]) => findLatestApprovedMock(...a),
    findById: (...a: unknown[]) => findByIdMock(...a),
  })),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../events/outbox', () => ({ publishEvent: jest.fn() }), { virtual: true });

import express from 'express';
import request from 'supertest';
import { deploymentsServiceRouter } from '../router';

const TOKEN = 'runtime-token';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/deployments', deploymentsServiceRouter);
  return a;
}

const DEPLOYMENT = {
  id: 'dep-1', tenantId: 't1', artifactRef: 'gs://bundle/v3',
  version: 3, status: 'approved', approvedAt: '2026-08-01T00:00:00.000Z',
};

beforeEach(() => {
  process.env.TENANT_RUNTIME_SERVICE_TOKEN = TOKEN;
  findLatestApprovedMock.mockReset().mockResolvedValue(DEPLOYMENT);
  findByIdMock.mockReset().mockResolvedValue(DEPLOYMENT);
});

describe('deployments service surface', () => {
  it('refuses a caller with no service token', async () => {
    const res = await request(app()).get('/api/deployments/tenant/t1/approved');

    expect(res.status).toBe(401);
    expect(findLatestApprovedMock).not.toHaveBeenCalled();
  });

  it('refuses a wrong service token', async () => {
    const res = await request(app())
      .get('/api/deployments/tenant/t1/approved')
      .set('X-Service-Auth', 'not-the-token');

    expect(res.status).toBe(401);
  });

  it('serves the approved deployment to the runtime', async () => {
    const res = await request(app())
      .get('/api/deployments/tenant/t1/approved')
      .set('X-Service-Auth', TOKEN);

    expect(res.status).toBe(200);
    // The shape the runtime maps into ApprovedDeployment.
    expect(res.body).toMatchObject({
      artifactRef: 'gs://bundle/v3', version: 3, status: 'approved',
    });
    expect(findLatestApprovedMock).toHaveBeenCalledWith('t1');
  });

  it('404s when the tenant has nothing approved, which the client reads as null', async () => {
    findLatestApprovedMock.mockResolvedValue(null);

    const res = await request(app())
      .get('/api/deployments/tenant/t1/approved')
      .set('X-Service-Auth', TOKEN);

    expect(res.status).toBe(404);
  });

  it('serves a single deployment by id, for the approved event', async () => {
    const res = await request(app())
      .get('/api/deployments/dep-1')
      .set('X-Service-Auth', TOKEN);

    expect(res.status).toBe(200);
    expect(res.body.artifactRef).toBe('gs://bundle/v3');
  });

  it('does not let the tenant route be swallowed by /:id', async () => {
    // '/tenant/t1/approved' must reach its own handler, not '/:id' with
    // id='tenant'. Getting this wrong would return the wrong row rather than
    // fail, which is the sort of thing that hides.
    await request(app())
      .get('/api/deployments/tenant/t1/approved')
      .set('X-Service-Auth', TOKEN);

    expect(findLatestApprovedMock).toHaveBeenCalledWith('t1');
    expect(findByIdMock).not.toHaveBeenCalled();
  });
});
