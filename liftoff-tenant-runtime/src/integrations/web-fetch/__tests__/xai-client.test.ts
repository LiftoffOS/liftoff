// web_x_search, against the response shape api.x.ai actually returns.
//
// The fixture below is trimmed from a real probe, not invented, because every
// assumption this client makes was wrong in the docs' summary of it:
//
//   - x_search does NOT emit `x_search_call` output items the way web_search
//     emits `web_search_call`. It fans out internally to x_keyword_search and
//     x_semantic_search, which arrive as `custom_tool_call`.
//   - the findings are prose in the `message` item, with `url_citation`
//     annotations naming the posts — there is no structured results block.
//   - the BILLABLE count is `usage.server_side_tool_usage_details.x_search_calls`,
//     which is not the number of custom_tool_call items.
//
// The last one is the money: the tool fee is $5/1,000 calls, so counting the
// items instead would charge for the fan-out rather than the searches. And the
// fee is the FLOOR, not the cost: `usage.cost_in_usd_ticks` is what xAI billed
// for the whole request, tokens included (1 USD = 10^10 ticks), and a live
// web_search with five calls came back at $0.045 against a $0.025 fee.

jest.mock('../web-tool-secrets', () => ({
  getWebToolSecret: jest.fn().mockResolvedValue('xai-test-key'),
}));

import { XaiClient } from '../xai-client';

/** Trimmed from a live api.x.ai response to the fields this client reads. */
function xaiResponse(over: {
  text?: string;
  annotations?: Array<{ type?: string; url?: string; title?: string }>;
  xSearchCalls?: number;
  /** Omit the vendor's exact figure (`false`) or set it in ticks. */
  costTicks?: number | false;
} = {}) {
  return {
    output: [
      { type: 'reasoning' },
      { type: 'custom_tool_call', name: 'x_keyword_search' },
      { type: 'custom_tool_call', name: 'x_semantic_search' },
      {
        type: 'message',
        content: [{
          type: 'output_text',
          text: over.text ?? 'Two accounts posted about it.',
          annotations: over.annotations ?? [
            { type: 'url_citation', url: 'https://x.com/a/status/1', title: '1' },
            { type: 'url_citation', url: 'https://x.com/b/status/2', title: '2' },
          ],
        }],
      },
    ],
    usage: {
      server_side_tool_usage_details: { x_search_calls: over.xSearchCalls ?? 2 },
      ...(over.costTicks === false ? {} : { cost_in_usd_ticks: over.costTicks ?? 452_284_000 }),
    },
  };
}

