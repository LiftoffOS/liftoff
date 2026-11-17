// Live ground truth for Grok's hosted web_search: does it RUN, and do we COUNT it?
//
// Skipped by default. Run with:
//   LIVE_TESTS=true XAI_API_KEY=xai-... npx jest xai-web-search.live
//
// Everything about this feature is a claim about a vendor boundary, and every
// unit test in the repo mocks that boundary away. Three separate defects got
// past unit tests and past a run's own `ok:true` before this existed:
//
//   1. the tool was rejected — 400 "Argument not supported: search_context_size",
//      because the SDK's webSearchTool() sends an OpenAI-only argument
//   2. a run that threw discarded the tokens it had already spent
//   3. the workflow-step loop dropped the per-call count, so searches billed 0
//
// What makes this test worth its cost is that it asserts the two things the
// money depends on — that a search actually happened, and that our count of it
// is non-zero — against the real API rather than against a fixture that would
// have agreed with all three bugs.

import { createXaiAdapter } from '../index';
import * as secrets from '../../../../infrastructure/secrets';
import type { McpToolCatalog } from '../../catalog-types';
import type { InvocationInput, InvocationEvent } from '../../types';

const live = process.env.LIVE_TESTS === 'true' && !!process.env.XAI_API_KEY;
const maybe = live ? describe : describe.skip;

maybe('Grok hosted web_search, against api.x.ai', () => {
  jest.setTimeout(180_000);

  beforeAll(() => {
    // The global setup mocks every provider-key getter to null, so the default
    // branch a unit test exercises is "no key configured". This suite is the
    // case that comment invites: it wants the real key, and says so.
    (secrets.getXaiApiKey as jest.Mock).mockResolvedValue(process.env.XAI_API_KEY);
  });

  it('runs a search and reports how many, so the per-call charge has an input', async () => {
    const adapter = new createXaiAdapter();
    const emptyCatalog: McpToolCatalog = { servers: [], tools: [] };
    adapter.registerToolCatalog(emptyCatalog);

    const input = {
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: 'Search the web for the most recent xAI announcement and reply in one sentence.',
        }],
      }],
      systemPrompt: 'You answer using the web when asked. Use your web_search tool.',
      model: 'grok-4.3',
      provider: 'xai',
      tenantId: 'live-test',
      invocationId: 'live-web-search',
      maxTurns: 4,
    } as unknown as InvocationInput;

    const events: InvocationEvent[] = [];
    for await (const e of adapter.invoke(input, new AbortController().signal)) events.push(e);

    const usage = events.filter((e) => e.type === 'usage') as Array<Extract<InvocationEvent, { type: 'usage' }>>;
    const searches = usage.reduce((n, u) => n + (u.usage.webSearchRequests ?? 0), 0);
    const tokens = usage.reduce((n, u) => n + (u.usage.inputTokens ?? 0), 0);

    // Printed because this is a diagnostic run against a live vendor: the
    // numbers are the evidence, and a pass with no numbers tells the next
    // person nothing about what actually happened.
     
    console.log(`live xai: inputTokens=${tokens} webSearchRequests=${searches}`);

    // The run reached the vendor at all.
    expect(tokens).toBeGreaterThan(0);
    // A hosted search actually ran, and we counted it. Zero here is the exact
    // shape of every defect above: a run that looks fine and bills nothing.
    expect(searches).toBeGreaterThan(0);
  });
});
