// Phase 4 cross-service RPC integration test.
//
// Plan §4 verification requires: "agent-service can call tool-gateway-service
// with valid OIDC token; unauthorized calls return 401". We verify that end-
// to-end by standing up real Express servers for tool-gateway / coordinator /
// reflection on random localhost ports, pointing the HTTP clients at them,
// and exercising the auth middleware with both shared-secret and OIDC
// (stubbed) paths.
//
// Why integration-style rather than mocking fetch: ServiceClient wraps undici
// with a real request pipeline (HTTP/2 → HTTP/1.1 fallback, keep-alive,
// circuit breaker, header redaction). Mocking fetch would skip that whole
// layer. Mounting real Express servers on loopback runs the real wire
// format, the real auth middleware, and the real client serialiser.
//
// The filename ends in `.integration.test.ts` — Jest's default test config
// ignores this pattern (testPathIgnorePatterns = `\.integration\.test\.ts$`)
// so `npm test` doesn't pick it up. Run explicitly with:
//   npm test -- --testPathPattern=split-service-rpc.integration --testPathIgnorePatterns=
// This matches the existing integration test convention in the repo (every
// .integration.test.ts file is runnable only via explicit opt-in).

import express, { type Request, type Response } from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import {
  setOidcVerifierClientForTests,
  resetOidcVerifierClientForTests,
} from '../../security/oidc-verifier';
import { ToolGatewayHttpClient } from '../../tool-gateway/http-client';
import { CoordinatorHttpClient } from '../../coordinator/http-client';
import { ReflectionServiceClient } from '../../reflection-engine/http-client';
import { requireServiceAuth } from '../../security/service-auth';

const SHARED_SECRET = 'correct-horse-battery-staple-integration';
const ALLOWED_SA = 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com';

interface TestServer {
  app: express.Express;
  server: Server;
  url: string;
  close(): Promise<void>;
}

