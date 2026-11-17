// A2A RPC Router — per-agent JSON-RPC endpoint
// Implements the A2A standard wire format (Google/Linux Foundation).
// Tenant-scoped: agents only callable within the same workspace.
//
// Auth: X-Service-Token validated against inbound_service_token_hash on external_agents.
// Existing /api/v1/a2a/rpc stays mounted and is deprecated.

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { withTenantScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { tenantRuntimeClient } from '../connectors/tenant-runtime-client';
import { hashToken } from '../tenant-members/tokens';
import { oversightService } from '../internal-agent-oversight/service';
import { resolveAgentHitlLevel } from '../internal-agent-oversight/types';
import type { A2ATaskStatus } from './types';

export const a2aRpcRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonRpcError(id: unknown, code: number, message: string): object {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function validateInboundServiceToken(
  serviceToken: string | undefined,
  tenantId: string,
): Promise<{ callerId: string } | null> {
  if (!serviceToken) return null;
  const tokenHash = hashToken(serviceToken);
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `SELECT id FROM external_agents
       WHERE inbound_service_token_hash = $1 AND tenant_id = $2
         AND deleted_at IS NULL AND status != 'disconnected'`,
      [tokenHash, tenantId],
    );
    if (result.rows.length === 0) return null;
    return { callerId: result.rows[0].id as string };
  });
}

