// Smoke test for the public barrel — guards against accidental removal of
// re-exports during refactors.

import * as pkg from '../src/index';

describe('@liftoffos/embedding barrel exports', () => {
  it('re-exports the runtime surface', () => {
    expect(typeof pkg.EmbeddingClient).toBe('function');
    expect(pkg.embeddingClient).toBeInstanceOf(pkg.EmbeddingClient);
    expect(typeof pkg.OpenAIEmbeddingProvider).toBe('function');
    expect(typeof pkg.GoogleEmbeddingProvider).toBe('function');
    expect(typeof pkg.VoyageEmbeddingProvider).toBe('function');
    expect(typeof pkg.EmbeddingError).toBe('function');
    expect(Array.isArray(pkg.WELL_KNOWN_PROVIDERS)).toBe(true);
    expect(pkg.WELL_KNOWN_PROVIDERS).toEqual(['openai', 'google', 'voyage']);
  });

  it('embeddingClient is the same singleton on every import', async () => {
    const second = await import('../src/index');
    expect(second.embeddingClient).toBe(pkg.embeddingClient);
  });
});
