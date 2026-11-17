// Predecessor plan L2 — schedule_followup / cancel_followup tool handlers.
//
// Built on top of:
//   - L1: enqueueAgentExecution gains scheduleTime + contextRef
//         (src/infrastructure/cloud-tasks.ts)
//   - L4: agent_scheduled_invocations table + repo
//         (src/scheduling/agent-scheduled-invocations-repo.ts)
//
// schedule_followup semantics:
//   1. Validate (delay_seconds XOR at; firesAt in [now+60s, now+30d]).
//   2. Enforce per-agent / per-tenant pending quotas.
//   3. Replace any existing pending row at (tenantId, agentId, context_ref):
//      mark prior status='cancelled', best-effort cancel the prior task.
//   4. Insert new pending row.
//   5. Enqueue a Cloud Task at firesAt targeting the existing
//      /api/tasks/agent-scheduled receiver with triggeredBy='agent' +
//      triggeredByLabel='self_scheduled:<context_ref>'.
//   6. Store the returned task name on the row for cancellation.
//
// cancel_followup semantics:
//   1. UPDATE the pending row by (tenantId, agentId, context_ref) to
//      status='cancelled'.
//   2. Best-effort delete the Cloud Task. NOT_FOUND (code 5) is fine —
//      the task may have already fired in the race window.
//   3. Return { cancelled: <whether a pending row existed> }.

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../infrastructure/logging';
import { agentScheduledInvocationsRepo } from '../scheduling/agent-scheduled-invocations-repo';
import {
  enqueueAgentExecution,
  cancelScheduledAgentExecution,
} from '../infrastructure/cloud-tasks';
import { getPool } from '../infrastructure/database';
import type { StandardToolContext, StandardToolResult } from './standard-tool-handler';

const MIN_DELAY_SECONDS = 60;
const MAX_DELAY_SECONDS = 30 * 24 * 60 * 60; // 30 days
const PER_AGENT_PENDING_QUOTA = Number(process.env.SCHEDULE_FOLLOWUP_PER_AGENT_QUOTA ?? 5000);
const PER_TENANT_PENDING_QUOTA = Number(process.env.SCHEDULE_FOLLOWUP_PER_TENANT_QUOTA ?? 50000);
// Bound self-scheduled chains. The pending quota only caps fan-out (many
// distinct context_refs at once); a steady self-loop reuses one context_ref
// and keeps exactly one pending row, so the quota never trips. A generation
// counter is the industry-standard recursion limit; admission credits remain
// the ultimate budget backstop.
const MAX_CHAIN_DEPTH = Number(process.env.SCHEDULE_FOLLOWUP_MAX_CHAIN_DEPTH ?? 10);

function rejectResult(error: string): StandardToolResult {
  return { success: false, error };
}

