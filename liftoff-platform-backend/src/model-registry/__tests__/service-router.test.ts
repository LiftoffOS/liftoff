// Test for the model-registry service router (GET /tenant/:id/configs
// behind verifyServiceAuth). Mirrors the entitlements service router
// pattern so tenant-runtime's cached_model_configs refresh path
// (model-config-resync endpoint + periodic reconciler) can hit PB
// without a Firebase token.

import { jest } from '@jest/globals';

const mockGetConfigsForTenant = jest.fn();

jest.mock('../service', () => ({
  ModelRegistryService: jest.fn().mockImplementation(() => ({
    getConfigsForTenant: (...args: unknown[]) => mockGetConfigsForTenant(...args),
  })),
}));

// Stub the service-client guard so the route runs without a real token.
jest.mock('@liftoffos/service-client', () => ({
  verifyServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Logging pulls in OpenTelemetry which doesn't initialize cleanly in jest.
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { modelRegistryServiceRouter } from '../router';

const app = express();
app.use(express.json());
app.use('/api/model-registry', modelRegistryServiceRouter);

beforeEach(() => mockGetConfigsForTenant.mockReset());

describe('modelRegistryServiceRouter', () => {
  it('GET /tenant/:tenantId/configs returns the configs from the service', async () => {
    const tenantId = '11111111-1111-1111-1111-111111111111';
    const configs = [{
      id: 'cfg-1',
      tenantId,
      modelId: 'model-uuid-1',
      routingPolicy: {
        defaultProvider: 'anthropic',
        defaultModel: 'claude-sonnet-4-6',
        providerOverrides: { embedding: 'google' },
        taskOverrides: { embedding: 'text-embedding-004' },
      },
      version: 1,
      entityVersion: 2,
    }];
    mockGetConfigsForTenant.mockResolvedValueOnce(configs);

    const res = await request(app).get(`/api/model-registry/tenant/${tenantId}/configs`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(configs);
    expect(mockGetConfigsForTenant).toHaveBeenCalledWith(tenantId);
  });

  it('propagates 500 when the service throws', async () => {
    mockGetConfigsForTenant.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app).get('/api/model-registry/tenant/00000000-0000-0000-0000-000000000001/configs');
    expect(res.status).toBe(500);
  });
});
