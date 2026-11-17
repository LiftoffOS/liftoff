// Coordinator HTTP Client
//
// Phase 4: when `SERVICE_TYPE=agent`, the
// agent execution engine calls coordinator-service over HTTP for workflow
// lifecycle operations — commitTransition, completeWorkflow, failWorkflow.
//
// Matches the subset of CoordinatorService methods that agent-execution
// actually invokes (plus a narrow getWorkflow for read-path needs). Heavier
// methods (startWorkflow, reconciliation, compensation) stay in-process on
// coordinator-service and don't need a client.
//
// Transport: `@liftoffos/service-client` ServiceClient — same HTTP/2 +
// keep-alive + OIDC + circuit-breaker stack used by ConnectorServiceClient
// and ToolGatewayHttpClient.

import { ServiceClient } from '@liftoffos/service-client';
import { withManagedServiceAuth } from '../infrastructure/service-client-auth';
import { logger } from '../infrastructure/logging';
import type { ToolCall } from './types';
import type { CoordinatorDispatcher } from './dispatcher';

export interface CoordinatorHttpClientOptions {
  baseUrl: string;
  serviceAuthSecret?: 'TENANT_RUNTIME_SERVICE_TOKEN';
}

export class CoordinatorHttpClient implements CoordinatorDispatcher {
  private readonly client: ServiceClient;
  private readonly baseUrl: string;

  constructor(opts: CoordinatorHttpClientOptions) {
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

  async commitTransition(input: {
    workflowId: string;
    taskId: string;
    idempotencyKey: string;
    newState: unknown;
    pendingToolCalls: ToolCall[];
  }): Promise<unknown> {
    // REST: POST /workflows/{id}/checkpoints — the workflow id is in the
    // path, the rest travels in the body. Matches the router convention
    // where actions are POST to sub-resource collections.
    const { workflowId, ...body } = input;
    const path = `/api/v1/workflows/${encodeURIComponent(workflowId)}/checkpoints`;
    const resp = await this.client.fetch('coordinator', path, {
      method: 'POST',
      body: JSON.stringify(body),
      breakerKey: 'coordinator:commitTransition',
    });
    return this.readJson(resp, 'commitTransition');
  }

  async completeWorkflow(workflowId: string, outcome: unknown): Promise<unknown> {
    const path = `/api/v1/workflows/${encodeURIComponent(workflowId)}/completions`;
    const resp = await this.client.fetch('coordinator', path, {
      method: 'POST',
      body: JSON.stringify({ outcome }),
      breakerKey: 'coordinator:completeWorkflow',
    });
    return this.readJson(resp, 'completeWorkflow');
  }

  async failWorkflow(workflowId: string, error: string): Promise<unknown> {
    const path = `/api/v1/workflows/${encodeURIComponent(workflowId)}/failures`;
    const resp = await this.client.fetch('coordinator', path, {
      method: 'POST',
      body: JSON.stringify({ error }),
      breakerKey: 'coordinator:failWorkflow',
    });
    return this.readJson(resp, 'failWorkflow');
  }

  async getWorkflow(workflowId: string): Promise<unknown | null> {
    const path = `/api/v1/workflows/${encodeURIComponent(workflowId)}`;
    const resp = await this.client.fetch('coordinator', path, {
      method: 'GET',
      breakerKey: 'coordinator:getWorkflow',
    });
    if (resp.status === 404) return null;
    return this.readJson(resp, 'getWorkflow');
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
      throw new Error(`coordinator ${op} failed: HTTP ${resp.status} ${detail}`);
    }
    return resp.json();
  }
}
