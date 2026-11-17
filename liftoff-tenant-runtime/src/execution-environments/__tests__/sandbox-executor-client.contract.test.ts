import express, { Request, Response } from 'express';
import type { Server } from 'http';
import { SandboxExecutorClient } from '../sandbox-executor-client';
import type { SandboxSession, SandboxToolCallInput, SandboxToolCallResult } from '../types';

jest.mock('../../infrastructure/oidc', () => ({
  mintRuntimeOidc: jest.fn(),
}));

import { mintRuntimeOidc } from '../../infrastructure/oidc';

const mintMock = mintRuntimeOidc as jest.MockedFunction<typeof mintRuntimeOidc>;

interface FakeBackend {
  url: string;
  close: () => Promise<void>;
  /** Last body received by /v2/execute. */
  lastBody: { session: SandboxSession; toolCall: SandboxToolCallInput } | null;
  /** Last Authorization header value received. */
  lastAuth: string | null;
  /** Configure the next response. */
  next: { status: number; body: unknown };
}

async function startFakeBackend(): Promise<FakeBackend> {
  const state: FakeBackend = {
    url: '',
    close: async () => undefined,
    lastBody: null,
    lastAuth: null,
    next: { status: 200, body: { success: true, data: {} } },
  };

  const app = express();
  app.use(express.json());
  app.post('/v2/execute', (req: Request, res: Response) => {
    state.lastBody = req.body as { session: SandboxSession; toolCall: SandboxToolCallInput };
    state.lastAuth = (req.headers.authorization as string | undefined) ?? null;
    res.status(state.next.status).json(state.next.body);
  });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind fake backend');
  state.url = `http://127.0.0.1:${address.port}`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

const SESSION: SandboxSession = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  agentId: '00000000-0000-0000-0000-0000000000a1',
  invocationId: 'inv-1',
  sessionId: 'sess-1',
};
const TOOL_CALL: SandboxToolCallInput = {
  toolName: 'shell_exec',
  input: { command: 'echo hi' },
  id: 'idem-1',
};

describe('SandboxExecutorClient', () => {
  let backend: FakeBackend;
  let client: SandboxExecutorClient;

  beforeEach(async () => {
    backend = await startFakeBackend();
    client = new SandboxExecutorClient(backend.url);
    mintMock.mockReset();
    mintMock.mockResolvedValue('test-oidc-token');
  });

  afterEach(async () => {
    await backend.close();
  });

  it('throws when constructed with empty url', () => {
    expect(() => new SandboxExecutorClient('')).toThrow(/SANDBOX_EXECUTOR_URL/);
  });

  it('forwards session + toolCall in the request body verbatim', async () => {
    backend.next = { status: 200, body: { success: true, data: { exitCode: 0 } } };
    const result = await client.execute(SESSION, TOOL_CALL);
    expect(result).toEqual({ success: true, data: { exitCode: 0 } });
    expect(backend.lastBody).toEqual({ session: SESSION, toolCall: TOOL_CALL });
  });

  it('mints OIDC with the backend URL as the audience', async () => {
    await client.execute(SESSION, TOOL_CALL);
    expect(mintMock).toHaveBeenCalledWith(backend.url);
    expect(backend.lastAuth).toBe('Bearer test-oidc-token');
  });

  it('returns success:false when OIDC mint fails', async () => {
    mintMock.mockResolvedValueOnce(undefined);
    const result = await client.execute(SESSION, TOOL_CALL);
    expect(result.success).toBe(false);
    expect(result.error).toBe('sandbox_executor_oidc_unavailable');
    expect(backend.lastBody).toBeNull();
  });

  it('returns success:false with transport prefix on non-2xx', async () => {
    backend.next = { status: 503, body: { error: 'overloaded' } };
    const result = await client.execute(SESSION, TOOL_CALL);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^sandbox_executor_transport_503:/);
  });

  it('returns success:false on connection failure', async () => {
    await backend.close();
    const result = await client.execute(SESSION, TOOL_CALL);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^sandbox_executor_error:/);
  });

  it('relays success:false from the backend without wrapping it', async () => {
    backend.next = {
      status: 200,
      body: { success: false, data: {}, error: 'phase_not_enabled' } as SandboxToolCallResult,
    };
    const result = await client.execute(SESSION, TOOL_CALL);
    expect(result).toEqual({ success: false, data: {}, error: 'phase_not_enabled' });
  });
});
