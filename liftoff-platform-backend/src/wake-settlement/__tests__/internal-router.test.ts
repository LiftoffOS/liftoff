/**
 * Wake-settlement internal router — service-auth gate.
 *
 * Regression lock for the live-caught 401: TR reaches this router through its platform-callback
 * client, which sends X-Service-Auth: PLATFORM_CALLBACK_TOKEN. The route must validate that token
 * (like every other TR-callback route), NOT the verifyServiceAuth() default TENANT_RUNTIME_SERVICE_TOKEN.
 * When it validated the wrong env var, every settlement delivery 401'd and looped in settlement_pending.
 *
 * Auth runs before the zod body parse, so we assert the gate without a live DB: the correct token
 * reaches validation (400 on an empty body); wrong/absent/other-token requests stop at 401.
 */

jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import { wakeSettlementInternalRouter } from '../internal-router';

const CALLBACK_TOKEN = 'platform-callback-secret';
const RUNTIME_TOKEN = 'tenant-runtime-service-secret';

let app: express.Express;
beforeAll(() => {
  process.env.PLATFORM_CALLBACK_TOKEN = CALLBACK_TOKEN;
  process.env.TENANT_RUNTIME_SERVICE_TOKEN = RUNTIME_TOKEN;
  app = express();
  app.use(express.json());
  app.use('/api/internal/wake-settlement', wakeSettlementInternalRouter);
});

describe('POST / service-auth gate', () => {
  it('401s with no x-service-auth header', async () => {
    const res = await request(app).post('/api/internal/wake-settlement').send({});
    expect(res.status).toBe(401);
  });

  it('401s with a wrong token', async () => {
    const res = await request(app)
      .post('/api/internal/wake-settlement')
      .set('x-service-auth', 'nope')
      .send({});
    expect(res.status).toBe(401);
  });

  it('401s with TENANT_RUNTIME_SERVICE_TOKEN (must reject the old default env var)', async () => {
    const res = await request(app)
      .post('/api/internal/wake-settlement')
      .set('x-service-auth', RUNTIME_TOKEN)
      .send({});
    expect(res.status).toBe(401);
  });

  it('accepts PLATFORM_CALLBACK_TOKEN — passes auth, then 400s on the empty body', async () => {
    const res = await request(app)
      .post('/api/internal/wake-settlement')
      .set('x-service-auth', CALLBACK_TOKEN)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /thread-revision service-auth gate', () => {
  it('401s with no header', async () => {
    const res = await request(app).get('/api/internal/wake-settlement/thread-revision');
    expect(res.status).toBe(401);
  });

  it('accepts PLATFORM_CALLBACK_TOKEN — passes auth, then 400s on missing query params', async () => {
    const res = await request(app)
      .get('/api/internal/wake-settlement/thread-revision')
      .set('x-service-auth', CALLBACK_TOKEN);
    expect(res.status).toBe(400);
  });
});

describe('whose agent id ends up on the delivered row', () => {
  // The runtime addresses agents in its OWN id space (ADR-039); this column is
  // an FK into internal_agents. Trusting the caller's hint made the INSERT
  // violate the constraint, the settlement 500, and a continuation's answer
  // vanish while the thread kept its "still working" notice.
  //
  // The failure looks like:
  //   agent_chat_messages_agent_id_fkey violated, wake settlement failed, 500.
  const router = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'internal-router.ts'), 'utf8',
  ) as string;

  it('takes the agent from the thread, like the channel beside it', () => {
    expect(router).toContain('const agentId = thread.agent_id ?? null;');
  });

  it('does not fall back to the caller anywhere it writes or posts', () => {
    // Including the Slack push, which had the same fallback.
    expect(router).not.toContain('parsed.data.agentId ??');
  });

  it('says on the schema that the field is not trusted', () => {
    const field = router.slice(router.indexOf('agentId: z.string()') - 400, router.indexOf('agentId: z.string()'));
    expect(field).toMatch(/NOT trusted|not trusted/);
  });
});