export async function handleScheduleFollowup(
  payload: Record<string, unknown>,
  ctx: StandardToolContext,
): Promise<StandardToolResult> {
  const delaySecondsRaw = payload.delay_seconds;
  const atRaw = payload.at;
  const contextRef = typeof payload.context_ref === 'string' ? payload.context_ref.trim() : '';
  const objective = typeof payload.objective === 'string' ? payload.objective.trim() : '';
  const threadId = typeof payload.thread_id === 'string' ? payload.thread_id : (ctx.threadId ?? null);

  if (!contextRef) return rejectResult('schedule_followup: context_ref is required and must be non-empty');
  if (!objective) return rejectResult('schedule_followup: objective is required and must be non-empty');

  // Bound self-schedule chains. ctx.chainDepth is the generation of the CURRENT
  // execution (0 if human/cron/event-triggered). The follow-up we schedule will
  // be generation depth+1; refuse once the current generation has hit the cap.
  const currentDepth = ctx.chainDepth ?? 0;
  if (currentDepth >= MAX_CHAIN_DEPTH) {
    return rejectResult(
      `schedule_followup: max self-schedule chain depth (${MAX_CHAIN_DEPTH}) reached; refusing to extend the loop`,
    );
  }
  const nextDepth = currentDepth + 1;

  const haveDelay = typeof delaySecondsRaw === 'number' && Number.isFinite(delaySecondsRaw);
  const haveAt = typeof atRaw === 'string' && atRaw.length > 0;
  if (haveDelay === haveAt) {
    return rejectResult('schedule_followup: provide exactly one of `delay_seconds` or `at`');
  }

  const now = Date.now();
  let firesAt: Date;
  if (haveDelay) {
    firesAt = new Date(now + (delaySecondsRaw as number) * 1000);
  } else {
    firesAt = new Date(atRaw as string);
    if (Number.isNaN(firesAt.getTime())) {
      return rejectResult(`schedule_followup: \`at\` is not a valid ISO-8601 timestamp: ${atRaw as string}`);
    }
  }

  const deltaMs = firesAt.getTime() - now;
  if (deltaMs < MIN_DELAY_SECONDS * 1000) {
    return rejectResult(`schedule_followup: fire time must be at least ${MIN_DELAY_SECONDS}s in the future`);
  }
  if (deltaMs > MAX_DELAY_SECONDS * 1000) {
    return rejectResult(`schedule_followup: fire time must be within ${MAX_DELAY_SECONDS / 86400}d`);
  }

  // Quota checks — both per-agent and per-tenant pending counts.
  const pool = getPool();
  const { rows: quotaRows } = await pool.query<{ agent_count: string; tenant_count: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE agent_id = $2) AS agent_count,
       COUNT(*) AS tenant_count
     FROM agent_scheduled_invocations
     WHERE tenant_id = $1 AND status = 'pending'`,
    [ctx.tenantId, ctx.agentId],
  );
  const agentPending = Number(quotaRows[0]?.agent_count ?? 0);
  const tenantPending = Number(quotaRows[0]?.tenant_count ?? 0);
  if (agentPending >= PER_AGENT_PENDING_QUOTA) {
    return rejectResult(
      `schedule_followup: per-agent pending quota of ${PER_AGENT_PENDING_QUOTA} reached (current=${agentPending})`,
    );
  }
  if (tenantPending >= PER_TENANT_PENDING_QUOTA) {
    return rejectResult(
      `schedule_followup: per-tenant pending quota of ${PER_TENANT_PENDING_QUOTA} reached (current=${tenantPending})`,
    );
  }

  // Replace semantics: if a pending row exists at (tenantId, agentId, context_ref),
  // mark it cancelled and remember its cloud_task_name so we can best-effort
  // delete the Cloud Task after committing.
  let priorCloudTaskName: string | null = null;
  let priorScheduleKey: string | null = null;
  const client = await pool.connect();
  let row: { id: string };
  try {
    await client.query('BEGIN');
    const existing = await client.query<{ id: string; cloud_task_name: string | null; schedule_key: string }>(
      `SELECT id, cloud_task_name, schedule_key
       FROM agent_scheduled_invocations
       WHERE tenant_id=$1 AND agent_id=$2 AND context_ref=$3 AND status='pending'
       FOR UPDATE`,
      [ctx.tenantId, ctx.agentId, contextRef],
    );
    if (existing.rowCount && existing.rows[0]) {
      priorCloudTaskName = existing.rows[0].cloud_task_name;
      priorScheduleKey = existing.rows[0].schedule_key;
      await client.query(
        `UPDATE agent_scheduled_invocations
         SET status='cancelled', cancelled_at=NOW(), updated_at=NOW()
         WHERE id=$1`,
        [existing.rows[0].id],
      );
    }

    const scheduleKey = firesAt.toISOString().slice(0, 16);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO agent_scheduled_invocations
         (tenant_id, agent_id, thread_id, context_ref, schedule_key, fires_at, objective,
          scheduled_by_invocation_id, chain_depth)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        ctx.tenantId,
        ctx.agentId,
        threadId,
        contextRef,
        scheduleKey,
        firesAt,
        objective,
        ctx.invocationId ?? null,
        nextDepth,
      ],
    );
    row = inserted.rows[0];
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Best-effort cancel the prior task AFTER commit so the new schedule isn't
  // blocked on a stale-cancel error.
  if (priorCloudTaskName && priorScheduleKey) {
    try {
      await cancelScheduledAgentExecution(ctx.tenantId, ctx.agentId, priorScheduleKey, contextRef);
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code !== 5) {
        logger.warn(
          { err: (err as Error).message, task: priorCloudTaskName },
          'schedule_followup: prior task cancel failed (non-fatal)',
        );
      }
    }
  }

  // Enqueue the new task. Receiver path is the default /api/tasks/agent-scheduled.
  const scheduleKey = firesAt.toISOString().slice(0, 16);
  // workflows.id and workflow_tasks.id are UUID columns; the escalation
  // helper INSERT against both fails with `invalid input syntax for type
  // uuid` on any prefix. Idempotency for the follow-up itself is enforced
  // upstream by (tenant, agent, schedule_key) on agent_scheduled_invocations
  // and by Cloud Tasks's idempotency-key, so deriving workflowId from row.id
  // wasn't load-bearing — switch to plain UUIDs.
  const { taskName } = await enqueueAgentExecution(ctx.tenantId, ctx.agentId, {
    workflowId: uuidv4(),
    taskId: uuidv4(),
    objective,
    threadId: threadId ?? '',
    triggeredBy: 'agent',
    triggeredByLabel: `self_scheduled:${contextRef}`,
    scheduleKey,
    scheduleTime: firesAt,
    contextRef,
    chainDepth: nextDepth,
    // Taint inheritance: an untrusted-origin run's self-scheduled follow-up carries
    // the trust in a server-set inputData field, which the receiver threads into
    // executeTask (resolvedTrustLevel elevates on it). Same mechanism as spawn.
    ...(ctx.trustLevel === 'untrusted_inbound'
      ? { inputData: { _originTrust: 'untrusted_inbound' } }
      : {}),
  });
  await agentScheduledInvocationsRepo.updateCloudTaskName(row.id, taskName);

  logger.info('schedule_followup scheduled', {
    tenant_id: ctx.tenantId,
    agent_id: ctx.agentId,
    context_ref: contextRef,
    fires_at: firesAt.toISOString(),
    scheduled_invocation_id: row.id,
  });

  return {
    success: true,
    result: {
      scheduled_at: new Date().toISOString(),
      fires_at: firesAt.toISOString(),
      context_ref: contextRef,
    },
  };
}

