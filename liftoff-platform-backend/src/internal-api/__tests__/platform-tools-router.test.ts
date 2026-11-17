// Platform Tools Router — unit tests
//
// Tests the /find-teammates callback endpoint for service auth,
// input validation, LIKE escaping, and response shape.

 

// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

import crypto from 'crypto';
import express from 'express';

// ── Mocks ──────────────────���─────────────────────────────────────────

const mockPoolQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  // The router runs every DB call under withTenantScope. Tests use
  // mockPoolQuery.mockResolvedValueOnce chains; expose the same mock
  // through the scoped client so those expectations stay intact.
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: { query: typeof mockPoolQuery }) => unknown) => {
    return fn({ query: mockPoolQuery });
  }),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
  GoogleAuth: jest.fn(),
}));

jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'https://api-test.example.com',
}));

jest.mock('@google-cloud/pubsub', () => ({
  PubSub: jest.fn(() => ({
    topic: jest.fn(() => ({ publishMessage: jest.fn().mockResolvedValue('msg-id') })),
  })),
}));

jest.mock('../../internal-agent-oversight/service', () => ({
  oversightService: {
    getOrCreateOversightSettings: jest.fn().mockResolvedValue({
      tenantId: '11111111-1111-1111-1111-111111111111',
      currentVersion: 1,
      autonomy: 'balanced',
      escalation: 'important',
      sensitiveWork: {},
      communication: 'review',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  },
}));

// send-agent-message normalises both agent ids from the runtime's id space to
// internal_agents.id before any check reads them (INV-TR-010: the spaces are
// disjoint). Mocked to an EMPTY map so these tests keep passing internal ids
// straight through — `toInternalAgentId` returns null on a miss and the handler
// falls back to the original, which is the control-plane caller's path.
jest.mock('../../internal-agents/runtime-agent-id-map', () => ({
  getRuntimeToInternalMap: jest.fn(async () => new Map<string, string>()),
  toInternalAgentId: (map: Map<string, string>, id: string) => map.get(id) ?? null,
}));

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    enqueueAgentTask: jest.fn().mockResolvedValue(undefined),
  },
}));

const mockResolveAccountIdForTenant = jest.fn();
const mockIngestEventWithBuckets = jest.fn();
jest.mock('../../cost-attribution/repository', () => ({
  resolveAccountIdForTenant: (...args: unknown[]) => mockResolveAccountIdForTenant(...args),
  ingestEventWithBuckets: (...args: unknown[]) => mockIngestEventWithBuckets(...args),
}));

import { platformToolsRouter } from '../platform-tools-router';

// ── Test app ────────────���────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/platform-tools', platformToolsRouter);
  return app;
}

// ── Helpers ────────���─────────────────────────────────���───────────────

const VALID_TOKEN = 'test-platform-callback-token-1234';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';

