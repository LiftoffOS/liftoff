// sync-model-pricing — the load-bearing property is the PRICING-PROVIDER KEY:
// a rate must be written under the key the lookup will build, because a rate
// filed anywhere else is not wrong, it is invisible. computeRowCost and TR's
// getModelPricing both build `provider:model_id` from the provider the run
// executed under, fall through to the static table on a miss, and log nothing
// a person reads.
//
// It used to be the gateway's name for all four open-weight vendors while the
// registry filed three of them by family, and this job bridged the two. After
// migration 450 there is one vocabulary and no bridge: a rate is written under
// the same key its registry row carries.

import { jest } from '@jest/globals';

jest.mock('../../infrastructure/secrets', () => ({ initSecrets: jest.fn(async () => undefined) }));

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  initDatabase: jest.fn(async () => undefined),
  getPool: () => ({ query: (...args: unknown[]) => mockQuery(...args) }),
  closePools: jest.fn(async () => undefined),
}));

const mockLogError = jest.fn();
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: (...args: unknown[]) => mockLogError(...args), debug: jest.fn() },
}));

import {
  main,
  fetchConservativeRate,
  fetchContextWindow,
  fetchInputModalities,
  OPENROUTER_PROVIDERS,
} from '../sync-model-pricing';

function endpointsResponse(endpoints: Array<Record<string, string | undefined>>): Response {
  return {
    ok: true,
    json: async () => ({ data: { endpoints: endpoints.map((pricing) => ({ pricing })) } }),
  } as unknown as Response;
}

/** Endpoints carrying a context_length, which is what the window sync reads. */
function windowResponse(contextLengths: Array<number | undefined>): Response {
  return {
    ok: true,
    json: async () => ({
      data: {
        endpoints: contextLengths.map((context_length) => ({
          pricing: { prompt: '0.000001', completion: '0.000002' },
          context_length,
        })),
      },
    }),
  } as unknown as Response;
}

/** The whole-catalog response, as GET /models serves it. */
function catalogResponse(
  models: Array<{ id: string; input_modalities?: string[] }>,
): Response {
  return {
    ok: true,
    json: async () => ({
      data: models.map((m) => ({
        id: m.id,
        ...(m.input_modalities ? { architecture: { input_modalities: m.input_modalities } } : {}),
      })),
    }),
  } as unknown as Response;
}

/** One fetch stub for a whole main() run: the catalog request and the
 *  per-slug endpoints requests hit the same global.fetch and must not answer
 *  each other's shape. */
