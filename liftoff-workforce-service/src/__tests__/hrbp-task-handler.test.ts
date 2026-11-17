// HRBP task handler OIDC + execution contract (PR 0.2):
//   - rejects requests without an Authorization: Bearer header (401)
//   - rejects requests whose OIDC token belongs to a different SA (403)
//   - rejects payloads missing required fields (400)
//   - on a valid request, invokes runPlatformAgent with HRBP_TOOLS and
//     returns 200 + terminator from the summary event

import Fastify, { type FastifyInstance } from 'fastify';
import { resetConfigForTests } from '../infrastructure/config.js';

const verifyIdToken = jest.fn();

// The handler itself only needs OAuth2Client, for verifying the Cloud Tasks
// OIDC token. GoogleAuth is here because the module graph reaches
// infrastructure/service-auth, which constructs one at import time: the handler
// now posts a provisioning notice, and mirroring that notice to Liftoff is an
// outbound service-to-service call. A partial mock of this library fails the
// whole suite at load rather than at an assertion, which is why it is spelled
// out.
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({ verifyIdToken })),
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getIdTokenClient: jest.fn().mockResolvedValue({
      getRequestHeaders: jest.fn().mockResolvedValue({ Authorization: 'Bearer test-token' }),
    }),
  })),
}));

jest.mock('../platform-agent/execution.js', () => {
  const runPlatformAgent = jest.fn();
  return { runPlatformAgent };
});

jest.mock('../platform-agent/hrbp/index.js', () => ({
  HRBP_TOOLS: [],
  dispatchHrbpToolCall: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { runPlatformAgent } = require('../platform-agent/execution.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { registerHrbpTaskRoutes } = require('../workforce-plans/hrbp-task-handler.js');

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerHrbpTaskRoutes(app);
  await app.ready();
  return app;
}

const validPayload = {
  tenantId: 'tenant-1',
  planId: 'plan-1',
  runId: 'run-1',
  spec: { specId: 'spec-1', name: 'X', agentType: 'agent', roleSummary: 'r' },
  approverAccountId: 'acct-1',
};

beforeEach(() => {
  resetConfigForTests();
  process.env['PLATFORM_BACKEND_URL'] = 'http://pb.local';
  process.env['GCP_PROJECT_ID'] = 'test-project';
  process.env['DB_INSTANCE_CONNECTION_NAME'] = 'test:region:instance';
  process.env['WORKFORCE_SERVICE_URL'] = 'https://workforce.example';
  process.env['WORKFORCE_SERVICE_ACCOUNT_EMAIL'] = 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com';
  verifyIdToken.mockReset();
  (runPlatformAgent as jest.Mock).mockReset();
});

describe('POST /api/tasks/hrbp-provision-spec', () => {
  it('returns 401 when the Authorization header is missing', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/hrbp-provision-spec',
      payload: validPayload,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 403 when the OIDC token email does not match WORKFORCE_SERVICE_ACCOUNT_EMAIL', async () => {
    verifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ email: 'other-service@example-project.iam.gserviceaccount.com' }),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/hrbp-provision-spec',
      payload: validPayload,
      headers: { authorization: 'Bearer fake-oidc' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns 400 when the payload is missing required fields', async () => {
    verifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ email: 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com' }),
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/hrbp-provision-spec',
      payload: { tenantId: 'tenant-1' },
      headers: { authorization: 'Bearer fake-oidc' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 200 and dispatches to runPlatformAgent on a valid OIDC + payload', async () => {
    verifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ email: 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com' }),
    });
    (runPlatformAgent as jest.Mock).mockReturnValue((async function* () {
      yield { type: 'complete', summary: { terminator: 'normal', ok: true, text: '', toolCalls: [], inputTokens: 0, outputTokens: 0 } };
    })());
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks/hrbp-provision-spec',
      payload: validPayload,
      headers: { authorization: 'Bearer fake-oidc' },
    });
    expect(res.statusCode).toBe(200);
    expect(runPlatformAgent).toHaveBeenCalledTimes(1);
    const invoked = (runPlatformAgent as jest.Mock).mock.calls[0][0];
    expect(invoked.agentId).toBe('00000000-0000-0000-0000-000000000002');
    expect(invoked.tenantId).toBe('tenant-1');
    expect(invoked.toolContext.runId).toBe('run-1');
    expect(invoked.toolContext.specId).toBe('spec-1');
    expect(invoked.usagePurpose).toBe('hrbp_provision_spec');
    await app.close();
  });
});