/** Make an HTTP request against the test app */
function makeRequest(
  app: express.Express,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}${path}`;

      fetch(url, { headers })
        .then(async (res) => {
          const body = await res.json().catch(() => null);
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// ── Setup / Teardown ─────���───────────────────────────────────────────

let originalEnv: string | undefined;

beforeEach(() => {
  jest.clearAllMocks();
  originalEnv = process.env.PLATFORM_CALLBACK_TOKEN;
  process.env.PLATFORM_CALLBACK_TOKEN = VALID_TOKEN;
});

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.PLATFORM_CALLBACK_TOKEN;
  } else {
    process.env.PLATFORM_CALLBACK_TOKEN = originalEnv;
  }
});

// ── Tests ──────────────────���─────────────────────────���───────────────

describe('GET /api/internal/platform-tools/find-teammates', () => {
  const basePath = `/api/internal/platform-tools/find-teammates?tenantId=${TENANT_ID}&agentId=${AGENT_ID}&query=engineer`;

  it('returns data with valid service auth', async () => {
    // find-teammates lists agents only: connected tools are not addressable.
    mockPoolQuery
      .mockResolvedValueOnce({
        rows: [
          { id: AGENT_ID, messaging_nickname: 'Alice', role: 'Engineer', summary_preview: 'Builds things' },
          { id: AGENT_ID, messaging_nickname: null, role: 'Designer', summary_preview: 'Designs things' },
        ],
      });

    const app = buildApp();
    const res = await makeRequest(app, basePath, { 'X-Service-Auth': VALID_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0]).toEqual({ id: AGENT_ID, type: 'internal_agent', name: 'Alice', role: 'Engineer', summary: 'Builds things' });
    // When messaging_nickname is null, falls back to role
    expect(res.body.results[1]).toEqual({ id: AGENT_ID, type: 'internal_agent', name: 'Designer', role: 'Designer', summary: 'Designs things' });
  });

  it('returns 401 when X-Service-Auth header is missing', async () => {
    const app = buildApp();
    const res = await makeRequest(app, basePath);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid service authentication');
  });

  it('returns 401 when token is invalid', async () => {
    const app = buildApp();
    const res = await makeRequest(app, basePath, { 'X-Service-Auth': 'wrong-token-wrong-token-wrong' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid service authentication');
  });

  it('returns 400 when tenantId is missing', async () => {
    const path = `/api/internal/platform-tools/find-teammates?agentId=${AGENT_ID}&query=test`;
    const app = buildApp();
    const res = await makeRequest(app, path, { 'X-Service-Auth': VALID_TOKEN });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('tenantId is required');
  });

  it('returns 400 when agentId is missing', async () => {
    const path = `/api/internal/platform-tools/find-teammates?tenantId=${TENANT_ID}&query=test`;
    const app = buildApp();
    const res = await makeRequest(app, path, { 'X-Service-Auth': VALID_TOKEN });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('agentId is required');
  });

  it('returns 400 when query is missing', async () => {
    const path = `/api/internal/platform-tools/find-teammates?tenantId=${TENANT_ID}&agentId=${AGENT_ID}`;
    const app = buildApp();
    const res = await makeRequest(app, path, { 'X-Service-Auth': VALID_TOKEN });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('query is required');
  });

  it('returns 400 when tenantId is not a valid UUID', async () => {
    const path = `/api/internal/platform-tools/find-teammates?tenantId=not-a-uuid&agentId=${AGENT_ID}&query=test`;
    const app = buildApp();
    const res = await makeRequest(app, path, { 'X-Service-Auth': VALID_TOKEN });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('tenantId must be a valid UUID');
  });

  it('returns 400 when query exceeds 200 characters', async () => {
    const longQuery = 'a'.repeat(201);
    const path = `/api/internal/platform-tools/find-teammates?tenantId=${TENANT_ID}&agentId=${AGENT_ID}&query=${longQuery}`;
    const app = buildApp();
    const res = await makeRequest(app, path, { 'X-Service-Auth': VALID_TOKEN });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('query must be at most 200 characters');
  });

  it('returns 200 with empty results when no matches found', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const path = `/api/internal/platform-tools/find-teammates?tenantId=${TENANT_ID}&agentId=${AGENT_ID}&query=nonexistent`;
    const app = buildApp();
    const res = await makeRequest(app, path, { 'X-Service-Auth': VALID_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  it('escapes LIKE wildcards (%, _, \\) in query', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const query = encodeURIComponent('100%_done\\');
    const path = `/api/internal/platform-tools/find-teammates?tenantId=${TENANT_ID}&agentId=${AGENT_ID}&query=${query}`;
    const app = buildApp();
    await makeRequest(app, path, { 'X-Service-Auth': VALID_TOKEN });

    // One query: internal_agents. Connected tools are not listed.
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    const callArgs = mockPoolQuery.mock.calls[0];
    const pattern = callArgs[1][2]; // [tenantId, agentId, pattern] for internal_agents query
    expect(pattern).toBe('%100\\%\\_done\\\\%');
  });

  it('uses timing-safe comparison for service auth', async () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    mockPoolQuery.mockResolvedValue({ rows: [] });

    const app = buildApp();
    await makeRequest(app, basePath, { 'X-Service-Auth': VALID_TOKEN });

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // ─��� OIDC Tenant Isolation (Issue #1) ────────────────────────────────

  describe('OIDC tenant isolation', () => {
    const PROJECT_NUMBER = '123456789012';
    const RUNTIME_URL = `https://agent-service-${PROJECT_NUMBER}.us-west1.run.app`;

    it('returns 403 when OIDC token belongs to a different project than the tenant runtime', async () => {
      process.env.NODE_ENV = 'production';

      // OIDC token from project 999999999999 (wrong project)
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({ email: '999999999999-compute@developer.gserviceaccount.com' }),
      });

      // First query: OIDC check looks up tenant's runtime_url
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ runtime_url: RUNTIME_URL }],
      });

      const app = buildApp();
      const res = await makeRequest(app, basePath, {
        'X-Service-Auth': VALID_TOKEN,
        Authorization: 'Bearer fake-oidc-token',
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Tenant isolation verification failed');

      process.env.NODE_ENV = 'test';
    });

    it('allows request when OIDC token project matches the tenant runtime', async () => {
      process.env.NODE_ENV = 'production';

      // OIDC token from correct project
      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({ email: `${PROJECT_NUMBER}-compute@developer.gserviceaccount.com` }),
      });

      // First query: OIDC check looks up tenant's runtime_url
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ runtime_url: RUNTIME_URL }] });
      // Next query: internal_agents (agents only).
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ id: AGENT_ID, messaging_nickname: 'Bob', role: 'Dev', summary_preview: 'Codes' }],
      });

      const app = buildApp();
      const res = await makeRequest(app, basePath, {
        'X-Service-Auth': VALID_TOKEN,
        Authorization: 'Bearer fake-oidc-token',
      });

      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(1);

      process.env.NODE_ENV = 'test';
    });

    it('skips OIDC check when no Authorization header (dev mode)', async () => {
      mockPoolQuery.mockResolvedValue({ rows: [] });

      const app = buildApp();
      const res = await makeRequest(app, basePath, { 'X-Service-Auth': VALID_TOKEN });

      // No OIDC header, NODE_ENV=test → OIDC check skipped, request passes
      expect(res.status).toBe(200);
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
    });
  });
});

// ── POST /api/internal/platform-tools/send-agent-message ─────────────────

