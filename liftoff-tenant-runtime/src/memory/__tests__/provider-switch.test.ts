import { jest } from '@jest/globals';

const mockClient = { query: jest.fn(), release: jest.fn() };
const mockPool = { connect: jest.fn().mockResolvedValue(mockClient) };
jest.mock('../../infrastructure/database', () => ({ pool: mockPool }));

jest.mock('../embedding', () => ({
  getProviderNativeDim: (p: string) => ({ openai: 1536, google: 768, voyage: 1024 } as any)[p],
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Mock GoogleAuth so the kick doesn't try to read credentials.
jest.mock('google-auth-library', () => ({
  GoogleAuth: class {
    async getClient() {
      return { getAccessToken: async () => ({ token: 'fake-token' }) };
    }
  },
}));

(global as any).fetch = jest.fn();

import { switchEmbeddingProvider, ProviderSwitchError } from '../provider-switch';

beforeEach(() => {
  mockClient.query.mockReset();
  ((global as any).fetch as jest.Mock).mockReset();
  process.env.GCP_PROJECT_ID = 'tenant-t1-dev';
  process.env.GCP_LOCATION = 'us-west1';
});

it('rejects unsupported providers', async () => {
  await expect(switchEmbeddingProvider('cohere' as any)).rejects.toBeInstanceOf(ProviderSwitchError);
});

it('runs DROP INDEX → NULL → ALTER → CREATE INDEX for every table', async () => {
  mockClient.query.mockResolvedValue({});
  ((global as any).fetch as jest.Mock).mockResolvedValue({
    ok: true, json: async () => ({ name: 'projects/.../executions/exec-xyz' }),
  });

  const r = await switchEmbeddingProvider('openai');

  expect(r.newProvider).toBe('openai');
  expect(r.newDim).toBe(1536);
  expect(r.jobExecutionName).toBe('projects/.../executions/exec-xyz');

  const sqls = mockClient.query.mock.calls.map(c => c[0]).filter((s): s is string => typeof s === 'string');

  expect(sqls).toEqual(expect.arrayContaining([
    'BEGIN',
    expect.stringMatching(/DROP INDEX IF EXISTS idx_memories_embedding/),
    expect.stringMatching(/UPDATE memories SET embedding = NULL, embedding_model = NULL/),
    expect.stringMatching(/ALTER TABLE memories ALTER COLUMN embedding TYPE vector\(1536\)/),
    expect.stringMatching(/CREATE INDEX idx_memories_embedding.*vector_cosine_ops/),
    expect.stringMatching(/DROP INDEX IF EXISTS idx_agent_skills_hnsw/),
    expect.stringMatching(/ALTER TABLE agent_skills ALTER COLUMN embedding TYPE vector\(1536\)/),
    expect.stringMatching(/CREATE INDEX idx_agent_skills_hnsw.*WHERE status = 'active'/),
    expect.stringMatching(/ALTER TABLE connector_content ALTER COLUMN embedding TYPE vector\(1536\)/),
    'TRUNCATE embedding_cache',
    'COMMIT',
  ]));
});

it('UPDATEs connector_content without embedding_model column reference', async () => {
  mockClient.query.mockResolvedValue({});
  ((global as any).fetch as jest.Mock).mockResolvedValue({
    ok: true, json: async () => ({ name: 'exec' }),
  });

  await switchEmbeddingProvider('google');

  const sqls = mockClient.query.mock.calls.map(c => c[0]).filter((s): s is string => typeof s === 'string');
  const connectorUpdate = sqls.find(s => s.includes('UPDATE connector_content'));
  expect(connectorUpdate).toBeDefined();
  expect(connectorUpdate!).not.toMatch(/embedding_model/);
});

it('rolls back on ALTER failure and throws ProviderSwitchError', async () => {
  // Default-resolve any trailing query (ROLLBACK happens in catch).
  mockClient.query.mockResolvedValue({});
  mockClient.query
    .mockResolvedValueOnce({})       // BEGIN
    .mockResolvedValueOnce({})       // DROP INDEX
    .mockResolvedValueOnce({})       // UPDATE NULL
    .mockRejectedValueOnce(new Error('lock timeout'));  // ALTER

  await expect(switchEmbeddingProvider('openai')).rejects.toBeInstanceOf(ProviderSwitchError);
  const sqls = mockClient.query.mock.calls.map(c => c[0]).filter((s): s is string => typeof s === 'string');
  expect(sqls).toContain('ROLLBACK');
});

it('does not throw when kick fails — returns result without jobExecutionName', async () => {
  mockClient.query.mockResolvedValue({});
  ((global as any).fetch as jest.Mock).mockResolvedValue({
    ok: false, status: 500, text: async () => 'boom',
  });

  const r = await switchEmbeddingProvider('voyage');
  expect(r.newDim).toBe(1024);
  expect(r.jobExecutionName).toBeUndefined();
});
