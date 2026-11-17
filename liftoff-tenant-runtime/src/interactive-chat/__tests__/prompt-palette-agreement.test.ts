// The prompt must only name tools the agent actually HAS.
//
// The failure this exists for: the system prompt told a Browser Use agent
// "the tool is run_browser_task" and "first tool call MUST be
// run_browser_task". That tool is Anchor-gated, so it was absent from the
// palette. The model went looking for the tool it had been ordered to use,
// could not find it, and told the user "I don't have access to a web browser
// or any tools in this conversation" — which read as a broken agent and was
// the prompt naming something that was not there.
//
// A prompt that names an absent tool is worse than one that names none: the
// model reasons from the instruction, not from the catalog.
jest.mock('../../integrations/web-fetch/global-flags', () => ({
  getAllVendorFlags: jest.fn().mockResolvedValue({
    webclaw: true, firecrawl: true, perplexity: true, anchor: true,
    browserbase: true, tavily: true, exa: true, openai: true, google: true, browser_use: true,
  }),
}));
jest.mock('../../integrations/web-fetch/web-tool-secrets', () => ({
  getTenantConnectedWebVendors: jest.fn().mockResolvedValue(new Set(['browser_use'])),
}));
jest.mock('../../browser-sessions/repository', () => ({ getActiveForThread: jest.fn().mockResolvedValue(null) }));
jest.mock('../../skills/retrieval', () => ({ skillDisclosureMode: () => 'inline' }));

import { buildExposedStandardTools } from '../../integrations/web-fetch/expose-tools';
import { STANDARD_TOOLS } from '../../tools/standard-tools';
import { buildAgentChatSystemPrompt } from '../system-prompt';

const base = {
  agent: { name: 'A', role: 'R' }, user: { firstName: 'U' }, tenantName: 'T',
  channel: 'chat' as const, hitlLevel: 'none' as const,
};

/** Tools the prompt tells the model to CALL, as opposed to ones it merely
 *  mentions to explain what they are. A directive looks like "call `x`",
 *  "the tool is `x`", "MUST be `x(`", or an example invocation `x({`. */
function toolsThePromptDirects(prompt: string): string[] {
  const hits = new Set<string>();
  for (const m of prompt.matchAll(/`([a-z_]+)\(\{/g)) hits.add(m[1]);          // example calls
  for (const m of prompt.matchAll(/(?:the tool is|call|MUST be)\s+\\?`([a-z_]+)\\?`/g)) hits.add(m[1]);
  return [...hits];
}

it('names no tool a browser_use-bound agent does not have', async () => {
  const exposed = new Set(
    (await buildExposedStandardTools(STANDARD_TOOLS, 't1', {
      threadId: 'th1', messageSenderAccountId: 'acc1',
      hasActiveBrowserSession: false,
      allowedConnectors: ['browser_use'],
    })).map(t => t.name),
  );
  const prompt = buildAgentChatSystemPrompt({
    ...base, activeBrowserSession: null, hasBrowserConnector: true,
  } as never);

  const directed = toolsThePromptDirects(prompt);
  // Only judge tools that are OURS; the prompt also names SDK builtins.
  const ours = new Set(STANDARD_TOOLS.map(t => t.name));
  // A tool the prompt explicitly says is unavailable is not a directive to use
  // it. Anything else it tells the model to call must actually be there.
  const disclaimed = new Set(
    [...prompt.matchAll(/`([a-z_]+)` is NOT available/g)].map(m => m[1]),
  );
  const missing = directed.filter(n => ours.has(n) && !exposed.has(n) && !disclaimed.has(n));

  if (missing.length) {
     
    console.error('prompt directs tools not in the palette:', missing);
  }
  expect(missing).toEqual([]);
});