describe('POST /api/internal/platform-tools/send-agent-message', () => {
  const SENDER_ID = '33333333-3333-3333-3333-333333333333';
  const RECIPIENT_ID = '44444444-4444-4444-4444-444444444444';
  const MSG_ID = '55555555-5555-5555-5555-555555555555';

  function postJson(
    app: ReturnType<typeof buildApp>,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        fetch(`http://127.0.0.1:${addr.port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
        })
          .then(async (res) => {
            const b = await res.json().catch(() => null);
            server.close();
            resolve({ status: res.status, body: b });
          })
          .catch((err) => { server.close(); reject(err); });
      });
    });
  }

  /** The query sequence a successful send makes, in order:
   *    1. sender belongs to this workspace   (bound 4)
   *    2. recipient's unread backlog          (bound 2)
   *    3. recipient belongs to this workspace
   *    4. the insert
   *  Stated once here so a test reads as "what happens", not as four anonymous
   *  mockResolvedValueOnce calls whose order nobody can check. */
  function mockHappySendQueries(pending = '0'): void {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });   // sender ok
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ pending }] });          // backlog
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'recipient-1' }] }); // recipient ok
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: MSG_ID }] });       // insert
  }

  it('inserts message when serviceAuth is valid and recipient exists', async () => {
    mockHappySendQueries();

    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/platform-tools/send-agent-message',
      { tenantId: TENANT_ID, senderAgentId: SENDER_ID, recipientAgentId: RECIPIENT_ID, content: 'hello' },
      { 'X-Service-Auth': VALID_TOKEN },
    );

    expect(res.status).toBe(201);
    expect((res.body as { success?: boolean }).success).toBe(true);
    expect((res.body as { messageId?: string }).messageId).toBe(MSG_ID);
  });

  it('returns 401 when X-Service-Auth is missing', async () => {
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/platform-tools/send-agent-message',
      { tenantId: TENANT_ID, senderAgentId: SENDER_ID, recipientAgentId: RECIPIENT_ID, content: 'hi' },
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when required fields are missing', async () => {
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/platform-tools/send-agent-message',
      { tenantId: TENANT_ID, content: 'hi' }, // missing senderAgentId and recipientAgentId
      { 'X-Service-Auth': VALID_TOKEN },
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when recipient not found in tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // sender ok
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ pending: '0' }] });  // backlog ok
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });                  // recipient not found
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/platform-tools/send-agent-message',
      { tenantId: TENANT_ID, senderAgentId: SENDER_ID, recipientAgentId: RECIPIENT_ID, content: 'hi' },
      { 'X-Service-Auth': VALID_TOKEN },
    );
    expect(res.status).toBe(404);
  });

  it('sender_type is always internal_agent (not from request body)', async () => {
    mockHappySendQueries();

    const app = buildApp();
    await postJson(
      app,
      '/api/internal/platform-tools/send-agent-message',
      { tenantId: TENANT_ID, senderAgentId: SENDER_ID, recipientAgentId: RECIPIENT_ID, content: 'hi' },
      { 'X-Service-Auth': VALID_TOKEN },
    );

    const insertCall = mockPoolQuery.mock.calls.find((c) => (c[0] as string).includes('INSERT INTO agent_messages'));
    expect(insertCall).toBeDefined();
    // The SQL template has 'internal_agent' hardcoded, verify it appears
    expect((insertCall![0] as string)).toContain("'internal_agent'");
  });

  // ── The three bounds A2A was missing ──────────────────────────────────
  //
  // Without them two agents can message each other in a tight loop: the queue
  // grows without limit, every read costs more, and a runaway sender fills it
  // faster than any reader drains it.

  // The recipient was already verified to belong to the tenant; the sender was
  // not, which held the two ends of the same message to different standards.
  // agent_messages.sender_id is trusted downstream to name an agent in the same
  // workspace.
  it('rejects a sender that does not belong to the workspace', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // sender not in tenant
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/platform-tools/send-agent-message',
      { tenantId: TENANT_ID, senderAgentId: SENDER_ID, recipientAgentId: RECIPIENT_ID, content: 'hi' },
      { 'X-Service-Auth': VALID_TOKEN },
    );
    expect(res.status).toBe(403);
    // And it never reached the insert.
    expect(mockPoolQuery.mock.calls.some((c) => (c[0] as string).includes('INSERT INTO agent_messages'))).toBe(false);
  });

  // A deep unread backlog means the recipient is not keeping up — either a loop
  // or a stalled reader, and adding to the queue makes both worse.
  it('refuses a send to a recipient with too many unread messages', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // sender ok
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ pending: '200' }] }); // at the cap
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/platform-tools/send-agent-message',
      { tenantId: TENANT_ID, senderAgentId: SENDER_ID, recipientAgentId: RECIPIENT_ID, content: 'hi' },
      { 'X-Service-Auth': VALID_TOKEN },
    );
    expect(res.status).toBe(429);
    expect(mockPoolQuery.mock.calls.some((c) => (c[0] as string).includes('INSERT INTO agent_messages'))).toBe(false);
  });

  it('allows a send when the backlog is below the cap', async () => {
    mockHappySendQueries('199');
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/platform-tools/send-agent-message',
      { tenantId: TENANT_ID, senderAgentId: SENDER_ID, recipientAgentId: RECIPIENT_ID, content: 'hi' },
      { 'X-Service-Auth': VALID_TOKEN },
    );
    expect(res.status).toBe(201);
  });

  // A sender that hits this is looping: composing a genuine message costs a
  // model turn, so one a second is not something an agent does legitimately.
  it('rate-limits a sender past the per-minute cap', async () => {
    const app = buildApp();
    const uniqueSender = '99999999-9999-9999-9999-999999999999';
    // A PERSISTENT implementation rather than 61 queued one-shots: the refused
    // send never reaches the database, so queued mocks would be left unconsumed
    // and would bleed into whichever suite ran next.
    mockPoolQuery.mockReset();
    mockPoolQuery.mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO agent_messages')) return Promise.resolve({ rows: [{ id: MSG_ID }] });
      if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ pending: '0' }] });
      if (sql.includes('FROM internal_agents WHERE id')) return Promise.resolve({ rows: [{ '?column?': 1 }] });
      return Promise.resolve({ rows: [{ id: 'recipient-1' }] });
    });
    try {
      let last = { status: 0, body: null as unknown };
      // 61 sends in one minute: the 61st must be refused.
      for (let i = 0; i < 61; i++) {
        last = await postJson(
          app,
          '/api/internal/platform-tools/send-agent-message',
          { tenantId: TENANT_ID, senderAgentId: uniqueSender, recipientAgentId: RECIPIENT_ID, content: 'hi' },
          { 'X-Service-Auth': VALID_TOKEN },
        );
      }
      expect(last.status).toBe(429);
    } finally {
      mockPoolQuery.mockReset();
    }
  });

  // Bound 1 was already present; asserted here so the four are checked together.
  it('rejects a message over the 50 KB size cap', async () => {
    const app = buildApp();
    const res = await postJson(
      app,
      '/api/internal/platform-tools/send-agent-message',
      { tenantId: TENANT_ID, senderAgentId: SENDER_ID, recipientAgentId: RECIPIENT_ID, content: 'x'.repeat(51201) },
      { 'X-Service-Auth': VALID_TOKEN },
    );
    expect(res.status).toBe(400);
  });
});

// ── GET /api/internal/platform-tools/agent-messages ──────────────────────

describe('GET /api/internal/platform-tools/agent-messages', () => {
  const RECIPIENT_ID = '44444444-4444-4444-4444-444444444444';

  function getRequest(
    app: ReturnType<typeof buildApp>,
    query: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        fetch(`http://127.0.0.1:${addr.port}/api/internal/platform-tools/agent-messages?${query}`, { headers })
          .then(async (res) => {
            const b = await res.json().catch(() => null);
            server.close();
            resolve({ status: res.status, body: b });
          })
          .catch((err) => { server.close(); reject(err); });
      });
    });
  }

  it('returns pending messages for this agent atomically', async () => {
    const msgRow = {
      id: '55555555-5555-5555-5555-555555555555',
      sender_type: 'claude_code', sender_id: '66666666-6666-6666-6666-666666666666',
      content: 'task for you', metadata: {}, created_at: new Date(),
    };
    mockPoolQuery.mockResolvedValueOnce({ rows: [msgRow] });

    const app = buildApp();
    const res = await getRequest(
      app,
      `tenantId=${TENANT_ID}&agentId=${RECIPIENT_ID}`,
      { 'X-Service-Auth': VALID_TOKEN },
    );

    expect(res.status).toBe(200);
    expect((res.body as { count?: number }).count).toBe(1);
    expect((res.body as { messages?: { content?: string }[] }).messages?.[0].content).toBe('task for you');

    const query = mockPoolQuery.mock.calls[0][0] as string;
    expect(query).toContain('UPDATE agent_messages');
    expect(query).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('returns 401 when X-Service-Auth is missing', async () => {
    const app = buildApp();
    const res = await getRequest(app, `tenantId=${TENANT_ID}&agentId=${RECIPIENT_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 400 when tenantId or agentId is missing', async () => {
    const app = buildApp();
    const res = await getRequest(app, `tenantId=${TENANT_ID}`, { 'X-Service-Auth': VALID_TOKEN });
    expect(res.status).toBe(400);
  });
});

// ── POST /api/internal/platform-tools/composio-tool-calls ────────────────

describe('POST /api/internal/platform-tools/composio-tool-calls', () => {
  const ACCOUNT_ID = 'acct_test123';

  function postJson(
    app: ReturnType<typeof buildApp>,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        fetch(`http://127.0.0.1:${addr.port}/api/internal/platform-tools/composio-tool-calls`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
        })
          .then(async (res) => {
            const b = await res.json().catch(() => null);
            server.close();
            resolve({ status: res.status, body: b });
          })
          .catch((err) => { server.close(); reject(err); });
      });
    });
  }

  const validCall = {
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
    callId: 'call_abc123',
    connectorType: 'cal_com',
    toolName: 'mcp__cal_com-abcd1234__list_bookings',
    occurredAt: '2026-05-22T19:00:00Z',
  };

  it('ingests one cost_attribution_event per call at $0.000299', async () => {
    mockResolveAccountIdForTenant.mockResolvedValue(ACCOUNT_ID);
    mockIngestEventWithBuckets.mockResolvedValue(1);

    const app = buildApp();
    const res = await postJson(app, { calls: [validCall] }, { 'X-Service-Auth': VALID_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ingested: 1, skipped: 0 });
    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      ACCOUNT_ID,
      `${TENANT_ID}:${AGENT_ID}:call_abc123`,
      0.000299,
      expect.objectContaining({
        tenantId: TENANT_ID,
        agentId: AGENT_ID,
        connector: 'cal_com',
        purpose: 'mcp__cal_com-abcd1234__list_bookings',
        eventType: 'connector_call',
        source: 'composio_mcp',
        correlationConfidence: 'direct',
      }),
    );
  });

  it('reuses the resolved accountId across calls for the same tenant', async () => {
    mockResolveAccountIdForTenant.mockResolvedValue(ACCOUNT_ID);
    mockIngestEventWithBuckets.mockResolvedValue(1);

    const app = buildApp();
    await postJson(app, {
      calls: [
        validCall,
        { ...validCall, callId: 'call_abc124' },
        { ...validCall, callId: 'call_abc125' },
      ],
    }, { 'X-Service-Auth': VALID_TOKEN });

    expect(mockResolveAccountIdForTenant).toHaveBeenCalledTimes(1);
    expect(mockIngestEventWithBuckets).toHaveBeenCalledTimes(3);
  });

  it('skips entries whose tenant has no resolvable account', async () => {
    mockResolveAccountIdForTenant.mockResolvedValue(null);

    const app = buildApp();
    const res = await postJson(app, { calls: [validCall] }, { 'X-Service-Auth': VALID_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ingested: 0, skipped: 1 });
    expect(mockIngestEventWithBuckets).not.toHaveBeenCalled();
  });

  it('returns 401 when X-Service-Auth is missing', async () => {
    const app = buildApp();
    const res = await postJson(app, { calls: [validCall] });
    expect(res.status).toBe(401);
    expect(mockIngestEventWithBuckets).not.toHaveBeenCalled();
  });

  it('rejects connector types outside the Composio-managed set', async () => {
    // zendesk is a native sidecar connector, not Composio-managed. Attributing
    // a zendesk call to the composio_mcp source would corrupt margin reports —
    // the endpoint refuses cross-attribution by hardcoding the known
    // Composio-managed types.
    //
    // 'salesforce' is not a valid example here: it uses Composio-managed auth
    // and is a legitimate member of the set.
    const app = buildApp();
    const res = await postJson(
      app,
      { calls: [{ ...validCall, connectorType: 'zendesk' }] },
      { 'X-Service-Auth': VALID_TOKEN },
    );
    expect(res.status).toBe(400);
    expect(mockIngestEventWithBuckets).not.toHaveBeenCalled();
  });

  it('rejects batches over the 500-entry cap', async () => {
    // 501 valid entries blows past the express.json() body-size limit
    // before reaching the validator on most realistic configs. Use 501
    // tiny entries to stay under the body limit and exercise the 500
    // cap check in the router itself.
    const calls = Array.from({ length: 501 }, (_, i) => ({
      ...validCall,
      callId: `c${i}`,
    }));
    const app = buildApp();
    const res = await postJson(app, { calls }, { 'X-Service-Auth': VALID_TOKEN });
    // Either the router's 400 OR express.json's 413 is acceptable —
    // both reject the batch without inserting anything.
    expect([400, 413]).toContain(res.status);
    expect(mockIngestEventWithBuckets).not.toHaveBeenCalled();
  });

  it('rejects entries with invalid UUID tenantId', async () => {
    const app = buildApp();
    const res = await postJson(
      app,
      { calls: [{ ...validCall, tenantId: 'not-a-uuid' }] },
      { 'X-Service-Auth': VALID_TOKEN },
    );
    expect(res.status).toBe(400);
    expect(mockIngestEventWithBuckets).not.toHaveBeenCalled();
  });
});


