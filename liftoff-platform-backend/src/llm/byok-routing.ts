// Per-tenant routing for platform-backend's own LLM calls.
//
// The boot-time pools in client.ts are built once and keyed by PURPOSE GROUP,
// not by tenant. A per-tenant credential cannot ride them as-is, so a call the
// resolver says is BYOK-funded gets a one-off provider instance pointed at the
// gateway instead of a pooled one.
//
// The instance is per call rather than cached because the credential it carries
// is per (tenant, run) and short-lived. Constructing an SDK client is cheap;
// caching one keyed by a rotating credential is how a revoked key keeps being
// used.
//
// All three providers a customer can hold an account with are wired here.
// Google is the one that is not a key swap: a customer's Google AI capacity
// lives in their own Vertex project, so the client is pointed at THEIR project
// and location while the service account that opens it stays in Secret Manager
// and is exchanged for a token inside the gateway.

import { randomUUID } from 'crypto';
import { log } from '../infrastructure/logging';
import type { LLMProviderClient } from './types';

export interface ByokRoutedCall {
  client: LLMProviderClient;
  /** Keyed onto the usage row so the ingester can ask the gateway which key
   *  actually served the run. Reuses the caller's own invocation id when it has
   *  one, so a chat turn's several calls settle as one run. */
  invocationId: string;
  vendor: string;
}

/** Providers whose client this module can re-point at the gateway. */
const GATEWAY_ROUTABLE = new Set(['anthropic', 'openai', 'google']);

/**
 * A gateway-routed client for this call, or null to carry on as today.
 *
 * Null is the answer for every ordinary call and for every failure: a
 * control-plane problem must not stop platform-backend from talking to a model,
 * and the cost of getting it wrong is that Liftoff pays for one call.
 */
export async function resolveByokRoutedCall(opts: {
  targetProvider: string;
  resolvedModelId?: string;
  usageContext?: Record<string, string>;
}): Promise<ByokRoutedCall | null> {
  const tenantId = opts.usageContext?.tenantId;
  const purpose = opts.usageContext?.purpose;
  if (!tenantId || !purpose) return null;
  if (!GATEWAY_ROUTABLE.has(opts.targetProvider)) return null;

  try {
    const { resolveByokCredential } = await import(
      '../tenant-ai-provider-keys/resolution-service'
    );
    const resolution = await resolveByokCredential({
      tenantId,
      resolvedProvider: opts.targetProvider,
      resolvedModelId: opts.resolvedModelId ?? null,
      purpose,
      agentId: opts.usageContext?.agentId ?? null,
      // These are platform-backend's own calls, so the purpose sets in
      // classifyChargeability apply. Naming it is what keeps the absorbed
      // purposes — distillation, the CAIO, the injection guard — off a
      // customer key even before the eligibility list is consulted.
      source: 'platform_llm',
    });
    if (resolution.mode !== 'byok') return null;
    // A Grok call would need the direct xAI API, which this client does not
    // speak. It stays on the managed OpenRouter path.
    if (resolution.rerouteToVendorApi) return null;

    const invocationId = opts.usageContext?.invocationId || randomUUID();

    const { mintGatewayToken } = await import('../byok-gateway/token-store');
    const { getBackendUrl } = await import('../infrastructure/control-plane-url');
    const minted = await mintGatewayToken({
      tenantId,
      invocationId,
      vendor: resolution.vendor,
      agentId: opts.usageContext?.agentId ?? null,
      purpose,
      // The resolver already said 'byok' above, so this is the customer's key.
      // Platform-backend's own calls have no managed-primary session: they are
      // made in-process against a pooled client, and re-pointing every one of
      // them at a local HTTP hop to count tokens the SDK already reports would
      // buy nothing. The gap the gateway closes is the SUBPROCESS engines, whose
      // usage reaches us only as a wrapper's summary.
      mode: 'byok',
    });

    const gatewayBase = `${getBackendUrl()}/byok/${resolution.vendor}`;

    if (resolution.vendor === 'anthropic') {
      const { AnthropicProvider } = await import('./providers/anthropic');
      return {
        client: AnthropicProvider.createForGateway(gatewayBase, minted.token),
        invocationId,
        vendor: resolution.vendor,
      };
    }
    if (resolution.vendor === 'openai') {
      const { OpenAIProvider } = await import('./providers/openai');
      // The OpenAI SDK appends its own paths to the base URL, so the `/v1`
      // segment belongs here rather than in the gateway's route.
      return {
        client: OpenAIProvider.createForGateway(`${gatewayBase}/v1`, minted.token),
        invocationId,
        vendor: resolution.vendor,
      };
    }
    if (resolution.vendor === 'google') {
      // Vertex names the project and location in every request path, so the
      // client has to build the path for the CUSTOMER's account. Read from the
      // stored credential rather than assumed: a path naming another project
      // would 403, because their service account has no standing in it.
      const { readProviderSecret } = await import('../tenant-ai-provider-keys/secret-storage');
      const credential = await readProviderSecret(resolution.secretName);
      if (credential?.kind !== 'vertex_service_account') return null;
      const { GoogleProvider } = await import('./providers/google');
      return {
        client: GoogleProvider.createForGateway(
          gatewayBase,
          credential.project,
          credential.location,
          minted.token,
        ),
        invocationId,
        vendor: resolution.vendor,
      };
    }
    return null;
  } catch (error) {
    log.warn(
      { tenantId, purpose, error: (error as Error).message },
      'byok: could not route this call through the gateway; using the managed pool',
    );
    return null;
  }
}
