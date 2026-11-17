// Did the vendor answer, and the PAGE yield nothing?
//
// A missing page is an answer, not a failure. Every fetch client already
// signals "the vendor answered and the page gave nothing back" with its own
// error class at `statusCode 200` — Exa's empty `/contents`, Tavily's
// `failed_results[].error` (which carries the origin's own failure, such as
// `404 page not found`), Firecrawl's empty markdown, WebClaw's, Perplexity's,
// Anchor's. A browser's is the origin's own client status for the page it
// navigated to (`browser-navigation.ts`, one shape for every browser vendor,
// because Chromium's own failure for an error status with an empty body
// names no status). The router then rethrew the last of them, the tool handler
// discarded it for `Failed to fetch URL.`, and the gateway classified that
// string as `internal_error`: three guessed addresses that did not exist read
// as a broken connector, and a step that had fetched thirty pages was aborted
// for "connectivity".
//
// This helper recognises the miss BY SHAPE, per vendor, and nothing else. A
// vendor `statusCode 404` is NOT a miss on its own — it can be the vendor's
// own API route — so it fails closed to today's error. A network error, a
// 5xx, an admission block: not a miss. Mixed exhaustion stays on today's
// classification; only a chain where EVERY vendor reported a miss is one.

import { AnchorError } from './anchor-client';
import { OriginAnsweredForPage } from './browser-navigation';
import { ExaError } from './exa-client';
import { FirecrawlError } from './firecrawl-client';
import { PerplexityError } from './perplexity-client';
import { TavilyError } from './tavily-client';
import { WebClawError } from './webclaw-client';
import type { WebVendor } from './types';
import { redactUrl } from './url-redactor';

/**
 * The page could not be retrieved, and that is the whole finding.
 *
 * Raised by the router only when EVERY vendor the chain tried answered and
 * reported that the page yielded nothing (`isOriginPageMiss` below). The tool
 * handler turns it into `not_found`, non-retryable, naming the address — a
 * fact about one page, not a broken tool. Mixed exhaustion (one miss and one
 * 5xx, say) keeps today's classification: this class is never raised for it.
 *
 * Defined beside the shape rule rather than in the router so a handler can
 * name the class without importing the router's vendor clients.
 */
export class PageUnretrievable extends Error {
  public readonly url: string;
  public readonly failures: Array<{ vendor: WebVendor; reason: string }>;
  constructor(url: string, failures: Array<{ vendor: WebVendor; reason: string }>) {
    super(`No content could be retrieved for ${redactUrl(url)}`);
    this.name = 'PageUnretrievable';
    this.url = url;
    this.failures = failures;
  }
}

/** The router's own signal for `extract`: the vendor answered and handed back
 *  no extraction at all (`data` undefined or null). The extract clients do not
 *  throw on that — the firecrawl client returns `data.data?.json` as it is —
 *  so the router validates the result centrally and raises this, which the
 *  classifier reads as a miss for that vendor whatever the vendor is. `{}` is
 *  a valid extraction and never raises it. */
export class ExtractionEmpty extends Error {
  constructor(public readonly vendor: WebVendor) {
    super(`Empty extraction from ${vendor} (no data)`);
    this.name = 'ExtractionEmpty';
  }
}

/** The clients' own empty-answer signal: their error class at 200. */
const EMPTY_ANSWER_STATUS = 200;

/** Tavily's `/extract` reports the origin's failure per URL in
 *  `failed_results[].error`; the client carries it into the message under this
 *  prefix. A client status (4xx) named there is the ORIGIN's answer for the
 *  page, whatever status the vendor call itself returned. */
const TAVILY_ORIGIN_FAILURE = /^Tavily \/extract failed: /;
const HTTP_CLIENT_STATUS = /\b4\d\d\b/;

function ownError(vendor: WebVendor, err: unknown): { statusCode: number; message: string } | null {
  switch (vendor) {
    case 'exa':        return err instanceof ExaError ? err : null;
    case 'tavily':     return err instanceof TavilyError ? err : null;
    case 'firecrawl':  return err instanceof FirecrawlError ? err : null;
    case 'webclaw':    return err instanceof WebClawError ? err : null;
    case 'perplexity': return err instanceof PerplexityError ? err : null;
    case 'anchor':     return err instanceof AnchorError ? err : null;
    default:           return null;
  }
}

/**
 * True iff `err` is `vendor`'s own statement that it answered and the page
 * yielded nothing. Anything else — another class, another status, a vendor
 * this module does not know the shape for — is not a miss.
 */
export function isOriginPageMiss(vendor: WebVendor, err: unknown): boolean {
  if (err instanceof ExtractionEmpty) return true;
  // A browser's statement, whichever vendor drove it: the origin answered a
  // client status for the page. Its API errors and Playwright's own carry none.
  if (err instanceof OriginAnsweredForPage) return true;
  const own = ownError(vendor, err);
  if (!own) return false;
  if (own.statusCode === EMPTY_ANSWER_STATUS) return true;
  if (vendor === 'tavily' && TAVILY_ORIGIN_FAILURE.test(own.message)) {
    return HTTP_CLIENT_STATUS.test(own.message.replace(TAVILY_ORIGIN_FAILURE, ''));
  }
  return false;
}
