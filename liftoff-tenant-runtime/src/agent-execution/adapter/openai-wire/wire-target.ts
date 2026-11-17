// What an OpenAI-wire adapter is pointed at, and what that endpoint calls its
// models.
//
// One class serves several endpoints that speak the OpenAI wire format, and
// those endpoints disagree about two things and only two: which SDK provider a
// call goes through, and what the model is named there. Everything else — the
// tool loop, the guardrails, the event translation — is identical, which is why
// they share an implementation rather than each having a copy of it.
//
// These decisions live on a TARGET rather than in a switch, because a switch
// has to enumerate every endpoint in one place. That is how xAI once ended up as
// two `vendor === 'xai'` branches inside the file serving OpenAI and OpenRouter.
// A target lets each endpoint carry its own answers, and leaves this file
// knowing about none of them.

import { createHash } from 'crypto';
import type { InvocationInput, ResolvedProvider } from '../types';
import type { OpenAIProvider as SdkOpenAIProvider } from '@openai/agents-openai';
import type { webSearchTool } from '@openai/agents';

/** A vendor-hosted tool the endpoint runs itself, rather than one we dispatch. */
export type HostedTool = ReturnType<typeof webSearchTool>;

/** The model handed to the Agent: a bare id, or a Model instance already bound
 *  to its own client (which is how a non-OpenAI slug reaches the right
 *  endpoint — see the OpenRouter target). */
export type WireModel = string | Awaited<ReturnType<SdkOpenAIProvider['getModel']>>;

export interface WireTarget {
  /** Recorded on logs so a run says which endpoint served it. */
  readonly name: string;


  /** The SDK provider this call goes through, or undefined to let the SDK use
   *  its default. Receives the whole input because BYOK is a property of the
   *  CALL, not of the adapter: the same target serves managed and
   *  customer-funded runs and only the credential differs. */
  sdkProvider(input: InvocationInput): Promise<SdkOpenAIProvider | undefined>;

  /** What this endpoint calls the model in `input.model`, BOUND to the provider
   *  that has to serve it. Use `bindModel` — see the rule it carries. */
  modelId(
    input: InvocationInput,
    provider: SdkOpenAIProvider | undefined,
  ): Promise<WireModel>;

  /** The endpoint's OWN hosted tools, offered alongside the platform catalog.
   *
   *  A property of the endpoint rather than of the model id. It used to be
   *  decided by matching the model against OpenAI's Responses-API families,
   *  which answers correctly only for OpenAI: every other vendor's model fails
   *  that match and silently gets no native tools, however many it serves. */
  nativeWebTools(input: InvocationInput): HostedTool[];

  /** The endpoint's prompt-cache routing key for this call, or undefined where
   *  the endpoint has no such concept.
   *
   *  OpenAI routes a request to a cache by `prompt_cache_key` plus a hash of the
   *  prompt prefix. The key does NOT make a hit — the prefix still has to match
   *  exactly — it decides which cache is consulted, so requests that DO share a
   *  prefix stop landing on different shards and missing each other.
   *
   *  A target answer, not a shared one, for the same reason `nativeWebTools` is:
   *  this class serves three endpoints and only one of them has this parameter.
   *  Sending an unknown field to the others is at best ignored and at worst a
   *  400, and a switch on vendor here is precisely what the target exists to
   *  avoid. */
  promptCacheKey?(input: InvocationInput): string | undefined;
  /** Sticky-routing key, for an endpoint that fans out across providers.
   *
   *  Distinct from `promptCacheKey`, which names a cache. This names a
   *  CONVERSATION, so every turn of it lands on the provider that already holds
   *  the prefix — on a fan-out endpoint the cache is per provider, so a prefix
   *  cached on one is missed by the next. */
  stickySessionId?(input: InvocationInput): string | undefined;
}

/**
 * The routing key an OpenAI-family endpoint should use for a run.
 *
 * Keyed on the AGENT, not the invocation. Two runs of one agent share a system
 * prompt and a tool catalog and are exactly the pair that should land on the
 * same cache; keying per invocation would route every run to a fresh shard and
 * guarantee the first turn of each is a miss — the opposite of the point.
 *
 * OpenAI asks that traffic per key stay near 15 requests per minute and that
 * busier workloads be split across several stable keys. One agent is well
 * inside that: its turns are seconds apart at most, and the platform's own
 * concurrency limits cap how many run at once. If an agent ever does exceed it,
 * the fix is to append a shard here — and it must be a STABLE function of
 * something (a session, a thread), never a random or per-run value, or the
 * partitioning throws away the routing it was meant to preserve.
 */
