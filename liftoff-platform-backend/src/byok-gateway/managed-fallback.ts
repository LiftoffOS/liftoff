// Liftoff's own credential for a vendor, used when a customer's key is declined
// mid-run.
//
// Section 6: losing a running agent's work because a key lapsed overnight is a
// worse failure than an unexpected charge, so the turn in flight completes on
// our key and bills as normal customer consumption. Liftoff's key paid for it.
//
// Every vendor the gateway serves has a managed credential it can substitute on
// the same wire protocol, and what each substitution has to change differs:
//
//   anthropic — the purpose-scoped Anthropic pool key. Same API, same shape.
//   openai    — the purpose-scoped OpenAI pool key. Same.
//   xai       — managed Grok runs through OpenRouter on Liftoff's account, which
//               is OpenAI-compatible. Substituting it means changing host, key
//               AND model id (OpenRouter namespaces Grok as `x-ai/…`), so this
//               one rewrites the request rather than just the credential.
//   google    — Liftoff's own Vertex, over Application Default Credentials. The
//               SAME service the customer's service account reaches, so the
//               substitution is a token and a project: mint from ADC instead of
//               from their key, and point the request at Liftoff's project and
//               location instead of theirs. The path carries both, so this one
//               rewrites the URL rather than just the credential.
//   openrouter — Liftoff's own OpenRouter key, and nothing else to change. This
//               door has no customer-funded side at all: the invoice is ours, so
//               the substitution is the only path through it, and the adapter is
//               already pointed at the right host with the right model ids.

import { GoogleAuth } from 'google-auth-library';
import {
  getAnthropicApiKeyForGroup,
  getOpenAIApiKeyForGroup,
  getOpenRouterApiKey,
} from '../infrastructure/secrets';
import { purposeToGroup } from '../llm/client';
import { DEFAULT_VERTEX_LOCATION } from '../tenant-ai-provider-keys/types';
import { googleUpstreamPath } from './google-path';
import { vertexHostForLocation } from './vertex-token';

export interface ManagedSubstitution {
  /** The credential to send. A key for the key-issuing vendors, an ADC access
   *  token for Google. */
  apiKey: string;
  /** Overrides the adapter's base URL with one that carries its OWN path prefix.
   *  Only xAI uses it, to reach OpenRouter at /api/v1. */
  baseUrlOverride?: string;
  /** Overrides the adapter's ORIGIN only, leaving the request path absolute.
   *  Only Google uses it, to reach a per-location Vertex host. */
  originOverride?: string;
  /** Rewrites the request body's model field. Only xAI uses it. */
  rewriteModel?: (model: string) => string;
  /** Rewrites the request PATH. Only Google uses it: Vertex names the project
   *  and location there, and both change when the account does. */
  rewritePath?: (path: string) => string;
}

/** Liftoff's credential for this vendor, or null when there is no managed
 *  substitute the gateway can make on the same protocol. */
export async function getManagedSubstitution(
  vendor: string,
  purpose: string,
): Promise<ManagedSubstitution | null> {
  const group = purposeToGroup(purpose);

  if (vendor === 'anthropic') {
    const apiKey = await getAnthropicApiKeyForGroup(group);
    return apiKey ? { apiKey } : null;
  }

  if (vendor === 'openai') {
    const apiKey = await getOpenAIApiKeyForGroup(group);
    return apiKey ? { apiKey } : null;
  }

  if (vendor === 'google') {
    // ADC is how every managed Vertex call in this estate authenticates
    // already, so the fallback runs on exactly the identity the workspace would
    // have used with no key on file.
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const accessToken = await auth.getAccessToken().catch(() => null);
    const project = process.env.GCP_PROJECT_ID;
    if (!accessToken || !project) return null;

    const location = process.env.GCP_LOCATION
      ?? process.env.VERTEX_LOCATION
      ?? DEFAULT_VERTEX_LOCATION;

    return {
      apiKey: accessToken,
      originOverride: `https://${vertexHostForLocation(location)}`,
      // Vertex names the account in the PATH, so serving on Liftoff's means
      // rewriting it: the customer's project reached with our token would 403,
      // because their project has never heard of our identity.
      //
      // And the path may not be a Vertex path at all. A client given only a base
      // URL and a key speaks the Gemini Developer API's grammar, which names no
      // account and which Vertex does not serve — see google-path.ts. One
      // function decides which of the two a request is and produces the Vertex
      // path either way.
      rewritePath: (path) => googleUpstreamPath(path, project, location),
    };
  }

  if (vendor === 'xai') {
    const apiKey = await getOpenRouterApiKey();
    if (!apiKey) return null;
    return {
      apiKey,
      baseUrlOverride: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
      // Grok reaches us through OpenRouter as `x-ai/grok-4.6`; a direct xAI call
      // names it `grok-4.6`. Prefixing is the whole of the translation, and a
      // model that already carries the prefix is left alone so a re-entry
      // cannot double it.
      rewriteModel: (model) => (model.startsWith('x-ai/') ? model : `x-ai/${model}`),
    };
  }

  if (vendor === 'openrouter') {
    // The credential and NOTHING else. The adapter's own base already points at
    // OpenRouter and the model id already carries its namespace, so unlike the
    // xAI substitution above there is no host to move and no id to translate —
    // this door was never a fallback from a customer key, it is the only way
    // through for a family a customer cannot hold a key for.
    const apiKey = await getOpenRouterApiKey();
    return apiKey ? { apiKey } : null;
  }

  return null;
}

/**
 * Could the gateway substitute Liftoff's credential for this vendor right now?
 *
 * Asked BEFORE a managed session is minted, and that ordering is the whole
 * point. A managed-primary session whose substitution turns out to be
 * unavailable is a 502 on a run that would otherwise have worked: the runtime
 * would be handed a base URL and a token, point its engine at them, and get back
 * "could not reach the provider" for a turn that had a perfectly good managed
 * path of its own. Two vendors can reach that state — Google with no
 * `GCP_PROJECT_ID` in the environment, xAI with no OpenRouter key on file — and
 * neither is a failure of the run.
 *
 * So the session is refused instead and the runtime goes direct, which is
 * exactly what it does today. The cost of asking is one substitution the request
 * will make again a moment later; for Google that includes an ADC token mint,
 * which the auth library caches.
 *
 * Deliberately the SAME function rather than a parallel list of preconditions. A
 * second copy of "what does xai need" is a second thing to keep in step, and the
 * failure it produces is the one this check exists to prevent.
 */
export async function canSubstituteManaged(vendor: string, purpose: string): Promise<boolean> {
  try {
    return (await getManagedSubstitution(vendor, purpose)) !== null;
  } catch {
    // An unreachable secret or a failed ADC mint answers the same way a missing
    // one does: not now. The run goes direct rather than through a door that
    // cannot open.
    return false;
  }
}
