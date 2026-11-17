// Platform tools — the runtime/control-plane agent id boundary (ADR-039,
// INV-PB-009, INV-TR-010).
//
// Every route in platform-tools-router is called BY THE RUNTIME, which derives
// agent ids from its own ExecutionContext and therefore sends runtime-space
// `agents.id`. Every table behind these routes is keyed on `internal_agents.id`.
// The spaces are disjoint, so an untranslated id matches ZERO rows — the
// failure is always "nothing found", never a wrong row, which is exactly why
// it goes unnoticed: an empty result reads as "no messages", "no
// teammates", "not a member".
//
// Untranslated, a delegated child that posts its answer gets 403 'sender does
// not belong to this workspace', and no A2A message is ever delivered for that
// workspace.
//
// These tests pin the translation at all three sites. The send/read pair
// matters most: translating only the send path would be WORSE than translating
// neither, because delivery would start working and every delivered message
// would then be unreadable.

// The output guard reads through the LLM client, which this suite does not
// mock: a pass-through keeps the suite off the network (INV-PB-015 has its
// own suites).
jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

import crypto from 'crypto';
import express from 'express';

const mockPoolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  withTenantScope: jest.fn(async (_t: string, fn: (c: { query: typeof mockPoolQuery }) => unknown) =>
    fn({ query: mockPoolQuery })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn(() => ({ verifyIdToken: jest.fn() })),
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
  oversightService: { getOrCreateOversightSettings: jest.fn().mockResolvedValue({}) },
}));

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: { enqueueAgentTask: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../../cost-attribution/repository', () => ({
  resolveAccountIdForTenant: jest.fn(),
  ingestEventWithBuckets: jest.fn(),
}));

const mockFindOrCreateThread = jest.fn();
const mockAppendMessage = jest.fn();
jest.mock('../../agent-chat/chat-repository', () => ({
  findOrCreateThread: (...a: unknown[]) => mockFindOrCreateThread(...a),
  appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
}));

jest.mock('../../infrastructure/frontend-url', () => ({ frontendUrl: () => 'https://app-test.example.com' }));

const mockGetMap = jest.fn<Promise<Map<string, string>>, [string]>();
jest.mock('../../internal-agents/runtime-agent-id-map', () => ({
  // Identity on a miss — the real module's contract, so a control-plane caller
  // passing internal ids must keep working untouched.
  getRuntimeToInternalMap: (t: string) => mockGetMap(t),
  toInternalAgentId: (map: ReadonlyMap<string, string>, id: string) => map.get(id) ?? id,
}));

import { platformToolsRouter } from '../platform-tools-router';

const TOKEN = 'test-platform-callback-token-1234';
const TENANT = '11111111-1111-1111-1111-111111111111';

// The two spaces, kept visually distinct on purpose.
const RUNTIME_SENDER = '93321b38-ead6-4f71-84f1-9a08ba2a2b5f';
const INTERNAL_SENDER = '122662dd-de4e-4b0d-8873-50cd6a00daaf';
const RUNTIME_RECIPIENT = 'abbb7a1c-f66f-46d8-b65a-e2e52ea77568';
const INTERNAL_RECIPIENT = '5e4acb47-c63b-4f3f-a90d-aedcedbda8eb';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/platform-tools', platformToolsRouter);
  return app;
}

function request(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = require('http').request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'x-service-auth': TOKEN,
            'content-type': 'application/json',
            ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res: NodeJS.ReadableStream & { statusCode: number }) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c; });
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
          });
        },
      );
      req.on('error', (e: Error) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PLATFORM_CALLBACK_TOKEN = TOKEN;
  // The pair the runtime actually sends, both directions.
  mockGetMap.mockResolvedValue(new Map([
    [RUNTIME_SENDER, INTERNAL_SENDER],
    [RUNTIME_RECIPIENT, INTERNAL_RECIPIENT],
  ]));
});

describe('POST /send-agent-message translates BOTH ids', () => {
  it('checks sender, recipient, and writes the row in the internal space', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })          // sender check
      .mockResolvedValueOnce({ rows: [{ pending: '0' }], rowCount: 1 })           // backlog
      .mockResolvedValueOnce({ rows: [{ id: 'recipient-1' }], rowCount: 1 })      // recipient
      .mockResolvedValueOnce({ rows: [{ id: 'msg-1' }], rowCount: 1 });           // insert

    const res = await request('POST', '/api/internal/platform-tools/send-agent-message', {
      tenantId: TENANT,
      senderAgentId: RUNTIME_SENDER,
      recipientAgentId: RUNTIME_RECIPIENT,
      content: 'the delegated answer',
    });

    expect(res.status).toBe(201);

    // The sender check is the one that produced the live 403.
    const senderCall = mockPoolQuery.mock.calls.find((c) => /FROM internal_agents/.test(c[0]));
    expect(senderCall?.[1]).toEqual([INTERNAL_SENDER, TENANT]);

    // The recipient would have missed identically; the 403 just fired first.
    const insertCall = mockPoolQuery.mock.calls.find((c) => /INSERT INTO agent_messages/.test(c[0]));
    expect(insertCall?.[1]?.[1]).toBe(INTERNAL_SENDER);
    expect(insertCall?.[1]?.[2]).toBe(INTERNAL_RECIPIENT);
  });

  it('leaves internal ids untouched, so control-plane callers still work', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pending: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'recipient-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'msg-2' }], rowCount: 1 });

    const res = await request('POST', '/api/internal/platform-tools/send-agent-message', {
      tenantId: TENANT,
      senderAgentId: INTERNAL_SENDER,
      recipientAgentId: INTERNAL_RECIPIENT,
      content: 'hello',
    });

    expect(res.status).toBe(201);
    const senderCall = mockPoolQuery.mock.calls.find((c) => /FROM internal_agents/.test(c[0]));
    expect(senderCall?.[1]).toEqual([INTERNAL_SENDER, TENANT]);
  });

  it('still sends when the map is unavailable, rather than failing the message', async () => {
    mockGetMap.mockRejectedValue(new Error('runtime unreachable'));
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pending: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'recipient-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'msg-3' }], rowCount: 1 });

    const res = await request('POST', '/api/internal/platform-tools/send-agent-message', {
      tenantId: TENANT,
      senderAgentId: INTERNAL_SENDER,
      recipientAgentId: INTERNAL_RECIPIENT,
      content: 'hello',
    });

    // Degrades to the pre-existing behaviour; it must not 500.
    expect(res.status).toBe(201);
  });
});

