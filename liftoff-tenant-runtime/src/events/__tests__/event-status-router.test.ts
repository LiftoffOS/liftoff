// Tests for event-status-router. Uses supertest + a mocked subscriberPool
// so we exercise the routing/response shape contract without requiring a DB.

import express from 'express';
import request from 'supertest';

const queryMock = jest.fn();

jest.mock('../subscriber', () => ({
  subscriberPool: { query: queryMock },
}));

// The router moved off the package's verifyServiceAuth, which resolves the
// expected token from process.env and 500s when it is absent. This repo's
// requireServiceAuth reads the secret store instead; same shared-bearer-only
// default, so the stub is the same shape in a different place.
jest.mock('../../security/service-auth', () => ({
  requireServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

// Import AFTER mocks land so the router picks up the mocked subscriberPool.
import { eventStatusRouter } from '../event-status-router';

const app = express();
app.use(express.json());
app.use('/api/internal', eventStatusRouter);

const EVENT_ID = '97ad66e5-2287-4fad-b200-22b7d343746f';
const TENANT_ID = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';

beforeEach(() => {
  queryMock.mockReset();
});

it('returns 400 on malformed event_id', async () => {
  const r = await request(app).get(`/api/internal/event-status/not-a-uuid?tenant_id=${TENANT_ID}`);
  expect(r.status).toBe(400);
  expect(r.body).toEqual({ error: 'invalid_event_id' });
});

it('returns 400 when tenant_id is missing', async () => {
  const r = await request(app).get(`/api/internal/event-status/${EVENT_ID}`);
  expect(r.status).toBe(400);
  expect(r.body).toEqual({ error: 'invalid_or_missing_tenant_id' });
});

it('returns 400 when tenant_id is not a UUID', async () => {
  const r = await request(app).get(`/api/internal/event-status/${EVENT_ID}?tenant_id=not-a-uuid`);
  expect(r.status).toBe(400);
  expect(r.body).toEqual({ error: 'invalid_or_missing_tenant_id' });
});

it('returns status=unknown for missing event', async () => {
  queryMock.mockResolvedValue({ rows: [] });
  const r = await request(app).get(`/api/internal/event-status/${EVENT_ID}?tenant_id=${TENANT_ID}`);
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ status: 'unknown' });
  expect(queryMock).toHaveBeenCalledWith(expect.any(String), [TENANT_ID, EVENT_ID]);
});

it('returns status=processed for completed event', async () => {
  queryMock.mockResolvedValue({
    rows: [{
      status: 'completed',
      error: null,
      attempt_count: 1,
      first_seen_at: new Date('2026-05-28T03:39:25Z'),
      completed_at: new Date('2026-05-28T03:39:26Z'),
      steps_completed: ['step_a', 'step_b'],
    }],
  });
  const r = await request(app).get(`/api/internal/event-status/${EVENT_ID}?tenant_id=${TENANT_ID}`);
  expect(r.status).toBe(200);
  expect(r.body.status).toBe('processed');
  expect(r.body.steps_completed).toEqual(['step_a', 'step_b']);
  expect(r.body.completed_at).toBe('2026-05-28T03:39:26.000Z');
});

it('returns status=failed for failed event', async () => {
  queryMock.mockResolvedValue({
    rows: [{
      status: 'failed',
      error: 'FK violation',
      attempt_count: 3,
      first_seen_at: new Date('2026-05-28T03:39:25Z'),
      completed_at: null,
      steps_completed: null,
    }],
  });
  const r = await request(app).get(`/api/internal/event-status/${EVENT_ID}?tenant_id=${TENANT_ID}`);
  expect(r.body).toEqual({ status: 'failed', error: 'FK violation', attempt_count: 3 });
});

it('returns status=processing for in-flight event', async () => {
  queryMock.mockResolvedValue({
    rows: [{
      status: 'processing',
      error: null,
      attempt_count: 2,
      first_seen_at: new Date('2026-05-28T03:39:25Z'),
      completed_at: null,
      steps_completed: null,
    }],
  });
  const r = await request(app).get(`/api/internal/event-status/${EVENT_ID}?tenant_id=${TENANT_ID}`);
  expect(r.body.status).toBe('processing');
  expect(r.body.attempt_count).toBe(2);
  expect(r.body.first_seen_at).toBe('2026-05-28T03:39:25.000Z');
});

it('returns 500 when the DB query throws', async () => {
  queryMock.mockRejectedValue(new Error('boom'));
  const r = await request(app).get(`/api/internal/event-status/${EVENT_ID}?tenant_id=${TENANT_ID}`);
  expect(r.status).toBe(500);
  expect(r.body).toEqual({ error: 'internal_error' });
});
