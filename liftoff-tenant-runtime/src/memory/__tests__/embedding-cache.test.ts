// Embedding cache tests — Change E
//
// Unit-style tests that verify the cache lookup/insert SQL shape and the
// pgvector parser. Full integration with a real Postgres + pgvector
// instance is covered by the memory-improvements-v3 integration suite.

import { createHash } from 'crypto';

jest.mock('../../infrastructure/database', () => ({
  pool: {
    query: jest.fn(),
  },
}));

// ModelConfigService.validateModelConfig was the source of a regression
// where it rewrote the entitlements-derived embedding model to
// whatever cached_model_configs.model_id happened to hold. The override was
// removed; the import is gone from embedding.ts so this mock is no longer
// needed. Kept for the entitlements-client mock below which IS still wired.

jest.mock('../../entitlements-client/service', () => ({
  getEntitlementsClient: () => ({
    getModelForTask: jest.fn().mockResolvedValue(null),
  }),
}));

// We can't mock fetch comfortably; tests focus on the cache-hit path which
// short-circuits before any provider call.
import { pool } from '../../infrastructure/database';

describe('embedding cache', () => {
  beforeEach(() => {
    (pool.query as jest.Mock).mockReset();
    delete process.env.MEM_EMBEDDING_CACHE_DISABLED;
  });

  it('returns cached embedding on hit and updates last_used_at + hit_count', async () => {
    jest.isolateModules(() => {
      // no-op
    });
    const { generateEmbedding } = await import('../embedding');
    // Cached vector MUST match the provider's native dim (768 for
    // google, post-migration-263) — the stale-dim guard added in PR-1
    // treats wrong-dim cache rows as misses, which would force a live
    // API call here.
    const cachedVec = new Array(768).fill(0).map((_, i) => i === 0 ? 0.1 : 0);
    (pool.query as jest.Mock).mockResolvedValueOnce({
      rows: [{ embedding: `[${cachedVec.join(',')}]` }],
      rowCount: 1,
    });

    const result = await generateEmbedding('hello world', { provider: 'google' });
    expect(result.length).toBe(768);
    expect(result[0]).toBe(0.1);

    const call = (pool.query as jest.Mock).mock.calls[0];
    expect(call[0]).toMatch(/UPDATE embedding_cache/);
    expect(call[0]).toMatch(/hit_count = hit_count \+ 1/);
    expect(call[1][0]).toBe(createHash('sha256').update('hello world').digest('hex'));
    // Default Google model: gemini-embedding-001 at native 768d.
    expect(call[1][1]).toBe('gemini-embedding-001');
  });

  it('treats cache lookup failure as a miss (falls through)', async () => {
    const { generateEmbedding } = await import('../embedding');
    // Lookup throws
    (pool.query as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    // Provider call would be invoked, but we can't easily mock fetch here.
    // Instead, mock to throw on the second query attempt (the insert) and
    // assert the fallthrough at least attempted to proceed past cache.
    // We rely on the provider call throwing fetch error.
    await expect(generateEmbedding('xyz', { provider: 'google' })).rejects.toBeDefined();
    // First call was the cache lookup that failed
    expect((pool.query as jest.Mock).mock.calls[0][0]).toMatch(/UPDATE embedding_cache/);
  });

  it('skips cache entirely when MEM_EMBEDDING_CACHE_DISABLED=1', async () => {
    process.env.MEM_EMBEDDING_CACHE_DISABLED = '1';
    jest.resetModules();
    const { generateEmbedding } = await import('../embedding');
    await expect(generateEmbedding('skip-me', { provider: 'google' })).rejects.toBeDefined();
    // No cache-related query should have run
    for (const call of (pool.query as jest.Mock).mock.calls) {
      expect(call[0]).not.toMatch(/embedding_cache/);
    }
  });
});
