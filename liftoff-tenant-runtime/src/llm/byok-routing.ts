// Per-tenant routing for the runtime's own llmClient calls.
//
// The pools in client.ts are built once at boot and keyed by PURPOSE GROUP, not
// by tenant. A per-tenant credential cannot ride them as-is, so a call the
// control plane says is BYOK-funded gets a one-off provider instance pointed at
// the gateway instead of a pooled one.
//
// Per call rather than cached: the credential is per (tenant, run) and
// short-lived, and caching a client keyed by a rotating credential is how a
// revoked key keeps being used. Constructing an SDK client is cheap.
//
// All three providers a customer can hold an account with are wired here.
// Google is the one that is not a credential swap: a customer's Google AI
// capacity lives in their own Vertex project, so the client is pointed at THEIR
// project and location while the service account that opens it stays in the
// control plane and is exchanged for a token inside the gateway.

import { logger } from '../infrastructure/logging';
import { openByokSession } from '../byok/session';
import { AnthropicProvider, GoogleProvider, OpenAIProvider } from './providers';
import type { LLMProvider, LLMProviderClient } from './types';

/** Providers this module can re-point at the gateway. */
const GATEWAY_ROUTABLE: ReadonlySet<string> = new Set(['anthropic', 'openai', 'google']);

export interface ByokRoutedCall {
  client: LLMProviderClient;
  vendor: string;
}

export interface ByokRoutingInput {
  targetProvider: LLMProvider;
  model: string | undefined;
  /** The attribution context llmClient callers already pass. `tenantId`,
   *  `purpose` and `invocationId` are the three fields that matter: without a
   *  tenant there is nobody to bill, without a purpose the eligibility question
   *  cannot be asked, and without an invocation id the gateway's usage rows
   *  cannot be matched to the run the ledger settles. */
  usageContext?: Record<string, string>;
}

/**
 * A gateway-routed client for this call, or null to carry on as today.
 *
 * Null for every ordinary call and for every failure: a control-plane problem
 * must not stop the runtime from talking to a model, and the cost of getting it
 * wrong is that Liftoff pays for one call.
 */
export async function resolveByokRoutedCall(
  input: ByokRoutingInput,
): Promise<ByokRoutedCall | null> {
  const tenantId = input.usageContext?.tenantId;
  const purpose = input.usageContext?.purpose;
  const invocationId = input.usageContext?.invocationId;
  if (!tenantId || !purpose || !invocationId) return null;
  if (!GATEWAY_ROUTABLE.has(input.targetProvider)) return null;

  try {
    const session = await openByokSession({
      tenantId,
      invocationId,
      resolvedProvider: input.targetProvider,
      resolvedModelId: input.model ?? null,
      call: { callKind: 'llm_call', purpose },
      runtimeAgentId: input.usageContext?.agentId ?? null,
    });
    if (!session) return null;
    // A Grok call would need the direct xAI API, which this client does not
    // speak — it has no openrouter provider at all. It stays managed.
    if (session.rerouteToVendorApi) return null;

    if (session.vendor === 'anthropic') {
      return {
        client: AnthropicProvider.createForGateway(session.baseUrl, session.token),
        vendor: session.vendor,
      };
    }
    if (session.vendor === 'openai') {
      // The OpenAI SDK appends its own paths to the base URL, so the `/v1`
      // segment belongs here rather than in the gateway's route.
      return {
        client: OpenAIProvider.createForGateway(`${session.baseUrl}/v1`, session.token),
        vendor: session.vendor,
      };
    }
    if (session.vendor === 'google' && session.vertex) {
      return {
        client: GoogleProvider.createForGateway(
          session.baseUrl,
          session.vertex.project,
          session.vertex.location,
          session.token,
        ),
        vendor: session.vendor,
      };
    }
    return null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId, purpose },
      'byok: could not route this call through the gateway; using the managed pool',
    );
    return null;
  }
}
