/**
 * runChatTurnStream body contract — the client builds the TR request body by
 * EXPLICIT field copy, so a param that chat-service passes but the builder
 * doesn't copy is silently dropped on the wire (conditional spreads bypass
 * TS excess-property checks). Dropping senderAccountId, for example, means TR
 * never sees the sender and recall_conversations can never register. These
 * tests pin the wire contract for the recall fields.
 */

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getIdTokenClient: jest.fn().mockRejectedValue(new Error('no metadata server')),
  })),
}));

jest.mock('../../tenants/repository', () => ({
  TenantRepository: jest.fn().mockImplementation(() => ({
    findById: jest.fn().mockResolvedValue(null),
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { tenantRuntimeClient } from '../tenant-runtime-client';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SENDER = '44444444-4444-4444-8444-444444444444';
const TURN = '55555555-5555-4555-8555-555555555555';

function baseParams() {
  return {
    agentId: '22222222-2222-4222-8222-222222222222',
    threadId: '33333333-3333-4333-8333-333333333333',
    invocationId: 'inv-1',
    userMessage: 'hello',
    channelHint: 'web' as const,
    userId: 'user-1',
    userDisplayName: 'Test',
    userRole: 'member',
    turnId: TURN,
  };
}

/** SSE response whose stream ends immediately — we only care about the request. */
function emptySseResponse() {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => ({ done: true, value: undefined }),
        releaseLock: () => undefined,
      }),
    },
  };
}

async function drain(gen: AsyncGenerator<unknown>) {
  for await (const _ of gen) {
    void _;
  }
}

function sentBody(): Record<string, unknown> {
  expect(mockFetch).toHaveBeenCalledTimes(1);
  return JSON.parse(mockFetch.mock.calls[0][1].body as string);
}

describe('runChatTurnStream wire body (recall attribution contract)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(emptySseResponse());
  });

  it('copies senderAccountId and turnId into the TR request body', async () => {
    await drain(
      tenantRuntimeClient.runChatTurnStream(TENANT_ID, {
        ...baseParams(),
        senderAccountId: SENDER,
      }),
    );
    const body = sentBody();
    expect(body.senderAccountId).toBe(SENDER);
    expect(body.turnId).toBe(TURN);
  });

  it('omits senderAccountId entirely for guest turns (no null/undefined leak)', async () => {
    await drain(tenantRuntimeClient.runChatTurnStream(TENANT_ID, baseParams()));
    const body = sentBody();
    expect('senderAccountId' in body).toBe(false);
    expect(body.turnId).toBe(TURN);
  });
});