export async function handleCancelFollowup(
  payload: Record<string, unknown>,
  ctx: StandardToolContext,
): Promise<StandardToolResult> {
  const contextRef = typeof payload.context_ref === 'string' ? payload.context_ref.trim() : '';
  if (!contextRef) return rejectResult('cancel_followup: context_ref is required and must be non-empty');

  const pool = getPool();
  const { rows } = await pool.query<{ id: string; cloud_task_name: string | null; schedule_key: string }>(
    `UPDATE agent_scheduled_invocations
     SET status='cancelled', cancelled_at=NOW(), updated_at=NOW()
     WHERE tenant_id=$1 AND agent_id=$2 AND context_ref=$3 AND status='pending'
     RETURNING id, cloud_task_name, schedule_key`,
    [ctx.tenantId, ctx.agentId, contextRef],
  );

  if (rows.length === 0) {
    return { success: true, result: { cancelled: false } };
  }

  const row = rows[0];
  try {
    await cancelScheduledAgentExecution(ctx.tenantId, ctx.agentId, row.schedule_key, contextRef);
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code !== 5) {
      logger.warn(
        { err: (err as Error).message, task: row.cloud_task_name },
        'cancel_followup: Cloud Task delete failed (non-fatal)',
      );
    }
  }

  logger.info('cancel_followup cancelled', {
    tenant_id: ctx.tenantId,
    agent_id: ctx.agentId,
    context_ref: contextRef,
    scheduled_invocation_id: row.id,
  });

  return { success: true, result: { cancelled: true } };
}
