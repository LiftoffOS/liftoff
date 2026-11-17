// FITNESS FUNCTION — a vendor path that cannot report token usage is not
// shippable, BYOK or not.
//
//   Every LLM call the platform makes produces a usage record with input and
//   output token counts, whoever's key paid for it. No exceptions.
//
// This is a property of the platform, not a feature of BYOK. BYOK is only the
// first thing to test it, because it is the first time the paying account is
// not ours. The consequence worth encoding is the one that is easy to skip
// under deadline: adding a vendor adapter WITHOUT its usage parser, and
// discovering months later that a whole provider's spend was invisible.
//
// So this test enumerates the registry rather than a hand-written list. A new
// vendor added to ADAPTERS with no usage parsing fails here, at the point it is
// added, rather than in a reconciliation nobody runs.
//
// REPORTING A TOKEN IS NOT THE SAME AS PRICING IT, and the second half of this
// file pins the distinctions pricing needs. `cachedTokens` held the cache READ and
// the cache WRITE added together; Anthropic bills a read at 0.1x the input rate
// and a write at 1.25x, so one column carrying their sum can be priced at neither
// — and the turn that writes the most cache is the cold one where the whole
// prompt is a write. Reasoning is the same shape at a different vendor: billed at
// the completion rate, reported in a field of its own, and a BREAKDOWN of the
// total rather than an addition to it.
//
// So every adapter is asserted to fill all three — read, write and reasoning —
// by the same enumeration that already holds the two above.

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  EMPTY_USAGE,
  gatewayVendors,
  getGatewayAdapter,
  type GatewayTokenUsage,
} from '../vendor-adapters';

/** A streamed usage event in each vendor's own shape, and the totals it means. */
const STREAM_FIXTURES: Record<string, { events: Array<Record<string, unknown>>; expected: GatewayTokenUsage }> = {
  anthropic: {
    events: [
      {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-5',
          usage: {
            input_tokens: 120,
            output_tokens: 1,
            cache_read_input_tokens: 4000,
            cache_creation_input_tokens: 90,
          },
        },
      },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      { type: 'message_delta', usage: { output_tokens: 512 } },
    ],
    // 4000 read and 90 written are SEPARATE MONEY. `cachedTokens` is the read
    // alone; the 4090 this once asserted was a sum that could be priced at
    // neither rate.
    expected: {
      model: 'claude-sonnet-5',
      inputTokens: 120,
      outputTokens: 512,
      cachedTokens: 4000,
      cacheReadTokens: 4000,
      cacheWriteTokens: 90,
      reasoningTokens: 0,
      vendorCostUsd: null,
    },
  },
  openai: {
    events: [
      { model: 'gpt-5.6-terra', choices: [{ delta: { content: 'hi' } }] },
      {
        model: 'gpt-5.6-terra',
        usage: {
          prompt_tokens: 300,
          completion_tokens: 44,
          prompt_tokens_details: { cached_tokens: 256 },
        },
      },
    ],
    expected: {
      model: 'gpt-5.6-terra',
      inputTokens: 300,
      outputTokens: 44,
      cachedTokens: 256,
      cacheReadTokens: 256,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      vendorCostUsd: null,
    },
  },
  xai: {
    events: [
      {
        model: 'grok-4.6',
        usage: {
          prompt_tokens: 88,
          completion_tokens: 12,
          total_tokens: 140,
          completion_tokens_details: { reasoning_tokens: 40 },
        },
      },
    ],
    // 140 - 88 = 52 billable completion tokens, of which 40 were thinking. The
    // reasoning count is the BREAKDOWN and is never added to the total: adding
    // it would bill 92 for 52.
    expected: {
      model: 'grok-4.6',
      inputTokens: 88,
      outputTokens: 52,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 40,
      vendorCostUsd: null,
    },
  },
  openrouter: {
    events: [
      {
        model: 'z-ai/glm-5.3',
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 203,
          total_tokens: 7431,
          prompt_tokens_details: { cached_tokens: 900 },
          completion_tokens_details: { reasoning_tokens: 6028 },
          // OpenRouter's own charge for the request, in credits, 1:1 with USD.
          cost: 0.01853990,
          cost_details: { upstream_inference_cost: 0.01712 },
        },
      },
    ],
    // The turn from the report: 203 output tokens self-reported against 6,231
    // the vendor billed. 7431 - 1200 = 6231, and the 6,028 sitting in
    // `reasoning_tokens` is the difference — the 1.714x gap, in one event.
    expected: {
      model: 'z-ai/glm-5.3',
      inputTokens: 1200,
      outputTokens: 6231,
      cachedTokens: 900,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      reasoningTokens: 6028,
      // THE FIGURE NO TOKEN COUNT SEES. 1200 input and 6231 output reconstruct to
      // less than this at the listed slug rate; the endpoint that served the
      // request charges above it, and `usage.cost` is the charge.
      vendorCostUsd: 0.01853990,
    },
  },
  google: {
    events: [
      {
        modelVersion: 'gemini-3.5-flash',
        usageMetadata: {
          promptTokenCount: 210,
          candidatesTokenCount: 30,
          thoughtsTokenCount: 5,
          // The tool RESULTS fed back in. Google bills them as input and does not
          // count them inside `promptTokenCount`; its own arithmetic is
          // `totalTokenCount = prompt + candidates + toolUsePrompt + thoughts`.
          toolUsePromptTokenCount: 120,
          cachedContentTokenCount: 64,
          // 210 + 30 + 120 + 5. Present so the identity below has something to
          // reconstruct against.
          totalTokenCount: 365,
        },
      },
    ],
    expected: {
      model: 'gemini-3.5-flash',
      inputTokens: 330,
      outputTokens: 35,
      cachedTokens: 64,
      cacheReadTokens: 64,
      cacheWriteTokens: 0,
      // Google reports thoughts as their own count and bills them at the output
      // rate, so `outputTokens` already contains the 5 and this is the
      // breakdown.
      reasoningTokens: 5,
      vendorCostUsd: null,
    },
  },
};