function routedFetch(
  catalog: Response | null,
  endpoints: Response,
): typeof fetch {
  return jest.fn(async (url: unknown) => {
    const href = String(url);
    if (href.endsWith('/models')) {
      return catalog ?? ({ ok: false, json: async () => ({}) } as unknown as Response);
    }
    return endpoints;
  }) as unknown as typeof fetch;
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

/** Endpoints whose pricing carries conditional overrides, as OpenRouter serves
 *  them (per-TOKEN strings, condition fields alongside the rate keys). */
function overrideResponse(
  endpoints: Array<{ base: Record<string, string>; overrides?: Array<Record<string, string | number>> }>,
): Response {
  return {
    ok: true,
    json: async () => ({
      data: {
        endpoints: endpoints.map((e) => ({
          pricing: { ...e.base, ...(e.overrides ? { overrides: e.overrides } : {}) },
        })),
      },
    }),
  } as unknown as Response;
}

describe('conditional override merging', () => {
  it('returns null overrides when no endpoint publishes any', async () => {
    global.fetch = (async () =>
      overrideResponse([{ base: { prompt: '0.000001', completion: '0.000002' } }])) as typeof fetch;
    const rate = await fetchConservativeRate('vendor/flat-model');
    expect(rate?.overrides).toBeNull();
  });

  it('converts per-token override rates to per-million and keeps the condition', async () => {
    global.fetch = (async () =>
      overrideResponse([
        {
          base: { prompt: '0.000002', completion: '0.000006' },
          overrides: [{ min_prompt_tokens: 200000, prompt: '0.000004', completion: '0.000012' }],
        },
      ])) as typeof fetch;
    const rate = await fetchConservativeRate('x-ai/grok-4.6');
    expect(rate?.overrides).toEqual([
      { minPromptTokens: 200000, input: 4, output: 12 },
    ]);
  });

  it('takes the MAX per key across endpoints sharing a condition', async () => {
    // Endpoint routing is unknowable, so the band is as conservative as the
    // base rates are. Two endpoints, same threshold, different prices.
    global.fetch = (async () =>
      overrideResponse([
        {
          base: { prompt: '0.000002', completion: '0.000006' },
          overrides: [{ min_prompt_tokens: 200000, prompt: '0.000004', completion: '0.000012' }],
        },
        {
          base: { prompt: '0.000004', completion: '0.000012' },
          overrides: [{ min_prompt_tokens: 200000, prompt: '0.000008', completion: '0.000024' }],
        },
      ])) as typeof fetch;
    const rate = await fetchConservativeRate('x-ai/grok-4.6');
    expect(rate?.overrides).toEqual([{ minPromptTokens: 200000, input: 8, output: 24 }]);
    expect(rate?.input).toBe(4);  // base stays max-of-BASE, not max-of-band
    expect(rate?.output).toBe(12);
  });

  it('keeps distinct thresholds separate and orders them ASCENDING', async () => {
    // Ascending order is load-bearing: the evaluator folds in array order with
    // last-writer-wins, so the highest (most specific) threshold must come last.
    global.fetch = (async () =>
      overrideResponse([
        {
          base: { prompt: '0.00000003', completion: '0.00000013' },
          overrides: [
            { min_prompt_tokens: 256000, prompt: '0.0000002', completion: '0.0000008' },
            { min_prompt_tokens: 32000, prompt: '0.0000001', completion: '0.0000004' },
          ],
        },
      ])) as typeof fetch;
    const rate = await fetchConservativeRate('qwen/qwen3.7-flash');
    expect(rate?.overrides?.map((o) => o.minPromptTokens)).toEqual([32000, 256000]);
  });

  it('does not materialize a rate key the vendor omitted', async () => {
    // An absent key must inherit BASE at evaluation time. Writing it as 0 here
    // would make that dimension free above the threshold.
    global.fetch = (async () =>
      overrideResponse([
        {
          base: { prompt: '0.000002', completion: '0.000006', input_cache_read: '0.0000005' },
          overrides: [{ min_prompt_tokens: 200000, prompt: '0.000004' }],
        },
      ])) as typeof fetch;
    const rate = await fetchConservativeRate('vendor/partial-band');
    expect(rate?.overrides).toEqual([{ minPromptTokens: 200000, input: 4 }]);
    expect(rate?.overrides?.[0]).not.toHaveProperty('output');
    expect(rate?.overrides?.[0]).not.toHaveProperty('cacheRead');
  });

  it('rounds band rates to the 6dp the rate columns carry', async () => {
    // 0.0000001 * 1e6 is 0.09999999999999999 in IEEE754. The flat columns get
    // rounded by NUMERIC(12,6) on write; JSONB does not, so it has to happen
    // here or float noise persists into the stored rate card.
    global.fetch = (async () =>
      overrideResponse([
        {
          base: { prompt: '0.00000003', completion: '0.00000013' },
          overrides: [{ min_prompt_tokens: 32000, prompt: '0.0000001', completion: '0.0000004' }],
        },
      ])) as typeof fetch;
    const rate = await fetchConservativeRate('qwen/qwen3.7-flash');
    expect(rate?.overrides).toEqual([{ minPromptTokens: 32000, input: 0.1, output: 0.4 }]);
    expect(rate?.input).toBe(0.03);
  });

  it('carries UTC-window conditions through unchanged', async () => {
    global.fetch = (async () =>
      overrideResponse([
        {
          base: { prompt: '0.00000028', completion: '0.00000042' },
          overrides: [{ utc_start: 1630, utc_end: 30, prompt: '0.00000056', completion: '0.00000084' }],
        },
      ])) as typeof fetch;
    const rate = await fetchConservativeRate('vendor/time-banded');
    expect(rate?.overrides).toEqual([
      { utcStart: 1630, utcEnd: 30, input: 0.56, output: 0.84 },
    ]);
  });

  it('carries a utc_days condition through, verbatim', async () => {
    // Dropping the day list does not lose a condition, it WIDENS one: a
    // weekday-only band read without it prices Saturday at the weekday rate.
    global.fetch = (async () =>
      overrideResponse([
        {
          base: { prompt: '0.00000028', completion: '0.00000042' },
          overrides: [{
            utc_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
            utc_start: 100,
            utc_end: 400,
            prompt: '0.00000056',
            completion: '0.00000084',
          }],
        },
      ])) as typeof fetch;
    const rate = await fetchConservativeRate('vendor/day-banded');
    expect(rate?.overrides).toEqual([{
      utcDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      utcStart: 100,
      utcEnd: 400,
      input: 0.56,
      output: 0.84,
    }]);
  });

  it('groups by day list too, so two day sets stay separate bands', async () => {
    global.fetch = (async () =>
      overrideResponse([
        {
          base: { prompt: '0.0000001', completion: '0.0000002' },
          overrides: [
            { utc_days: ['saturday', 'sunday'], prompt: '0.0000003' },
            { utc_days: ['monday'], prompt: '0.0000005' },
          ],
        },
      ])) as typeof fetch;
    const rate = await fetchConservativeRate('vendor/two-day-sets');
    expect(rate?.overrides).toEqual([
      { utcDays: ['saturday', 'sunday'], input: 0.3 },
      { utcDays: ['monday'], input: 0.5 },
    ]);
  });
});

describe('a band may only RAISE the conservative base, never lower it', () => {
  // The base is the MAX across endpoints because routing is unknowable, but a
  // band binds only the endpoint that published it. A band kept below base
  // would price a request at the cheapest endpoint's conditional rate when any
  // endpoint could have served it.

  it('drops a band that undercuts the base, leaving the entry gone', async () => {
    global.fetch = (async () =>
      overrideResponse([
        {
          base: { prompt: '0.0000001', completion: '0.0000002' },
          overrides: [{ min_prompt_tokens: 32000, prompt: '0.00000005', completion: '0.0000001' }],
        },
        { base: { prompt: '0.0000004', completion: '0.0000008' } },
      ])) as typeof fetch;
    const rate = await fetchConservativeRate('vendor/undercutting-band');
    expect(rate?.overrides).toBeNull();
    expect(rate?.input).toBe(0.4);
    expect(rate?.output).toBe(0.8);
  });

  it('drops a band exactly EQUAL to base — it is a no-op, not a rate', async () => {
    global.fetch = (async () =>
      overrideResponse([
        {
          base: { prompt: '0.0000004', completion: '0.0000008' },
          overrides: [{ min_prompt_tokens: 32000, prompt: '0.0000004', completion: '0.0000008' }],
        },
      ])) as typeof fetch;
    expect((await fetchConservativeRate('vendor/equal-band'))?.overrides).toBeNull();
  });

  it('keeps only the keys that exceed base within one band', async () => {
    // Half-dropped, not all-or-nothing: the surviving key still raises, and the
    // dropped one inherits base at evaluation time, which is the same figure.
    global.fetch = (async () =>
      overrideResponse([
        {
          base: { prompt: '0.0000001', completion: '0.0000008' },
          overrides: [{ min_prompt_tokens: 32000, prompt: '0.0000004', completion: '0.0000002' }],
        },
        { base: { prompt: '0.0000001', completion: '0.0000008' } },
      ])) as typeof fetch;
    const rate = await fetchConservativeRate('vendor/mixed-band');
    expect(rate?.overrides).toEqual([{ minPromptTokens: 32000, input: 0.4 }]);
    expect(rate?.overrides?.[0]).not.toHaveProperty('output');
  });

  it('leaves the Qwen-shaped bands untouched — the rule is additive', async () => {
    // Every band this estate carried before the rule existed sits ABOVE base.
    // If this assertion ever changes, the fix stopped being additive.
    global.fetch = (async () =>
      overrideResponse([
        {
          base: { prompt: '0.00000003', completion: '0.00000013' },
          overrides: [
            { min_prompt_tokens: 32000, prompt: '0.0000001', completion: '0.0000004' },
            { min_prompt_tokens: 256000, prompt: '0.0000002', completion: '0.0000008' },
          ],
        },
      ])) as typeof fetch;
    const rate = await fetchConservativeRate('qwen/qwen3.7-flash');
    expect(rate?.overrides).toEqual([
      { minPromptTokens: 32000, input: 0.1, output: 0.4 },
      { minPromptTokens: 256000, input: 0.2, output: 0.8 },
    ]);
  });

  it('prices DeepSeek V4.1 Flash flat at the cross-endpoint max', async () => {
    // The live case, and the one that would have shipped a 2.5x under-charge.
    // Only DeepSeek's own endpoint publishes bands; every one of them sits
    // below what the other endpoints charge flat, and the weekend entry
    // carries NO window — so before the rule above, at least one band applied
    // to every request and the 0.375/1.50 base was unreachable.
    // Rates from OpenRouter /models/deepseek/deepseek-v4.1-flash/endpoints,
    // read 2026-09-11.
    global.fetch = (async () =>
      overrideResponse([
        {
          base: { prompt: '0.00000015', completion: '0.0000006', input_cache_read: '0.000000003' },
          overrides: [
            { utc_days: ['saturday', 'sunday'], prompt: '0.00000015', completion: '0.0000006' },
            { utc_days: ['monday', 'friday'], utc_start: 100, utc_end: 400, prompt: '0.0000003', completion: '0.0000012' },
            { utc_days: ['monday', 'friday'], utc_start: 600, utc_end: 1000, prompt: '0.0000003', completion: '0.0000012' },
          ],
        },
        { base: { prompt: '0.0000003', completion: '0.0000012', input_cache_read: '0.00000003' } },
        { base: { prompt: '0.000000375', completion: '0.0000015', input_cache_read: '0.0000000075' } },
      ])) as typeof fetch;
    const rate = await fetchConservativeRate('deepseek/deepseek-v4.1-flash');
    expect(rate?.input).toBe(0.375);
    expect(rate?.output).toBe(1.5);
    expect(rate?.cacheRead).toBe(0.03);
    expect(rate?.overrides).toBeNull();
  });
});

describe('constants', () => {
  it('syncs exactly the vendors whose transport is the gateway', () => {
    // Grok is absent: it executes on xAI's own API, so its rates come from
    // xAI's price list and its rows are keyed 'xai:<native id>'. Syncing it here
    // would write rows under 'openrouter:x-ai/...' that no lookup reads.
    //
    // Derived from the vendor record, so this asserts the ANSWER rather than a
    // copy of it — the copy said 'openrouter' where it meant 'glm'.
    expect([...OPENROUTER_PROVIDERS].sort())
      .toEqual(['deepseek', 'glm', 'kimi', 'minimax', 'qwen', 'xiaomi']);
  });
});

describe('fetchConservativeRate', () => {
  it('takes the MAX across endpoints (fail-safe-toward-business)', async () => {
    global.fetch = jest.fn(async () =>
      endpointsResponse([
        { prompt: '0.000001', completion: '0.000002', input_cache_read: '0.0000001' },
        { prompt: '0.000003', completion: '0.000001', input_cache_read: '0.0000004' },
      ]),
    ) as unknown as typeof fetch;
    const rate = await fetchConservativeRate('qwen/qwen3.8-max');
    // toBeCloseTo: the per-token strings are binary-float-inexact after * 1e6.
    expect(rate).not.toBeNull();
    expect(rate!.input).toBeCloseTo(3, 9);
    expect(rate!.output).toBeCloseTo(2, 9);
    expect(rate!.cacheRead).toBeCloseTo(0.4, 9);
  });

  it('returns null for a slug with no endpoints (nonexistent model)', async () => {
    global.fetch = jest.fn(async () => endpointsResponse([])) as unknown as typeof fetch;
    expect(await fetchConservativeRate('qwen/typo-model')).toBeNull();
  });
});

describe('fetchContextWindow', () => {
  // The endpoints genuinely disagree — z-ai/glm-5.2 serves from 96,890 up to
  // 1,048,576 — so the only question is which way to be wrong. Overstating
  // costs a missed detection, which the provider's own rejection still catches.
  // Understating retires a healthy session on a reading that was never true for
  // the endpoint it actually landed on. So: the largest.
  it('takes the LARGEST window across endpoints', async () => {
    global.fetch = jest.fn(async () =>
      windowResponse([96_890, 262_144, 1_048_576]),
    ) as unknown as typeof fetch;

    expect(await fetchContextWindow('z-ai/glm-5.2')).toBe(1_048_576);
  });

  it('ignores endpoints that publish no window', async () => {
    global.fetch = jest.fn(async () =>
      windowResponse([undefined, 200_000, undefined]),
    ) as unknown as typeof fetch;

    expect(await fetchContextWindow('some/model')).toBe(200_000);
  });

  // Null, not zero: "nobody published one" has to stay distinguishable from a
  // real number, because the runtime acts differently on each.
  it('returns null when no endpoint publishes a window', async () => {
    global.fetch = jest.fn(async () =>
      windowResponse([undefined, undefined]),
    ) as unknown as typeof fetch;

    expect(await fetchContextWindow('some/model')).toBeNull();
  });

  it('returns null for a slug that serves nothing', async () => {
    global.fetch = jest.fn(async () => endpointsResponse([])) as unknown as typeof fetch;

    expect(await fetchContextWindow('qwen/typo-model')).toBeNull();
  });
});

describe('main', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockLogError.mockReset();
  });

  it('writes each rate under the provider its registry row carries', async () => {
    // SELECT returns one row per registry key class.
    mockQuery.mockImplementation(async (sql: string) => {
      // The coverage report also SELECTs from models; keep it separate so this
      // test's rows do not stand in for its answer.
      if (typeof sql === 'string' && sql.includes('context_window IS NULL')) {
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.trim().startsWith('SELECT')) {
        return {
          rows: [
            { provider: 'glm', model_id: 'z-ai/glm-5.2' },
            { provider: 'qwen', model_id: 'qwen/qwen3.8-max' },
            { provider: 'kimi', model_id: 'moonshotai/kimi-k3' },
          ],
        };
      }
      return { rows: [] };
    });
    global.fetch = jest.fn(async () =>
      endpointsResponse([{ prompt: '0.000002', completion: '0.000006', input_cache_read: '0.00000025' }]),
    ) as unknown as typeof fetch;

    await main();

    const inserts = mockQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && (sql as string).includes('INSERT INTO model_pricing'),
    );
    expect(inserts).toHaveLength(3);
    expect(inserts.map(([, p]) => (p as unknown[])[0])).toEqual(['glm', 'qwen', 'kimi']);
    // The model ids ride through untouched — vendor identity lives in the slug.
    expect(inserts.map(([, p]) => (p as unknown[])[1])).toEqual([
      'z-ai/glm-5.2', 'qwen/qwen3.8-max', 'moonshotai/kimi-k3',
    ]);
  });

  it('records the context window onto the models row', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM models') && sql.includes('context_window IS NULL')) {
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.trim().startsWith('SELECT')) {
        return { rows: [{ provider: 'openrouter', model_id: 'z-ai/glm-5.2' }] };
      }
      return { rows: [] };
    });
    global.fetch = jest.fn(async () =>
      windowResponse([96_890, 1_048_576]),
    ) as unknown as typeof fetch;

    await main();

    const updates = mockQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && (sql as string).includes('UPDATE models SET context_window'),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual(['openrouter', 'z-ai/glm-5.2', 1_048_576]);
  });

  // The window is written under the model's own provider key — the same key its
  // rate is written under, which is the point of collapsing the two. It was two
  // keys, and an UPDATE addressed by the wrong one matches no row and reports
  // success.
  it('updates the models row under its own registry provider key', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM models') && sql.includes('context_window IS NULL')) {
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.trim().startsWith('SELECT')) {
        return { rows: [{ provider: 'qwen', model_id: 'qwen/qwen3.8-max' }] };
      }
      return { rows: [] };
    });
    global.fetch = jest.fn(async () => windowResponse([1_000_000])) as unknown as typeof fetch;

    await main();

    const updates = mockQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && (sql as string).includes('UPDATE models SET context_window'),
    );
    expect(updates[0][1]).toEqual(['qwen', 'qwen/qwen3.8-max', 1_000_000]);
  });

  // A slug can publish a context length and no usable price. Losing the window
  // because the price was unusable would put the model back on a provider floor.
  it('still records the window when the rate is unusable', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM models') && sql.includes('context_window IS NULL')) {
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.trim().startsWith('SELECT')) {
        return { rows: [{ provider: 'openrouter', model_id: 'z-ai/glm-5.2' }] };
      }
      return { rows: [] };
    });
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        data: { endpoints: [{ pricing: { prompt: '0', completion: '0' }, context_length: 512_000 }] },
      }),
    })) as unknown as typeof fetch;

    await main();

    const updates = mockQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && (sql as string).includes('UPDATE models SET context_window'),
    );
    const inserts = mockQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && (sql as string).includes('INSERT INTO model_pricing'),
    );
    expect(updates).toHaveLength(1);
    expect(inserts).toHaveLength(0);
  });

  // The one signal that stops this column rotting back to inert. It covers the
  // whole approved catalog, including the direct-API models this job cannot
  // sync — nothing else in the estate would ever notice their window missing.
  it('reports approved models that still have no recorded window', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM models') && sql.includes('context_window IS NULL')) {
        return {
          rows: [
            { provider: 'anthropic', model_id: 'claude-opus-5' },
            { provider: 'openai', model_id: 'gpt-5.4' },
          ],
        };
      }
      return { rows: [] };
    });
    global.fetch = jest.fn(async () => endpointsResponse([])) as unknown as typeof fetch;

    await main();

    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'model_context_window_missing',
        missingWindows: 2,
        models: ['anthropic:claude-opus-5', 'openai:gpt-5.4'],
      }),
      expect.stringContaining('NO recorded context window'),
    );
  });

  it('stays quiet when every approved model has a window', async () => {
    mockQuery.mockImplementation(async () => ({ rows: [] }));
    global.fetch = jest.fn(async () => endpointsResponse([])) as unknown as typeof fetch;

    await main();

    expect(mockLogError).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'model_context_window_missing' }),
      expect.anything(),
    );
  });

  it('logs LOUDLY and skips the insert for a registered slug OpenRouter does not serve', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('context_window IS NULL')) {
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.trim().startsWith('SELECT')) {
        return { rows: [{ provider: 'deepseek', model_id: 'deepseek/no-such-model' }] };
      }
      return { rows: [] };
    });
    global.fetch = jest.fn(async () => endpointsResponse([])) as unknown as typeof fetch;

    await main();

    const inserts = mockQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && (sql as string).includes('INSERT INTO model_pricing'),
    );
    expect(inserts).toHaveLength(0);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ model_id: 'deepseek/no-such-model' }),
      expect.stringContaining('NO OpenRouter endpoint pricing'),
    );
  });
});

