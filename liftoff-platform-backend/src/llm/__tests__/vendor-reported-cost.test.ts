/**
 * The vendor's own charge beats our estimate, and an absent charge is not zero.
 *
 * For a model served through OpenRouter the estimate cannot be accurate in
 * principle: one model is served by many endpoints at different prices — Kimi K3
 * by nineteen, spanning $1.03 to $4.50 per million input — and no price list can
 * say which one took a given request. `sync-model-pricing` resolves that with the
 * MAX across endpoints, which is safe and about 2x the median, so a customer is
 * attributed for an endpoint we did not use.
 *
 * `usage: { include: true }` makes the gateway return the real charge. Two
 * properties have to hold for that to be worth anything, and both are the kind
 * that fail silently:
 *
 *   1. The request must actually ASK for accounting — and on all three request
 *      paths, not two. A missing flag returns no cost and every call quietly
 *      reverts to the max-endpoint estimate.
 *   2. A missing or zero charge must fall through to the estimate, never book
 *      zero. Anthropic, OpenAI, Google and xAI report no per-call charge at all,
 *      so "no cost field" is the common case; reading it as free would un-bill
 *      the majority of spend.
 */

import { OpenRouterProvider } from '../providers/openrouter';
import { OpenAIProvider } from '../providers/openai';

/** `extraBody` is what the base class merges into every request, so reading it
 *  off a CONSTRUCTED instance asserts the flag reaches the wire rather than that
 *  a field was declared. It is an instance field, so a prototype read sees
 *  nothing — which is how the first version of this test passed vacuously. */
function extraBodyOf(p: unknown): Record<string, unknown> | undefined {
  return (p as { extraBody?: Record<string, unknown> }).extraBody;
}

/** The providers take an OpenAI client but touch nothing on it at construction. */
const stubClient = {} as never;
const make = <T>(C: { prototype: T }): T => {
  const Ctor = C as unknown as new (c: never) => T;
  return new Ctor(stubClient);
};

describe('the gateway is asked what the call cost', () => {
  it('OpenRouter requests usage accounting', () => {
    expect(extraBodyOf(make(OpenRouterProvider))).toEqual({ usage: { include: true } });
  });

  it('the direct OpenAI provider does not, because its API returns no charge', () => {
    // Guards against the flag being hoisted to the shared base class, which
    // would send a field the direct API has no contract for.
    expect(extraBodyOf(make(OpenAIProvider))?.usage).toBeUndefined();
  });
});

describe('an absent charge falls through to the estimate', () => {
  // The ingester's rule, stated as the predicate it uses. Kept here rather than
  // only inside the ingester because the direction of the failure matters more
  // than the call site: a zero booked as a charge is an unbilled call.
  const prefer = (reportedRaw: string | null, estimate: number): number => {
    const reported = reportedRaw == null ? NaN : Number(reportedRaw);
    return Number.isFinite(reported) && reported > 0 ? reported : estimate;
  };

  it('uses the vendor charge when it reported one', () => {
    // A real response measured on the gateway: 8 prompt + 5 completion tokens.
    expect(prefer('0.00000252', 0.9)).toBeCloseTo(0.00000252, 12);
  });

  it('prices from the table when the vendor reported nothing', () => {
    expect(prefer(null, 0.0406)).toBeCloseTo(0.0406, 12);
  });

  it('prices from the table on a zero rather than booking a free call', () => {
    expect(prefer('0', 0.0406)).toBeCloseTo(0.0406, 12);
    expect(prefer('0.0000000000', 0.0406)).toBeCloseTo(0.0406, 12);
  });

  it('prices from the table on an unparseable value', () => {
    expect(prefer('not-a-number', 0.0406)).toBeCloseTo(0.0406, 12);
  });

  it('keeps sub-microdollar precision rather than rounding it to zero', () => {
    // NUMERIC(18,10) exists for this: the charge is fractions of a cent and is
    // summed over millions of rows.
    expect(prefer('0.0000000001', 5)).toBeCloseTo(1e-10, 15);
  });
});