/** A non-streaming body in each vendor's own shape. */
const BODY_FIXTURES: Record<string, { body: Record<string, unknown>; expected: GatewayTokenUsage }> = {
  anthropic: {
    body: {
      model: 'claude-opus-5',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3,
      },
    },
    expected: {
      model: 'claude-opus-5',
      inputTokens: 10,
      outputTokens: 20,
      cachedTokens: 5,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      reasoningTokens: 0,
      vendorCostUsd: null,
    },
  },
  openai: {
    body: {
      model: 'gpt-5.6-luna',
      usage: { prompt_tokens: 7, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 2 } },
    },
    expected: {
      model: 'gpt-5.6-luna',
      inputTokens: 7,
      outputTokens: 9,
      cachedTokens: 2,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      vendorCostUsd: null,
    },
  },
  xai: {
    // Captured from api.x.ai, grok-4.6, 2026-09-04. Note 641 + 1 != 906: xAI
    // reports reasoning tokens OUTSIDE completion_tokens, unlike OpenAI, which
    // folds them in. Reading completion_tokens alone would record 1 output
    // token for a call that produced 265.
    body: {
      model: 'grok-4.6',
      usage: {
        prompt_tokens: 641,
        completion_tokens: 1,
        total_tokens: 906,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 264 },
      },
    },
    expected: {
      model: 'grok-4.6',
      inputTokens: 641,
      outputTokens: 265,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 264,
      vendorCostUsd: null,
    },
  },
  openrouter: {
    // The Responses-shaped names, because both shapes reach this gateway and
    // only one of them was ever exercised here.
    body: {
      model: 'qwen/qwen3.7-plus',
      usage: {
        input_tokens: 4102,
        output_tokens: 3,
        total_tokens: 10_117,
        input_tokens_details: { cached_tokens: 3800 },
        output_tokens_details: { reasoning_tokens: 6012 },
        cost: 0.00421337,
      },
    },
    expected: {
      model: 'qwen/qwen3.7-plus',
      inputTokens: 4102,
      outputTokens: 6015,
      cachedTokens: 3800,
      cacheReadTokens: 3800,
      cacheWriteTokens: 0,
      reasoningTokens: 6012,
      vendorCostUsd: 0.00421337,
    },
  },
  google: {
    body: {
      modelVersion: 'gemini-3.1-pro-preview',
      usageMetadata: {
        promptTokenCount: 11,
        candidatesTokenCount: 13,
        toolUsePromptTokenCount: 7,
        thoughtsTokenCount: 4,
        // 11 + 13 + 7 + 4.
        totalTokenCount: 35,
      },
    },
    expected: {
      model: 'gemini-3.1-pro-preview',
      inputTokens: 18,
      outputTokens: 17,
      cachedTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 4,
      vendorCostUsd: null,
    },
  },
};