describe('fetchInputModalities', () => {
  it('reads architecture.input_modalities per id from one whole-catalog request', async () => {
    global.fetch = jest.fn(async () =>
      catalogResponse([
        { id: 'qwen/qwen3.8-max', input_modalities: ['text', 'image', 'video'] },
        { id: 'z-ai/glm-5.2', input_modalities: ['text'] },
      ]),
    ) as unknown as typeof fetch;

    const map = await fetchInputModalities();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(map?.get('qwen/qwen3.8-max')).toEqual(['text', 'image', 'video']);
    expect(map?.get('z-ai/glm-5.2')).toEqual(['text']);
  });

  it('gives a model with no architecture block an EMPTY list, not a missing one', async () => {
    // Present in the catalog and publishing nothing is a real answer: the
    // vendor serves the model and lists no image input.
    global.fetch = jest.fn(async () =>
      catalogResponse([{ id: 'z-ai/glm-5.2' }]),
    ) as unknown as typeof fetch;

    const map = await fetchInputModalities();
    expect(map?.get('z-ai/glm-5.2')).toEqual([]);
  });

  it('returns null when the request failed — a failed request knows nothing', async () => {
    global.fetch = jest.fn(async () => ({ ok: false } as unknown as Response)) as unknown as typeof fetch;
    expect(await fetchInputModalities()).toBeNull();
  });

  it('returns null when the body is not the catalog shape', async () => {
    global.fetch = jest.fn(async () =>
      ({ ok: true, json: async () => ({ data: { endpoints: [] } }) } as unknown as Response),
    ) as unknown as typeof fetch;
    expect(await fetchInputModalities()).toBeNull();
  });
});

