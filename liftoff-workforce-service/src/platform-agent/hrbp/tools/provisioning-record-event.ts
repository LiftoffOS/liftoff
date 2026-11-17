// Tool: provisioning__record_event
//
// Appends a row to the hrbp_provisioning_events ledger so the user (via
// /activity) and operators (via DB queries) can trace what HRBP did.
//
// Each call records one step of the per-spec provisioning workflow:
// `distill`, `create_agent`, `update_agent`, or `attribute_session`, with
// a lifecycle status of `pending`, `in_progress`, `completed`, or `failed`.

import { getPool } from '../../../infrastructure/database.js';
import type { LLMToolDefinition } from '../../../llm/types.js';
import type { HrbpToolContext } from '../types.js';

export const PROVISIONING_RECORD_EVENT_TOOL: LLMToolDefinition = {
  name: 'provisioning__record_event',
  description:
    'Record a provisioning event for the current spec. Use this before and after each upstream call so the activity timeline reflects what HRBP is doing. ' +
    'Step must be one of "distill" | "create_agent" | "update_agent" | "attribute_session". ' +
    'Status must be one of "pending" | "in_progress" | "completed" | "failed". ' +
    'On failure pass errorMessage; after a successful create pass internalAgentId.',
  input_schema: {
    type: 'object',
    properties: {
      step: {
        type: 'string',
        enum: ['distill', 'create_agent', 'update_agent', 'attribute_session'],
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'failed'],
      },
      internalAgentId: { type: 'string', description: 'UUID of the internal_agent row, when known.' },
      idempotencyKey: { type: 'string', description: 'Optional idempotency key carried with the upstream call.' },
      errorMessage: { type: 'string', description: 'Required when status="failed". Free text.' },
    },
    required: ['step', 'status'],
  },
};

export async function handleProvisioningRecordEvent(
  input: Record<string, unknown>,
  ctx: HrbpToolContext,
): Promise<{ ok: boolean; data: unknown }> {
  const step = input.step as string;
  const status = input.status as string;
  const internalAgentId = (input.internalAgentId as string | undefined) ?? null;
  const idempotencyKey = (input.idempotencyKey as string | undefined) ?? null;
  const errorMessage = (input.errorMessage as string | undefined) ?? null;

  const pool = getPool();
  await pool.query(
    `INSERT INTO hrbp_provisioning_events
       (run_id, plan_id, tenant_id, spec_id, step, status,
        internal_agent_id, idempotency_key, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      ctx.runId,
      ctx.planId,
      ctx.tenantId,
      ctx.specId,
      step,
      status,
      internalAgentId,
      idempotencyKey,
      errorMessage,
    ],
  );
  return { ok: true, data: { recorded: { step, status } } };
}
