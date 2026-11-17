// Tests for platform-backend's embedding bootstrap:
//   - initEmbeddingClient registers configured providers from env
//   - onUsage callback writes a full-attribution row to llm_usage_log
//   - Failure event writes success=false with error_message, input_tokens=0

const mockInit = jest.fn();
const mockOnUsage = jest.fn();

class FakeOpenAIProvider {
  static lastClient: unknown = null;
  constructor(client: unknown) { FakeOpenAIProvider.lastClient = client; }
}
class FakeGoogleProvider {
  static lastConfig: unknown = null;
  constructor(config: unknown) { FakeGoogleProvider.lastConfig = config; }
}
class FakeVoyageProvider {
  static lastKey: string | null = null;
  constructor(key: string) { FakeVoyageProvider.lastKey = key; }
}

jest.mock('@liftoffos/embedding', () => ({
  embeddingClient: {
    init: (...args: unknown[]) => mockInit(...args),
    onUsage: (cb: unknown) => mockOnUsage(cb),
  },
  OpenAIEmbeddingProvider: FakeOpenAIProvider,
  GoogleEmbeddingProvider: FakeGoogleProvider,
  VoyageEmbeddingProvider: FakeVoyageProvider,
}));

jest.mock('openai', () => ({ __esModule: true, default: jest.fn().mockImplementation(() => ({ tag: 'openai-client' })) }));

const mockGetOpenAIKey = jest.fn();
jest.mock('../../infrastructure/secrets', () => ({
  getOpenAIApiKeyForGroup: (...args: unknown[]) => mockGetOpenAIKey(...args),
}));

const mockPool = { query: jest.fn() };
jest.mock('../../infrastructure/database', () => {
  const __db: any = {
  getPool: () => mockPool,
};
  const __mkc = () => (__db.getPool ? __db.getPool() : (__db.pool || { query: jest.fn() }));
  __db.withTenantScope = (_t: string, fn: (c: any) => any) => fn(__mkc());
  __db.withAdminScope = (_c: any, fn: (c: any) => any) => fn(__mkc());
  return __db;
});

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { initEmbeddingClient } from '../init';

const ORIG_ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  mockPool.query.mockResolvedValue({});
  // Wipe env vars the test cares about so jest setup doesn't leak in.
  process.env = { ...ORIG_ENV };
  delete process.env.GCP_PROJECT_ID;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GCP_LOCATION;
  delete process.env.VERTEX_LOCATION;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.EMBEDDING_PROVIDER;
});
afterAll(() => { process.env = ORIG_ENV; });

describe('initEmbeddingClient', () => {
  it('registers openai/google/voyage based on env presence', async () => {
    process.env.GCP_PROJECT_ID = 'proj-1';
    process.env.GCP_LOCATION = 'us-west1';
    process.env.VOYAGE_API_KEY = 'sk-voyage';
    process.env.EMBEDDING_PROVIDER = 'google';
    mockGetOpenAIKey.mockResolvedValueOnce('sk-openai');

    await initEmbeddingClient();

    expect(mockInit).toHaveBeenCalledTimes(1);
    const config = mockInit.mock.calls[0][0];
    expect(config.providers.openai).toBeInstanceOf(FakeOpenAIProvider);
    expect(config.providers.google).toBeInstanceOf(FakeGoogleProvider);
    expect(config.providers.voyage).toBeInstanceOf(FakeVoyageProvider);
    expect(config.defaultProvider).toBe('google');
    expect(config.defaultPreference).toEqual(['google', 'voyage', 'openai']);
    expect(FakeGoogleProvider.lastConfig).toEqual({ projectId: 'proj-1', location: 'us-west1' });
    expect(FakeVoyageProvider.lastKey).toBe('sk-voyage');
  });

  it('skips providers when env not set and defers default to init', async () => {
    delete process.env.GCP_PROJECT_ID;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.VOYAGE_API_KEY;
    mockGetOpenAIKey.mockResolvedValueOnce(null);

    await initEmbeddingClient();

    const config = mockInit.mock.calls[0][0];
    expect(config.providers.openai).toBeUndefined();
    expect(config.providers.google).toBeUndefined();
    expect(config.providers.voyage).toBeUndefined();
    // No EMBEDDING_PROVIDER set → undefined; init's preference resolves
    expect(config.defaultProvider).toBeUndefined();
  });

  it('persists a successful onUsage event to llm_usage_log with all attribution', async () => {
    process.env.GCP_PROJECT_ID = 'p';
    mockGetOpenAIKey.mockResolvedValueOnce(null);
    await initEmbeddingClient();

    const callback = mockOnUsage.mock.calls[0][0] as (e: Record<string, unknown>) => Promise<void>;
    const ts = new Date('2026-05-23T12:00:00Z');
    await callback({
      timestamp: ts,
      provider: 'google',
      model: 'gemini-embedding-001',
      inputTokens: 42,
      success: true,
      context: {
        tenantId: 't-1', agentId: 'a-1', sessionId: 's-1',
        threadId: 'th-1', invocationId: 'iv-1', itemId: 'item-1',
        purpose: 'knowledge_embedding',
      },
    });

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mockPool.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO llm_usage_log/);
    expect(sql).toMatch(/item_id/);
    expect(params).toEqual([
      ts, 'google', 'gemini-embedding-001', 42,
      true, null,
      't-1', 'knowledge_embedding', 'a-1', 's-1',
      'th-1', 'iv-1', 'item-1',
    ]);
  });

  it('persists a failure event with success=false, error_message, input_tokens=0', async () => {
    process.env.GCP_PROJECT_ID = 'p';
    mockGetOpenAIKey.mockResolvedValueOnce(null);
    await initEmbeddingClient();

    const callback = mockOnUsage.mock.calls[0][0] as (e: Record<string, unknown>) => Promise<void>;
    await callback({
      timestamp: new Date(),
      provider: 'google',
      model: 'gemini-embedding-001',
      inputTokens: 0,
      success: false,
      error: 'Vertex AI embedding HTTP 503: quota exceeded',
      context: { tenantId: 't', purpose: 'knowledge_embedding_query', agentId: 'a' },
    });

    const params = mockPool.query.mock.calls[0][1] as unknown[];
    expect(params[4]).toBe(false); // success
    expect(params[5]).toBe('Vertex AI embedding HTTP 503: quota exceeded'); // error_message
    expect(params[3]).toBe(0); // input_tokens
  });

  it('swallows DB write errors so embed calls never fail because of telemetry', async () => {
    process.env.GCP_PROJECT_ID = 'p';
    mockGetOpenAIKey.mockResolvedValueOnce(null);
    mockPool.query.mockRejectedValueOnce(new Error('db down'));
    await initEmbeddingClient();

    const callback = mockOnUsage.mock.calls[0][0] as (e: Record<string, unknown>) => Promise<void>;
    await expect(callback({
      timestamp: new Date(),
      provider: 'google',
      model: 'g',
      inputTokens: 1,
      success: true,
      context: { tenantId: 't', purpose: 'p' },
    })).resolves.toBeUndefined();
  });
});