describe('main — modality reconciliation', () => {
  const priced = () =>
    endpointsResponse([{ prompt: '0.000002', completion: '0.000006' }]);

  function registryRow(provider: string, model_id: string): void {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql === 'string' && sql.includes('context_window IS NULL')) return { rows: [] };
      if (typeof sql === 'string' && sql.trim().startsWith('SELECT')) {
        return { rows: [{ provider, model_id }] };
      }
      return { rows: [], rowCount: 1 };
    });
  }

  function capabilityWrites(): Array<[string, unknown[]]> {
    return mockQuery.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && (sql as string).includes('SET capabilities'),
    ) as Array<[string, unknown[]]>;
  }

  it("ADDS vision and video for a model whose catalog entry lists image and video", async () => {
    registryRow('qwen', 'qwen/qwen3.8-max');
    global.fetch = routedFetch(
      catalogResponse([{ id: 'qwen/qwen3.8-max', input_modalities: ['text', 'image', 'video'] }]),
      priced(),
    );

    await main();

    const writes = capabilityWrites();
    expect(writes).toHaveLength(2);
    for (const [sql, params] of writes) {
      expect(sql).toContain('capabilities || $3::jsonb');
      // Written under the model's own REGISTRY provider key, like the window.
      expect(params[0]).toBe('qwen');
      expect(params[1]).toBe('qwen/qwen3.8-max');
    }
    expect(writes.map(([, p]) => p[2])).toEqual(['["vision"]', '["video"]']);
  });

  it('REMOVES a mark the vendor no longer publishes', async () => {
    registryRow('openrouter', 'z-ai/glm-5.2');
    global.fetch = routedFetch(
      catalogResponse([{ id: 'z-ai/glm-5.2', input_modalities: ['text'] }]),
      priced(),
    );

    await main();

    const writes = capabilityWrites();
    expect(writes).toHaveLength(2);
    for (const [sql] of writes) expect(sql).toContain('capabilities - $3::text');
    expect(writes.map(([, p]) => p[2])).toEqual(['vision', 'video']);
  });

  it('touches NOTHING when the catalog request failed', async () => {
    registryRow('qwen', 'qwen/qwen3.8-max');
    global.fetch = routedFetch(null, priced());

    await main();

    expect(capabilityWrites()).toHaveLength(0);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'model_modality_catalog_unavailable' }),
      expect.stringContaining('left untouched'),
    );
  });

  it('SKIPS a registered model the catalog does not list at all', async () => {
    // Absence is "the vendor has never heard of this slug", which is the
    // unmatched-pricing signal — not evidence that it cannot see.
    registryRow('deepseek', 'deepseek/no-such-model');
    global.fetch = routedFetch(
      catalogResponse([{ id: 'z-ai/glm-5.2', input_modalities: ['text'] }]),
      priced(),
    );

    await main();

    expect(capabilityWrites()).toHaveLength(0);
  });
});

