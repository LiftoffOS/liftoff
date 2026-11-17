// Liftoff's own xAI account, for MANAGED Grok.
//
// Separate from the gateway provider a BYOK run gets: that one carries a
// short-lived per-run token and is built per call, because caching a client
// keyed by a rotating credential is how a revoked key keeps being used. This
// one is built once.
//
// THE RESPONSES SURFACE. api.x.ai serves `/v1/responses` (verified against the
// live API), and it is the ONLY surface carrying xAI's server-side tools: chat
// completions rejects `{"type":"web_search"}` outright, naming `function` and
// `live_search` as the only tool types it knows, and Live Search is a
// different, older feature. So the vendor's own web_search is reachable only
// here — and the same surface is what produces the `web_search_call` output
// items the run loop counts for per-call billing.

import { OpenAIProvider as SdkOpenAIProvider } from '@openai/agents-openai';

let xaiProvider: SdkOpenAIProvider | null = null;

/** Undefined when no key is configured. The xAI TARGET turns that into a
 *  refusal rather than passing it on, because undefined means "use the SDK's
 *  default" and the SDK's default is an OpenAI client — which would report a
 *  missing OPENAI_API_KEY for a run that has nothing to do with OpenAI. */
export async function getSdkXaiProvider(): Promise<SdkOpenAIProvider | undefined> {
  if (xaiProvider) return xaiProvider;
  const { getXaiApiKey } = await import('../../../infrastructure/secrets');
  const apiKey = await getXaiApiKey();
  if (!apiKey) return undefined;
  const { XAI_BASE_URL } = await import('../../../llm/providers/xai');
  xaiProvider = new SdkOpenAIProvider({
    apiKey,
    baseURL: `${process.env.XAI_BASE_URL ?? XAI_BASE_URL}/v1`,
  });
  return xaiProvider;
}
