import { EmbeddingClient } from '../src/client';
import type {
  EmbeddingProviderClient,
  EmbeddingProviderCapabilities,
  EmbeddingRequest,
  EmbeddingResponse,
  EmbeddingUsageEvent,
  EmbeddingProvider,
} from '../src/types';
import { EmbeddingError } from '../src/types';

const DEFAULT_CAPS: EmbeddingProviderCapabilities = {
  taskType: true, maxBatchSize: 100, matryoshka: true,
};

function makeProvider(
  name: EmbeddingProvider,
  impl: (req: EmbeddingRequest) => Promise<EmbeddingResponse>,
  opts: { capabilities?: EmbeddingProviderCapabilities; defaultModel?: string } = {},
): EmbeddingProviderClient {
  return {
    provider: name,
    capabilities: opts.capabilities ?? DEFAULT_CAPS,
    defaultModel: opts.defaultModel ?? 'test-model',
    embed: impl,
  };
}

describe('EmbeddingClient', () => {
  it('emits success usage event with context and returns response', async () => {
    const client = new EmbeddingClient();
    const events: EmbeddingUsageEvent[] = [];
    client.init({
      providers: {
        google: makeProvider('google', async () => ({
          embeddings: [[0.1, 0.2, 0.3]],
          promptTokens: 17,
          model: 'gemini-embedding-001',
          provider: 'google',
        })),
      },
    });
    client.onUsage(e => { events.push(e); });

    const r = await client.embed({ input: 'hello', context: { tenantId: 't1', purpose: 'test' } });
    expect(r.embeddings).toEqual([[0.1, 0.2, 0.3]]);
    expect(events).toHaveLength(1);
    expect(events[0].success).toBe(true);
    expect(events[0].inputTokens).toBe(17);
    expect(events[0].context?.purpose).toBe('test');
    expect(events[0].model).toBe('gemini-embedding-001');
  });

  it('emits failure usage event and rethrows when provider throws', async () => {
    const client = new EmbeddingClient();
    const events: EmbeddingUsageEvent[] = [];
    client.init({
      providers: {
        google: makeProvider('google', async () => { throw new Error('boom'); }),
      },
    });
    client.onUsage(e => { events.push(e); });

    await expect(client.embed({ input: 'x', model: 'm', context: { tenantId: 't1', purpose: 'p' } }))
      .rejects.toThrow('boom');
    expect(events).toHaveLength(1);
    expect(events[0].success).toBe(false);
    expect(events[0].error).toBe('boom');
    expect(events[0].inputTokens).toBe(0);
    expect(events[0].model).toBe('m');
  });

  it('falls back to provider.defaultModel in failure event when request.model omitted', async () => {
    const client = new EmbeddingClient();
    const events: EmbeddingUsageEvent[] = [];
    client.init({
      providers: {
        google: makeProvider('google', async () => { throw new Error('x'); }, { defaultModel: 'gemini-embedding-001' }),
      },
    });
    client.onUsage(e => { events.push(e); });
    await expect(client.embed({ input: 'q' })).rejects.toThrow();
    expect(events[0].model).toBe('gemini-embedding-001');
  });

  it('throws EmbeddingError(invalid) when requested provider is not configured', async () => {
    const client = new EmbeddingClient();
    const events: EmbeddingUsageEvent[] = [];
    client.init({
      providers: {
        google: makeProvider('google', async () => ({ embeddings: [[]], promptTokens: 0, model: 'g', provider: 'google' })),
      },
    });
    client.onUsage(e => { events.push(e); });

    await expect(client.embed({ input: 'x', provider: 'openai', context: { tenantId: 't' } }))
      .rejects.toMatchObject({ name: 'EmbeddingError', kind: 'invalid', provider: 'openai' });
    expect(events).toHaveLength(1);
    expect(events[0].success).toBe(false);
  });

  it('default provider preference: google > voyage > openai by default', async () => {
    const tests: Array<{ providers: EmbeddingProvider[]; expected: string }> = [
      { providers: ['openai', 'voyage', 'google'], expected: 'google' },
      { providers: ['openai', 'voyage'],           expected: 'voyage' },
      { providers: ['openai'],                     expected: 'openai' },
    ];
    for (const t of tests) {
      const client = new EmbeddingClient();
      const provs: Partial<Record<EmbeddingProvider, EmbeddingProviderClient>> = {};
      for (const p of t.providers) {
        provs[p] = makeProvider(p, async () => ({ embeddings: [[0]], promptTokens: 1, model: p, provider: p }));
      }
      client.init({ providers: provs });
      expect(client.getDefaultProvider()).toBe(t.expected);
    }
  });

  it('respects defaultPreference override', async () => {
    const client = new EmbeddingClient();
    client.init({
      providers: {
        openai: makeProvider('openai', async () => ({ embeddings: [[0]], promptTokens: 0, model: 'o', provider: 'openai' })),
        google: makeProvider('google', async () => ({ embeddings: [[0]], promptTokens: 0, model: 'g', provider: 'google' })),
      },
      defaultPreference: ['openai', 'google'],
    });
    expect(client.getDefaultProvider()).toBe('openai');
  });

  it('throws if init called with empty providers', () => {
    const client = new EmbeddingClient();
    expect(() => client.init({ providers: {} })).toThrow(/at least one provider required/);
  });

  it('throws if defaultProvider not configured', () => {
    const client = new EmbeddingClient();
    expect(() => client.init({
      providers: {
        openai: makeProvider('openai', async () => ({ embeddings: [[0]], promptTokens: 0, model: 'm', provider: 'openai' })),
      },
      defaultProvider: 'google',
    })).toThrow(/defaultProvider "google" not configured/);
  });

  it('embed throws if client not initialized', async () => {
    const client = new EmbeddingClient();
    await expect(client.embed({ input: 'x' })).rejects.toThrow(/not initialized/);
  });

  it('init is idempotent; reset() allows reconfiguration', () => {
    const client = new EmbeddingClient();
    client.init({
      providers: {
        google: makeProvider('google', async () => ({ embeddings: [[0]], promptTokens: 0, model: 'g', provider: 'google' })),
      },
    });
    client.init({
      providers: {
        openai: makeProvider('openai', async () => ({ embeddings: [[0]], promptTokens: 0, model: 'o', provider: 'openai' })),
      },
    });
    expect(client.getDefaultProvider()).toBe('google');
    client.reset();
    client.init({
      providers: {
        openai: makeProvider('openai', async () => ({ embeddings: [[0]], promptTokens: 0, model: 'o', provider: 'openai' })),
      },
    });
    expect(client.getDefaultProvider()).toBe('openai');
  });

  it('swallows usage callback errors', async () => {
    const client = new EmbeddingClient();
    client.init({
      providers: {
        google: makeProvider('google', async () => ({ embeddings: [[0]], promptTokens: 1, model: 'g', provider: 'google' })),
      },
    });
    client.onUsage(() => { throw new Error('callback failed'); });
    await expect(client.embed({ input: 'x', context: { tenantId: 't', purpose: 'p' } }))
      .resolves.toBeDefined();
  });

  it('backstops embedding count mismatch from a misbehaving provider', async () => {
    const client = new EmbeddingClient();
    client.init({
      providers: {
        google: makeProvider('google', async () => ({
          embeddings: [[0.1]], promptTokens: 1, model: 'g', provider: 'google',
        })),
      },
    });
    await expect(client.embed({ input: ['a', 'b'] }))
      .rejects.toBeInstanceOf(EmbeddingError);
  });

  it('capabilitiesOf returns the provider capabilities; undefined for unconfigured', () => {
    const client = new EmbeddingClient();
    const customCaps = { taskType: false, maxBatchSize: 99, matryoshka: false };
    client.init({
      providers: {
        google: makeProvider('google', async () => ({ embeddings: [[0]], promptTokens: 0, model: 'g', provider: 'google' }), { capabilities: customCaps }),
      },
    });
    expect(client.capabilitiesOf('google')).toEqual(customCaps);
    expect(client.capabilitiesOf('voyage')).toBeUndefined();
  });

  it('accepts a string-named third-party provider (open union)', async () => {
    const client = new EmbeddingClient();
    client.init({
      providers: {
        cohere: makeProvider('cohere' as EmbeddingProvider, async () => ({
          embeddings: [[0.42]], promptTokens: 4, model: 'embed-english-v3.0', provider: 'cohere',
        })),
      },
    });
    const r = await client.embed({ input: 'hi', provider: 'cohere' });
    expect(r.embeddings).toEqual([[0.42]]);
    expect(client.getDefaultProvider()).toBe('cohere');
  });
});
