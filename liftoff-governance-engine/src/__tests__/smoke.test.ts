// Smoke test — proves Jest + ts-jest wiring is alive and that the Express
// app builds without throwing at import time. Real handler coverage lives
// under src/rpc/__tests__ once handlers are implemented.

import request from 'supertest';
import type { Logger } from '@liftoffos/telemetry';
import { buildApp } from '../server.js';

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
} as unknown as Logger;

describe('GovernanceEngine HTTP skeleton', () => {
  const ORIG_TOKEN = process.env.GOVERNANCE_SERVICE_TOKEN;

  beforeAll(() => {
    process.env.GOVERNANCE_SERVICE_TOKEN = 'test-token';
  });
  afterAll(() => {
    if (ORIG_TOKEN === undefined) delete process.env.GOVERNANCE_SERVICE_TOKEN;
    else process.env.GOVERNANCE_SERVICE_TOKEN = ORIG_TOKEN;
  });

  it('GET /health returns 200 without auth', async () => {
    const app = buildApp({ port: 0, log: silentLog });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('governance-engine');
  });

  it('protected Connect-RPC routes require X-Service-Auth', async () => {
    const app = buildApp({ port: 0, log: silentLog });
    const res = await request(app).post('/liftoff.governance.v1.GovernanceService/Authorize');
    expect(res.status).toBe(401);
  });

  it('rejects wrong X-Service-Auth token', async () => {
    const app = buildApp({ port: 0, log: silentLog });
    const res = await request(app)
      .post('/liftoff.governance.v1.GovernanceService/Authorize')
      .set('X-Service-Auth', 'wrong-token');
    expect(res.status).toBe(401);
  });
});
