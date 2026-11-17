// The BYOK gateway, as an SDK provider. Vendor-agnostic on purpose.
//
// Every vendor on this wire is funded the same way when a customer pays: the
// SDK is pointed at Liftoff's gateway instead of the vendor, and the gateway
// attaches the real key on the far side. Nothing here knows which vendor it is
// serving, which is why it lives beside the shared adapter rather than in any
// one vendor's module.

import { OpenAIProvider as SdkOpenAIProvider } from '@openai/agents-openai';

/**
 * A provider that talks to the BYOK gateway instead of the vendor directly.
 *
 * `token` is the short-lived per-run gateway credential, never a customer key:
 * the real key is attached on the far side, out of reach of anything in this
 * process. The `/v1` suffix belongs here because the OpenAI SDK appends its own
 * paths to whatever base URL it is given.
 *
 * Built per call rather than pooled, on purpose. A pool is built once at boot
 * and keyed by purpose group; this credential is per (tenant, run) and
 * short-lived, so it cannot ride one — and caching an instance keyed by a
 * rotating credential is how a revoked key keeps being used.
 */
export function getSdkGatewayProvider(
  _vendor: string,
  baseUrl: string,
  token: string,
): SdkOpenAIProvider {
  return new SdkOpenAIProvider({
    apiKey: token,
    baseURL: `${baseUrl.replace(/\/+$/, '')}/v1`,
  });
}
