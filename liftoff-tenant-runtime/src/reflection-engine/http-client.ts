// Reflection Engine HTTP Client
//
// Phase 4: evaluations are primarily
// driven asynchronously via Cloud Tasks — `enqueueReflectionJob` enqueues
// to the REFLECTION_URL target (reflection-service in split mode), and
// Cloud Tasks delivers to `POST /api/v1/evaluations`. That's the hot path.
//
// This client provides a SYNCHRONOUS HTTP path for the narrow cases where
// the caller wants to wait for reflection to run (scheduled trigger,
// quota inspection, suggestion accept). It mirrors the coordinator and
// tool-gateway client patterns.
//
// Callers that want the async path should continue to use
// `reflectionTriggerService.onXxx()` — those internally call
// `enqueueReflectionJob` which uses REFLECTION_URL as the Cloud Tasks
// target. Agent-service and coordinator-service both need REFLECTION_URL
// set to reflection-service's URL in cloudbuild so the Cloud Tasks
// deliveries land on the right service.

import { ServiceClient } from '@liftoffos/service-client';
import { withManagedServiceAuth } from '../infrastructure/service-client-auth';
import { logger } from '../infrastructure/logging';

export interface ReflectionServiceClientOptions {
  baseUrl: string;
  serviceAuthSecret?: 'TENANT_RUNTIME_SERVICE_TOKEN';
}

export interface ReflectionTriggerRequest {
  tenantId: string;
  triggerType: string;
  metadata?: Record<string, unknown>;
}

export class ReflectionServiceClient {
  private readonly client: ServiceClient;
  private readonly baseUrl: string;

  constructor(opts: ReflectionServiceClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.client = new ServiceClient(withManagedServiceAuth(
      opts.serviceAuthSecret ?? 'TENANT_RUNTIME_SERVICE_TOKEN',
      {
        resolveTargetUrl: async () => this.baseUrl,
        onLog: (level, ctx, msg) => {
          if (level === 'error') logger.error({ ...ctx }, msg);
          else if (level === 'warn') logger.warn({ ...ctx }, msg);
          else if (level === 'info') logger.info({ ...ctx }, msg);
          else logger.debug({ ...ctx }, msg);
        },
      },
    ));
  }

  /**
   * Synchronously create an evaluation run for an agent. Returns the result
   * body from reflection-service. The caller blocks until the analysis
   * completes — typical 10-60 seconds. For non-blocking dispatch,
   * use `reflectionTriggerService.onXxx()` + Cloud Tasks instead.
   */
  async trigger(agentId: string, req: ReflectionTriggerRequest): Promise<unknown> {
    // REST: agentId in the body, not the URL. /evaluations is the resource
    // collection; POST creates a new evaluation identified by its input.
    const resp = await this.client.fetch('reflection', '/api/v1/evaluations', {
      method: 'POST',
      body: JSON.stringify({
        agentId,
        tenantId: req.tenantId,
        triggerType: req.triggerType,
        metadata: req.metadata,
      }),
      headers: { 'X-Tenant-Id': req.tenantId },
      breakerKey: 'evaluations:create',
    });
    return this.readJson(resp, 'trigger');
  }

  /**
   * Read current quota status for a tenant. Used to decide whether to
   * trigger an evaluation or skip (plan §16 backpressure).
   */
  async getQuotaStatus(tenantId: string): Promise<unknown> {
    const path = `/api/v1/evaluations/quotas/${encodeURIComponent(tenantId)}`;
    const resp = await this.client.fetch('reflection', path, {
      method: 'GET',
      breakerKey: 'evaluations:getQuotaStatus',
    });
    return this.readJson(resp, 'getQuotaStatus');
  }

  /**
   * Check whether an evaluation trigger should fire given the current
   * evidence. Called by the trigger-service to avoid burning quota on
   * triggers that won't produce a useful evaluation.
   */
  async shouldTrigger(
    agentId: string,
    tenantId: string,
    triggerType: string,
  ): Promise<unknown> {
    const qs = new URLSearchParams({ agentId, tenantId, triggerType }).toString();
    const resp = await this.client.fetch(
      'reflection',
      `/api/v1/evaluations/eligibility?${qs}`,
      {
        method: 'GET',
        breakerKey: 'evaluations:eligibility',
      },
    );
    return this.readJson(resp, 'shouldTrigger');
  }

  /**
   * Get evaluation suggestions for an agent. Returns `{ items: [...] }`.
   */
  async getSuggestions(agentId: string): Promise<unknown> {
    const qs = new URLSearchParams({ agentId }).toString();
    const resp = await this.client.fetch(
      'reflection',
      `/api/v1/evaluations/suggestions?${qs}`,
      {
        method: 'GET',
        breakerKey: 'evaluations:suggestions',
      },
    );
    return this.readJson(resp, 'getSuggestions');
  }

  private async readJson(resp: Response, op: string): Promise<unknown> {
    if (!resp.ok) {
      let detail = '';
      try {
        const text = await resp.text();
        detail = text.length > 512 ? `${text.slice(0, 512)}…` : text;
      } catch {
        detail = '<unreadable body>';
      }
      throw new Error(`reflection ${op} failed: HTTP ${resp.status} ${detail}`);
    }
    return resp.json();
  }
}

/**
 * Lazily-built singleton so the HTTP/2 session + circuit breaker are shared
 * across the whole process.
 */
let sharedClient: ReflectionServiceClient | null = null;
export function getReflectionServiceClient(): ReflectionServiceClient | null {
  const url = process.env.REFLECTION_SERVICE_URL?.trim();
  if (!url) return null;
  if (!sharedClient) sharedClient = new ReflectionServiceClient({ baseUrl: url });
  return sharedClient;
}

export function resetReflectionServiceClientForTests(): void {
  sharedClient = null;
}