describe('GET /agent-messages reads in the same space it writes', () => {
  it('translates the recipient, so a delivered message is actually readable', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(
      'GET',
      `/api/internal/platform-tools/agent-messages?tenantId=${TENANT}&agentId=${RUNTIME_SENDER}&limit=20`,
    );

    expect(res.status).toBe(200);
    // The whole point: had this stayed the runtime id, recipient_id would never
    // match and the agent would be told it has no mail while its mail sits in
    // the table.
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([TENANT, INTERNAL_SENDER, 20]);
  });
});

describe('GET /find-teammates excludes the caller', () => {
  it('translates the caller id, so an agent does not find itself', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });  // internal_agents search (agents only)

    const res = await request(
      'GET',
      `/api/internal/platform-tools/find-teammates?tenantId=${TENANT}&agentId=${RUNTIME_SENDER}&query=review`,
    );

    expect(res.status).toBe(200);
    // `id != $2` only excludes anything when asked in the space the rows are
    // keyed in; with the runtime id it excluded nothing and the agent appeared
    // in its own teammate list.
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([TENANT, INTERNAL_SENDER, '%review%']);
  });
});

describe('POST /notify-team writes the notice in the internal space', () => {
  it('translates the agent id before the owner lookup, the thread, and the message', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })          // agent exists
      .mockResolvedValueOnce({ rows: [{ actor_id: 'acct-owner' }], rowCount: 1 }); // creation audit row
    mockFindOrCreateThread.mockResolvedValue({ id: 'thread-1' });
    mockAppendMessage.mockResolvedValue({ id: 'msg-1' });

    const res = await request('POST', '/api/internal/platform-tools/notify-team', {
      tenantId: TENANT, agentId: RUNTIME_SENDER, message: 'Enrichment finished.',
    });

    expect(res.status).toBe(200);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([INTERNAL_SENDER, TENANT]);
    expect(mockPoolQuery.mock.calls[1][1]).toEqual([TENANT, INTERNAL_SENDER]);
    expect(mockFindOrCreateThread).toHaveBeenCalledWith(
      TENANT, 'acct-owner', INTERNAL_SENDER, 'web', `notice:${INTERNAL_SENDER}`,
    );
    expect(mockAppendMessage).toHaveBeenCalledWith(TENANT, 'thread-1', 'assistant', 'Enrichment finished.', INTERNAL_SENDER);
  });

  it('refuses an agent the workspace does not have, before any write', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // agent exists?

    const res = await request('POST', '/api/internal/platform-tools/notify-team', {
      tenantId: TENANT, agentId: '99999999-9999-4999-8999-999999999999', message: 'hello',
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('unknown_agent');
    expect(mockFindOrCreateThread).not.toHaveBeenCalled();
    expect(mockAppendMessage).not.toHaveBeenCalled();
  });
});

// ── Migration 132 (byok_cutover_drop) ────────────────────────────────────
//
// claude_code_proxy_keys was DROPped CASCADE and its keys moved to the
// developer-proxy service. Postgres resolves every branch of a UNION before
// running any of it, so a dead branch does not degrade the query — it throws
// 'relation ... does not exist' and takes the whole statement down.
//
// Such a branch makes EVERY send-agent-message answer 500, and it can hide
// behind the id-space 403 above, which answers first. These assertions exist
// so the branch cannot be reintroduced by a copy-paste from an older revision
// of this file.

describe('queries do not reference the dropped claude_code_proxy_keys table', () => {
  it('send-agent-message resolves a recipient without it', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pending: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'recipient-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'msg-4' }], rowCount: 1 });

    await request('POST', '/api/internal/platform-tools/send-agent-message', {
      tenantId: TENANT,
      senderAgentId: INTERNAL_SENDER,
      recipientAgentId: INTERNAL_RECIPIENT,
      content: 'hello',
    });

    const sql = mockPoolQuery.mock.calls.map((c) => String(c[0])).join('\n');
    expect(sql).not.toMatch(/claude_code_proxy_keys/);
    // Nor mcp_tokens: a connected tool is not an addressable recipient, so no
    // recipient lookup may resolve one.
    expect(sql).not.toMatch(/mcp_tokens/);
  });

  it('cc-routing answers without it', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ key_id: 'k1' }], rowCount: 1 });

    const res = await request(
      'GET',
      `/api/internal/platform-tools/cc-routing?tenantId=${TENANT}&platformAgentId=${INTERNAL_RECIPIENT}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ isClaudeCode: true, keyIds: ['k1'] });
    expect(String(mockPoolQuery.mock.calls[0][0])).not.toMatch(/claude_code_proxy_keys/);
  });
});
