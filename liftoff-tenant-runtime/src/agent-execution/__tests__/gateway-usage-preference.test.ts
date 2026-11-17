// The arithmetic that decides how much of the gateway's answer to believe.
//
// It is arithmetic worth a suite of its own because it decides money and both of
// its failure modes are silent. Take too little and the under-count this change
// exists to fix survives; take too much and a run is billed twice for the same
// tokens, on the path where nobody is watching a single turn.
//
// IT SHIPPED TAKING TOO LITTLE, twice, and both are pinned below. It compared only
// the cache write and the output, so an entire second request's input tokens were
// visible in the gateway and dropped. And it reconstructed the charge from tokens
// at the listed rate, which on a gateway-served model cannot be right: one model is
// served by many endpoints at different prices, and only the vendor's own
// `usage.cost` sees the premium the serving endpoint charges.

import type { CostResult } from '../../llm/pricing';
import {
  gatewayShortfall,
  preferGatewayCounts,
  type EngineTotals,
} from '../gateway-usage-preference';
import type { GatewayRunUsage } from '../../byok/gateway-usage';

/** Sonnet-shaped rates: $3 input, $15 output, $0.30 cached, $3.75 cache write. */
const RATES: CostResult = {
  costUsd: 0,
  inputPricePerMillion: 3,
  outputPricePerMillion: 15,
  cachedInputPricePerMillion: 0.3,
  cacheWritePricePerMillion: 3.75,
};

function usage(over: Partial<GatewayRunUsage>): GatewayRunUsage {
  return {
    requests: 1,
    incomplete: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    vendorCostUsd: null,
    vendorCostRequests: 0,
    ...over,
  };
}

function engine(over: Partial<EngineTotals> = {}): EngineTotals {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, ...over };
}

describe('a run the gateway never served is left exactly as the engine reported it', () => {
  // The normal case, and the one that must cost nothing. `requests` is the field
  // that says so: the token totals of a run the gateway never saw are zeroes, and
  // reading them as counts would replace every real number with nothing.
  const eng = engine({ inputTokens: 5_000, outputTokens: 900, cacheWriteTokens: 28_015 });

  it('takes nothing when there is no gateway usage at all', () => {
    expect(gatewayShortfall(null, eng, RATES).costUsd).toBe(0);
    expect(gatewayShortfall(undefined, eng, RATES).costUsd).toBe(0);
    expect(preferGatewayCounts(null, eng)).toEqual(eng);
  });

  it('takes nothing when the gateway served ZERO requests for it', () => {
    const none = usage({ requests: 0 });
    expect(gatewayShortfall(none, eng, RATES).costUsd).toBe(0);
    expect(preferGatewayCounts(none, eng)).toEqual(eng);
  });
});

describe('EVERY billable count is compared, not the two somebody remembered', () => {
  // THE FIRST DEFECT. The shortfall returned {costUsd, cacheWriteTokens,
  // outputTokens} and compared only those two. On a real turn the gateway saw
  // 43,209 input against the engine's 32,944 — an entire second request's 10,265
  // tokens — and because the output happened to match exactly, the shortfall
  // computed zero and nothing at all was added.
  //
  // The reasoning that allowed it confused two things. Never evaluating a rate BAND
  // against a sum is right; pricing a DELTA at a rate already resolved tests no
  // threshold at all.
  it('prices an unreported request\'s input tokens', () => {
    const gateway = usage({ requests: 2, inputTokens: 43_209, outputTokens: 224 });
    const short = gatewayShortfall(
      gateway, engine({ inputTokens: 32_944, outputTokens: 224 }), RATES,
    );
    expect(short.inputTokens).toBe(10_265);
    expect(short.outputTokens).toBe(0);
    // 10,265 x $3 / 1e6
    expect(short.costUsd).toBeCloseTo(0.030795, 8);
  });

  it('prices cache READS the engine did not report', () => {
    // Billed at their own rate, and billed nonetheless. A read that was served is a
    // read that was charged.
    const short = gatewayShortfall(usage({ requests: 1, cacheReadTokens: 28_015 }), engine(), RATES);
    expect(short.cacheReadTokens).toBe(28_015);
    expect(short.costUsd).toBeCloseTo(0.0084045, 8);
  });

  it('falls back to the INPUT rate for a cache read on a model with no cached rate', () => {
    // Not to zero. A model that does not discount a read still charges for it.
    const { cachedInputPricePerMillion: _omit, ...noCachedRate } = RATES;
    const short = gatewayShortfall(
      usage({ requests: 1, cacheReadTokens: 1_000_000 }), engine(), noCachedRate as CostResult,
    );
    expect(short.costUsd).toBeCloseTo(3, 6);
  });

  it('prices all four counts together', () => {
    const gateway = usage({
      requests: 3,
      inputTokens: 10_000, outputTokens: 2_000,
      cacheReadTokens: 5_000, cacheWriteTokens: 1_000,
    });
    const short = gatewayShortfall(gateway, engine(), RATES);
    expect(short).toMatchObject({
      inputTokens: 10_000, outputTokens: 2_000,
      cacheReadTokens: 5_000, cacheWriteTokens: 1_000,
      vendorReported: false,
    });
    expect(short.costUsd).toBeCloseTo((30_000 + 30_000 + 1_500 + 3_750) / 1_000_000, 10);
  });
});

