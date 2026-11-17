// Escalation Helper — single source of truth for creating escalations.
//
// Every execution path routes through this function, so escalations are
// written in one place and always populate workflow_escalations with
// tenant_id (migration 230). A second, private insert path is how tenant
// scope gets silently dropped or written to a column that does not exist.
//
// REVIEW FIX DE-001: Uses existing `workflow_escalations` table (not `escalations`).

import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';
import { getPoolForService } from '../../infrastructure/database';
import { streamingService } from '../../streaming/service';
import { insertAuditLog } from '../../audit/service';
import { recordEscalationRaised } from '../evidence-totals';
import { logger } from '../../infrastructure/logging';
import type { ExecutionContext } from '../types';
import { firstPresentId } from '../run-identity';

/** A thread title from the blocker's first line.
 *
 *  The chat thread list shows a title, and a team's escalations would otherwise
 *  be a column of identical untitled rows — readable only by opening each one.
 *  The first sentence of a blocker is written to a person and is the closest
 *  thing to a subject line available without another model call.
 *
 *  Markdown is stripped rather than rendered: a title is plain text, and a
 *  leading `**` in the list reads as broken rather than as emphasis. */
export function escalationThreadTitle(reason: string): string | null {
  const firstLine = reason
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0);
  if (!firstLine) return null;
  const plain = firstLine
    .replace(/[*_`#>]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return null;
  return plain.length > 80 ? `${plain.slice(0, 77)}...` : plain;
}

export interface CreateEscalationOptions {
  /** Which surface this escalation belongs on.
   *
   *  - 'escalation' (default): the customer-facing review queue + notifications.
   *  - 'system_internal': platform-internal record only; no SSE, no
   *    notification, not in the review queue (D14).
   *
   *  THE TEST, and it is about the reader, not the severity: does a person
   *  reading this reason have something to DO about it? Use 'escalation' only
   *  when a human decision or action unblocks the agent AND the reason was
   *  written for a human — an agent-authored escalation reason, a report_task_outcome
   *  summary, an approval the person must grant.
   *
   *  Use 'system_internal' for reasons assembled by code from internal state:
   *  retry counters, tool error codes, cap exhaustion, context limits. These are
   *  real failures worth recording, but a person cannot act on
   *  `permanent tool error x2 on "Bash" (internal_error)` — putting it in the
   *  review queue trains people to ignore the queue, which costs them the
   *  escalations that DO need them. */
  kind?: 'escalation' | 'system_internal';
  /** WHAT failed, as `<class>:<stable ids>` — `unsatisfied_output:s3,s7`,
   *  `condition_dead_end:s4`, `recovery_cap:s9`, `permanent:auth_expired:s2`,
   *  `expiry:clarification`. The dedupe below collapses a repeat into an
   *  existing open row only when this matches (NULL matches NULL and nothing
   *  else), so two different defects on one agent no longer fold into a
   *  single row whose text is whichever came last. A caller that supplies
   *  none keeps today's behaviour among the rows that supply none. */
  fingerprint?: string;
  /** WHICH graph version it happened on: `state.context.instructionVersion`.
   *  Compared the same way, so a redistill that repaired the graph starts a
   *  fresh row and the old one stops growing. Omitted by a caller whose
   *  context carries no real version (the clarification-expiry handler builds
   *  a minimal context with `instructionVersion: 0`); passing that would
   *  dedupe every version into one row. */
  instructionVersion?: number;
  /** Why the escalation landed on this surface, for the row's `context`
   *  column (migration 429): `ask_check = { person_can_act: p }` when the ask
   *  check moved a customer-facing escalation to an operator record. */
  context?: Record<string, unknown>;
}

/** The `<class>` half of a fingerprint, for the recurrence metric. A
 *  fingerprint is `<class>:<ids>`; the ids are per agent and would explode the
 *  label space, the class is what a recurring defect is counted by. */
function fingerprintPrefix(fingerprint: string | undefined): string {
  if (!fingerprint) return 'none';
  const i = fingerprint.indexOf(':');
  return i === -1 ? fingerprint : fingerprint.slice(0, i);
}

/** One escalation occurrence, recorded whether or not it opened a new row.
 *
 *  Fire-and-forget by design: an escalation that cannot be audited is still an
 *  escalation, and failing the run over the ledger would be the worse trade. */
function writeEscalationAudit(
  context: ExecutionContext,
  reason: string,
  kind: 'escalation' | 'system_internal',
): void {
  insertAuditLog(null, context.tenantId, {
    internalAgentId: context.agentId,
    invocationId: context.invocationId,
    action: 'agent_escalation',
    inputArgs: { reason, kind },
    outcome: 'success',
    triggeredBy: `agent:${context.agentId}`,
  }).catch(err => logger.warn({ err }, 'Non-fatal: escalation audit failed'));
}

/** Namespace for ids minted on behalf of a run that has no workflow of its
 *  own. Fixed, so the same run always derives the same synthetic ids. */
const SYNTHETIC_RUN_IDENTITY_NS = 'b1f4e0a2-7c3d-4e8f-9a6b-2d5c8e1f0a37';

/** The (workflowId, taskId) pair an escalation is written under.
 *
 *  `workflow_escalations.workflow_id` and `.task_id` are NOT NULL foreign keys,
 *  so an escalation must name a workflow and a task even for a run that has
 *  none — a chat clarification, a sweeper, a companion work item. This is the
 *  one boundary that turns an absent id into a real one, and it does so in a
 *  fixed order:
 *
 *   1. the context's own ids, when well-formed;
 *   2. a present taskId with an absent workflowId: the task's ACTUAL parent,
 *      read from workflow_tasks — an escalation must never name a workflow
 *      other than the one its task belongs to;
 *   3. anything still absent: a synthetic id derived from the run (tenant,
 *      agent, and the invocation or trace), not drawn at random, so a retry of
 *      the same run resolves to the same rows and the ON CONFLICT DO NOTHING
 *      inserts make the retry idempotent instead of a second orphan pair. A
 *      run with no invocation and no trace has nothing stable to derive from
 *      and falls back to a random id.
 *
 *  Resolved ids are written back onto the context so every later write in the
 *  same run agrees with the escalation. Minting is logged so an upstream path
 *  that failed to recover a real id is visible as a count, not silence. */
async function resolveEscalationIdentity(
  pool: { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  context: ExecutionContext,
): Promise<{ workflowId: string; taskId: string; minted: Array<'workflowId' | 'taskId'> }> {
  let workflowId = firstPresentId(context.workflowId);
  const taskId = firstPresentId(context.taskId);
  const minted: Array<'workflowId' | 'taskId'> = [];

  if (!workflowId && taskId) {
    const parent = await pool.query<{ workflow_id: string | null }>(
      `SELECT workflow_id FROM workflow_tasks WHERE id = $1`,
      [taskId],
    );
    workflowId = firstPresentId(parent.rows[0]?.workflow_id);
  }

  const runKey = context.invocationId ?? context.traceId;
  const synthetic = (facet: 'workflow' | 'task'): string =>
    runKey
      ? uuidv5(`${context.tenantId}:${context.agentId}:${runKey}:${facet}`, SYNTHETIC_RUN_IDENTITY_NS)
      : uuidv4();

  const resolvedWorkflowId = workflowId ?? (minted.push('workflowId'), synthetic('workflow'));
  const resolvedTaskId = taskId ?? (minted.push('taskId'), synthetic('task'));

  context.workflowId = resolvedWorkflowId;
  context.taskId = resolvedTaskId;
  if (minted.length > 0) {
    logger.info(
      {
        event: 'escalation_identity_minted',
        tenant_id: context.tenantId,
        agent_id: context.agentId,
        invocation_id: context.invocationId,
        trace_id: context.traceId,
        minted,
        deterministic: Boolean(runKey),
      },
      'escalation: run carried no workflow/task id; synthetic identity minted for the escalation rows',
    );
  }
  return { workflowId: resolvedWorkflowId, taskId: resolvedTaskId, minted };
}

/** Which surface an escalation row is on, read back by id.
 *
 *  A run's `escalated` flag says a record was written; it does not say a
 *  person received anything. Only a row of kind 'escalation' opened a thread
 *  and sent a notification (see the two `kind === 'escalation'` branches
 *  below); a 'system_internal' row is operator-only. The chat turn handler
 *  asks this before it tells a thread the work was passed to a person.
 *
 *  `null` on a miss, on a missing id, or on a lookup error — each logged with
 *  the id — and the caller treats null as "no person received anything": the
 *  claim is made only when the record proves it. */
export async function escalationKindById(
  tenantId: string,
  escalationId: string | undefined,
): Promise<'escalation' | 'system_internal' | null> {
  if (!escalationId) return null;
  try {
    const pool = getPoolForService('scheduled-execution');
    const res = await pool.query<{ kind: 'escalation' | 'system_internal' | null }>(
      `SELECT kind FROM workflow_escalations WHERE id = $1 AND tenant_id = $2`,
      [escalationId, tenantId],
    );
    const kind = res.rows[0]?.kind ?? null;
    if (kind === null) {
      logger.warn({ escalationId, tenantId }, 'escalation kind lookup found no row for this id');
      return null;
    }
    return kind;
  } catch (err) {
    logger.warn({ err: (err as Error).message, escalationId, tenantId }, 'escalation kind lookup failed');
    return null;
  }
}

export async function createEscalation(
  context: ExecutionContext,
  reason: string,
  opts?: CreateEscalationOptions
): Promise<string> {
  const pool = getPoolForService('scheduled-execution');
  const escalationId = uuidv4();
  const kind: 'escalation' | 'system_internal' = opts?.kind ?? 'escalation';
  const fingerprint = opts?.fingerprint ?? null;
  const instructionVersion = opts?.instructionVersion ?? null;

  // Dedup: collapse repeat escalations of the same still-open issue into the
  // existing row instead of piling up a new workflow/task/escalation + SSE +
  // notification every scheduled run. Keyed on (tenant, agent, kind) AND on
  // the fingerprint and graph version the caller supplied — an agent stuck on
  // an unresolved blocker re-escalates the same thing, so a single live row +
  // an occurrence counter is the correct representation, not thousands of
  // near-identical rows; but two DIFFERENT blockers are two rows, and the
  // same blocker on a repaired graph is a fresh one. IS NOT DISTINCT FROM so
  // a caller that supplies neither (NULL, NULL) still merges with its own kind
  // exactly as before and never with a fingerprinted row.
  if (context.agentId) {
    const existing = await pool.query<{ id: string; occurrence_count: number }>(
      `UPDATE workflow_escalations
          SET occurrence_count = occurrence_count + 1,
              last_occurred_at = NOW(),
              reason = $4
        WHERE id = (
          SELECT id FROM workflow_escalations
           WHERE tenant_id = $1 AND agent_id = $2 AND kind = $3 AND status = 'pending'
             AND reason_fingerprint IS NOT DISTINCT FROM $5
             AND instruction_version IS NOT DISTINCT FROM $6
           ORDER BY created_at DESC
           LIMIT 1
        )
        RETURNING id, occurrence_count`,
      [context.tenantId, context.agentId, kind, reason, fingerprint, instructionVersion],
    );
    if (existing.rows.length > 0) {
      const { id: existingId, occurrence_count: count } = existing.rows[0];
      logger.info(
        { escalationId: existingId, agentId: context.agentId, kind, occurrenceCount: count, fingerprint, instructionVersion },
        'Escalation deduped — bumped existing open escalation instead of creating a new one',
      );
      // A recurring defect is visible as a log-based metric rather than only
      // as a silently growing row. Label space is the class, not the ids.
      logger.info({
        metric: 'hybrid_loop.escalation_recurrence',
        fingerprint_prefix: fingerprintPrefix(fingerprint ?? undefined),
        occurrence_count: String(count),
      }, 'hybrid_loop.escalation_recurrence');
      // The audit row is written on BOTH paths, and it is the only per-
      // occurrence record that exists.
      //
      // It used to sit after this early return, so a deduped escalation left
      // nothing behind but `occurrence_count`. The UPDATE above also does
      // `SET reason = $4`, so the previous reason was overwritten with no
      // trace: an agent that escalated eighteen times had one audit row, one
      // reason — the newest — and no way to tell one recurring blocker from
      // eighteen different ones. Whether a person is NOTIFIED is a separate
      // decision, deliberately unchanged here; whether the platform can say
      // what happened is not a decision at all.
      writeEscalationAudit(context, reason, kind);
      // NB: dedup only. We deliberately do NOT change the agent's lifecycle
      // (e.g. auto-pause) here — a silent ACTIVE→PAUSED transition the operator
      // didn't ask for is more confusing than the runaway it prevents. The
      // occurrence_count + last_occurred_at surface the recurrence so an
      // operator can decide; the row no longer multiplies.
      return existingId;
    }
  }

  // Insert escalation — workflow_escalations has FKs on workflow_id → workflows(id)
  // and task_id → workflow_tasks(id). Scheduled/SDK executions generate random UUIDs
  // for these that don't have parent rows. Ensure parent rows exist first.
  const { workflowId, taskId } = await resolveEscalationIdentity(pool, context);

  await pool.query(
    `INSERT INTO workflows (id, tenant_id, agent_id, objective, status)
     VALUES ($1, $2, $3, $4, 'escalated')
     ON CONFLICT (id) DO NOTHING`,
    [workflowId, context.tenantId, context.agentId, reason]
  );

  await pool.query(
    `INSERT INTO workflow_tasks (id, workflow_id, agent_id, status, idempotency_key)
     VALUES ($1, $2, $3, 'escalated', $4)
     ON CONFLICT (id) DO NOTHING`,
    [taskId, workflowId, context.agentId, `escalation-${escalationId}`]
  );

  // `last_occurred_at` is stamped on the INSERT, with the same NOW() as
  // created_at: a row's first occurrence IS its creation. It used to be set
  // only by the dedupe UPDATE, so a fresh row carried NULL until its second
  // occurrence and any query ordered or windowed on last_occurred_at missed
  // exactly the rows that had just appeared. Migration 287 backfilled the rows
  // that existed then; migration 416 backfills the ones inserted since.
  await pool.query(
    `INSERT INTO workflow_escalations (id, workflow_id, task_id, agent_id, tenant_id, reason, status, kind, created_at,
                                       last_occurred_at, reason_fingerprint, instruction_version, context)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NOW(), NOW(), $8, $9, $10)`,
    [escalationId, workflowId, taskId, context.agentId, context.tenantId, reason, kind, fingerprint, instructionVersion,
      opts?.context ? JSON.stringify(opts.context) : null]
  );

  // D14: only user-facing escalations emit the SSE notification. System-
  // internal records (cap-exhausted, clarification-expiry) are operator-only
  // and must NOT surface in the customer-facing /reviews stream.
  if (kind === 'escalation' && context.threadId) {
    streamingService.emitHitlRequired(
      context.threadId,
      context.invocationId || '',
      escalationId,
      reason,
      [],
      new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h expiry
    );
  }

  // B0: the raised-count half of the evidence totals, stamped at the event so
  // it survives the row being deleted by retention. Non-fatal and not awaited
  // for the same reason the audit log below is not: bookkeeping must never be
  // what stops an escalation from persisting.
  if (context.agentId) {
    void recordEscalationRaised(context.tenantId, context.agentId);
  }

  // Audit log — see writeEscalationAudit, called from the dedupe path too.
  writeEscalationAudit(context, reason, kind);

  // WS-3.9: fire a durable notification so escalations reach humans even when
  // no one is watching the thread's SSE stream. `kind: 'system_internal'`
  // skips this (cap-exhausted records are operator-only). The dedup in
  // notification_dedup prevents double-delivery if the agent ALSO called
  // notifications_send for the same reason in the same invocation.
  if (kind === 'escalation') {
    try {
      const { enqueueEscalationNotification } = await import('../../platform-callback/client');
      // context.agentId is the RUNTIME id. PB's recipient/name lookup reads
      // internal_agents, which is keyed by the control-plane id — the two are
      // linked only through internal_agent_runtime_mapping (INV-TR-010).
      // A raw runtime id matches zero rows there with no error and silently
      // discards the configured recipient, so it must be translated here.
      // resolveInternalAgentId never falls back and emits a structured miss
      // event.
      const { resolveInternalAgentId } = await import('../../agent-lifecycle/resolve-runtime-agent-id');
      const internalAgentId = context.agentId
        ? await resolveInternalAgentId(context.tenantId, context.agentId, 'escalation-notify')
        : null;

      // Put the blocker in the team's chat before announcing it, so the DM has
      // somewhere to point.
      //
      // This is the in-app half of the delivery and it is the half that was
      // missing. An escalated run has ended, so it is deliberately absent from
      // the /review queue — that queue holds work which resumes when someone
      // answers it, and there is nothing here to resume. Without a thread the
      // Slack DM was the only delivery in existence: miss it and there was no
      // screen anywhere to go and look.
      //
      // Best-effort and ordered first rather than awaited-together: a chat
      // failure must cost the link, never the notification. Needs the
      // control-plane id, so it is skipped when the mapping could not resolve
      // — PB would have nothing to attach the message to.
      let chatThreadId: string | null = null;
      if (internalAgentId) {
        try {
          const { openEscalationThread } = await import('../../platform-callback/client');
          chatThreadId = await openEscalationThread({
            tenantId: context.tenantId,
            internalAgentId,
            escalationId,
            reason,
            threadId: context.threadId ?? null,
            title: escalationThreadTitle(reason),
          });
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, escalationId, agentId: context.agentId },
            'Non-fatal: could not open the escalation chat thread',
          );
        }
      }

      await enqueueEscalationNotification({
        tenantId: context.tenantId,
        agentId: context.agentId,
        internalAgentId,
        invocationId: context.invocationId ?? null,
        escalationId,
        reason,
        threadId: context.threadId ?? null,
        chatThreadId,
        // Stated rather than left to the default, because the default is what
        // an OLD runtime sends and the backend has to be able to tell the two
        // apart. 'escalation' means the run has ended and left a record: there
        // is no queue item to send anyone to, which is exactly what the
        // notification must not imply.
        recordKind: 'escalation',
      });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, escalationId, agentId: context.agentId },
        'Non-fatal: escalation notification enqueue failed',
      );
      // Never throw — escalation row + audit must persist regardless.
    }
  }

  logger.info({ escalationId, agentId: context.agentId, reason, kind, fingerprint, instructionVersion }, 'Escalation created from SDK engine');

  return escalationId;
}