// ── Agent Conversation Recall (plan v13 Change 3) ─────────────────────

describe('POST /api/internal/platform-tools/agent-conversations', () => {
  const ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
  const TURN_ID = '44444444-4444-4444-4444-444444444444';
  const AC_PATH = '/api/internal/platform-tools/agent-conversations';
  const CUSTOM_SA = 'tenant-runtime@tenant-acme-dev.iam.gserviceaccount.com';
  const EXPECTED_AUDIENCE = 'https://api-test.example.com/api/internal/platform-tools/agent-conversations';

  function postJson(
    app: express.Express,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        fetch(`http://127.0.0.1:${addr.port}${AC_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
        })
          .then(async (res) => {
            const parsed = await res.json().catch(() => null);
            server.close();
            resolve({ status: res.status, body: parsed });
          })
          .catch((err) => {
            server.close();
            reject(err);
          });
      });
    });
  }

  const validBody = { tenantId: TENANT_ID, agentId: AGENT_ID, accountId: ACCOUNT_ID };

  afterEach(() => {
    delete process.env.ENVIRONMENT;
  });

  it('400s invalid tenantId / agentId / accountId', async () => {
    const app = buildApp();
    for (const bad of [
      { ...validBody, tenantId: 'nope' },
      { ...validBody, agentId: 'nope' },
      { ...validBody, accountId: 'nope' },
      { tenantId: TENANT_ID, agentId: AGENT_ID },
    ]) {
      const res = await postJson(app, bad, { 'X-Service-Auth': VALID_TOKEN });
      expect(res.status).toBe(400);
    }
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('400s over-long query, non-string query, and invalid excludeTurnId', async () => {
    const app = buildApp();
    expect((await postJson(app, { ...validBody, query: 'x'.repeat(201) }, { 'X-Service-Auth': VALID_TOKEN })).status).toBe(400);
    expect((await postJson(app, { ...validBody, query: 42 }, { 'X-Service-Auth': VALID_TOKEN })).status).toBe(400);
    expect((await postJson(app, { ...validBody, excludeTurnId: 'not-a-uuid' }, { 'X-Service-Auth': VALID_TOKEN })).status).toBe(400);
  });

  it('applies documented limit semantics: 0/-1 clamp to 1, 1.5 truncates, non-numeric defaults 5, 11 clamps to 10', async () => {
    const app = buildApp();
    const cases: Array<[unknown, number]> = [
      [0, 1],
      [-1, 1],
      [1.5, 1],
      ['abc', 5],
      [11, 10],
      [undefined, 5],
    ];
    for (const [input, expected] of cases) {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const res = await postJson(app, { ...validBody, limit: input }, { 'X-Service-Auth': VALID_TOKEN });
      expect(res.status).toBe(200);
      const args = mockPoolQuery.mock.calls[mockPoolQuery.mock.calls.length - 1][1];
      expect(args[3]).toBe(expected);
    }
  });

  it('normalizes empty/whitespace query to recent mode (no ILIKE %%)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const app = buildApp();
    const res = await postJson(app, { ...validBody, query: '   ' }, { 'X-Service-Auth': VALID_TOKEN });
    expect(res.status).toBe(200);
    const args = mockPoolQuery.mock.calls[0][1];
    expect(args[4]).toBeNull();
    expect(args[6]).toBeNull();
  });

  it('trims BEFORE the length check: 250 spaces is recent mode, not a 400', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const app = buildApp();
    const res = await postJson(app, { ...validBody, query: ' '.repeat(250) }, { 'X-Service-Auth': VALID_TOKEN });
    expect(res.status).toBe(200);
    expect(mockPoolQuery.mock.calls[0][1][4]).toBeNull();
  });

  it('LIKE-escapes wildcards and passes the lowercased raw copy for windowing', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const app = buildApp();
    const res = await postJson(app, { ...validBody, query: '100%_Done\\' }, { 'X-Service-Auth': VALID_TOKEN });
    expect(res.status).toBe(200);
    const args = mockPoolQuery.mock.calls[0][1];
    expect(args[4]).toBe('%100\\%\\_Done\\\\%');
    expect(args[6]).toBe('100%_done\\');
  });

  it('positions args: tenant $1, agent $2, account $3, excludeTurnId $6', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const app = buildApp();
    const res = await postJson(app, { ...validBody, excludeTurnId: TURN_ID }, { 'X-Service-Auth': VALID_TOKEN });
    expect(res.status).toBe(200);
    const args = mockPoolQuery.mock.calls[0][1];
    expect(args[0]).toBe(TENANT_ID);
    expect(args[1]).toBe(AGENT_ID);
    expect(args[2]).toBe(ACCOUNT_ID);
    expect(args[5]).toBe(TURN_ID);
  });

  it('maps rows to the response shape', async () => {
    const at = new Date('2026-07-17T21:28:00Z');
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        turn_id: TURN_ID,
        thread_id: '55555555-5555-4555-8555-555555555555',
        channel: 'mcp',
        created_at: at,
        messages: [{ role: 'user', preview: 'hi', created_at: at }],
      }],
    });
    const app = buildApp();
    const res = await postJson(app, validBody, { 'X-Service-Auth': VALID_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.turns).toHaveLength(1);
    expect(res.body.turns[0]).toMatchObject({
      turnId: TURN_ID,
      channel: 'mcp',
    });
  });

  describe('strict OIDC verification', () => {
    it('403s a missing OIDC token in deployed environments', async () => {
      process.env.ENVIRONMENT = 'dev';
      const app = buildApp();
      const res = await postJson(app, validBody, { 'X-Service-Auth': VALID_TOKEN });
      expect(res.status).toBe(403);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('allows a missing OIDC token only in test/local/unset environments', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const app = buildApp();
      const res = await postJson(app, validBody, { 'X-Service-Auth': VALID_TOKEN });
      expect(res.status).toBe(200);
    });

    it('pins the audience to the exact canonical endpoint URL and 403s wrong-audience tokens', async () => {
      process.env.ENVIRONMENT = 'dev';
      mockVerifyIdToken.mockRejectedValueOnce(new Error('Wrong recipient'));
      const app = buildApp();
      const res = await postJson(app, validBody, {
        'X-Service-Auth': VALID_TOKEN,
        Authorization: 'Bearer some-token',
      });
      expect(res.status).toBe(403);
      expect(mockVerifyIdToken).toHaveBeenCalledWith({
        idToken: 'some-token',
        audience: EXPECTED_AUDIENCE,
      });
    });

    it('403s (fail closed) when the tenant has no gcp_project_id', async () => {
      process.env.ENVIRONMENT = 'dev';
      mockVerifyIdToken.mockResolvedValueOnce({ getPayload: () => ({ email: CUSTOM_SA }) });
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ gcp_project_id: null }] });
      const app = buildApp();
      const res = await postJson(app, validBody, {
        'X-Service-Auth': VALID_TOKEN,
        Authorization: 'Bearer t',
      });
      expect(res.status).toBe(403);
    });

    it('403s a validly signed token from the WRONG tenant project', async () => {
      process.env.ENVIRONMENT = 'dev';
      mockVerifyIdToken.mockResolvedValueOnce({ getPayload: () => ({ email: CUSTOM_SA }) });
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ gcp_project_id: 'tenant-other-prod' }] });
      const app = buildApp();
      const res = await postJson(app, validBody, {
        'X-Service-Auth': VALID_TOKEN,
        Authorization: 'Bearer t',
      });
      expect(res.status).toBe(403);
    });

    it('accepts the real custom-SA shape for the matching tenant project', async () => {
      process.env.ENVIRONMENT = 'dev';
      mockVerifyIdToken.mockResolvedValueOnce({ getPayload: () => ({ email: CUSTOM_SA }) });
      mockPoolQuery
        .mockResolvedValueOnce({ rows: [{ gcp_project_id: 'tenant-acme-dev' }] })
        .mockResolvedValueOnce({ rows: [] });
      const app = buildApp();
      const res = await postJson(app, validBody, {
        'X-Service-Auth': VALID_TOKEN,
        Authorization: 'Bearer t',
      });
      expect(res.status).toBe(200);
    });
  });
});

// ── Semantic retrieval v2 (plan v6 Change 8.4) ────────────────────────

const mockGetRecallQueryEmbedding = jest.fn();
jest.mock('../../agent-chat/turn-embedding-service', () => ({
  getRecallQueryEmbedding: (...args: unknown[]) => mockGetRecallQueryEmbedding(...args),
}));

describe('POST /agent-conversations — semantic retrieval (v2)', () => {
  const ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';
  const AC_PATH = '/api/internal/platform-tools/agent-conversations';
  const validBody = { tenantId: TENANT_ID, agentId: AGENT_ID, accountId: ACCOUNT_ID };

  const { AGENT_CONVERSATIONS_SQL, AGENT_CONVERSATIONS_SEMANTIC_SQL } = require('../platform-tools-router');
  const { log: mockedLog } = require('../../infrastructure/logging');

  function turnRow(id: string, extra: Record<string, unknown> = {}) {
    return {
      turn_id: id,
      thread_id: '55555555-5555-4555-8555-555555555555',
      channel: 'web',
      created_at: new Date('2026-07-13T00:00:00Z'),
      messages: [{ role: 'user', preview: 'p', created_at: '2026-07-13T00:00:00Z' }],
      ...extra,
    };
  }

  function postJson(
    app: express.Express,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        fetch(`http://127.0.0.1:${addr.port}${AC_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
        })
          .then(async (res) => {
            const parsed = await res.json().catch(() => null);
            server.close();
            resolve({ status: res.status, body: parsed });
          })
          .catch((err) => {
            server.close();
            reject(err);
          });
      });
    });
  }

  function lastRecallLog(): Record<string, unknown> | undefined {
    const calls = (mockedLog.info as jest.Mock).mock.calls
      .filter((c: unknown[]) => (c[0] as { event?: string })?.event === 'platform_tool_agent_conversations');
    return calls.at(-1)?.[0];
  }

  afterEach(() => {
    delete process.env.RECALL_SEMANTIC_READ_ENABLED;
  });

  it('read flag off + query → single v1 keyword query, embed helper never called', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const app = buildApp();
    const res = await postJson(app, { ...validBody, query: 'atlas' }, { 'X-Service-Auth': VALID_TOKEN });
    expect(res.status).toBe(200);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery.mock.calls[0][0]).toBe(AGENT_CONVERSATIONS_SQL);
    expect(mockGetRecallQueryEmbedding).not.toHaveBeenCalled();
    expect(lastRecallLog()?.retrieval).toBe('keyword');
  });

  it('read on + keyword FILLS the limit → SHORT-CIRCUIT: embed never called, single query', async () => {
    process.env.RECALL_SEMANTIC_READ_ENABLED = 'true';
    mockPoolQuery.mockResolvedValueOnce({ rows: [turnRow('aaaaaaaa-0000-4000-8000-000000000001')] });
    const app = buildApp();
    const res = await postJson(app, { ...validBody, query: 'atlas', limit: 1 }, { 'X-Service-Auth': VALID_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.turns).toHaveLength(1);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockGetRecallQueryEmbedding).not.toHaveBeenCalled();
    expect(lastRecallLog()?.retrieval).toBe('keyword');
  });

  it('read on + under-fill + embed success → keyword-first fill, dedup, params, telemetry', async () => {
    process.env.RECALL_SEMANTIC_READ_ENABLED = 'true';
    const K1 = 'aaaaaaaa-0000-4000-8000-000000000001';
    const S1 = 'bbbbbbbb-0000-4000-8000-000000000002';
    const S2 = 'cccccccc-0000-4000-8000-000000000003';
    mockGetRecallQueryEmbedding.mockResolvedValueOnce({
      vector: [0.5, 0.25], provider: 'google', model: 'gemini-embedding-001',
    });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [turnRow(K1)] })                               // keyword
      .mockResolvedValueOnce({ rows: [                                              // semantic (limit rows,
        turnRow(K1, { similarity: 0.91 }),                                          //  includes the keyword row)
        turnRow(S1, { similarity: 0.82 }),
        turnRow(S2, { similarity: 0.7 }),
      ] });
    const app = buildApp();
    const res = await postJson(app, { ...validBody, query: 'atlas launch', limit: 2 }, { 'X-Service-Auth': VALID_TOKEN });

    expect(res.status).toBe(200);
    // keyword row leads; semantic fill deduped (K1 once) and capped at limit.
    expect(res.body.turns.map((t: { turnId: string }) => t.turnId)).toEqual([K1, S1]);
    // similarity is internal telemetry — never in the response.
    expect(res.body.turns[0]).not.toHaveProperty('similarity');

    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
    expect(mockPoolQuery.mock.calls[0][0]).toBe(AGENT_CONVERSATIONS_SQL);
    expect(mockPoolQuery.mock.calls[1][0]).toBe(AGENT_CONVERSATIONS_SEMANTIC_SQL);
    const semanticArgs = mockPoolQuery.mock.calls[1][1];
    expect(semanticArgs[4]).toBe('[0.5,0.25]');            // $5 vector literal
    expect(semanticArgs[7]).toBe('google');                // $8 provider
    expect(semanticArgs[8]).toBe('gemini-embedding-001');  // $9 model

    const logged = lastRecallLog();
    expect(logged?.retrieval).toBe('semantic+keyword');
    expect(logged?.semanticCount).toBe(3);
    expect(logged?.keywordCount).toBe(1);
    expect(logged?.simMax).toBe(0.91);
    expect(logged?.simMin).toBe(0.7);
    expect(logged?.simMean).toBeCloseTo(0.81, 2);
  });

  it('limit=1 with keyword under-fill (zero keyword rows): semantic fills the single slot', async () => {
    process.env.RECALL_SEMANTIC_READ_ENABLED = 'true';
    const S1 = 'bbbbbbbb-0000-4000-8000-000000000002';
    mockGetRecallQueryEmbedding.mockResolvedValueOnce({
      vector: [0.5], provider: 'google', model: 'gemini-embedding-001',
    });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })              // keyword empty (under-fill)
      .mockResolvedValueOnce({ rows: [turnRow(S1, { similarity: 0.6 })] });
    const app = buildApp();
    const res = await postJson(app, { ...validBody, query: 'atlas', limit: 1 }, { 'X-Service-Auth': VALID_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.turns.map((t: { turnId: string }) => t.turnId)).toEqual([S1]);
    expect(lastRecallLog()?.retrieval).toBe('semantic+keyword');
  });

  it('read on + under-fill + embed null (failure/deadline) → keyword rows, no error, single query', async () => {
    process.env.RECALL_SEMANTIC_READ_ENABLED = 'true';
    mockGetRecallQueryEmbedding.mockResolvedValueOnce(null);
    const K1 = 'aaaaaaaa-0000-4000-8000-000000000001';
    mockPoolQuery.mockResolvedValueOnce({ rows: [turnRow(K1)] });
    const app = buildApp();
    const res = await postJson(app, { ...validBody, query: 'atlas', limit: 5 }, { 'X-Service-Auth': VALID_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.turns.map((t: { turnId: string }) => t.turnId)).toEqual([K1]);
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(lastRecallLog()?.retrieval).toBe('keyword');
  });

  it('recent mode (no query) + read on → embed helper never called', async () => {
    process.env.RECALL_SEMANTIC_READ_ENABLED = 'true';
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const app = buildApp();
    const res = await postJson(app, validBody, { 'X-Service-Auth': VALID_TOKEN });
    expect(res.status).toBe(200);
    expect(mockGetRecallQueryEmbedding).not.toHaveBeenCalled();
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it('sim stats absent when semantic returns zero rows', async () => {
    process.env.RECALL_SEMANTIC_READ_ENABLED = 'true';
    mockGetRecallQueryEmbedding.mockResolvedValueOnce({
      vector: [0.5], provider: 'google', model: 'm',
    });
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })   // keyword under-fills (empty)
      .mockResolvedValueOnce({ rows: [] });  // semantic empty too
    const app = buildApp();
    const res = await postJson(app, { ...validBody, query: 'zebra unicorn' }, { 'X-Service-Auth': VALID_TOKEN });
    expect(res.status).toBe(200);
    const logged = lastRecallLog();
    expect(logged?.retrieval).toBe('semantic+keyword');
    expect(logged?.semanticCount).toBe(0);
    expect(logged).not.toHaveProperty('simMax');
  });
});

