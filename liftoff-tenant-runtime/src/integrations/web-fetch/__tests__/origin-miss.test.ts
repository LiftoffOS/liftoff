// A missing page is recognised BY SHAPE, per vendor, and nothing else.
//
// Every fetch client signals "the vendor answered and the page yielded
// nothing" with its own error class at statusCode 200. A vendor 404 is NOT a
// miss on its own (it can be the vendor's own API route), a network error is
// not, a 5xx is not. Only the vendor's own empty-answer shape, Tavily's
// per-URL origin failure naming an HTTP client status, or a browser's
// navigation response carrying one, is.

import { isOriginPageMiss, ExtractionEmpty } from '../origin-miss';
import { ExaError } from '../exa-client';
import { TavilyError } from '../tavily-client';
import { FirecrawlError } from '../firecrawl-client';
import { WebClawError } from '../webclaw-client';
import { PerplexityError } from '../perplexity-client';
import { AnchorError } from '../anchor-client';
import { SteelError } from '../steel-client';
import { OriginAnsweredForPage } from '../browser-navigation';

describe('isOriginPageMiss', () => {
  it("recognises each vendor's own 200-empty shape", () => {
    expect(isOriginPageMiss('exa', new ExaError('Empty content from Exa /contents (likely antibot block or unsupported URL)', 200))).toBe(true);
    expect(isOriginPageMiss('tavily', new TavilyError('Tavily /extract failed: 404 page not found', 200))).toBe(true);
    expect(isOriginPageMiss('tavily', new TavilyError('Empty content from Tavily /extract (likely antibot block)', 200))).toBe(true);
    expect(isOriginPageMiss('firecrawl', new FirecrawlError('Empty markdown from Firecrawl (likely antibot block)', 200))).toBe(true);
    expect(isOriginPageMiss('webclaw', new WebClawError('Empty markdown from WebClaw (likely antibot block)', 200))).toBe(true);
    expect(isOriginPageMiss('perplexity', new PerplexityError('Empty content from Perplexity fetch_url (likely antibot block)', 200))).toBe(true);
    expect(isOriginPageMiss('perplexity', new PerplexityError('Perplexity fetch_url returned no result for the page (no_result_returned)', 200))).toBe(true);
    expect(isOriginPageMiss('anchor', new AnchorError('Anchor Web Unlocker returned empty content', 200))).toBe(true);
  });

  it("reads Tavily's per-URL origin failure naming a client status as a miss, whatever the call's own status", () => {
    expect(isOriginPageMiss('tavily', new TavilyError('Tavily /extract failed: 404 page not found', 400))).toBe(true);
    expect(isOriginPageMiss('tavily', new TavilyError('Tavily /extract failed: HTTP 410 Gone', 500))).toBe(true);
    // A server status named for the page is the origin being down, not the
    // page being absent.
    expect(isOriginPageMiss('tavily', new TavilyError('Tavily /extract failed: 503 service unavailable', 400))).toBe(false);
  });

  it("reads a browser's navigation answer for any browser vendor: the origin answered a client status for the page", () => {
    expect(isOriginPageMiss('steel', new OriginAnsweredForPage(404))).toBe(true);
    expect(isOriginPageMiss('browser_use', new OriginAnsweredForPage(410))).toBe(true);
    expect(isOriginPageMiss('browserbase', new OriginAnsweredForPage(404))).toBe(true);
    expect(isOriginPageMiss('anchor', new OriginAnsweredForPage(404))).toBe(true);
    // A browser's own API errors carry no origin status, and Chromium's
    // navigation failure for an empty error body names none: neither is a miss.
    expect(isOriginPageMiss('steel', new SteelError('steel POST /sessions: HTTP 404 Not Found', 404))).toBe(false);
    expect(isOriginPageMiss('browser_use', new Error('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at https://x.test/gone'))).toBe(false);
  });

  it('is NOT a miss on a vendor API 404: that can be the vendor route itself', () => {
    expect(isOriginPageMiss('tavily', new TavilyError('Not Found', 404))).toBe(false);
    expect(isOriginPageMiss('exa', new ExaError('Not Found', 404))).toBe(false);
    expect(isOriginPageMiss('firecrawl', new FirecrawlError('route not found', 404))).toBe(false);
  });

  it('is NOT a miss on a network error, a 5xx or a foreign class', () => {
    expect(isOriginPageMiss('exa', new ExaError('fetch failed', 0))).toBe(false);
    expect(isOriginPageMiss('exa', new ExaError('upstream error', 502))).toBe(false);
    expect(isOriginPageMiss('exa', new Error('Empty content from Exa /contents'))).toBe(false);
    // The right shape, the wrong vendor: not this vendor's statement.
    expect(isOriginPageMiss('exa', new TavilyError('Tavily /extract failed: 404 page not found', 200))).toBe(false);
    // A vendor this module knows no shape for fails closed.
    expect(isOriginPageMiss('browser_use', new Error('anything') as unknown as ExaError)).toBe(false);
  });

  it("treats the router's own empty-extraction signal as a miss for any vendor", () => {
    expect(isOriginPageMiss('firecrawl', new ExtractionEmpty('firecrawl'))).toBe(true);
    expect(isOriginPageMiss('browserbase', new ExtractionEmpty('browserbase'))).toBe(true);
  });
});