describe('main — pricing coverage', () => {
  const priced = () => endpointsResponse([{ prompt: '0.000002', completion: '0.000006' }]);

  /** The registry rows and the model_pricing rows, answered separately — the
   *  coverage report compares the two and a mock that hands both the same rows
   *  cannot tell a hit from a miss. */
  function catalog(
    approved: Array<{ provider: string; model_id: string }>,
    pricingRows: Array<{ provider: string; model_id: string }>,
  ): void {
    mockQuery.mockImplementation(async (sql: string) => {
      if (typeof sql !== 'string') return { rows: [] };
      if (sql.includes('context_window IS NULL')) return { rows: [] };
      if (sql.includes('FROM model_pricing')) return { rows: pricingRows };
      if (sql.includes('FROM models') && sql.includes("status = 'approved'")) {
        return { rows: approved };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  function coverageCall(): Record<string, unknown> | undefined {
    const call = mockLogError.mock.calls.find(
      ([fields]) => (fields as { event?: string })?.event === 'model_pricing_missing',
    );
    return call?.[0] as Record<string, unknown> | undefined;
  }

  it('names an approved model that has no rate anywhere', async () => {
    catalog([{ provider: 'google', model_id: 'gemini-9-pro' }], []);
    global.fetch = routedFetch(catalogResponse([]), priced());

    await main();

    expect(coverageCall()).toEqual(
      expect.objectContaining({ unpricedModels: 1, models: ['google:gemini-9-pro'] }),
    );
  });

  it('resolves a gateway-served model under the one key it is filed at', async () => {
    // Registry key and pricing key are the same value now. When they were not,
    // comparing one to the other reported a priced model as unpriced on every
    // run — and a report that cries wolf is ignored within a week.
    catalog(
      [{ provider: 'qwen', model_id: 'qwen/qwen9-max' }],
      [{ provider: 'qwen', model_id: 'qwen/qwen9-max' }],
    );
    global.fetch = routedFetch(catalogResponse([]), priced());

    await main();

    expect(coverageCall()).toBeUndefined();
  });

  it('accepts a static MODEL_PRICING entry as a rate', async () => {
    // gpt-5.4 has no model_pricing row and never will — the sync job only
    // covers OpenRouter-hosted models — but it is priced in src/llm/pricing.ts,
    // which is where computeRowCost finds it.
    catalog([{ provider: 'openai', model_id: 'gpt-5.4' }], []);
    global.fetch = routedFetch(catalogResponse([]), priced());

    await main();

    expect(coverageCall()).toBeUndefined();
  });

  it('stays quiet when every approved model has a rate', async () => {
    catalog([], []);
    global.fetch = routedFetch(catalogResponse([]), priced());

    await main();

    expect(coverageCall()).toBeUndefined();
  });
});