// Recall ranking.
//
// Three refinements were on the list; two turned out to be satisfied already,
// and saying so is worth as much as the one that needed building.
describe('recall ranking', () => {
  const { AGENT_CONVERSATIONS_SEMANTIC_SQL } = require('../platform-tools-router');
  const sql = AGENT_CONVERSATIONS_SEMANTIC_SQL as string;

  it('returns at most one hit per conversation', () => {
    // Without this a single long thread that discussed a topic repeatedly takes
    // every slot, and the other conversations that also touched it never
    // surface.
    expect(sql).toMatch(/DISTINCT ON \(tr\.thread_id\)/);
  });

  it('picks the BEST turn from each conversation, not an arbitrary one', () => {
    // DISTINCT ON keeps the first row per group, so the group ordering has to
    // put the closest match first.
    expect(sql).toMatch(/ORDER BY tr\.thread_id, tr\.content_embedding <=> \$5::vector/);
  });

  it('still ranks the deduped set by similarity overall', () => {
    expect(sql).toMatch(/ORDER BY r\.distance/);
  });

  it('excludes the platform own out-of-turn rows from the preview', () => {
    // A routine proposal and a learning confirmation are assistant-role but are
    // not conversation; quoting them back as "what you discussed" is confusing
    // and wastes the preview budget.
    expect(sql).toMatch(/message_type NOT IN/);
    expect(sql).toMatch(/'suggestion'/);
    expect(sql).toMatch(/'learning_confirmation'/);
    expect(sql).toMatch(/'hitl_status'/);
  });

  it('keeps ordinary messages, which carry no message_type', () => {
    expect(sql).toMatch(/m\.message_type IS NULL OR/);
  });

  it('bounds the messages per hit', () => {
    // The property is that a bound EXISTS — without one, a single long turn
    // crowds out every other conversation the search found. The exact number is
    // a tuning decision somebody is allowed to change without a red test, so
    // this asserts a small bound rather than a specific one.
    const m = /LIMIT (\d+)/.exec(sql);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(1);
    expect(Number(m![1])).toBeLessThanOrEqual(20);
  });

  it('is still scoped to the asking person, which is what excludes automation', () => {
    // Hermes DEMOTES cron sessions because its search is global. Ours filters on
    // sender_account_id, and an automated run has no sender — so cron turns are
    // excluded outright rather than merely ranked down. Stronger by
    // construction; nothing to build.
    expect(sql).toMatch(/tr\.sender_account_id = \$3/);
  });
});