describe('reasoning tokens are output tokens', () => {
  // The two OpenAI-compatible vendors disagree about whether completion_tokens
  // already contains reasoning, and getting it wrong is silent: the usage row
  // exists, INV-PB-013 is satisfied, and the number is a fraction of the truth.
  const { getGatewayAdapter } = require('../vendor-adapters') as typeof import('../vendor-adapters');

  it("adds xAI's reasoning tokens, which sit OUTSIDE completion_tokens", () => {
    const parsed = getGatewayAdapter('xai')!.parseNonStreamingUsage({
      model: 'grok-4.6',
      usage: {
        prompt_tokens: 641, completion_tokens: 1, total_tokens: 906,
        completion_tokens_details: { reasoning_tokens: 264 },
      },
    } as never);
    expect(parsed?.outputTokens).toBe(265);
  });

  it("does not double-count OpenAI's, which sit INSIDE it", () => {
    // OpenAI reports completion_tokens = 120 with reasoning_tokens = 100 as a
    // breakdown of it, and total = prompt + completion. Adding again would bill
    // 220 for 120.
    const parsed = getGatewayAdapter('openai')!.parseNonStreamingUsage({
      model: 'gpt-5.6-terra',
      usage: {
        prompt_tokens: 50, completion_tokens: 120, total_tokens: 170,
        completion_tokens_details: { reasoning_tokens: 100 },
      },
    } as never);
    expect(parsed?.outputTokens).toBe(120);
  });

  it('falls back to the vendor\'s own arithmetic when a category is unnamed', () => {
    // total - prompt is what the vendor asserts it is charging for, whatever
    // buckets it chooses to name.
    const parsed = getGatewayAdapter('xai')!.parseNonStreamingUsage({
      model: 'grok-4.6',
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 99 },
    } as never);
    expect(parsed?.outputTokens).toBe(89);
  });
});

