// The expiry sweeper takes the oldest lapses first.
//
// It reads a capped batch every 30 minutes. Unordered, a backlog larger than
// one batch could hand back whichever rows Postgres happened to return and
// leave the oldest lapse waiting indefinitely — and a lapsed hitl-expiry row
// that is never swept never resumes the run it is holding.

import express from 'express';
import request from 'supertest';

const queryMock = jest.fn();

jest.mock('../../infrastructure/database', () => {
  const query = (...args: unknown[]) => queryMock(...args);
  return {
    pool: { query },
    // The router's import graph reaches modules that take their own pool at
    // module load, so every accessor has to answer with the same stub.
    getPoolForService: () => ({ query }),
    withTenantScope: jest.fn(async (_tenantId: string, fn: (c: unknown) => unknown) =>
      fn({ query })),
  };
});

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import internalCronRouter from '../internal-cron-handler';

function appWithRouter() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal', internalCronRouter);
  return app;
}

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('hybrid-loop sweep-stuck', () => {
  it('selects the oldest lapsed rows first', async () => {
    await request(appWithRouter()).post('/api/internal/hybrid-loop/sweep-stuck').send({});

    const selects = queryMock.mock.calls
      .map((call) => String(call[0]))
      .filter((sql) => sql.includes('FROM agent_scheduled_invocations') && sql.includes('SELECT'));

    expect(selects.length).toBeGreaterThan(0);
    expect(selects[0]).toContain('ORDER BY fires_at ASC');
    // The cap is what makes the ordering matter.
    expect(selects[0]).toContain('LIMIT 100');
  });
});
