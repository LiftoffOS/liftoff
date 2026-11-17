// Z.ai / GLM Provider — OpenAI-wire, reached via OpenRouter (or a configurable
// base URL for Vertex/self-host). Subclasses OpenAIProvider so the entire
// request/stream/tool-translation is reused; only the base URL and the tier→model
// map differ — and the latter is overlaid from the `models` registry at runtime
// (60s refresh) so onboarding a model/tier is a DB row, not a code change.
import OpenAI from 'openai';
import { OpenAIProvider } from './openai';
import { getOpenRouterApiKey } from '../../infrastructure/secrets';
import { frontendOrigin } from '../../infrastructure/frontend-url';
import { log } from '../../infrastructure/logging';
import { GoogleAuth } from 'google-auth-library';
import { startRegistryTierRefresh } from '../registry-tier-loader';
import type { LLMModelTier } from '../types';

// Static seed for the tier→model map. The registry-tier loader overlays the latest
// approved model per tier from the `models` registry on top of this at runtime;
// this is the offline / first-boot fallback. Slugs verified against the live API.
export const OPENROUTER_TIER_MODELS: Record<LLMModelTier, string> = {
  large:    'z-ai/glm-5.3',
  medium:   'z-ai/glm-5.3',
  small:    'z-ai/glm-5.3-flash',
};
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
// 'openrouter' (default, public aggregator) | 'adc' (Vertex AI Model Garden, in-GCP).
const AUTH_MODE = process.env.OPENROUTER_AUTH_MODE ?? 'openrouter';

/** Vertex AI Model Garden OpenAI-compatible endpoint for the resolved project/region. */
function vertexBaseUrl(): string {
  const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT_ID ?? '';
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1';
  return `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${project}/locations/${location}/endpoints/openapi`;
}

/** Build the OpenAI-wire client for GLM. OpenRouter (static API key) by default;
 *  Vertex (ADC bearer, refreshed per request via a custom fetch — GoogleAuth caches
 *  and auto-refreshes near expiry) when OPENROUTER_AUTH_MODE=adc. Returns null only when
 *  the OpenRouter key is required but unset. */
async function makeOpenRouterClient(): Promise<OpenAI | null> {
  if (AUTH_MODE === 'adc') {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const adcFetch = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const token = await auth.getAccessToken();
      const headers = new Headers(init?.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return fetch(url, { ...init, headers });
    }) as unknown as typeof fetch;
    return new OpenAI({ apiKey: 'vertex-adc', baseURL: vertexBaseUrl(), fetch: adcFetch });
  }
  const apiKey = await getOpenRouterApiKey();
  if (!apiKey) return null;
  const referer = frontendOrigin();
  return new OpenAI({
    apiKey, baseURL: OPENROUTER_BASE_URL,
    // OpenRouter attributes usage to whatever these name, so a hard-coded pair
    // credits one deployment for every other deployment's spend. Sent only when
    // this one knows its own address; omitted otherwise, which costs nothing but
    // a leaderboard entry. frontendOrigin() returns null rather than throwing —
    // an attribution header is not worth failing a model call over.
    defaultHeaders: referer ? { 'HTTP-Referer': referer } : {},
  });
}

const OPENROUTER_VENDORS_WITHOUT_TOOL_CHOICE_NONE: ReadonlySet<string> = new Set(['z-ai', 'minimax']);

export class OpenRouterProvider extends OpenAIProvider {
  /** The gateway documents `cache_control` and every vendor behind it that was
   *  measured honours it — GLM, Qwen, DeepSeek, Kimi, MiniMax and Xiaomi all
   *  publish a cache-read rate, and Qwen cached MORE with an explicit
   *  breakpoint than without one (7,716 tokens against 7,168, repeat call
   *  2.1x cheaper). Without this the assistants' system prompt got whatever
   *  prefix the vendor chose on its own. */
  protected override emitsCacheControl(): boolean {
    return true;
  }

  /** Ask the gateway what the call cost, and use that instead of a rate.
   *
   *  A model here is served by MANY endpoints at different prices — Kimi K3 by
   *  nineteen, spanning $1.03 to $4.50 per million input — and which one served
   *  a given request is not knowable from any price list. So a synced rate
   *  cannot be accurate in principle: `sync-model-pricing` takes the max across
   *  endpoints because over-attributing is the safer error, and the cost of that
   *  safety is attributing at roughly twice the median.
   *
   *  `usage: { include: true }` makes the gateway return `usage.cost` — the real
   *  charge for this request — plus `cost_details` and the `provider` that served
   *  it. With that on the response there is no estimate to get wrong, in either
   *  direction: no over-charging a customer for an endpoint we did not use, and
   *  no under-charging ourselves when a dear endpoint is chosen.
   *
   *  It rides `extraBody`, which the base class merges into all three request
   *  paths (both non-streaming and the stream), so enabling it here cannot cover
   *  one path and miss another. On the stream the charge arrives on the same
   *  terminal chunk as the token totals. */
  protected override extraBody: Record<string, unknown> = { usage: { include: true } };

  static async createOpenRouter(): Promise<OpenRouterProvider | null> {
    const client = await makeOpenRouterClient();
    if (!client) { log.info('OpenRouter key not configured, openrouter provider unavailable'); return null; }
    const p = new OpenRouterProvider(client, 'openrouter', { ...OPENROUTER_TIER_MODELS });
    // Drive tier→slug from the model registry (60s refresh); the static seed
    // above is the fallback until the first load lands.
    //
    // GLM's rows, and only GLM's. This class is the platform's own client for
    // the OpenRouter gateway and its tier map has always been GLM's — which is
    // why it reads 'glm' rather than 'openrouter' after migration 450 moved
    // those rows to the family that owns them. Qwen, DeepSeek and Kimi are
    // reached over the same gateway and keep their own keys, precisely so a
    // newly registered one cannot displace GLM here.
    startRegistryTierRefresh('openrouter', [p], ['glm']);
    return p;
  }

  /** Vendors reached over this gateway whose own API takes no
   *  `tool_choice: "none"`, by the OpenRouter slug prefix: Z.AI documents
   *  `auto` as the only value; MiniMax's OpenAI-format API documents no
   *  tool_choice at all. For these the base class sends no tools and folds
   *  the tool history into text instead. Qwen, DeepSeek and Kimi document
   *  `none` and take it on the wire. */
  protected toolChoiceNoneSupported(model: string): boolean {
    const vendor = model.includes('/') ? model.slice(0, model.indexOf('/')).toLowerCase() : '';
    return !OPENROUTER_VENDORS_WITHOUT_TOOL_CHOICE_NONE.has(vendor);
  }

  /** Overlay registry-sourced tier→model slugs onto the static OPENROUTER_TIER_MODELS
   *  seed. Called by the registry-tier loader; a tier absent from the registry keeps
   *  its seed value. */
  applyRegistryTierModels(overrides: Partial<Record<LLMModelTier, string>>): void {
    this.tierModels = { ...OPENROUTER_TIER_MODELS, ...overrides };
  }
}