describe('every gateway vendor reports token usage', () => {
  const vendors = gatewayVendors();

  it('finds vendors at all, so this cannot pass vacuously', () => {
    expect(vendors.length).toBeGreaterThan(0);
  });

  it.each(vendors)('%s has a streaming usage fixture and parses it', (vendor) => {
    const fixture = STREAM_FIXTURES[vendor];
    expect(
      fixture,
      // Jest prints this when the assertion fails, which is the whole point:
      // the person adding a vendor learns what is missing.
    ).toBeDefined();
    const adapter = getGatewayAdapter(vendor)!;
    let usage = { ...EMPTY_USAGE };
    for (const event of fixture.events) usage = adapter.accumulateStreamUsage(usage, event);
    expect(usage).toEqual(fixture.expected);
  });

  it.each(vendors)('%s parses a non-streaming body', (vendor) => {
    const fixture = BODY_FIXTURES[vendor];
    expect(fixture).toBeDefined();
    const adapter = getGatewayAdapter(vendor)!;
    expect(adapter.parseNonStreamingUsage(fixture.body)).toEqual(fixture.expected);
  });

  it.each(vendors)('%s never sums a cumulative total twice', (vendor) => {
    // Final provider totals are authoritative. An adapter that ADDED each
    // repeat would double every streamed response's token count, which is the
    // failure mode that looks like a pricing bug for months.
    const fixture = STREAM_FIXTURES[vendor];
    const adapter = getGatewayAdapter(vendor)!;
    let once = { ...EMPTY_USAGE };
    for (const event of fixture.events) once = adapter.accumulateStreamUsage(once, event);
    let twice = { ...once };
    for (const event of fixture.events) twice = adapter.accumulateStreamUsage(twice, event);
    expect(twice).toEqual(once);
  });

  it.each(vendors)('%s returns null rather than zeroes for a body with no usage', (vendor) => {
    // A coerced zero is indistinguishable from a real free call. Null lets the
    // caller record what it has instead of asserting something it did not see.
    const adapter = getGatewayAdapter(vendor)!;
    expect(adapter.parseNonStreamingUsage({ model: 'x' })).toBeNull();
  });

  it.each(vendors)('%s injects a credential and never forwards the caller own', (vendor) => {
    const adapter = getGatewayAdapter(vendor)!;
    const injected = adapter.buildAuthHeaders('the-real-customer-key');
    expect(Object.keys(injected).length).toBeGreaterThan(0);
    expect(JSON.stringify(injected)).toContain('the-real-customer-key');
    // The gateway replaces the caller's credential rather than passing it on:
    // a client must not be able to smuggle its own key past the allow-list.
    for (const header of Object.keys(injected)) {
      expect(adapter.allowedRequestHeaders.has(header.toLowerCase())).toBe(false);
    }
    expect(adapter.allowedRequestHeaders.has('authorization')).toBe(false);
    expect(adapter.allowedRequestHeaders.has('x-api-key')).toBe(false);
    expect(adapter.allowedRequestHeaders.has('x-goog-api-key')).toBe(false);
  });

  it.each(vendors)('%s builds an upstream URL from the vendor path, not the inbound one', (vendor) => {
    const adapter = getGatewayAdapter(vendor)!;
    const url = adapter.buildUpstreamUrl('/v1/models');
    // ENDS WITH rather than EQUALS, because a vendor's base is allowed to carry
    // its own path prefix: OpenRouter serves at /api/v1, so its upstream path is
    // /api/v1/models and an equality here would have forced the adapter to
    // resolve `/v1/…` absolutely — which silently discards the prefix and hits
    // the wrong host root. The property being asserted is that the VENDOR's path
    // arrives and the inbound mount does not, and both halves still hold.
    expect(url.pathname.endsWith('/v1/models')).toBe(true);
    expect(url.origin).toBe(new URL(adapter.baseUrl()).origin);
    // The mount path must never reach the vendor.
    expect(url.href).not.toContain('/byok/');
  });

  it.each(vendors)('%s separates the cache READ from the cache WRITE', (vendor) => {
    // The defect this exists for is not a missing number, it is two numbers
    // added together. Anthropic charges 0.1x for a read and 1.25x for a write —
    // a 12.5x spread — so a row holding their sum can be priced at neither rate,
    // and the cold turn that writes the whole prompt is exactly the one that
    // matters. A vendor with no write to report says zero, which is the wire's
    // answer rather than a gap; what must never happen again is one field
    // carrying both.
    const fixture = STREAM_FIXTURES[vendor];
    const adapter = getGatewayAdapter(vendor)!;
    let usage = { ...EMPTY_USAGE };
    for (const event of fixture.events) usage = adapter.accumulateStreamUsage(usage, event);
    expect(usage.cacheReadTokens).toBe(fixture.expected.cacheReadTokens);
    expect(usage.cacheWriteTokens).toBe(fixture.expected.cacheWriteTokens);
    // `cachedTokens` is kept for the readers written against it, and it is the
    // READ. If it ever became the sum again this is what would say so.
    expect(usage.cachedTokens).toBe(usage.cacheReadTokens);
  });

  it.each(vendors)('%s reports reasoning tokens without double-billing them', (vendor) => {
    // Reasoning is charged at the completion rate by every vendor we serve, and
    // they disagree about whether their own completion count already contains
    // it. `outputTokens` is the BILLABLE total either way; `reasoningTokens` is
    // the breakdown, so it can never exceed the total it breaks down.
    const fixture = BODY_FIXTURES[vendor];
    const adapter = getGatewayAdapter(vendor)!;
    const parsed = adapter.parseNonStreamingUsage(fixture.body)!;
    expect(parsed.reasoningTokens).toBe(fixture.expected.reasoningTokens);
    expect(parsed.reasoningTokens).toBeLessThanOrEqual(parsed.outputTokens);
  });

  it.each(vendors)('%s reports every field of the usage record, not a subset', (vendor) => {
    // The failure this catches is a new adapter that fills the two fields
    // somebody remembered and leaves the rest `undefined`, which reaches the
    // database as NULL and reads as "nobody looked" forever. Every field is a
    // number on every vendor.
    const adapter = getGatewayAdapter(vendor)!;
    const parsed = adapter.parseNonStreamingUsage(BODY_FIXTURES[vendor].body)!;
    for (const field of [
      'inputTokens', 'outputTokens', 'cachedTokens',
      'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens',
    ] as const) {
      expect(typeof parsed[field]).toBe('number');
    }
    // The cost is the one field where NULL is the right answer and zero is not: a
    // vendor that publishes a price list reports no per-call charge, and a zero
    // booked as a charge is an unbilled call. So it is a number or null, never
    // undefined — undefined reaches the column as NULL by accident rather than by
    // decision, and the two are indistinguishable afterwards.
    expect(parsed.vendorCostUsd === null || typeof parsed.vendorCostUsd === 'number').toBe(true);
    expect(parsed.vendorCostUsd).not.toBeUndefined();
  });
});

