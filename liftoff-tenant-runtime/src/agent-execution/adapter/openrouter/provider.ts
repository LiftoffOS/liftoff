// OpenRouter, on Liftoff's account — the open-weight models (GLM, Qwen,
// DeepSeek, Kimi).
//
// Chat Completions, not Responses: `useResponses:false` is set on THIS provider
// only, never via a process-global, so concurrent Responses runs on other
// vendors are unaffected.
//
// Two auth modes. The default is an OpenRouter API key; `OPENROUTER_AUTH_MODE=adc`
// points the same wire at Vertex AI Model Garden inside GCP, where the
// credential is an ADC bearer refreshed per request rather than a static key.

import { fetchLoggingShapeOnRejection } from '../request-shape-on-rejection';
import { fetchRequestingUsageAccounting } from './usage-accounting';
import { OpenAIProvider as SdkOpenAIProvider } from '@openai/agents-openai';
import { getOpenRouterApiKey } from '../../../infrastructure/secrets';

let openRouterProvider: SdkOpenAIProvider | null = null;

/** Undefined when no key is configured. The OpenRouter TARGET turns that into a
 *  refusal, for the same reason the xAI one does: undefined means "use the
 *  SDK's default", and that default is an OpenAI client. */
export async function getSdkOpenRouterProvider(): Promise<SdkOpenAIProvider | undefined> {
  if (openRouterProvider) return openRouterProvider;
  if ((process.env.OPENROUTER_AUTH_MODE ?? 'openrouter') === 'adc') {
    // Vertex AI Model Garden (in-GCP). ADC bearer refreshed per request via a
    // custom fetch on a raw OpenAI client, handed to the agents-SDK provider.
    const { GoogleAuth } = await import('google-auth-library');
    const OpenAI = (await import('openai')).default;
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT_ID ?? '';
    const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
    const baseURL = `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/endpoints/openapi`;
    const adcFetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const token = await auth.getAccessToken();
      const headers = new Headers(init?.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return fetch(url, { ...init, headers });
    }) as unknown as typeof fetch;
    // No usage-accounting wrapper here: this is Vertex AI Model Garden, which
    // returns no per-call charge, and a flag it does not understand is a body
    // field on a request that has to succeed. Model Garden also serves one
    // endpoint per model, so the estimate has no endpoint spread to be wrong
    // about — the reason the flag exists does not apply.
    const client = new OpenAI({ apiKey: 'vertex-adc', baseURL, fetch: adcFetch });
    // Cast: @openai/agents-openai bundles its own copy of `openai`, so the
    // dynamically-imported client is structurally identical but a nominally
    // different type (version skew). Runtime is correct. Reference the SDK's own
    // option type via ConstructorParameters (no named-export dependency).
    type OpenRouterClient = NonNullable<NonNullable<ConstructorParameters<typeof SdkOpenAIProvider>[0]>['openAIClient']>;
    openRouterProvider = new SdkOpenAIProvider({ openAIClient: client as unknown as OpenRouterClient, useResponses: false });
    return openRouterProvider;
  }
  const apiKey = await getOpenRouterApiKey();
  if (!apiKey) return undefined;
  // A raw client, so the fetch can be wrapped. OpenRouter fans a request out
  // to a provider that answers a malformed one with a code and no parameter
  // name; the wrapper logs the request's shape on a 4xx, which is the only
  // record of what was actually sent.
  const OpenAI = (await import('openai')).default;
  const client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    // Composed inside-out: the accounting flag is added to the body, then the
    // shape logger sees the body that will actually be sent. Reversing them
    // would log a request missing the field it was sent with.
    fetch: fetchRequestingUsageAccounting(fetchLoggingShapeOnRejection(fetch, 'openrouter')),
  });
  type OpenRouterClient = NonNullable<NonNullable<ConstructorParameters<typeof SdkOpenAIProvider>[0]>['openAIClient']>;
  openRouterProvider = new SdkOpenAIProvider({ openAIClient: client as unknown as OpenRouterClient, useResponses: false });
  return openRouterProvider;
}
