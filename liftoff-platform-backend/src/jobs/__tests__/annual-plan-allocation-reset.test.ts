// The monthly allowance reset for annual subscribers.
//
// Annual subscribers invoice once a year, so the invoice-driven period reset
// never fires for them and this job is the only thing that grants their second
// month onwards. Two properties are worth holding: the shared X-Service-Auth
// token is the only gate in front of a cross-tenant UPDATE, and a run that
// cannot do the work must say so — a 200 on the disabled path leaves Cloud
// Scheduler green while every annual subscriber goes without an allowance.

import express from 'express';
import request from 'supertest';
import { annualPlanAllocationResetRouter } from '../annual-plan-allocation-reset';

const query = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...args: unknown[]) => query(...args) }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const TOKEN = 'test-platform-callback-token-32ch';
const PATH = '/api/internal/annual-plan-allocation-reset';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', annualPlanAllocationResetRouter);
  return app;
}

// Keyed on the statement rather than on call order: the handler's query count is
// an implementation detail, and an ordered mock turns adding one into a failure
// somewhere unrelated.
function respondBySql(subscribers: Array<{ account_id: string }>) {
  query.mockImplementation((sql: string) =>
    /FROM billing_controls/i.test(sql)
      ? Promise.resolve({ rows: subscribers })
      : Promise.resolve({ rows: [], rowCount: 1 }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLATFORM_CALLBACK_TOKEN = TOKEN;
  process.env.ANNUAL_ALLOCATION_RESET_ENABLED = 'true';
  respondBySql([]);
});

afterEach(() => {
  delete process.env.ANNUAL_ALLOCATION_RESET_ENABLED;
});

describe(`POST ${PATH}`, () => {
  it('resets every annual subscriber it finds and reports the counts', async () => {
    respondBySql([{ account_id: 'acct-1' }, { account_id: 'acct-2' }]);

    const res = await request(buildApp()).post(PATH).set('X-Service-Auth', TOKEN).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, processed: 2, succeeded: 2, failed: 0 });
  });

  it('carries on past one failing account and counts it', async () => {
    query.mockImplementation((sql: string, params?: unknown[]) => {
      if (/FROM billing_controls/i.test(sql)) {
        return Promise.resolve({ rows: [{ account_id: 'acct-1' }, { account_id: 'acct-2' }] });
      }
      return (params as string[])?.[0] === 'acct-1'
        ? Promise.reject(new Error('deadlock detected'))
        : Promise.resolve({ rows: [], rowCount: 1 });
    });

    const res = await request(buildApp()).post(PATH).set('X-Service-Auth', TOKEN).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, processed: 2, succeeded: 1, failed: 1 });
  });

  // The defect this endpoint sat in for its whole life: it answered 200 with
  // skipped:true, so a scheduler pointed at it reported success forever.
  it('refuses with 503 when the flag is not set, rather than reporting a clean run', async () => {
    delete process.env.ANNUAL_ALLOCATION_RESET_ENABLED;

    const res = await request(buildApp()).post(PATH).set('X-Service-Auth', TOKEN).send({});

    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(buildApp()).post(PATH).send({});

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a wrong token', async () => {
    const res = await request(buildApp())
      .post(PATH)
      .set('X-Service-Auth', 'not-the-token-but-same-lengthhh')
      .send({});

    expect(res.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('answers 500 so the scheduler retries rather than reporting a clean run', async () => {
    query.mockRejectedValue(new Error('database down'));

    const res = await request(buildApp()).post(PATH).set('X-Service-Auth', TOKEN).send({});

    expect(res.status).toBe(500);
  });
});