describe('Google\'s four counts reconstruct the total it reports', () => {
  // THE IDENTITY IS THE ASSERTION WORTH HAVING, because it fails for ANY omitted
  // count rather than only the one somebody thought of. Google states the
  // arithmetic on `totalTokenCount`: prompt + candidates + toolUsePrompt +
  // thoughts, and none of the four sits inside another. So a parser that reads
  // three of them cannot reconstruct the vendor's own total, and the shortfall is
  // exactly what goes unbilled.
  //
  // `thoughtsTokenCount` was the first to go missing and `toolUsePromptTokenCount`
  // the second — the tool-result prompt, which on the gemini-cli engine is present
  // on nearly every turn, because its only tools arrive over the governed MCP
  // proxy. A test that asserted each count separately would have passed for the
  // one it named and missed the other.
  const adapter = getGatewayAdapter('google')!;

  it('reconstructs totalTokenCount from a STREAMED response', () => {
    const events = STREAM_FIXTURES.google.events;
    // The LAST event's total, not the first. `usageMetadata` on a streamed chunk is
    // cumulative for the response and REPLACES rather than accumulates, so the
    // final chunk carries the figure the whole response is billed on. Reading
    // `events[0]` happens to work while there is one event and silently compares
    // against a stale total the moment a second is added.
    const meta = events[events.length - 1].usageMetadata as Record<string, number>;
    let usage = { ...EMPTY_USAGE };
    for (const event of events) usage = adapter.accumulateStreamUsage(usage, event);
    expect(usage.inputTokens + usage.outputTokens).toBe(meta.totalTokenCount);
  });

  it('reconstructs totalTokenCount from a non-streaming body', () => {
    const meta = BODY_FIXTURES.google.body.usageMetadata as Record<string, number>;
    const parsed = adapter.parseNonStreamingUsage(BODY_FIXTURES.google.body)!;
    expect(parsed.inputTokens + parsed.outputTokens).toBe(meta.totalTokenCount);
  });

  it('counts the tool-result prompt as INPUT, which promptTokenCount excludes', () => {
    // Google bills it at the input rate. Reading `promptTokenCount` alone
    // under-counts every tool-using turn.
    const parsed = adapter.parseNonStreamingUsage({
      modelVersion: 'gemini-3.5-flash',
      usageMetadata: {
        promptTokenCount: 1_000,
        toolUsePromptTokenCount: 4_000,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 90,
        totalTokenCount: 5_100,
      },
    } as never)!;
    expect(parsed.inputTokens).toBe(5_000);
    expect(parsed.outputTokens).toBe(100);
    expect(parsed.inputTokens + parsed.outputTokens).toBe(5_100);
  });

  it('holds when the vendor reports no tool prompt and no thinking', () => {
    // The common shape, and the identity still has to hold on it or the check is
    // only asserting the interesting case.
    const parsed = adapter.parseNonStreamingUsage({
      modelVersion: 'm',
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 },
    } as never)!;
    expect(parsed.inputTokens + parsed.outputTokens).toBe(25);
  });

  it('is the SAME arithmetic the provider prices with', () => {
    // One module states it (`llm/google-usage.ts`) and both consumers call it, so
    // this cannot drift by construction. The assertion is still worth keeping: it
    // is what says the adapter actually calls it rather than restating it.
    const {
      googleInputTokens, googleOutputTokens,
    } = require('../../llm/google-usage') as typeof import('../../llm/google-usage');
    const meta = {
      promptTokenCount: 1_000,
      toolUsePromptTokenCount: 4_000,
      candidatesTokenCount: 10,
      thoughtsTokenCount: 90,
    };
    const parsed = adapter.parseNonStreamingUsage({
      modelVersion: 'm', usageMetadata: { ...meta, totalTokenCount: 5_100 },
    } as never)!;
    expect(parsed.inputTokens).toBe(googleInputTokens(meta));
    expect(parsed.outputTokens).toBe(googleOutputTokens(meta));
  });
});