// Start a minimal Express app on a random localhost port. The auth middleware
// accepts BOTH the shared secret and (stubbed) Google OIDC so the same
// server can serve both test paths.
async function startTestServer(
  build: (app: express.Express, audienceUrl: string) => void,
): Promise<TestServer> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Bind first so we know the port — the OIDC audience must match the exact
  // URL the server is reachable on.
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  build(app, url);

  return {
    app,
    server,
    url,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// Wire a real requireServiceAuth middleware with OIDC + shared-secret both
// enabled. The OAuth2Client stub is set per-test.
function makeAuth(audience: string) {
  return requireServiceAuth({
    acceptOidc: true,
    oidcAudience: audience,
    allowedOidcEmails: [ALLOWED_SA],
  });
}

describe('Phase 4 cross-service RPC (integration)', () => {
  const originalToken = process.env.TENANT_RUNTIME_SERVICE_TOKEN;

  beforeAll(() => {
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = SHARED_SECRET;
  });

  afterAll(() => {
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = originalToken;
    resetOidcVerifierClientForTests();
  });

  beforeEach(() => {
    // Default OIDC stub: accepts every token, returns a payload that matches
    // ALLOWED_SA. Individual tests can override.
    setOidcVerifierClientForTests({
      verifyIdToken: async () => ({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          email: ALLOWED_SA,
          email_verified: true,
        }),
      }),
    } as unknown as Parameters<typeof setOidcVerifierClientForTests>[0]);
  });

  afterEach(() => {
    resetOidcVerifierClientForTests();
  });

  describe('tool-gateway-service', () => {
    it('ToolGatewayHttpClient.execute succeeds with shared-secret auth', async () => {
      const calls: unknown[] = [];
      const server = await startTestServer((app, url) => {
        const auth = makeAuth(url);
        app.post('/api/v1/tool-calls', auth, (req: Request, res: Response) => {
          calls.push(req.body);
          res.json({ success: true, data: { ok: 1 }, traceId: req.body.traceId });
        });
      });

      try {
        const client = new ToolGatewayHttpClient({ baseUrl: server.url });
        const result = await client.execute({
          tenantId: 't', agentId: 'a', instructionVersion: 1,
          traceId: 'trace-1', idempotencyKey: 'k1',
          connector: 'slack', entityType: 'message', actionType: 'create',
          payload: { hello: 'world' },
        });

        expect(result).toEqual({ success: true, data: { ok: 1 }, traceId: 'trace-1' });
        expect(calls).toHaveLength(1);
      } finally {
        await server.close();
      }
    });

    it('ToolGatewayHttpClient.executeBatch succeeds with shared-secret auth', async () => {
      const server = await startTestServer((app, url) => {
        const auth = makeAuth(url);
        app.post('/api/v1/tool-calls/batch', auth, (req: Request, res: Response) => {
          // REST convention: request body = { items: [...] }, response
          // body = { items: [...] }.
          const { items } = req.body as { items: { traceId: string }[] };
          res.status(201).json({
            items: items.map((i) => ({ success: true, data: { idx: i.traceId }, traceId: i.traceId })),
          });
        });
      });

      try {
        const client = new ToolGatewayHttpClient({ baseUrl: server.url });
        const results = await client.executeBatch([
          { tenantId: 't', agentId: 'a', instructionVersion: 1, traceId: 't1', idempotencyKey: 'k1', connector: 'x', entityType: 'y', actionType: 'z', payload: {} },
          { tenantId: 't', agentId: 'a', instructionVersion: 1, traceId: 't2', idempotencyKey: 'k2', connector: 'x', entityType: 'y', actionType: 'z', payload: {} },
        ]);
        expect(results).toHaveLength(2);
        expect(results[0].traceId).toBe('t1');
        expect(results[1].traceId).toBe('t2');
      } finally {
        await server.close();
      }
    });

    it('ToolGatewayHttpClient returns 401 when both auth paths fail', async () => {
      setOidcVerifierClientForTests({
        verifyIdToken: async () => { throw new Error('bad sig'); },
      } as unknown as Parameters<typeof setOidcVerifierClientForTests>[0]);

      const server = await startTestServer((app, url) => {
        const auth = makeAuth(url);
        app.post('/api/v1/tool-calls', auth, (_req, res) => {
          res.json({ success: true, data: null, traceId: 'n' });
        });
      });

      try {
        // Temporarily break the shared secret — client will send the wrong
        // bearer and the server's OIDC stub rejects everything.
        const original = process.env.TENANT_RUNTIME_SERVICE_TOKEN;
        process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'wrong-secret';
        try {
          const client = new ToolGatewayHttpClient({
            baseUrl: server.url,
            // Force the client to read a DIFFERENT env var that's unset so
            // no X-Service-Auth gets attached at all.
            serviceAuthEnvVar: 'TEST_DOES_NOT_EXIST',
          });
          await expect(
            client.execute({
              tenantId: 't', agentId: 'a', instructionVersion: 1,
              traceId: 'trace-1', idempotencyKey: 'k1',
              connector: 'slack', entityType: 'message', actionType: 'create',
              payload: {},
            }),
          ).rejects.toThrow(/HTTP 401/);
        } finally {
          process.env.TENANT_RUNTIME_SERVICE_TOKEN = original;
        }
      } finally {
        await server.close();
      }
    });

    it('ToolGatewayHttpClient.getConflictPolicy returns null on 404', async () => {
      const server = await startTestServer((app, url) => {
        const auth = makeAuth(url);
        app.get(
          '/api/v1/conflict-policies/:c/:e/:a',
          auth,
          (_req, res) => {
            res.status(404).json({ error: 'not found' });
          },
        );
      });

      try {
        const client = new ToolGatewayHttpClient({ baseUrl: server.url });
        const policy = await client.getConflictPolicy('slack', 'message', 'create');
        expect(policy).toBeNull();
      } finally {
        await server.close();
      }
    });
  });

  describe('coordinator-service', () => {
    it('CoordinatorHttpClient.commitTransition posts to /workflows/{id}/checkpoints', async () => {
      let receivedBody: Record<string, unknown> = {};
      const server = await startTestServer((app, url) => {
        const auth = makeAuth(url);
        // REST: POST /workflows/{id}/checkpoints. workflowId is in the URL;
        // the rest of the input travels in the body.
        app.post('/api/v1/workflows/:id/checkpoints', auth, (req, res) => {
          receivedBody = req.body;
          res.status(201).json({ id: 'cp-1', workflowId: req.params.id });
        });
      });

      try {
        const client = new CoordinatorHttpClient({ baseUrl: server.url });
        const cp = await client.commitTransition({
          workflowId: 'wf-1',
          taskId: 'task-1',
          idempotencyKey: 'idem-1',
          newState: { foo: 'bar' },
          pendingToolCalls: [],
        });
        expect(cp).toEqual({ id: 'cp-1', workflowId: 'wf-1' });
        // Body must NOT contain workflowId (it moved to the URL).
        expect(receivedBody).toEqual({
          taskId: 'task-1',
          idempotencyKey: 'idem-1',
          newState: { foo: 'bar' },
          pendingToolCalls: [],
        });
      } finally {
        await server.close();
      }
    });

    it('CoordinatorHttpClient.completeWorkflow posts to /workflows/{id}/completions', async () => {
      let receivedId = '';
      let receivedOutcome: unknown = null;
      const server = await startTestServer((app, url) => {
        const auth = makeAuth(url);
        app.post('/api/v1/workflows/:id/completions', auth, (req, res) => {
          receivedId = req.params.id;
          receivedOutcome = req.body.outcome;
          res.status(201).json({ id: receivedId, status: 'completed' });
        });
      });

      try {
        const client = new CoordinatorHttpClient({ baseUrl: server.url });
        const result = await client.completeWorkflow('wf-42', { ok: true });
        expect(receivedId).toBe('wf-42');
        expect(receivedOutcome).toEqual({ ok: true });
        expect(result).toEqual({ id: 'wf-42', status: 'completed' });
      } finally {
        await server.close();
      }
    });

    it('CoordinatorHttpClient.failWorkflow posts to /workflows/{id}/failures', async () => {
      let receivedError: string | undefined;
      const server = await startTestServer((app, url) => {
        const auth = makeAuth(url);
        app.post('/api/v1/workflows/:id/failures', auth, (req, res) => {
          receivedError = req.body.error;
          res.status(201).json({ id: req.params.id, status: 'failed' });
        });
      });

      try {
        const client = new CoordinatorHttpClient({ baseUrl: server.url });
        const result = await client.failWorkflow('wf-99', 'boom');
        expect(receivedError).toBe('boom');
        expect(result).toEqual({ id: 'wf-99', status: 'failed' });
      } finally {
        await server.close();
      }
    });

    it('CoordinatorHttpClient.getWorkflow returns null on 404', async () => {
      const server = await startTestServer((app, url) => {
        const auth = makeAuth(url);
        app.get('/api/v1/workflows/:id', auth, (_req, res) => {
          res.status(404).json({ error: 'not found' });
        });
      });

      try {
        const client = new CoordinatorHttpClient({ baseUrl: server.url });
        const wf = await client.getWorkflow('does-not-exist');
        expect(wf).toBeNull();
      } finally {
        await server.close();
      }
    });
  });

  describe('evaluations-service', () => {
    it('ReflectionServiceClient.trigger posts to /evaluations with agentId in the body', async () => {
      let receivedHeaders: Record<string, string> = {};
      let receivedBody: unknown = null;

      const server = await startTestServer((app, url) => {
        const auth = makeAuth(url);
        app.post('/api/v1/evaluations', auth, (req, res) => {
          receivedHeaders = req.headers as Record<string, string>;
          receivedBody = req.body;
          res.status(201).json({ ok: true });
        });
      });

      try {
        const client = new ReflectionServiceClient({ baseUrl: server.url });
        const result = await client.trigger('agent-99', {
          tenantId: 'tenant-123',
          triggerType: 'workflow_completed',
          metadata: { runs: 5 },
        });

        expect(receivedHeaders['x-tenant-id']).toBe('tenant-123');
        expect(receivedBody).toEqual({
          agentId: 'agent-99',
          tenantId: 'tenant-123',
          triggerType: 'workflow_completed',
          metadata: { runs: 5 },
        });
        expect(result).toEqual({ ok: true });
      } finally {
        await server.close();
      }
    });

    it('ReflectionServiceClient.shouldTrigger GETs /evaluations/eligibility with query string', async () => {
      let receivedQuery: Record<string, string> = {};
      const server = await startTestServer((app, url) => {
        const auth = makeAuth(url);
        app.get('/api/v1/evaluations/eligibility', auth, (req, res) => {
          receivedQuery = req.query as Record<string, string>;
          res.json({ shouldTrigger: true });
        });
      });

      try {
        const client = new ReflectionServiceClient({ baseUrl: server.url });
        const r = await client.shouldTrigger('agent-1', 'tenant-a', 'scheduled');
        expect(receivedQuery.agentId).toBe('agent-1');
        expect(receivedQuery.tenantId).toBe('tenant-a');
        expect(receivedQuery.triggerType).toBe('scheduled');
        expect(r).toEqual({ shouldTrigger: true });
      } finally {
        await server.close();
      }
    });

    it('ReflectionServiceClient.getQuotaStatus GETs /evaluations/quotas/{tenantId}', async () => {
      let receivedTenantId = '';
      const server = await startTestServer((app, url) => {
        const auth = makeAuth(url);
        app.get('/api/v1/evaluations/quotas/:tenantId', auth, (req, res) => {
          receivedTenantId = req.params.tenantId;
          res.json({ remaining: 7 });
        });
      });

      try {
        const client = new ReflectionServiceClient({ baseUrl: server.url });
        const r = await client.getQuotaStatus('tenant-a');
        expect(receivedTenantId).toBe('tenant-a');
        expect(r).toEqual({ remaining: 7 });
      } finally {
        await server.close();
      }
    });

    it('ReflectionServiceClient.getSuggestions GETs /evaluations/suggestions?agentId=', async () => {
      let receivedQuery: Record<string, string> = {};
      const server = await startTestServer((app, url) => {
        const auth = makeAuth(url);
        app.get('/api/v1/evaluations/suggestions', auth, (req, res) => {
          receivedQuery = req.query as Record<string, string>;
          res.json({ items: [{ id: 's1' }] });
        });
      });

      try {
        const client = new ReflectionServiceClient({ baseUrl: server.url });
        const r = await client.getSuggestions('agent-7');
        expect(receivedQuery.agentId).toBe('agent-7');
        expect(r).toEqual({ items: [{ id: 's1' }] });
      } finally {
        await server.close();
      }
    });
  });

  describe('auth interop', () => {
    it('tool-gateway accepts an OIDC bearer (stubbed) even when shared-secret is wrong', async () => {
      // Make the shared secret fail to authenticate (mismatched), but keep
      // OIDC stubbed to succeed — this proves the OIDC path works on its
      // own. This is the "intra-tenant OIDC-only" case from plan §4c.
      const server = await startTestServer((app, url) => {
        const auth = makeAuth(url);
        app.post('/api/v1/tool-calls', auth, (_req, res) => {
          res.json({ success: true, data: { via: 'oidc' }, traceId: 'x' });
        });
      });

      try {
        const original = process.env.TENANT_RUNTIME_SERVICE_TOKEN;
        process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'wrong-secret';
        try {
          // ServiceClient attaches OIDC + X-Service-Auth on every call. The
          // OIDC stub succeeds, so requireServiceAuth's first path accepts
          // and the request proceeds without consulting the shared secret.
          const client = new ToolGatewayHttpClient({ baseUrl: server.url });
          const result = await client.execute({
            tenantId: 't', agentId: 'a', instructionVersion: 1,
            traceId: 'x', idempotencyKey: 'k',
            connector: 'c', entityType: 'e', actionType: 'a', payload: {},
          });
          expect(result).toEqual({ success: true, data: { via: 'oidc' }, traceId: 'x' });
        } finally {
          process.env.TENANT_RUNTIME_SERVICE_TOKEN = original;
        }
      } finally {
        await server.close();
      }
    });

    it('tool-gateway rejects OIDC tokens whose email is not allow-listed', async () => {
      setOidcVerifierClientForTests({
        verifyIdToken: async () => ({
          getPayload: () => ({
            iss: 'https://accounts.google.com',
            email: 'other-sa@example-project.iam.gserviceaccount.com',
            email_verified: true,
          }),
        }),
      } as unknown as Parameters<typeof setOidcVerifierClientForTests>[0]);

      const server = await startTestServer((app, url) => {
        const auth = makeAuth(url);
        app.post('/api/v1/tool-calls', auth, (_req, res) => {
          res.json({ success: true, data: null, traceId: 'n' });
        });
      });

      try {
        // Make the shared-secret path also fail by pointing the client at an
        // unset env var → no X-Service-Auth header → fallback fails too →
        // 401.
        const client = new ToolGatewayHttpClient({
          baseUrl: server.url,
          serviceAuthEnvVar: 'TEST_DOES_NOT_EXIST',
        });
        await expect(
          client.execute({
            tenantId: 't', agentId: 'a', instructionVersion: 1,
            traceId: 'x', idempotencyKey: 'k',
            connector: 'c', entityType: 'e', actionType: 'a', payload: {},
          }),
        ).rejects.toThrow(/HTTP 401/);
      } finally {
        await server.close();
      }
    });
  });
});
