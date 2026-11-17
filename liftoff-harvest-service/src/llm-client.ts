import { buildOidcAuthHeader } from '@liftoffos/service-client';
import type { LLMCompletionRequest, LLMCompletionResponse } from './types';

const PLATFORM_BACKEND_URL = process.env.PLATFORM_BACKEND_URL ?? 'http://localhost:3000';
const HARVEST_SERVICE_TOKEN = process.env.HARVEST_SERVICE_TOKEN ?? '';

/**
 * Error from the platform-backend internal LLM gateway, carrying the HTTP
 * status so callers can distinguish a TERMINAL refusal (4xx — e.g. the tenant
 * is suspended / not execution-allowed, or a scoping/validation error) from a
 * RETRYABLE failure (5xx / network). Terminal refusals must be acked-and-
 * skipped, never nacked: nacking a 4xx just burns the Pub/Sub retry budget and
 * DLQs the message for a verdict that will never change on retry.
 */
export class LlmGatewayError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`LLM gateway error ${status}: ${body}`);
    this.name = 'LlmGatewayError';
    this.status = status;
  }
}

/** True for terminal client-error refusals (4xx) that must not be retried. */
export function isTerminalGatewayError(err: unknown): boolean {
  return err instanceof LlmGatewayError && err.status >= 400 && err.status < 500;
}

export async function llmComplete(
  request: LLMCompletionRequest,
  usageContext: Record<string, string>,
): Promise<LLMCompletionResponse> {
  const targetUrl = `${PLATFORM_BACKEND_URL}/api/internal/llm/complete`;
  // SEC-003: OIDC token scoped to platform-backend audience for cross-project Cloud Run calls.
  // buildOidcAuthHeader returns {} when not running on GCP (local dev).
  const oidcHeaders = await buildOidcAuthHeader(PLATFORM_BACKEND_URL);
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Auth': HARVEST_SERVICE_TOKEN,
      ...oidcHeaders,
    },
    body: JSON.stringify({ request, usageContext }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new LlmGatewayError(res.status, body);
  }
  return res.json() as Promise<LLMCompletionResponse>;
}