describe('what the vendor says it charged', () => {
  // THE TOKENS CAN ALL BE RIGHT AND THE MONEY STILL WRONG. A model on OpenRouter is
  // served by many endpoints at different prices and no price list says which one
  // took the request, so a charge reconstructed from tokens at the listed slug
  // rate is short by the serving endpoint's premium — measured at 31% on a real
  // turn. `usage.cost` IS the charge, and it is the only figure that sees it.
  it('reads OpenRouter\'s own charge off the response', () => {
    const parsed = getGatewayAdapter('openrouter')!.parseNonStreamingUsage({
      model: 'z-ai/glm-5.3',
      usage: { prompt_tokens: 43_209, completion_tokens: 224, total_tokens: 43_433, cost: 0.01853990 },
    } as never);
    expect(parsed!.vendorCostUsd).toBe(0.01853990);
    // And the tokens still reconstruct to less, which is the whole point: at the
    // listed rate these counts give $0.01411360, 31% short of what was charged.
    const reconstructed = (43_209 * 0.32 + 224 * 1.28) / 1_000_000;
    expect(reconstructed).toBeLessThan(parsed!.vendorCostUsd!);
  });

  it('reads it off a STREAMED response too, where most turns arrive', () => {
    // A streamed turn is the normal shape. A cost captured only on the
    // non-streaming path would be absent for nearly every real request.
    const adapter = getGatewayAdapter('openrouter')!;
    let usage = { ...EMPTY_USAGE };
    usage = adapter.accumulateStreamUsage(usage, {
      model: 'z-ai/glm-5.3',
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.002 },
    });
    expect(usage.vendorCostUsd).toBe(0.002);
  });

  it('answers NULL, not zero, for a vendor that publishes a price list', () => {
    // Anthropic, OpenAI, Google and xAI report no per-call charge. Zero would
    // un-bill the call; null means "price it from the rate table".
    for (const vendor of ['anthropic', 'openai', 'google', 'xai']) {
      const parsed = getGatewayAdapter(vendor)!.parseNonStreamingUsage(BODY_FIXTURES[vendor].body);
      expect(parsed!.vendorCostUsd).toBeNull();
    }
  });

  it('refuses a zero or a negative as a charge', () => {
    // A vendor that reports `cost: 0` has not told us the call was free, it has
    // told us nothing. Booking it as a charge is an unbilled call.
    for (const c of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '0.02', null, undefined]) {
      const parsed = getGatewayAdapter('openrouter')!.parseNonStreamingUsage({
        model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1, cost: c },
      } as never);
      expect(parsed!.vendorCostUsd).toBeNull();
    }
  });

  it('never sums a cumulative cost twice across a stream', () => {
    // The same property the token counts have. A cost that ADDED on each repeat
    // would multiply the charge by the number of usage events in the stream.
    const adapter = getGatewayAdapter('openrouter')!;
    const event = {
      model: 'm',
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.002 },
    };
    const once = adapter.accumulateStreamUsage({ ...EMPTY_USAGE }, event);
    const twice = adapter.accumulateStreamUsage(once, event);
    expect(twice.vendorCostUsd).toBe(once.vendorCostUsd);
  });
});

