/**
 * Internal feature-flags router tests.
 *
 * Verifies service-auth gating + the upsert semantics on PUT /key/:key.
 * The FeatureFlagService is mocked; we're testing the router, not the
 * service's PubSub-publish path (already covered in feature-flags tests).
 */

const mockList = jest.fn();
const mockGetByKey = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();

jest.mock('../service', () => ({
  FeatureFlagService: jest.fn().mockImplementation(() => ({
    list: mockList,
    getByKey: mockGetByKey,
    create: mockCreate,
    update: mockUpdate,
    delete: mockDelete,
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { featureFlagsInternalRouter } from '../internal-router';

const TOKEN = 'shared-secret-for-tests';

let app: express.Express;
beforeAll(() => {
  process.env.PLATFORM_CALLBACK_TOKEN = TOKEN;
  app = express();
  app.use(express.json());
  app.use('/api/internal', featureFlagsInternalRouter);
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('service-auth gate', () => {
  it('rejects GET /feature-flags with no header', async () => {
    const res = await request(app).get('/api/internal/feature-flags');
    expect(res.status).toBe(401);
  });

  it('rejects POST /feature-flags with wrong header', async () => {
    const res = await request(app)
      .post('/api/internal/feature-flags')
      .set('x-service-auth', 'wrong')
      .send({ key: 'k', name: 'n', description: 'd', enabled: true });
    expect(res.status).toBe(401);
  });

  it('500s when PLATFORM_CALLBACK_TOKEN is unset', async () => {
    const original = process.env.PLATFORM_CALLBACK_TOKEN;
    delete process.env.PLATFORM_CALLBACK_TOKEN;
    const res = await request(app).get('/api/internal/feature-flags').set('x-service-auth', TOKEN);
    expect(res.status).toBe(500);
    process.env.PLATFORM_CALLBACK_TOKEN = original;
  });
});

describe('POST /feature-flags', () => {
  it('400s on missing required fields', async () => {
    const res = await request(app)
      .post('/api/internal/feature-flags')
      .set('x-service-auth', TOKEN)
      .send({ key: 'k' });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('calls service.create and returns 201 with the new flag', async () => {
    const created = { id: 'f1', key: 'web_fetch_vendor_webclaw', name: 'n', description: 'd', enabled: false };
    mockCreate.mockResolvedValueOnce(created);
    const res = await request(app)
      .post('/api/internal/feature-flags')
      .set('x-service-auth', TOKEN)
      .send({ key: 'web_fetch_vendor_webclaw', name: 'n', description: 'd', enabled: false });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    expect(mockCreate).toHaveBeenCalledWith({
      key: 'web_fetch_vendor_webclaw', name: 'n', description: 'd', enabled: false,
    });
  });

  it('accepts value_num and passes it to service.create as valueNum', async () => {
    const created = { id: 'f3', key: 'web_fetch_anchor_max_concurrent_global', name: 'n', description: 'd', enabled: true, valueNum: 30 };
    mockCreate.mockResolvedValueOnce(created);
    const res = await request(app)
      .post('/api/internal/feature-flags')
      .set('x-service-auth', TOKEN)
      .send({ key: 'web_fetch_anchor_max_concurrent_global', name: 'n', description: 'd', enabled: true, value_num: 30 });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith({
      key: 'web_fetch_anchor_max_concurrent_global', name: 'n', description: 'd', enabled: true, valueNum: 30,
    });
  });

  it('400s when value_num is provided but not a finite number', async () => {
    const res = await request(app)
      .post('/api/internal/feature-flags')
      .set('x-service-auth', TOKEN)
      .send({ key: 'k', name: 'n', description: 'd', enabled: true, value_num: 'oops' });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('defaults enabled=true for numeric-only tunables (ADR-018 UX fix)', async () => {
    const created = { id: 'f5', key: 'web_fetch_anchor_max_concurrent_global', name: 'n', description: 'd', enabled: true, valueNum: 40 };
    mockCreate.mockResolvedValueOnce(created);
    const res = await request(app)
      .post('/api/internal/feature-flags')
      .set('x-service-auth', TOKEN)
      // Note: no `enabled` field at all — just key/name/description/value_num
      .send({ key: 'web_fetch_anchor_max_concurrent_global', name: 'n', description: 'd', value_num: 40 });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith({
      key: 'web_fetch_anchor_max_concurrent_global', name: 'n', description: 'd', enabled: true, valueNum: 40,
    });
  });

  it('still 400s on missing enabled when value_num is also missing (pure-boolean flags still require it)', async () => {
    const res = await request(app)
      .post('/api/internal/feature-flags')
      .set('x-service-auth', TOKEN)
      .send({ key: 'k', name: 'n', description: 'd' });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('PUT /feature-flags/key/:key upsert', () => {
  it('updates when the flag exists', async () => {
    const existing = { id: 'f1', key: 'web_fetch_vendor_webclaw', name: 'n', description: 'd', enabled: true };
    const updated = { ...existing, enabled: false };
    mockGetByKey.mockResolvedValueOnce(existing);
    mockUpdate.mockResolvedValueOnce(updated);
    const res = await request(app)
      .put('/api/internal/feature-flags/key/web_fetch_vendor_webclaw')
      .set('x-service-auth', TOKEN)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(updated);
    expect(mockUpdate).toHaveBeenCalledWith('f1', { enabled: false });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates when the flag does not exist (with name+description)', async () => {
    const created = { id: 'f2', key: 'k', name: 'n', description: 'd', enabled: false };
    mockGetByKey.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce(created);
    const res = await request(app)
      .put('/api/internal/feature-flags/key/k')
      .set('x-service-auth', TOKEN)
      .send({ name: 'n', description: 'd', enabled: false });
    expect(res.status).toBe(201);
    expect(res.body).toEqual(created);
    expect(mockCreate).toHaveBeenCalledWith({ key: 'k', name: 'n', description: 'd', enabled: false });
  });

  it('400s when the flag does not exist and name/description are missing', async () => {
    mockGetByKey.mockResolvedValueOnce(null);
    const res = await request(app)
      .put('/api/internal/feature-flags/key/k')
      .set('x-service-auth', TOKEN)
      .send({ enabled: false });
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('400s on missing enabled boolean (no value_num present either)', async () => {
    const res = await request(app)
      .put('/api/internal/feature-flags/key/k')
      .set('x-service-auth', TOKEN)
      .send({});
    expect(res.status).toBe(400);
  });

  it('defaults enabled=true when only value_num is supplied on existing-row update (ADR-018)', async () => {
    const existing = { id: 'f6', key: 'web_fetch_anchor_max_concurrent_global', name: 'n', description: 'd', enabled: true, valueNum: 25 };
    const updated = { ...existing, valueNum: 40 };
    mockGetByKey.mockResolvedValueOnce(existing);
    mockUpdate.mockResolvedValueOnce(updated);
    const res = await request(app)
      .put('/api/internal/feature-flags/key/web_fetch_anchor_max_concurrent_global')
      .set('x-service-auth', TOKEN)
      .send({ value_num: 40 });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith('f6', { enabled: true, valueNum: 40 });
  });

  it('defaults enabled=true when only value_num is supplied on create-via-PUT (ADR-018)', async () => {
    const created = { id: 'f7', key: 'web_fetch_webclaw_rate_per_hour_web_fetch_advanced', name: 'n', description: 'd', enabled: true, valueNum: 500 };
    mockGetByKey.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce(created);
    const res = await request(app)
      .put('/api/internal/feature-flags/key/web_fetch_webclaw_rate_per_hour_web_fetch_advanced')
      .set('x-service-auth', TOKEN)
      .send({ name: 'n', description: 'd', value_num: 500 });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith({
      key: 'web_fetch_webclaw_rate_per_hour_web_fetch_advanced',
      name: 'n', description: 'd', enabled: true, valueNum: 500,
    });
  });

  it('passes value_num through to service.update as valueNum on existing', async () => {
    const existing = { id: 'f1', key: 'k', name: 'n', description: 'd', enabled: true, valueNum: null };
    const updated = { ...existing, enabled: true, valueNum: 30 };
    mockGetByKey.mockResolvedValueOnce(existing);
    mockUpdate.mockResolvedValueOnce(updated);
    const res = await request(app)
      .put('/api/internal/feature-flags/key/k')
      .set('x-service-auth', TOKEN)
      .send({ enabled: true, value_num: 30 });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith('f1', { enabled: true, valueNum: 30 });
  });

  it('passes value_num through to service.create as valueNum on create-via-PUT', async () => {
    const created = { id: 'f4', key: 'k', name: 'n', description: 'd', enabled: true, valueNum: 30 };
    mockGetByKey.mockResolvedValueOnce(null);
    mockCreate.mockResolvedValueOnce(created);
    const res = await request(app)
      .put('/api/internal/feature-flags/key/k')
      .set('x-service-auth', TOKEN)
      .send({ name: 'n', description: 'd', enabled: true, value_num: 30 });
    expect(res.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith({ key: 'k', name: 'n', description: 'd', enabled: true, valueNum: 30 });
  });

  it('400s when value_num is non-numeric on PUT', async () => {
    const res = await request(app)
      .put('/api/internal/feature-flags/key/k')
      .set('x-service-auth', TOKEN)
      .send({ enabled: true, value_num: 'bad' });
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('GET endpoints', () => {
  it('list returns service.list result', async () => {
    mockList.mockResolvedValueOnce([{ id: 'f1', key: 'k', name: 'n', description: 'd', enabled: true }]);
    const res = await request(app).get('/api/internal/feature-flags').set('x-service-auth', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('getByKey 404s when missing', async () => {
    mockGetByKey.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/internal/feature-flags/key/missing').set('x-service-auth', TOKEN);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /feature-flags/key/:key', () => {
  it('404s when the flag does not exist', async () => {
    mockGetByKey.mockResolvedValueOnce(null);
    const res = await request(app).delete('/api/internal/feature-flags/key/missing').set('x-service-auth', TOKEN);
    expect(res.status).toBe(404);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('deletes and returns 204 when the flag exists', async () => {
    mockGetByKey.mockResolvedValueOnce({ id: 'f1', key: 'k', name: 'n', description: 'd', enabled: true });
    mockDelete.mockResolvedValueOnce(undefined);
    const res = await request(app).delete('/api/internal/feature-flags/key/k').set('x-service-auth', TOKEN);
    expect(res.status).toBe(204);
    expect(mockDelete).toHaveBeenCalledWith('f1');
  });
});
