// The benchmark has to be right before its numbers mean anything.
//
// It runs against real providers and costs real money, so it is not something to
// debug by running it. These tests drive it through a scripted adapter instead
// and pin the properties a wrong baseline would come from: an unstable prompt,
// a conversation that is not append-only, turn 1 counted as a measurement, and
// "could not measure" reported as "measured zero".

import type {
  InvocationEvent,
  InvocationInput,
  PlatformMessage,
  VendorSdkAdapter,
} from '../../adapter';
import {
  BENCHMARK_PAIRS,
  BENCHMARK_TURNS,
  approxTokens,
  benchmarkEngine,
  benchmarkSystemPrompt,
  computeCacheReadRatio,
} from '../benchmark';
import { VENDORS, PROVIDER_FAMILY_EXCLUSIONS } from '../../adapter/vendors';
import { RESOLVABLE_EXECUTION_ENGINE_IDS } from '../../adapter/types';

/** An adapter that records what it was asked and answers with the usage a
 *  caching provider would report: turn 1 all fresh, later turns mostly cached. */
function scriptedAdapter(opts: {
  usagePerTurn?: Array<{ inputTokens: number; cachedTokens: number; outputTokens?: number }>;
  throwOnTurn?: number;
} = {}): { adapter: VendorSdkAdapter; calls: InvocationInput[] } {
  const calls: InvocationInput[] = [];
  const adapter = {
    registerToolCatalog: async () => undefined,
    invoke(input: InvocationInput): AsyncIterable<InvocationEvent> {
      calls.push(input);
      const turn = calls.length;
      const usage = opts.usagePerTurn?.[turn - 1]
        ?? { inputTokens: turn === 1 ? 1000 : 100, cachedTokens: turn === 1 ? 0 : 900 };
      return (async function* () {
        if (opts.throwOnTurn === turn) throw new Error(`vendor said no on turn ${turn}`);
        yield { type: 'assistant_delta', text: `answer ${turn}` } as InvocationEvent;
        yield {
          type: 'usage',
          usage: {
            inputTokens: usage.inputTokens,
            cachedTokens: usage.cachedTokens,
            outputTokens: usage.outputTokens ?? 3,
          },
        } as InvocationEvent;
      })();
    },
  } as unknown as VendorSdkAdapter;
  return { adapter, calls };
}

const OPTS = { model: 'test-model', provider: 'anthropic' as const };

describe('the prompt', () => {
  it('is byte-identical every time it is built', () => {
    // Half of what the benchmark measures IS this. A date or an id in here and
    // every engine reports zero for a reason that has nothing to do with the
    // provider.
    expect(benchmarkSystemPrompt()).toBe(benchmarkSystemPrompt());
  });

  it('clears the highest vendor caching floor', () => {
    // Gemini's implicit caching needs 4,096 tokens on the 3.x models, the
    // highest of the three floors. Under it, a zero would be a fact about this
    // string rather than about the provider.
    expect(approxTokens(benchmarkSystemPrompt())).toBeGreaterThan(4096);
  });
});

describe('benchmarkEngine', () => {
  it('sends the same system prompt on every turn', async () => {
    const { adapter, calls } = scriptedAdapter();

    await benchmarkEngine('claude-agent-sdk', adapter, OPTS);

    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.systemPrompt)).size).toBe(1);
  });

  it('builds an append-only conversation', async () => {
    // The property a cache rewards, and the one a benchmark can accidentally
    // break by rebuilding history per turn. Each turn must re-send the previous
    // turn's messages unchanged and add to them.
    const { adapter, calls } = scriptedAdapter();

    await benchmarkEngine('claude-agent-sdk', adapter, OPTS);

    const texts = (msgs: PlatformMessage[]): string[] =>
      msgs.map((m) => `${m.role}:${JSON.stringify(m.content)}`);

    expect(texts(calls[1].messages).slice(0, calls[0].messages.length))
      .toEqual(texts(calls[0].messages));
    expect(texts(calls[2].messages).slice(0, calls[1].messages.length))
      .toEqual(texts(calls[1].messages));
    // user, (assistant, user), (assistant, user)
    expect(calls.map((c) => c.messages.length)).toEqual([1, 3, 5]);
  });

  it('carries the assistant turn back into the history', async () => {
    // Without it turn 3 re-sends turn 2's prefix with a hole in it, which is a
    // different prefix, which caches nothing.
    const { adapter, calls } = scriptedAdapter();

    await benchmarkEngine('claude-agent-sdk', adapter, OPTS);

    expect(calls[1].messages[1].role).toBe('assistant');
    expect(JSON.stringify(calls[1].messages[1].content)).toContain('answer 1');
  });

  it('reports the provider the engine was driven as, and drives it as that provider', async () => {
    const { adapter, calls } = scriptedAdapter();

    const m = await benchmarkEngine('opencode', adapter, { ...OPTS, provider: 'xai' });

    // The pair under measurement, not one provider per engine: opencode is
    // measured once from xAI's account and once from OpenRouter's, and the
    // provider on the measurement says which this was.
    expect(m.provider).toBe('xai');
    expect(calls.every((c) => c.provider === 'xai')).toBe(true);
    expect(calls[0].agentId).toBe('cache-benchmark-opencode-xai');
  });

  it('excludes turn 1 from the ratio, because turn 1 is the write', async () => {
    const { adapter } = scriptedAdapter({
      usagePerTurn: [
        { inputTokens: 1000, cachedTokens: 0 },
        { inputTokens: 100, cachedTokens: 900 },
        { inputTokens: 100, cachedTokens: 900 },
      ],
    });

    const m = await benchmarkEngine('claude-agent-sdk', adapter, OPTS);

    // 1800 cached / 2000 total across turns 2 and 3. Including turn 1 would
    // report 60% and make a three-turn run look worse than a longer one for a
    // reason nobody could act on.
    expect(m.cacheReadRatio).toBeCloseTo(0.9, 5);
  });

  it('sums several usage events within one turn', async () => {
    // An adapter emits one per model round. Last-wins would flatter any engine
    // that retried.
    const calls: InvocationInput[] = [];
    const adapter = {
      registerToolCatalog: async () => undefined,
      invoke(input: InvocationInput): AsyncIterable<InvocationEvent> {
        calls.push(input);
        return (async function* () {
          yield { type: 'usage', usage: { inputTokens: 50, cachedTokens: 100, outputTokens: 1 } } as InvocationEvent;
          yield { type: 'usage', usage: { inputTokens: 50, cachedTokens: 100, outputTokens: 1 } } as InvocationEvent;
        })();
      },
    } as unknown as VendorSdkAdapter;

    const m = await benchmarkEngine('claude-agent-sdk', adapter, OPTS);

    expect(m.turns[0]).toMatchObject({ turn: 1, inputTokens: 100, cachedTokens: 200, outputTokens: 2 });
  });

  it('stops at a failed turn and says which one', async () => {
    // Every later turn's prefix depends on the one before it, so carrying on
    // would record numbers for a conversation that never happened.
    const { adapter } = scriptedAdapter({ throwOnTurn: 2 });

    const m = await benchmarkEngine('claude-agent-sdk', adapter, OPTS);

    expect(m.turns).toHaveLength(2);
    expect(m.turns[1].error).toContain('vendor said no on turn 2');
    expect(m.error).toContain('turn 2');
  });
});