export function agentPromptCacheKey(input: InvocationInput): string | undefined {
  // An off switch, for one reason that is not "in case something breaks".
  //
  // The effect of this key cannot be MEASURED without it. The benchmark's
  // before-and-after ran at two different prompt sizes — Wave A grew the system
  // prompt from ~7.2k to ~18.4k tokens — and a longer stable prefix raises the
  // cached fraction on its own. So the observed 32.7% -> 49.3% on
  // `openai-agents` has two candidate explanations and the numbers cannot
  // separate them. With this, the same engine runs twice at a FIXED prompt with
  // the key on and off, which is the one-variable experiment that can.
  //
  // It doubles as the operational escape if a key ever routes traffic somewhere
  // unhelpful, but that is the smaller reason.
  if (process.env.PROMPT_CACHE_KEY_DISABLED === '1') return undefined;
  if (!input.tenantId || !input.agentId) return undefined;
  // A digest, not the ids themselves: OpenAI caps the key at 64 characters
  // and two UUIDs with a prefix are 81. The endpoint answered every direct
  // OpenAI run with `400 Invalid 'prompt_cache_key': string too long` for as
  // long as the key was the ids, and the engine reported it as a validation
  // failure before the first model call. Stable per tenant and agent, which
  // is all the key is for; nothing reads it back.
  const digest = createHash('sha256').update(`${input.tenantId}:${input.agentId}`).digest('hex');
  return `liftoff:${digest.slice(0, PROMPT_CACHE_KEY_MAX - 'liftoff:'.length)}`;
}

/** OpenAI's documented maximum length for `prompt_cache_key`. */
export const PROMPT_CACHE_KEY_MAX = 64;

/**
 * Bind a model id to the provider that must serve it.
 *
 * A bare string is resolved by the SDK's DEFAULT OpenAI client. There is no
 * per-call escape from that: `modelProvider` is a field of `RunConfig`, which
 * only a `Runner` instance carries, so a property of that name in the options
 * of the standalone `run()` is accepted by the type system and then ignored.
 * (It typechecks because it is passed through a conditional spread, and a
 * spread is exempt from excess-property checking.)
 *
 * Every target here points somewhere that default client is wrong about: a
 * different endpoint, a different account's key, or the BYOK gateway. So
 * whenever a provider exists, the model must be bound to it — a resolved
 * `Model` carries its own client, and that is what actually routes the call.
 *
 * An undefined provider is the one case a bare string is right: it means "use
 * the SDK's default", which is a deliberate fallback rather than an oversight.
 */
export async function bindModel(
  provider: SdkOpenAIProvider | undefined,
  modelId: string,
): Promise<WireModel> {
  return provider ? provider.getModel(modelId) : modelId;
}

/**
 * The conversation a run belongs to, for endpoints that route across providers.
 *
 * OpenRouter pins a session to the provider that served it, which is what makes
 * a multi-turn prefix cacheable there at all: without one, stickiness begins
 * only AFTER a cache hit has already been observed, so the first turns scatter
 * across providers and the hit that would start it never happens. With one it
 * pins from the first successful request. (Documented on openrouter.ai's
 * prompt-caching guide; the provider-routing reference does not mention it.)
 *
 * Keyed by AGENT, not by invocation: an invocation is one turn, and a key that
 * changed every turn would pin nothing. The agent is also the right scope on the
 * merits — the cacheable prefix IS its system prompt, so every thread of the same
 * agent shares one, and pooling them onto one provider keeps that prefix warm
 * rather than splitting it.
 *
 * Ignored by OpenRouter when `provider.order` is set — an explicit ordering wins
 * — and the session expires after ten minutes of inactivity.
 */
export function agentStickySessionId(input: InvocationInput): string | undefined {
  if (process.env.PROMPT_CACHE_KEY_DISABLED === '1') return undefined;
  if (!input.tenantId) return undefined;
  if (!input.agentId) return undefined;
  // Under 256 characters by construction: two uuids and a prefix.
  return `liftoff:${input.tenantId}:${input.agentId}`;
}
