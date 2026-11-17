// Live ground truth for web_x_search, against api.x.ai.
//
// Skipped by default. Run with:
//   LIVE_TESTS=true XAI_API_KEY=xai-... npx jest xai-x-search.live
//
// The unit test beside this one asserts against a fixture, and a fixture only
// ever proves we parse what we already believed. Everything this client does
// was shaped by probing the real API precisely because the belief was wrong
// twice: x_search does not emit `x_search_call` items, and its billable count
// is not the number of tool-call items in the output.
//
// So this asserts the two things that decide whether the tool works and whether
// it bills: that real posts come back with real x.com citations, and that the
// vendor's own call count is non-zero.

import { XaiClient } from '../xai-client';

jest.mock('../web-tool-secrets', () => ({
  getWebToolSecret: jest.fn(async () => process.env.XAI_API_KEY as string),
}));

const live = process.env.LIVE_TESTS === 'true' && !!process.env.XAI_API_KEY;
const maybe = live ? describe : describe.skip;

maybe('web_x_search, against api.x.ai', () => {
  jest.setTimeout(180_000);

  it('finds real posts and reports what it was billed for', async () => {
    const out = await new XaiClient().xSearch({
      query: 'xAI Grok announcements',
      maxSources: 10,
    });

     
    console.log(
      `live x_search: answerChars=${out.answer.length} sources=${out.sources.length} costMicros=${out.costMicros}`,
    );

    // It answered at all.
    expect(out.answer.length).toBeGreaterThan(0);
    // It actually searched — the count is the vendor's, and it is what the
    // $5/1,000 charge is levied on. Zero here means the model answered from
    // recollection, which is a different product than "search X".
    expect(out.costMicros).toBeGreaterThan(0);
    // The citations point at X, not at articles about X. This is the whole
    // reason the tool exists rather than deferring to web_research.
    expect(out.sources.length).toBeGreaterThan(0);
    for (const s of out.sources) {
      expect(s.url).toMatch(/^https:\/\/(x\.com|twitter\.com)\//);
    }
  });
});