describe('computeCacheReadRatio', () => {
  it('is null when nothing was measured, not zero', () => {
    // The distinction the whole baseline rests on. Zero means "measured, this
    // provider did not cache"; null means "we do not know". Reporting the
    // second as the first invents a finding.
    expect(computeCacheReadRatio([], 'anthropic')).toBeNull();
    expect(computeCacheReadRatio([{ turn: 1, inputTokens: 900, cachedTokens: 0, outputTokens: 1 }], 'anthropic')).toBeNull();
    expect(computeCacheReadRatio([
      { turn: 1, inputTokens: 900, cachedTokens: 0, outputTokens: 1 },
      { turn: 2, inputTokens: 0, cachedTokens: 0, outputTokens: 0, error: 'boom' },
    ], 'anthropic')).toBeNull();
  });

  it('is zero when the provider genuinely cached nothing', () => {
    expect(computeCacheReadRatio([
      { turn: 1, inputTokens: 900, cachedTokens: 0, outputTokens: 1 },
      { turn: 2, inputTokens: 950, cachedTokens: 0, outputTokens: 1 },
    ], 'openai')).toBe(0);
  });

  it('reads fresh input by the provider\'s own accounting, so the same re-read scores the same', () => {
    // Anthropic: input EXCLUDES the cached portion. 16,128 re-read, 67 fresh.
    expect(computeCacheReadRatio([
      { turn: 1, inputTokens: 16195, cachedTokens: 0, outputTokens: 1 },
      { turn: 2, inputTokens: 67, cachedTokens: 16128, outputTokens: 1 },
    ], 'anthropic')).toBeCloseTo(16128 / 16195, 3);
    // The OpenAI wire (and Gemini, Codex): the prompt count INCLUDES the cached
    // portion. The same 16,128 re-read of a 16,195 prompt.
    expect(computeCacheReadRatio([
      { turn: 1, inputTokens: 16195, cachedTokens: 0, outputTokens: 1 },
      { turn: 2, inputTokens: 16195, cachedTokens: 16128, outputTokens: 1 },
    ], 'xai')).toBeCloseTo(16128 / 16195, 3);
  });
});

describe('coverage', () => {
  it('measures every engine the platform can run', () => {
    // A benchmark that quietly skips an engine is how an engine stops being
    // kept live-ready. The list is the same shape certification uses.
    expect([...new Set(BENCHMARK_PAIRS.map((p) => p.engine))].sort()).toEqual([...RESOLVABLE_EXECUTION_ENGINE_IDS].sort());
  });

  it('measures every reachable provider FAMILY, with no representative collapse', () => {
    // A cache ratio is a property of the endpoint AND the model: Qwen has cache
    // rules of its own, and a benchmark that ran it as glm would report GLM's
    // numbers as Qwen's. Derived from the vendor record minus the documented
    // exclusions, so a new vendor is a new row by construction.
    const families = Object.keys(VENDORS).filter((v) => !PROVIDER_FAMILY_EXCLUSIONS[v]);
    expect([...new Set(BENCHMARK_PAIRS.map((p) => p.provider))].sort()).toEqual(families.sort());
    expect(BENCHMARK_PAIRS.filter((p) => p.engine === 'opencode').map((p) => p.provider).sort())
      .toEqual(['deepseek', 'glm', 'kimi', 'minimax', 'qwen', 'xai', 'xiaomi']);
  });

  it('documents every exclusion with a reason', () => {
    // Empty today — 'anthropic-vertex' was the only exclusion and the provider
    // is retired, so it is not excluded from the matrix, it is absent from the
    // record. The property is what matters and it still holds: an exclusion
    // must name a real vendor and say why, so the list can never become a
    // silent way to drop a family from the benchmark.
    for (const [provider, reason] of Object.entries(PROVIDER_FAMILY_EXCLUSIONS)) {
      expect(Object.keys(VENDORS)).toContain(provider);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('runs enough turns for a read to be possible', () => {
    // Two turns would measure one read. Three is the smallest number that shows
    // a read holding rather than happening once.
    expect(BENCHMARK_TURNS.length).toBeGreaterThanOrEqual(3);
  });
});