function mockFetch(body: unknown, ok = true, status = 200) {
  global.fetch = jest.fn().mockResolvedValue({
    ok, status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as typeof fetch;
}

afterEach(() => jest.restoreAllMocks());

it('returns the prose answer and the posts it cited', async () => {
  mockFetch(xaiResponse());
  const out = await new XaiClient().xSearch({ query: 'grok' });
  expect(out.answer).toBe('Two accounts posted about it.');
  // The annotation's title is the citation's ordinal, which names nothing; the
  // URL stands in for it.
  expect(out.sources).toEqual([
    { url: 'https://x.com/a/status/1', title: 'https://x.com/a/status/1' },
    { url: 'https://x.com/b/status/2', title: 'https://x.com/b/status/2' },
  ]);
  expect(out.vendor).toBe('xai');
});

it('bills what xAI says the request cost, tokens and tool fees together', async () => {
  // 452,284,000 ticks at 10^10 ticks a dollar is $0.0452284 → 45,228 micros.
  mockFetch(xaiResponse({ xSearchCalls: 2, costTicks: 452_284_000 }));
  const out = await new XaiClient().xSearch({ query: 'grok' });
  expect(out.costMicros).toBe(45_228);
});

it('falls back to the vendors OWN call count at the tool fee, not the internal fan-out', async () => {
  // Three custom_tool_call items would be three charges if we counted items.
  // xAI says it ran 2 searches; 2 × $0.005 = 10,000 micros — the floor, when
  // the response carries no exact figure.
  mockFetch(xaiResponse({ xSearchCalls: 2, costTicks: false }));
  const out = await new XaiClient().xSearch({ query: 'grok' });
  expect(out.costMicros).toBe(10_000);
});

it('charges nothing when the model answered without searching and reported no cost', async () => {
  // A real outcome: the model can answer from its own recollection. Billing a
  // search that did not happen is the mirror of missing one that did.
  mockFetch(xaiResponse({ xSearchCalls: 0, costTicks: false }));
  const out = await new XaiClient().xSearch({ query: 'grok' });
  expect(out.costMicros).toBe(0);
});

it('de-duplicates a post cited several times', async () => {
  // xAI annotates every span it drew from, so one post backing three sentences
  // appears three times. A source list that repeats is noise, not three posts.
  mockFetch(xaiResponse({
    annotations: [
      { type: 'url_citation', url: 'https://x.com/a/status/1', title: '1' },
      { type: 'url_citation', url: 'https://x.com/a/status/1', title: '1' },
      { type: 'url_citation', url: 'https://x.com/b/status/2', title: '2' },
    ],
  }));
  const out = await new XaiClient().xSearch({ query: 'grok' });
  expect(out.sources.map(s => s.url)).toEqual([
    'https://x.com/a/status/1',
    'https://x.com/b/status/2',
  ]);
});

it('ignores annotations that are not url citations', async () => {
  mockFetch(xaiResponse({
    annotations: [
      { type: 'file_citation', url: 'https://x.com/a/status/1' },
      { type: 'url_citation', url: 'https://x.com/b/status/2', title: '2' },
    ],
  }));
  const out = await new XaiClient().xSearch({ query: 'grok' });
  expect(out.sources).toEqual([{ url: 'https://x.com/b/status/2', title: 'https://x.com/b/status/2' }]);
});

it('sends x_search as a server-side tool, on the Responses surface', async () => {
  // Chat Completions rejects `{"type":"x_search"}` outright, so the endpoint and
  // the tool declaration are one decision rather than two.
  mockFetch(xaiResponse());
  await new XaiClient().xSearch({ query: 'grok', fromDate: '2026-09-01', handles: ['@elonmusk'] });
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
  expect(String(url)).toContain('/v1/responses');
  const sent = JSON.parse((init as { body: string }).body);
  expect(sent.tools).toEqual([{ type: 'x_search' }]);
  // The filters have no parameters to live in, so they ride in the instruction.
  expect(sent.input[0].content).toContain('2026-09-01');
  expect(sent.input[0].content).toContain('@elonmusk');
});

it('fails loudly on a vendor error rather than returning an empty answer', async () => {
  // An empty answer with zero sources reads as "nothing was said on X", which
  // is a different claim from "the search did not run".
  mockFetch({ error: 'bad request' }, false, 400);
  await expect(new XaiClient().xSearch({ query: 'grok' })).rejects.toThrow(/HTTP 400/);
});

// The bridged web_search for a Grok run: xAI's hosted `web_search`, on the
// same surface as x_search, answering in prose with the pages it cited.
describe('XaiClient.webSearch', () => {
  function webResponse(over: { webSearchCalls?: number; items?: unknown[]; usageDetails?: boolean; costTicks?: number | false } = {}) {
    return {
      output: [
        { type: 'reasoning' },
        ...(over.items ?? [{ type: 'web_search_call' }, { type: 'web_search_call' }]),
        {
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'Two pages cover it.',
            annotations: [
              { type: 'url_citation', url: 'https://a.example/1', title: 'A' },
              { type: 'url_citation', url: 'https://a.example/1', title: 'A' },
              { type: 'url_citation', url: 'https://b.example/2', title: 'B' },
            ],
          }],
        },
      ],
      usage: {
        ...(over.usageDetails === false
          ? {}
          : { server_side_tool_usage_details: { web_search_calls: over.webSearchCalls ?? 2 } }),
        ...(over.costTicks === false ? {} : { cost_in_usd_ticks: over.costTicks ?? 452_284_000 }),
      },
    };
  }

  it('returns the cited pages as results, deduped, with the prose as the summary', async () => {
    mockFetch(webResponse());
    const out = await new XaiClient().webSearch({ query: 'liftoff' });
    expect(out.results).toEqual([
      { url: 'https://a.example/1', title: 'A' },
      { url: 'https://b.example/2', title: 'B' },
    ]);
    expect(out.summary).toBe('Two pages cover it.');
    expect(out.vendor).toBe('xai');
  });

  it('bills what xAI says the request cost, tokens and tool fees together', async () => {
    mockFetch(webResponse({ webSearchCalls: 5, costTicks: 452_284_000 }));
    const out = await new XaiClient().webSearch({ query: 'liftoff' });
    expect(out.costMicros).toBe(45_228);
  });

  it('falls back to the vendor\'s own call count at $0.005 a call', async () => {
    mockFetch(webResponse({ webSearchCalls: 3, costTicks: false }));
    const out = await new XaiClient().webSearch({ query: 'liftoff' });
    expect(out.costMicros).toBe(15_000);
  });

  it('counts web_search_call output items when the usage block reports neither cost nor category', async () => {
    mockFetch(webResponse({ usageDetails: false, costTicks: false, items: [{ type: 'web_search_call' }] }));
    const out = await new XaiClient().webSearch({ query: 'liftoff' });
    expect(out.costMicros).toBe(5_000);
  });

  it('sends web_search as a server-side tool on the Responses surface, with the cap in the instruction', async () => {
    mockFetch(webResponse());
    await new XaiClient().webSearch({ query: 'liftoff', maxResults: 3 });
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(url)).toContain('/v1/responses');
    const sent = JSON.parse((init as { body: string }).body);
    expect(sent.tools).toEqual([{ type: 'web_search' }]);
    expect(sent.input[0].content).toContain('liftoff');
    expect(sent.input[0].content).toContain('up to 3 pages');
  });

  it('fails loudly on a vendor error', async () => {
    mockFetch({ error: 'bad request' }, false, 400);
    await expect(new XaiClient().webSearch({ query: 'liftoff' })).rejects.toThrow(/HTTP 400/);
  });
});
