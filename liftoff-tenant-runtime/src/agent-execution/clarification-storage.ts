import type { PoolClient } from 'pg';
import { logger } from '../infrastructure/logging';
// Type-only import to eliminate any runtime dependency chain
// (service.ts → standard-tool-handler.ts → anchor-client.ts).
import type { HybridResumeState } from './service';

/** What kind of thing the run is waiting on.
 *
 *  'question' — a person must choose between options or supply a value. Only
 *  useful in context, so it expires with the run's window.
 *  'blocker'  — a person must act outside the product before the run can go on
 *  (share a sheet, fix a credential, grant access). Still true tomorrow, so it
 *  gets a longer window and an expiry that does not hide it. */
export type ClarificationOrigin = 'question' | 'blocker';

export type ClarificationSource =
  | { kind: 'recovery_llm'; origin?: ClarificationOrigin }
  | { kind: 'anchor_intervention'; vendorRequestId: string };

/** Windows before an unanswered clarification expires.
 *
 *  A question dropped after a day costs the user nothing: they have moved on
 *  and the run's context is stale. A blocker is a standing request against the
 *  workspace, and expiring it in a day means a run abandoned before anyone
 *  reasonably could have acted. Both are re-parked by the agent's next tick, so
 *  these bound how long ONE ask stays open, not how long we keep asking. */
export const QUESTION_EXPIRY_MS = 24 * 60 * 60 * 1000;
export const BLOCKER_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** NULL origin means the row predates the column, and every consumer must read
 *  it as the old behaviour rather than guessing. */
export function originOf(source: ClarificationSource): ClarificationOrigin {
  return source.kind === 'recovery_llm' ? (source.origin ?? 'question') : 'question';
}

export interface InsertClarificationRowArgs {
  client: PoolClient;              // caller manages BEGIN/COMMIT
  /** The row's id, when the caller minted it ahead of the insert (a pause
   *  checkpoint is keyed by it and written first). Absent, the database mints
   *  one. Unused on a dedup, which returns the earlier open row's id. */
  id?: string;
  tenantId: string;
  agentId: string;
  invocationId: string;
  threadId: string | null;         // null → create a new thread inside this fn
  pausedAtStepId: string | null;
  question: string;
  source: ClarificationSource;
  // null when source.kind === 'anchor_intervention' — our agent loop isn't paused.
  pauseState: HybridResumeState | null;
  /** Whether a person is driving this turn live, from ExecutionContext.streamSink
   *  ("When set (interactive chat)"). Suppresses the A1 notification below,
   *  because somebody is already in the conversation watching the answer arrive.
   *
   *  Deliberately NOT inferred from threadId being absent. A run resumed after
   *  its question was answered carries the blocker thread forward, so a second
   *  blocker in that same thread has a threadId and no audience: the answer came
   *  back through Cloud Tasks and nobody is watching the stream. Reading a
   *  threadId as "a person is here" silences exactly the case A1 exists for. */
  interactive: boolean;
  /** Whether to tell somebody the run is parked. False under the Escalation
   *  setting "Only exceptions" for a plain question (hitl-enforcement/
   *  surfacing.ts): the row is written and the run pauses, but nobody is
   *  notified and the row is not an item on the review page
   *  (`review_listed`, migration 430); the question waits in its chat thread
   *  under the run's paused state. Absent reads as true. */
  notify?: boolean;
}

