// OpenAI's own SDK providers, one per purpose group.
//
// Module-scoped lazy singleton: the four Secret Manager reads happen once per
// process and subsequent createAdapter() calls reuse the cached Map. Without it
// every adapter instantiation would re-fetch the four group keys.
//
// The purpose group selects WHICH OpenAI key pays, which is how spend is
// attributed across the estate — so this is billing plumbing, not just
// connection setup.

import { OpenAIProvider as SdkOpenAIProvider } from '@openai/agents-openai';
import { getOpenAIApiKeyForGroup, type OpenAIPurposeGroup } from '../../../infrastructure/secrets';
import { purposeToOpenAIGroup } from '../../../llm/client';

const GROUPS: OpenAIPurposeGroup[] = [
  'agent-execution',
  'reflective-services',
  'platform-analytics',
  'background-services',
];

let cached: Map<OpenAIPurposeGroup, SdkOpenAIProvider> | null = null;
let pending: Promise<Map<OpenAIPurposeGroup, SdkOpenAIProvider>> | null = null;

async function buildPool(): Promise<Map<OpenAIPurposeGroup, SdkOpenAIProvider>> {
  const entries = await Promise.all(
    GROUPS.map(async g => {
      const key = await getOpenAIApiKeyForGroup(g);
      return [g, key ? new SdkOpenAIProvider({ apiKey: key }) : null] as const;
    }),
  );
  return new Map(
    entries.filter((e): e is [OpenAIPurposeGroup, SdkOpenAIProvider] => e[1] !== null),
  );
}

/** The per-purpose provider for a purpose string, falling back to the
 *  `agent-execution` provider when the requested group isn't in the pool. The
 *  first call hydrates the lazy singleton; concurrent callers share the same
 *  Promise via `pending` to avoid duplicate fetches. */
export async function getSdkOpenAIProvider(
  purpose: string | undefined,
): Promise<SdkOpenAIProvider | undefined> {
  try {
    if (!cached) {
      pending ??= buildPool();
      cached = await pending;
      pending = null;
    }
    return cached.get(purposeToOpenAIGroup(purpose)) ?? cached.get('agent-execution');
  } catch {
    // Pool hydration failed (no Secret Manager access, no group keys seeded
    // yet). Undefined means "use the SDK's default", which for OPENAI is the
    // right fallback — same endpoint, same model ids, just without per-purpose
    // billing attribution. It is not the right fallback for any other vendor,
    // which is why the other providers here refuse instead.
    return undefined;
  }
}