describe('the door with no customer-funded side', () => {
  // `openrouter` is a vendor the GATEWAY serves and not a vendor a customer can
  // hold a key for: the invoice is Liftoff's. It is here for the counting half
  // of what this component does, and the two properties that make it work are
  // easy to get wrong in opposite directions.
  it('is a gateway vendor', () => {
    expect(gatewayVendors()).toContain('openrouter');
  });

  it('joins the vendor path RELATIVE to a base that carries its own prefix', () => {
    // OpenRouter serves at /api/v1. Resolving `/v1/chat/completions` absolutely
    // against that base discards `/api/v1` and reaches openrouter.ai/v1, which
    // does not exist — and the symptom is a 404 that reads like a bad model id.
    const url = getGatewayAdapter('openrouter')!.buildUpstreamUrl('/v1/chat/completions');
    expect(url.href).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('does not double the v1 segment', () => {
    // The base ends in /v1 and the vendor path begins with it. One of the two
    // has to go, and dropping the base's would lose the /api prefix with it.
    const url = getGatewayAdapter('openrouter')!.buildUpstreamUrl('/v1/models');
    expect(url.pathname).toBe('/api/v1/models');
  });

  it('KEEPS the v1 segment when the operator base does not carry one', () => {
    // `OPENROUTER_BASE_URL` is the estate's existing override and its documented
    // use is a self-hosted vLLM or SGLang host, which may be named without the
    // segment. Stripping the vendor's `v1/` unconditionally loses it entirely and
    // 404s every request — the failure looks like a bad path, not like a base URL
    // somebody set two environments ago.
    const original = process.env.OPENROUTER_BASE_URL;
    try {
      process.env.OPENROUTER_BASE_URL = 'https://vllm.internal.example';
      expect(getGatewayAdapter('openrouter')!.buildUpstreamUrl('/v1/chat/completions').href)
        .toBe('https://vllm.internal.example/v1/chat/completions');
      // And a trailing slash on the override does not produce an empty segment,
      // which reaches a router as a path it does not serve.
      process.env.OPENROUTER_BASE_URL = 'https://vllm.internal.example/api/v1/';
      expect(getGatewayAdapter('openrouter')!.buildUpstreamUrl('/v1/chat/completions').href)
        .toBe('https://vllm.internal.example/api/v1/chat/completions');
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_BASE_URL;
      else process.env.OPENROUTER_BASE_URL = original;
    }
  });
});

describe('the x402 connector vendor path reports usage (INV-PB-013)', () => {
  // The same invariant, for the newest kind of paying vendor: an x402 call is
  // MONEY leaving the platform wallet per call, and a payment with no usage
  // record is invisible spend — the exact failure this file exists to make
  // unshippable. The x402 path's usage records travel connector-service →
  // tenant-runtime usage ledger (tool-gateway/x402-usage.ts, enumerated over
  // X402_FUNDED_CONNECTORS there) → this repo's usage-ledger ingester → the
  // x402 branch of ingestEventWithBuckets (behavioural tests:
  // cost-attribution/__tests__/x402-wallet-funded.test.ts and
  // usage-ledger-ingester.test.ts).
  //
  // What is pinned HERE is the ingester's enumeration, structurally: the
  // 'connector_call' event type must sit in BOTH maps. In EVENT_TYPE_MAP but
  // not TOOL_COST_FROM_METADATA is the silent one — the event ingests
  // "successfully" priced off `credits` at ~$0, which is how browser sessions
  // once billed zero while looking correctly ingested.
  const ingesterSource = readFileSync(
    join(__dirname, '..', '..', 'cost-attribution', 'ingestion', 'usage-ledger-ingester.ts'),
    'utf8',
  );

  it("maps 'connector_call' into cost_attribution_events", () => {
    expect(ingesterSource).toMatch(/connector_call:\s*'connector_call'/);
  });

  it("prices 'connector_call' from metadata.cost_micros, never from credits", () => {
    const metadataSet = ingesterSource.match(/TOOL_COST_FROM_METADATA = new Set\(\[[\s\S]*?\]\)/)?.[0] ?? '';
    expect(metadataSet).toContain("'connector_call'");
  });

  it('routes the x402 funding marker to the wallet-funded branch', () => {
    expect(ingesterSource).toContain("e.metadata?.funding === 'x402_wallet'");
    expect(ingesterSource).toContain('x402Funded: true');
  });
});