// ── POST /skill-feedback — agent id-space normalization (ADR-039) ─────

const mockProcessSkillFeedback = jest.fn();
jest.mock('../../internal-agents/skill-feedback-service', () => ({
  processSkillFeedback: (...args: unknown[]) => mockProcessSkillFeedback(...args),
}));

const mockGetRuntimeToInternalMap = jest.fn();
jest.mock('../../internal-agents/runtime-agent-id-map', () => ({
  getRuntimeToInternalMap: (...args: unknown[]) => mockGetRuntimeToInternalMap(...args),
  toInternalAgentId: (map: ReadonlyMap<string, string>, id: string) => map.get(id) ?? id,
}));

describe('POST /api/internal/platform-tools/skill-feedback', () => {
  const RUNTIME_AGENT_ID = '66666666-6666-6666-6666-666666666666';
  const INTERNAL_AGENT_ID = '77777777-7777-7777-7777-777777777777';
  const FEEDBACK = [{ skillId: '88888888-8888-8888-8888-888888888888', skillName: 'x', outcome: 'success' }];

  function postFeedback(body: unknown): Promise<{ status: number; body: unknown }> {
    const app = buildApp();
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        fetch(`http://127.0.0.1:${addr.port}/api/internal/platform-tools/skill-feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Service-Auth': VALID_TOKEN },
          body: JSON.stringify(body),
        })
          .then(async (res) => {
            const b = res.status === 204 ? null : await res.json().catch(() => null);
            server.close();
            resolve({ status: res.status, body: b });
          })
          .catch((err) => { server.close(); reject(err); });
      });
    });
  }

  it('prefers internalAgentId and processes with it (no map lookup)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 }); // provisioned check
    mockProcessSkillFeedback.mockResolvedValueOnce(undefined);

    const res = await postFeedback({
      tenantId: TENANT_ID, agentId: RUNTIME_AGENT_ID, internalAgentId: INTERNAL_AGENT_ID, feedback: FEEDBACK,
    });

    expect(res.status).toBe(204);
    expect(mockGetRuntimeToInternalMap).not.toHaveBeenCalled();
    expect(mockProcessSkillFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: INTERNAL_AGENT_ID, tenantId: TENANT_ID }),
    );
  });

  it('translates a bare runtime agentId through the id map (legacy fallback)', async () => {
    mockGetRuntimeToInternalMap.mockResolvedValueOnce(new Map([[RUNTIME_AGENT_ID, INTERNAL_AGENT_ID]]));
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });
    mockProcessSkillFeedback.mockResolvedValueOnce(undefined);

    const res = await postFeedback({ tenantId: TENANT_ID, agentId: RUNTIME_AGENT_ID, feedback: FEEDBACK });

    expect(res.status).toBe(204);
    expect(mockGetRuntimeToInternalMap).toHaveBeenCalledWith(TENANT_ID);
    expect(mockProcessSkillFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: INTERNAL_AGENT_ID }),
    );
  });

  it('returns 409 agent_not_provisioned when the id resolves to no internal agent', async () => {
    mockGetRuntimeToInternalMap.mockResolvedValueOnce(new Map()); // identity fallback
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // provisioned check misses

    const res = await postFeedback({ tenantId: TENANT_ID, agentId: RUNTIME_AGENT_ID, feedback: FEEDBACK });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'agent_not_provisioned' });
    expect(mockProcessSkillFeedback).not.toHaveBeenCalled();
  });

  it('rejects a malformed internalAgentId with 400', async () => {
    const res = await postFeedback({
      tenantId: TENANT_ID, agentId: RUNTIME_AGENT_ID, internalAgentId: 'not-a-uuid', feedback: FEEDBACK,
    });
    expect(res.status).toBe(400);
  });
});


// ── POST /thread-history ───────────────────────────────────────────────

describe('POST /api/internal/platform-tools/thread-history', () => {
  const TH_PATH = '/api/internal/platform-tools/thread-history';
  const THREAD_ID = '55555555-5555-5555-5555-555555555555';
  const EXPECTED_AUDIENCE = 'https://api-test.example.com/api/internal/platform-tools/thread-history';
  const RUNTIME_SA = 'tenant-runtime@tenant-acme-dev.iam.gserviceaccount.com';

  function post(
    app: express.Express,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const server = app.listen(0, () => {
        const addr = server.address() as { port: number };
        fetch(`http://127.0.0.1:${addr.port}${TH_PATH}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(body),
        })
          .then(async (res) => {
            const parsed = await res.json().catch(() => null);
            server.close();
            resolve({ status: res.status, body: parsed });
          })
          .catch((err) => { server.close(); reject(err); });
      });
    });
  }

  const validBody = { tenantId: TENANT_ID, threadId: THREAD_ID };

  afterEach(() => {
    delete process.env.ENVIRONMENT;
  });

  it('rejects a caller with no service token', async () => {
    const res = await post(buildApp(), validBody);
    expect(res.status).toBe(401);
  });

  it.each([
    ['tenantId', { tenantId: 'not-a-uuid', threadId: THREAD_ID }],
    ['threadId', { tenantId: TENANT_ID, threadId: 'not-a-uuid' }],
  ])('rejects a malformed %s with 400', async (_which, body) => {
    const res = await post(buildApp(), body, { 'X-Service-Auth': VALID_TOKEN });
    expect(res.status).toBe(400);
  });

  it('rejects a match longer than 200 characters', async () => {
    const res = await post(
      buildApp(),
      { ...validBody, match: 'x'.repeat(201) },
      { 'X-Service-Auth': VALID_TOKEN },
    );
    expect(res.status).toBe(400);
  });

  it('is a hard 403 in a deployed environment when the OIDC identity token is missing', async () => {
    process.env.ENVIRONMENT = 'dev';

    const res = await post(buildApp(), validBody, { 'X-Service-Auth': VALID_TOKEN });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Tenant caller verification failed');
  });

  it('pins the OIDC audience to ITS OWN path, not the recall route\'s', async () => {
    process.env.ENVIRONMENT = 'dev';
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ email: RUNTIME_SA }) });
    // tenants.gcp_project_id for the strict caller check, then the thread read.
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ gcp_project_id: 'tenant-acme-dev' }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await post(buildApp(), validBody, {
      'X-Service-Auth': VALID_TOKEN,
      Authorization: 'Bearer fake-oidc-token',
    });

    expect(mockVerifyIdToken).toHaveBeenCalledWith(
      expect.objectContaining({ audience: EXPECTED_AUDIENCE }),
    );
  });

  it('answers a thread that does not resolve under the tenant in words, not as an error', async () => {
    process.env.ENVIRONMENT = 'dev';
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ email: RUNTIME_SA }) });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ gcp_project_id: 'tenant-acme-dev' }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = await post(buildApp(), validBody, {
      'X-Service-Auth': VALID_TOKEN,
      Authorization: 'Bearer fake-oidc-token',
    });

    expect(res.status).toBe(200);
    expect(res.body.text).toBe('This conversation could not be read.');
  });

  it('takes no surface argument: a runtime cannot reach another surface through it', async () => {
    process.env.ENVIRONMENT = 'dev';
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => ({ email: RUNTIME_SA }) });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ gcp_project_id: 'tenant-acme-dev' }] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    await post(
      buildApp(),
      { ...validBody, surface: 'liftoff' },
      { 'X-Service-Auth': VALID_TOKEN, Authorization: 'Bearer fake-oidc-token' },
    );

    // The team surface's thread table, whatever the body asked for.
    const readSql = mockPoolQuery.mock.calls[1][0] as string;
    expect(readSql).toContain('agent_chat_threads');
    expect(readSql).not.toContain('liftoff_chat_threads');
  });
});