export async function insertClarificationRow(
  args: InsertClarificationRowArgs,
): Promise<{ scheduledRowId: string; threadId: string; deduped: boolean }> {
  const {
    client, tenantId, agentId, invocationId, pausedAtStepId, question, source, pauseState,
  } = args;
  const origin = originOf(source);

  // 0. Dedup: at most ONE open recovery-advisor clarification per agent.
  //
  // The advisor can now choose 'ask_user' (its decision was previously
  // unreachable), and it sits on the common anomaly path. A scheduled agent
  // whose blocker recurs — a disconnected connector, say — hits that anomaly on
  // every tick, so without this an agent on a 1-minute cron would open 1,440
  // clarifications a day: 1,440 threads, 1,440 questions posted at the user,
  // 1,440 24-hour expiry tasks. The pause does not hold the per-agent lock (it
  // is released in executeTaskInner's finally) and it closes its trigger row,
  // so later ticks keep running by design — which is exactly why the flood is
  // possible and has to be stopped here.
  //
  // Same shape as createEscalation's per-(tenant, agent, kind) dedup. Scoped to
  // 'recovery_llm' so interactive-chat / anchor_intervention clarifications are
  // untouched: those are user-initiated and one per turn.
  if (source.kind === 'recovery_llm') {
    const existing = await client.query<{
      id: string; thread_id: string; notified_at: Date | null; clarification_origin: string | null;
      original_question: string | null;
    }>(
      // original_question comes from the row rather than from this tick. A
      // retry announces the question that is actually parked and waiting for an
      // answer; this tick's phrasing of the same blocker was never asked, is in
      // no thread, and would send somebody looking for a question the queue
      // does not show. Same JSONB path the queue listing reads.
      `SELECT id, thread_id, notified_at, clarification_origin,
              workflow_resume_payload->'pauseContext'->>'originalQuestion' AS original_question
         FROM agent_scheduled_invocations
        WHERE tenant_id = $1 AND agent_id = $2
          AND status = 'pending'
          AND clarification_source = 'recovery_llm'
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, agentId],
    );
    if (existing.rows.length > 0) {
      const { id, thread_id: existingThreadId, notified_at } = existing.rows[0];
      logger.info(
        { clarificationId: id, tenantId, agentId },
        'Clarification deduped — this agent already has an unanswered question outstanding',
      );
      // The dedup suppresses a second ASK. It must not also suppress a first
      // TELL: if the earlier tick's notification failed, nobody knows this run
      // is parked, and returning here again would leave it that way until the
      // row expires. Retry on this tick and stamp it, so delivery is
      // at-least-once while the flood protection stays exactly as strong.
      if (!notified_at && args.notify !== false) {
        await notifyBlockerParked({
          client,
          tenantId,
          agentId,
          invocationId,
          scheduledRowId: id,
          threadId: existingThreadId,
          // Falls back to this tick's text only if the stored payload has no
          // question, which would mean a row written outside this function.
          question: existing.rows[0].original_question ?? question,
          origin: (existing.rows[0].clarification_origin as ClarificationOrigin | null) ?? 'question',
          interactive: args.interactive,
        });
      }
      // Deliberately no new thread, message or expiry task: the user has
      // already been asked and answering the open one resumes that run.
      // `deduped` is what stops the caller arming a SECOND expiry Cloud Task.
      // Without it this function's promise above — "deliberately no new thread,
      // message or expiry task" — was only two-thirds true: the task is armed by
      // the CALLER, which could not tell an insert from a dedup because both
      // returned the same shape. Twelve tasks accumulated against one row.
      return { scheduledRowId: id, threadId: existingThreadId, deduped: true };
    }
  }

  // 1. Resolve or create thread.
  let threadId: string;
  if (args.threadId) {
    threadId = args.threadId;
  } else {
    const titleTrunc = question.length > 80 ? question.slice(0, 77) + '...' : question;
    // "Clarification needed: Share the sheet with the service account" reads
    // like a request for detail on something already under way. A blocker is
    // the opposite: nothing is under way until somebody acts. The title is the
    // first thing anyone sees in the thread list, so it names which it is.
    const titlePrefix = origin === 'blocker' ? 'Blocked: ' : 'Clarification needed: ';
    const res = await client.query(
      `INSERT INTO threads (id, tenant_id, agent_id, initiated_by_type, initiated_by_user, title, status, execution_path)
       VALUES (gen_random_uuid(), $1, $2, 'agent', NULL, $3, 'open', 'interactive')
       RETURNING id`,
      [tenantId, agentId, `${titlePrefix}${titleTrunc}`],
    );
    threadId = res.rows[0].id as string;
  }

  // 2. INSERT assistant message into messages.
  await client.query(
    `INSERT INTO messages (id, tenant_id, thread_id, role, content, input_tokens, output_tokens, created_at)
     VALUES (gen_random_uuid(), $1, $2, 'assistant', $3, 0, 0, NOW())`,
    [tenantId, threadId, question],
  );

  // 3. Build the workflow_resume_payload JSONB.
  //    - For recovery_llm: full HybridResumeState as today.
  //    - For anchor_intervention: minimal `{ pauseContext: { originalQuestion, threadId } }`
  //      so the unified listing query's JSONB extraction
  //      (workflow_resume_payload->'pauseContext'->>'originalQuestion') returns the question
  //      text in both branches.
  let resumePayload: unknown;
  if (source.kind === 'recovery_llm') {
    if (!pauseState) {
      throw new Error('recovery_llm clarification requires a HybridResumeState pauseState');
    }
    resumePayload = {
      ...pauseState,
      kind: 'hybrid-pause',
      pauseReason: 'ask_user',
      pauseContext: { originalQuestion: question, threadId },
    };
  } else {
    resumePayload = {
      pauseContext: { originalQuestion: question, threadId },
    };
  }

  // 4. INSERT agent_scheduled_invocations row.
  //
  // A blocker holds its ask open for a week rather than a day: "share the
  // sheet" is still true at hour 25, and expiring it overnight abandons the run
  // before anyone could reasonably have acted.
  const firesAt = new Date(
    Date.now() + (origin === 'blocker' ? BLOCKER_EXPIRY_MS : QUESTION_EXPIRY_MS),
  );
  const contextRef = `clarification:${agentId}:${invocationId}:${pausedAtStepId ?? 'none'}`;
  const scheduleKey = firesAt.toISOString().slice(0, 16);
  const clarificationSource = source.kind;
  const vendorRequestId = source.kind === 'anchor_intervention' ? source.vendorRequestId : null;
  // One decision, two effects: a question nobody is told about is not an item
  // on the review page either. The review queue's listing and count read
  // this column and nothing else does, so the row is still answered by a
  // reply in its thread and expired by the sweeper as a listed one is.
  const reviewListed = args.notify !== false;

  const insertRes = await client.query(
    `INSERT INTO agent_scheduled_invocations
       (tenant_id, agent_id, thread_id, context_ref, schedule_key, fires_at, objective,
        scheduled_by_invocation_id, workflow_resume_payload,
        clarification_source, vendor_request_id, clarification_origin, id, review_listed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13::uuid, gen_random_uuid()), $14)
     RETURNING id`,
    [
      tenantId,
      agentId,
      threadId,
      contextRef,
      scheduleKey,
      firesAt,
      'clarification-expiry',
      invocationId,
      JSON.stringify(resumePayload),
      clarificationSource,
      vendorRequestId,
      origin,
      args.id ?? null,
      reviewListed,
    ],
  );
  const scheduledRowId = insertRes.rows[0].id as string;

  // 5. A1: tell somebody the run is parked.
  //
  // Escalations fired a durable notification (WS-3.9) so they reached humans
  // even when nobody was watching the thread's SSE stream. Routing a
  // customer-clearable blocker to a pause instead of an escalation replaced
  // that path with nothing, so a scheduled agent blocked on something a person
  // could fix now parks in silence. For a cron agent nobody is watching, that
  // is worse than what it replaced. This restores it through the SAME sender
  // the escalation used, so there is one notification path, not two.
  //
  // Placement is load-bearing. It sits after the dedup's early return above,
  // so a blocker that recurs on every tick notifies once rather than once per
  // tick — a 1-minute cron would otherwise send 1,440 a day, the exact flood
  // the dedup exists to prevent. The re-arm is the dedup's too: answering or
  // expiring moves the row out of 'pending' (both paths reach
  // markClarificationFired), the next occurrence therefore misses the dedup,
  // and it notifies again. No second piece of state tracks "already told".
  //
  if (args.notify !== false) {
    await notifyBlockerParked({
      client,
      tenantId,
      agentId,
      invocationId,
      scheduledRowId,
      threadId,
      question,
      origin,
      interactive: args.interactive,
      sourceKind: source.kind,
    });
  } else {
    logger.info(
      { clarificationId: scheduledRowId, tenantId, agentId, origin, threadId },
      'Clarification parked without notification or a review item: the Escalation setting is "Only exceptions"',
    );
  }

  return { scheduledRowId, threadId, deduped: false };
}

/** A1: tell somebody the run is parked.
 *
 *  Escalations fired a durable notification (WS-3.9) so they reached humans
 *  even when nobody was watching the thread's SSE stream. Routing a
 *  customer-clearable blocker to a pause instead of an escalation replaced that
 *  path with nothing, so a scheduled agent blocked on something a person could
 *  fix parked in silence. For a cron agent nobody is watching, that is worse
 *  than what it replaced. This is the same sender the escalation used, so there
 *  is one notification path rather than two.
 *
 *  Shared by the insert path and the dedup's retry, which is why it takes the
 *  row id rather than creating one: both are "this run is parked and the person
 *  who can clear it has not been told".
 *
 *  Silent for anchor_intervention (a live browser hand-off) and for interactive
 *  chat (somebody is reading the reply as it streams). Everything else —
 *  scheduled, event-triggered and resumed runs — parks where nobody is looking,
 *  which is the whole reason this exists. */
async function notifyBlockerParked(args: {
  client: PoolClient;
  tenantId: string;
  agentId: string;
  invocationId: string;
  scheduledRowId: string;
  threadId: string;
  question: string;
  origin: ClarificationOrigin;
  interactive: boolean;
  /** Absent on the dedup retry, where the row was already filtered to
   *  recovery_llm by the lookup that found it. */
  sourceKind?: ClarificationSource['kind'];
}): Promise<void> {
  const { client, tenantId, agentId, scheduledRowId, interactive } = args;
  if (args.sourceKind === 'anchor_intervention' || interactive) return;

  try {
    const { enqueueEscalationNotification } = await import('../platform-callback/client');
    // agentId here is the RUNTIME id. PB's recipient and display-name lookup
    // reads internal_agents, keyed by the control-plane id; the two are linked
    // only through internal_agent_runtime_mapping (INV-TR-010). A raw runtime
    // id matches zero rows there with no error and silently discards the
    // configured recipient, so it must be translated first. Same translation
    // the escalation path does, for the same reason.
    const { resolveInternalAgentId } = await import('../agent-lifecycle/resolve-runtime-agent-id');
    const internalAgentId = await resolveInternalAgentId(tenantId, agentId, 'clarification-notify');
    await enqueueEscalationNotification({
      tenantId,
      agentId,
      internalAgentId,
      invocationId: args.invocationId,
      // PB treats this as an opaque correlation id: it rides the notification
      // payload and becomes the Slack and Teams fan-out's reviewId. It never
      // queries workflow_escalations with it, and the link it builds is the
      // review queue itself rather than a per-item route. The clarification row
      // is this record's identity, so it is what belongs here.
      escalationId: scheduledRowId,
      reason: args.question,
      threadId: args.threadId,
      // Chooses the wording on PB's side. A parked run announced as "escalated"
      // describes something that already ended; this one is still waiting.
      recordKind: args.origin === 'blocker' ? 'blocker' : 'clarification',
    });
    // Stamped only after the send resolves, so a failure leaves it NULL and the
    // owning agent's next tick retries through the dedup path. The
    // notification links to the review queue, so a row somebody was told
    // about is on it: a question filed under "Only exceptions" that a later
    // tick announces (the setting changed in between) is listed from here on.
    await client.query(
      `UPDATE agent_scheduled_invocations SET notified_at = NOW(), review_listed = true WHERE id = $1`,
      [scheduledRowId],
    );
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, clarificationId: scheduledRowId, agentId },
      'Non-fatal: clarification notification enqueue failed — will retry on the next tick',
    );
    // Never throw. The pause row, its thread and its message must persist
    // regardless, exactly how the escalation path treats a failed notify. A run
    // that parked but could not announce itself is still parked, the queue at
    // /dashboard/review still lists it, and notified_at being NULL means the
    // next tick tries again rather than waiting for the window to lapse.
  }
}
