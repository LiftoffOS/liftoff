// Tests for the embedding module's native-dim behavior and the detailed
// return shape. The shared @liftoffos/embedding client is mocked so we
// control what the "provider" returns and what dims fly through the
// caller-facing path.

import { jest } from '@jest/globals';

const mockEmbed = jest.fn();
const mockOnUsage = jest.fn();
const mockInit = jest.fn();

jest.mock('@liftoffos/embedding', () => ({
  embeddingClient: { init: mockInit, onUsage: mockOnUsage, embed: mockEmbed },
  OpenAIEmbeddingProvider: class {},
  GoogleEmbeddingProvider: class {},
  VoyageEmbeddingProvider: class {},
  WELL_KNOWN_PROVIDERS: ['openai', 'google', 'voyage'] as const,
}));

const mockGetModelForTask = jest.fn().mockResolvedValue(null);
jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({ getModelForTask: mockGetModelForTask }),
}));

jest.mock('../../infrastructure/database', () => ({
  pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));

jest.mock('../../usage-ledger/service', () => ({
  usageLedgerService: { recordUsage: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('../metrics', () => ({ incCounter: jest.fn() }));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  generateEmbedding,
  generateEmbeddingDetailed,
  generateEmbeddingsBatchDetailed,
  EmbeddingDimMismatchError,
  ACTIVE_DIM,
  getProviderNativeDim,
  getProviderModel,
} from '../embedding';

beforeEach(() => {
  mockEmbed.mockReset();
  // Default response so calls that don't care about specifics don't blow up.
  mockEmbed.mockResolvedValue({
    embeddings: [new Array(768).fill(0.1)],
    model: 'gemini-embedding-001',
    provider: 'google',
    promptTokens: 5,
  });
});

describe('provider native dim configuration', () => {
  it('exposes openai=1536', () => {
    expect(getProviderNativeDim('openai')).toBe(1536);
  });
  it('exposes google=768', () => {
    expect(getProviderNativeDim('google')).toBe(768);
  });
  it('exposes voyage=1024', () => {
    expect(getProviderNativeDim('voyage')).toBe(1024);
  });
  it('throws on unknown provider', () => {
    expect(() => getProviderNativeDim('cohere' as any)).toThrow(/Unknown embedding provider/);
  });
  it('getProviderModel returns the configured model string', () => {
    expect(getProviderModel('google')).toBe('gemini-embedding-001');
    expect(getProviderModel('openai')).toBe('text-embedding-3-small');
    expect(getProviderModel('voyage')).toBe('voyage-4');
  });
  it('ACTIVE_DIM equals the platform-default provider native dim (768, google)', () => {
    expect(ACTIVE_DIM).toBe(768);
  });
});

describe('generateEmbeddingDetailed', () => {
  it('returns {embedding, model, provider, dim} matching the resolved provider', async () => {
    const r = await generateEmbeddingDetailed('hello');
    expect(r.embedding.length).toBe(768);
    expect(r.model).toBe('gemini-embedding-001');
    expect(r.provider).toBe('google');
    expect(r.dim).toBe(768);
  });

  it('requests dimensions=nativeDim from the provider (no truncation)', async () => {
    await generateEmbeddingDetailed('x', { provider: 'openai' });
    // Re-mock with the openai response so the dim check passes.
    mockEmbed.mockResolvedValueOnce({
      embeddings: [new Array(1536).fill(0)],
      model: 'text-embedding-3-small', provider: 'openai', promptTokens: 1,
    });
    expect(mockEmbed).toHaveBeenCalledWith(expect.objectContaining({ dimensions: 1536, provider: 'openai' }));
  });

  it('forwards taskType to the underlying embed call', async () => {
    await generateEmbeddingDetailed('q', { taskType: 'retrieval_query' });
    expect(mockEmbed).toHaveBeenCalledWith(expect.objectContaining({ taskType: 'retrieval_query' }));
  });

  it('omits taskType when MEM_EMBED_TASKTYPE_DISABLED=1', async () => {
    process.env.MEM_EMBED_TASKTYPE_DISABLED = '1';
    try {
      await generateEmbeddingDetailed('q', { taskType: 'retrieval_query' });
      expect(mockEmbed).toHaveBeenCalledWith(expect.objectContaining({ taskType: undefined }));
    } finally {
      delete process.env.MEM_EMBED_TASKTYPE_DISABLED;
    }
  });

  it('throws EmbeddingDimMismatchError when provider returns wrong dim', async () => {
    mockEmbed.mockResolvedValueOnce({
      embeddings: [new Array(999).fill(0)],  // wrong dim
      model: 'gemini-embedding-001', provider: 'google', promptTokens: 1,
    });
    await expect(generateEmbeddingDetailed('x')).rejects.toBeInstanceOf(EmbeddingDimMismatchError);
  });

  it('honors the entitlement provider but always uses the canonical model', async () => {
    // Tenant entitlement picks the provider; the embedding client picks
    // the model. An entitlement row carrying a non-embedding model id
    // must NOT propagate — the canonical EMBEDDING_CONFIGS[provider]
    // wins.
    mockGetModelForTask.mockResolvedValueOnce({ provider: 'openai', model: 'gpt-5.4' });
    mockEmbed.mockResolvedValueOnce({
      embeddings: [new Array(1536).fill(0)],
      model: 'text-embedding-3-small', provider: 'openai', promptTokens: 1,
    });
    const r = await generateEmbeddingDetailed('x', { tenantId: 'tenant-uuid-1' });
    expect(r.provider).toBe('openai');
    expect(r.model).toBe('text-embedding-3-small');
    expect(r.dim).toBe(1536);
    expect(mockEmbed).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'text-embedding-3-small',
    }));
  });
});

describe('generateEmbedding (legacy variant)', () => {
  it('returns just the embedding array', async () => {
    const vec = await generateEmbedding('hello');
    expect(Array.isArray(vec)).toBe(true);
    expect(vec.length).toBe(768);
  });

  it('still throws on dim mismatch (same underlying path)', async () => {
    mockEmbed.mockResolvedValueOnce({
      embeddings: [new Array(999).fill(0)],
      model: 'gemini-embedding-001', provider: 'google', promptTokens: 1,
    });
    await expect(generateEmbedding('x')).rejects.toBeInstanceOf(EmbeddingDimMismatchError);
  });
});

describe('generateEmbeddingsBatchDetailed', () => {
  it('returns {embeddings, model, provider, dim}', async () => {
    mockEmbed.mockResolvedValueOnce({
      embeddings: [new Array(768).fill(0), new Array(768).fill(0.5)],
      model: 'gemini-embedding-001', provider: 'google', promptTokens: 10,
    });
    const r = await generateEmbeddingsBatchDetailed(['a', 'b']);
    expect(r.embeddings).toHaveLength(2);
    expect(r.embeddings[0].length).toBe(768);
    expect(r.dim).toBe(768);
    expect(r.provider).toBe('google');
  });

  it('throws on any wrong-dim vector in the batch response', async () => {
    mockEmbed.mockResolvedValueOnce({
      embeddings: [new Array(768).fill(0), new Array(999).fill(0)],
      model: 'gemini-embedding-001', provider: 'google', promptTokens: 10,
    });
    await expect(generateEmbeddingsBatchDetailed(['a', 'b'])).rejects.toBeInstanceOf(EmbeddingDimMismatchError);
  });

  it('returns empty for empty input without hitting the provider', async () => {
    mockEmbed.mockReset();
    const r = await generateEmbeddingsBatchDetailed([]);
    expect(r.embeddings).toEqual([]);
    expect(mockEmbed).not.toHaveBeenCalled();
  });
});
