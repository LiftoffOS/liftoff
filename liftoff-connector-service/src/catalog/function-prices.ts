// What one call of a platform-funded function costs the platform, in USD, by
// connector type and function name — the vendor's listed per-call price, the
// same figure each executor books when the vendor reports no charge of its
// own. Read by platform-backend's capability discovery so cost can rank:
// two functions that fit a need equally well are not equally good when one
// is thirty times the price of the other, and a keyless read of a free
// source (nasdaq) is the cheapest answer there is. Only platform-funded
// vendors appear: a BYO card's charge is the workspace's own and unknown
// here; a store actor's is quoted by the store.
//
// Assembled from the dispatch tables, so a price cannot drift from the
// executor that charges it.

import { LOCUS_DISPATCH } from './generated/locus.js';
import { LOCUS_PARSE_DISPATCH } from './generated/locus-parse.js';
import { VAAYA_DISPATCH } from './generated/vaaya.js';
import { KADEC0_DISPATCH } from './generated/kadec0.js';
import { GOOGLE_TRENDS_DISPATCH } from './generated/google-trends.js';
import { BROWSERBASE_X402_DISPATCH } from './generated/browserbase-x402.js';
import { STRALE_DISPATCH } from './generated/strale.js';
import { TIKHUB_DISPATCH } from './generated/tikhub.js';
import { TIKHUB_PRICES } from './generated/tikhub-prices.js';
import { DEFILLAMA_FUNCTIONS } from './generated/defillama.js';
import { NASDAQ_FUNCTIONS } from './generated/nasdaq.js';
import { YCOMBINATOR_FUNCTIONS } from './generated/ycombinator.js';
import { GLORIA_PREMIUM_REST } from '../clients/gloria-mcp.js';

function fromDispatch(table: Record<string, { priceUsd?: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [fn, entry] of Object.entries(table)) {
    if (typeof entry.priceUsd === 'number' && Number.isFinite(entry.priceUsd) && entry.priceUsd >= 0) out[fn] = entry.priceUsd;
  }
  return out;
}

function tikhub(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [fn, entry] of Object.entries(TIKHUB_DISPATCH)) {
    const usd = entry.priceUsd ?? TIKHUB_PRICES[entry.path];
    if (typeof usd === 'number' && Number.isFinite(usd)) out[fn] = usd;
  }
  return out;
}

/** Free at the source: every function is a keyless read, priced at zero. */
function free(functions: ReadonlyArray<{ name: string }>): Record<string, number> {
  return Object.fromEntries(functions.map((f) => [f.name, 0]));
}

const PRICES: Record<string, Record<string, number>> = {
  locus: fromDispatch({ ...LOCUS_DISPATCH, ...LOCUS_PARSE_DISPATCH }),
  vaaya: fromDispatch(VAAYA_DISPATCH),
  kadec0: fromDispatch(KADEC0_DISPATCH),
  google_trends: fromDispatch(GOOGLE_TRENDS_DISPATCH),
  browserbase_x402: fromDispatch(BROWSERBASE_X402_DISPATCH),
  strale: fromDispatch(STRALE_DISPATCH),
  tikhub: tikhub(),
  gloria: fromDispatch(GLORIA_PREMIUM_REST),
  defillama: free(DEFILLAMA_FUNCTIONS),
  nasdaq: free(NASDAQ_FUNCTIONS),
  ycombinator: free(YCOMBINATOR_FUNCTIONS),
};

/** The per-call prices of a connector type's platform-funded functions, or
 *  undefined when the type has none the platform pays for. */
export function getFunctionPrices(connectorType: string): Record<string, number> | undefined {
  const prices = PRICES[connectorType];
  return prices && Object.keys(prices).length > 0 ? prices : undefined;
}
