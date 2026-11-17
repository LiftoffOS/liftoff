// Hourly re-fire of failed OU meter events from ou_meter_event_retries.
//
// Behavior verified:
//   - Success → re-fire with the ORIGINAL identifier, then DELETE the row.
//   - Failure → attempts incremented, row retained (never dropped).
//   - Rows at/over the attempt ceiling log ou_meter_retry_exhausted at ERROR.
//   - Rejects without the service token.

import express from 'express';
import request from 'supertest';

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../infrastructure/logging', () => ({ log: mockLog }));

const poolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => poolQuery(...a) }),
}));

const mockFire = jest.fn();
jest.mock('../../billing/ou-meter-event', () => ({
  fireOuMeterEvent: (...a: unknown[]) => mockFire(...a),
}));

import { ouMeterRetryDrainRouter } from '../ou-meter-retry-drain';

const TOKEN = 'test-platform-callback-token';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', ouMeterRetryDrainRouter);
  return app;
}

function retryRow(identifier: string, attempts = 1) {
  return {
    identifier,
    stripe_customer_id: 'cus_retry_test',
    cost_usd: '0.163819',
    occurred_at: new Date('2026-08-06T05:00:00Z'),
    attempts,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLATFORM_CALLBACK_TOKEN = TOKEN;
  poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('POST /api/internal/ou-meter-retry-drain', () => {
  it('rejects without the service token', async () => {
    const res = await request(buildApp()).post('/api/internal/ou-meter-retry-drain').send({});
    expect(res.status).toBe(401);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('re-fires with the original identifier and deletes the row on success', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [retryRow('src_pending')], rowCount: 1 });
    mockFire.mockResolvedValue(true);

    const res = await request(buildApp())
      .post('/api/internal/ou-meter-retry-drain')
      .set('X-Service-Auth', TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ batch: 1, drained: 1, stillFailing: 0, exhausted: 0 });
    expect(mockFire).toHaveBeenCalledWith({
      stripeCustomerId: 'cus_retry_test',
      costUsd: 0.163819,
      identifier: 'src_pending',
      occurredAt: new Date('2026-08-06T05:00:00Z'),
    });
    const deleteCall = poolQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('DELETE FROM ou_meter_event_retries'),
    );
    expect(deleteCall?.[1]).toEqual(['src_pending']);
  });

  it('increments attempts and retains the row on failure — never drops it', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [retryRow('src_still_bad')], rowCount: 1 });
    mockFire.mockResolvedValue(false);

    const res = await request(buildApp())
      .post('/api/internal/ou-meter-retry-drain')
      .set('X-Service-Auth', TOKEN)
      .send({});

    expect(res.body).toEqual({ batch: 1, drained: 0, stillFailing: 1, exhausted: 0 });
    const deleteCall = poolQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('DELETE'),
    );
    expect(deleteCall).toBeUndefined();
    const updateCall = poolQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('SET attempts = attempts + 1'),
    );
    expect(updateCall?.[1]).toEqual(['src_still_bad']);
  });

  it('logs ou_meter_retry_exhausted at ERROR when a row reaches the attempt ceiling', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [retryRow('src_exhausted', 19)], rowCount: 1 });
    mockFire.mockResolvedValue(false);

    const res = await request(buildApp())
      .post('/api/internal/ou-meter-retry-drain')
      .set('X-Service-Auth', TOKEN)
      .send({});

    expect(res.body).toEqual({ batch: 1, drained: 0, stillFailing: 1, exhausted: 1 });
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: 'src_exhausted', attempts: 20 }),
      'ou_meter_retry_exhausted',
    );
  });
});