describe('the cache write the engine reported as zero', () => {
  // The engine's count says nothing was written; the vendor billed at 1.25x input.
  // Where a cache write goes missing does not change what it costs, and on a cold
  // turn it is almost the whole charge.
  const eng = engine({ outputTokens: 4 });
  const gateway = usage({ requests: 5, outputTokens: 4, cacheWriteTokens: 31_300 });

  it('prices the whole write at the cache-write rate', () => {
    const short = gatewayShortfall(gateway, eng, RATES);
    expect(short.cacheWriteTokens).toBe(31_300);
    expect(short.outputTokens).toBe(0);
    expect(short.costUsd).toBeCloseTo(0.117375, 8);
  });

  it('puts the count on the row, which is what a reconciliation reads', () => {
    expect(preferGatewayCounts(gateway, eng).cacheWriteTokens).toBe(31_300);
  });

  it('falls back to 1.25x input when the rate table carries no cache-write rate', () => {
    const { cacheWritePricePerMillion: _omitted, ...noWriteRate } = RATES;
    expect(gatewayShortfall(gateway, eng, noWriteRate as CostResult).costUsd)
      .toBeCloseTo(0.117375, 8);
  });
});

describe('the reasoning the engine left out of its completion count', () => {
  // The opencode gap: the vendor bills reasoning at the completion rate and the
  // engine publishes a completion count that excludes it.
  const eng = engine({ outputTokens: 203 });
  const gateway = usage({ requests: 3, outputTokens: 6_231, reasoningTokens: 6_028 });

  it('prices only the DIFFERENCE, at the output rate', () => {
    const short = gatewayShortfall(gateway, eng, RATES);
    expect(short.outputTokens).toBe(6_028);
    expect(short.costUsd).toBeCloseTo(0.09042, 8);
  });

  it('raises the count on the row to what the vendor billed', () => {
    expect(preferGatewayCounts(gateway, eng).outputTokens).toBe(6_231);
  });
});

