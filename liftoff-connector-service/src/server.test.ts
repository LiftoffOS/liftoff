import request from 'supertest';
import type { Logger } from '@liftoffos/telemetry';
import { buildApp } from './server.js';

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLog,
} as unknown as Logger;

describe('ConnectorService HTTP skeleton', () => {
  const ORIG_TOKEN = process.env.CONNECTOR_SERVICE_TOKEN;

  beforeAll(() => {
    process.env.CONNECTOR_SERVICE_TOKEN = 'test-token';
  });
  afterAll(() => {
    if (ORIG_TOKEN === undefined) delete process.env.CONNECTOR_SERVICE_TOKEN;
    else process.env.CONNECTOR_SERVICE_TOKEN = ORIG_TOKEN;
  });

  it('GET /health returns 200 without auth', async () => {
    const app = buildApp({ port: 0, log: silentLog });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('connector-service');
  });

  it('protected routes require X-Service-Auth', async () => {
    const app = buildApp({ port: 0, log: silentLog });
    const res = await request(app).post('/liftoff.connector.v1.ConnectorService/Execute');
    expect(res.status).toBe(401);
  });

  it('rejects wrong X-Service-Auth token', async () => {
    const app = buildApp({ port: 0, log: silentLog });
    const res = await request(app)
      .post('/liftoff.connector.v1.ConnectorService/Execute')
      .set('X-Service-Auth', 'wrong-token');
    expect(res.status).toBe(401);
  });
});