// POST /api/a2a/agents/:agentId/rpc
a2aRpcRouter.post('/agents/:agentId/rpc', async (req: Request, res: Response) => {
  const { agentId } = req.params;
  const { method, id, params } = req.body as {
    method?: string; id?: unknown; params?: Record<string, unknown>;
  };

  if (!UUID_RE.test(agentId)) {
    return res.status(400).json(jsonRpcError(id, -32602, 'Invalid agentId'));
  }

  // Validate tenantId first — auth lookup requires it
  const tenantId = req.query.tenantId as string | undefined;
  if (!tenantId || !UUID_RE.test(tenantId)) {
    return res.status(400).json(jsonRpcError(id, -32602, 'tenantId required'));
  }

  // Validate X-Service-Token against inbound_service_token_hash on external_agents
  const serviceToken = req.headers['x-service-token'] as string | undefined;
  const caller = await validateInboundServiceToken(serviceToken, tenantId);
  if (!caller) {
    return res.json(jsonRpcError(id, -32001, 'Unauthorized'));
  }

  if (!method) {
    return res.json(jsonRpcError(id, -32600, 'Invalid Request'));
  }

  // Verify agent exists and belongs to caller's tenant
  const agentRows = await withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, role, autonomy_override FROM internal_agents
       WHERE id = $1 AND tenant_id = $2 AND status = 'active' AND deleted_at IS NULL`,
      [agentId, tenantId],
    );
    return result.rows;
  });
  if (agentRows.length === 0) {
    return res.json(jsonRpcError(id, -32001, 'agent not found in this workspace'));
  }

  switch (method) {
    case 'SendMessage': {
      const message = (params?.message as { parts?: Array<{ text?: string }>; contextId?: string }) ?? {};
      const text = message.parts?.[0]?.text;
      if (!text) {
        return res.json(jsonRpcError(id, -32602, 'message.parts[0].text required'));
      }

      const taskId = randomUUID();
      const contextId = message.contextId ?? randomUUID();

      try {
        const oversightSettings = await oversightService.getOrCreateOversightSettings(tenantId);
        const hitlLevel = resolveAgentHitlLevel(agentRows[0].autonomy_override, oversightSettings.autonomy);

        // M2 atomicity fix: persist the registry row FIRST so the task is
        // observable via GetTask even if the runtime enqueue fails. If the
        // enqueue then fails, best-effort delete the registry row so we
        // don't leave a phantom task id that no runtime is processing.
        //
        // The prior order (enqueue → INSERT) had the opposite failure mode:
        // a runtime task would be in flight with no corresponding registry
        // row, so GetTask/CancelTask could not resolve it and the task was
        // un-cancellable from the API surface.
        await withTenantScope(tenantId, (client) =>
          client.query(
            `INSERT INTO a2a_task_registry (task_id, agent_id, tenant_id, requester_key_id, context_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [taskId, agentId, tenantId, caller.callerId, contextId],
          ),
        );

        try {
          await tenantRuntimeClient.enqueueAgentTask(tenantId, agentId, {
            objective: text,
            context: { a2aContextId: contextId, a2aTaskId: taskId },
            triggeredBy: 'a2a',
            triggerRef: `a2a:${taskId}`,
            hitlLevel,
            escalationLevel: oversightSettings.escalation,
            requestedByType: 'a2a_token',
            requestedById: caller.callerId,
          });
        } catch (enqueueErr) {
          // Best-effort: roll back the registry row so the orphan doesn't
          // appear in GetTask. Swallow rollback errors and propagate the
          // original enqueue failure.
          try {
            await withTenantScope(tenantId, (client) =>
              client.query(
                `DELETE FROM a2a_task_registry WHERE task_id = $1 AND tenant_id = $2`,
                [taskId, tenantId],
              ),
            );
          } catch (rollbackErr) {
            log.warn(
              {
                taskId,
                tenantId,
                rollbackError: (rollbackErr as Error).message,
              },
              'a2a SendMessage: failed to rollback registry row after enqueue failure',
            );
          }
          throw enqueueErr;
        }

        return res.json({
          jsonrpc: '2.0', id,
          result: {
            task: { id: taskId, status: 'submitted' as A2ATaskStatus, contextId },
          },
        });
      } catch (err) {
        log.error({ error: (err as Error).message, agentId, tenantId }, 'a2a SendMessage failed');
        return res.json(jsonRpcError(id, -32603, 'Failed to enqueue task'));
      }
    }

    case 'GetTask': {
      const taskId = params?.id as string | undefined;
      if (!taskId || taskId.length > 256) {
        return res.json(jsonRpcError(id, -32602, 'params.id required'));
      }

      try {
        const taskRows = await withTenantScope(tenantId, async (client) => {
          const result = await client.query(
            `SELECT task_id, agent_id FROM a2a_task_registry
             WHERE task_id = $1 AND tenant_id = $2
               AND (requester_key_id = $3 OR agent_id::text = $4)`,
            [taskId, tenantId, caller.callerId, agentId],
          );
          return result.rows;
        });
        if (taskRows.length === 0) {
          return res.json(jsonRpcError(id, -32001, 'Task not found or access denied'));
        }
        // Status is always 'submitted' since we don't track it in platform-backend;
        // the runtime is the source of truth but we enforce ownership here.
        return res.json({
          jsonrpc: '2.0', id,
          result: { task: { id: taskId, status: 'submitted' as A2ATaskStatus, agentId } },
        });
      } catch (err) {
        log.error({ error: (err as Error).message }, 'a2a GetTask failed');
        return res.json(jsonRpcError(id, -32603, 'Failed to get task'));
      }
    }

    case 'CancelTask': {
      const taskId = params?.id as string | undefined;
      if (!taskId || taskId.length > 256) {
        return res.json(jsonRpcError(id, -32602, 'params.id required'));
      }

      const ownerRows = await withTenantScope(tenantId, async (client) => {
        const result = await client.query(
          `SELECT task_id FROM a2a_task_registry
           WHERE task_id = $1 AND tenant_id = $2
             AND (requester_key_id = $3 OR agent_id::text = $4)`,
          [taskId, tenantId, caller.callerId, agentId],
        );
        return result.rows;
      });
      if (ownerRows.length === 0) {
        return res.json(jsonRpcError(id, -32001, 'Task not found or access denied'));
      }

      try {
        await tenantRuntimeClient.cancelAgentTask(tenantId, agentId, taskId);
      } catch (err) {
        log.warn({ error: (err as Error).message, taskId }, 'a2a CancelTask: runtime cancellation failed');
      }
      return res.json({
        jsonrpc: '2.0', id,
        result: { task: { id: taskId, status: 'failed' as A2ATaskStatus } },
      });
    }

    default:
      return res.json(jsonRpcError(id, -32601, 'Method not found'));
  }
});