describe('WHAT THE VENDOR CHARGED beats any reconstruction from tokens', () => {
  // THE SECOND DEFECT. Every token count can be right and the money still wrong. A
  // model on OpenRouter is served by many endpoints at different prices, and the
  // listed slug rate is short by whatever premium the serving endpoint charges:
  // 43,209 input and 224 output reconstruct to $0.01411360 against the $0.01853990
  // actually charged — 31% invisible with every count correct.
  const CHARGED = 0.01853990;
  const RECONSTRUCTED = 0.01411360;
  const gateway = usage({
    requests: 2, vendorCostUsd: CHARGED, vendorCostRequests: 2,
    inputTokens: 43_209, outputTokens: 224,
  });

  it('takes the vendor\'s figure, not the token arithmetic', () => {
    const short = gatewayShortfall(gateway, engine(), RATES, 0);
    expect(short.costUsd).toBe(CHARGED);
    expect(short.vendorReported).toBe(true);
  });

  it('closes exactly the gap the reconstruction left', () => {
    const short = gatewayShortfall(gateway, engine(), RATES, RECONSTRUCTED);
    expect(short.costUsd).toBeCloseTo(CHARGED - RECONSTRUCTED, 10);
    expect(RECONSTRUCTED + short.costUsd).toBeCloseTo(CHARGED, 10);
  });

  it('compares against what the steps were already charged, so nothing bills twice', () => {
    // Without the comparison a run served entirely by the gateway is billed roughly
    // twice: the steps' own reconstruction plus the vendor's total on top of it.
    expect(gatewayShortfall(gateway, engine(), RATES, 0.05).costUsd).toBe(0);
    expect(gatewayShortfall(gateway, engine(), RATES, 0.05).vendorReported).toBe(false);
  });

  it('still reports the COUNTS, which the row records either way', () => {
    // A row whose charge came from the vendor still has to say what it was charged
    // for: a reconciliation reads the counts.
    const short = gatewayShortfall(gateway, engine({ inputTokens: 32_944 }), RATES, 0);
    expect(short.inputTokens).toBe(10_265);
  });

  it('REFUSES a partial sum and falls back to the tokens', () => {
    // A cost summed over one of two requests is not the run's charge. Preferring it
    // would under-bill by whatever the silent request cost — the same defect as
    // dropping a count, arrived at from the other side.
    const partial = usage({
      requests: 2, vendorCostUsd: 0.002, vendorCostRequests: 1,
      inputTokens: 43_209, outputTokens: 224,
    });
    const short = gatewayShortfall(
      partial, engine({ inputTokens: 32_944, outputTokens: 224 }), RATES, 0,
    );
    expect(short.vendorReported).toBe(false);
    expect(short.costUsd).toBeCloseTo(0.030795, 8);
  });

  it('falls back to the tokens when no request reported a charge', () => {
    // Every direct-API vendor. They publish a price list, so the rate table is the
    // only thing that can price them.
    const none = usage({ requests: 2, inputTokens: 10_000 });
    const short = gatewayShortfall(none, engine(), RATES, 0);
    expect(short.vendorReported).toBe(false);
    expect(short.costUsd).toBeCloseTo(0.03, 8);
  });
});

describe('the engine is allowed to have seen MORE, and often has', () => {
  // A turn that fell back to a direct path mid-run, a delegated child whose calls
  // never passed the door, a run the gateway served only part of. Treating the
  // gateway as authoritative there would UN-BILL real spend — the same defect in
  // the other direction, and the more expensive one to discover because nobody
  // reports a charge that never arrived.
  const eng = engine({
    inputTokens: 50_000, outputTokens: 9_000, cachedTokens: 8_000, cacheWriteTokens: 40_000,
  });
  const gateway = usage({ requests: 2, inputTokens: 1_200, outputTokens: 1_200, cacheWriteTokens: 300 });

  it('adds nothing', () => {
    expect(gatewayShortfall(gateway, eng, RATES).costUsd).toBe(0);
  });

  it('keeps the engine counts on the row', () => {
    expect(preferGatewayCounts(gateway, eng)).toEqual(eng);
  });

  it('never subtracts, and compares each count on its own', () => {
    // Mixed: the gateway saw more output and fewer of everything else. Neither can
    // pull the other down.
    const mixed = usage({
      requests: 2, inputTokens: 1_000, outputTokens: 12_000, cacheWriteTokens: 300,
    });
    const short = gatewayShortfall(mixed, eng, RATES);
    expect(short.outputTokens).toBe(3_000);
    expect(short.inputTokens).toBe(0);
    expect(short.cacheWriteTokens).toBe(0);
    expect(preferGatewayCounts(mixed, eng)).toEqual({
      inputTokens: 50_000, outputTokens: 12_000, cachedTokens: 8_000, cacheWriteTokens: 40_000,
    });
  });
});

describe('what is deliberately NOT taken from the gateway', () => {
  it('never adds reasoning on top of the output it is a breakdown of', () => {
    // `reasoningTokens` is a BREAKDOWN of `outputTokens` at every vendor we serve.
    // Adding it would bill the thinking twice.
    const gateway = usage({ requests: 1, outputTokens: 5_000, reasoningTokens: 4_800 });
    const short = gatewayShortfall(gateway, engine({ outputTokens: 5_000 }), RATES);
    expect(short.outputTokens).toBe(0);
    expect(short.costUsd).toBe(0);
  });
});
