/**
 * `open_chat_thread` — deliver the work into the team's own chat.
 *
 * A team whose workspace has no team-chat connector still has somewhere to put
 * its output: the chat it already has with the person it works for. The thread
 * opens on `/dashboard/agents` with an unread badge, the reply box works, and
 * the message carries the team as its author.
 *
 * This rides the machinery escalation already uses — `findOrCreateThread`, the
 * participant row, `message_type`, idempotency on the external ref — and
 * differs from it in one deliberate way. Escalation means the run STOPPED and
 * somebody must act; it is a terminal marker that ends the run and stamps
 * `status='escalated'`, which the reflection engine counts as a run that got
 * stuck. A delivered checklist is the opposite of stuck, and it happens in the
 * middle of a workflow rather than at the end of one. So this is a TOOL, which
 * a graph can dispatch as a step and distillation can emit, rather than a
 * marker that would end the run three steps early and pollute the metric.
 */
import { v5 as uuidv5 } from 'uuid';
import { logger } from '../infrastructure/logging';
import type { StandardToolContext, StandardToolResult } from './standard-tool-handler';

/** Fixed namespace for delivery ids. Any constant UUID works; it exists so the
 *  same delivery always hashes to the same id and two different tools cannot
 *  collide on one name. */
const DELIVERY_NAMESPACE = '1b4e28ba-2fa1-11d2-883f-0016d3cca427';

export interface OpenChatThreadInput {
  title?: string;
  body?: string;
}

export async function handleOpenChatThread(
  input: OpenChatThreadInput,
  ctx: StandardToolContext,
): Promise<StandardToolResult> {
  const body = (input.body ?? '').trim();
  if (!body) {
    return { success: false, error: 'open_chat_thread requires "body": the message a person will read' };
  }

  // PB attaches the message to a CONTROL-PLANE internal_agents.id; the runtime
  // id addresses nothing there (ADR-039 / INV-TR-010).
  const { resolveInternalAgentId } = await import('../agent-lifecycle/resolve-runtime-agent-id');
  const internalAgentId = ctx.agentId
    ? await resolveInternalAgentId(ctx.tenantId, ctx.agentId, 'open-chat-thread')
    : null;
  if (!internalAgentId) {
    return { success: false, error: 'open_chat_thread: this team has no control-plane id, so there is nothing to attach the message to' };
  }

  // Idempotency key, doubling as the thread's external ref. Derived from the
  // content rather than random, so a retried step lands on the thread it
  // already opened instead of opening a second one saying the same thing.
  //
  // It must be a real UUID, not merely a stable string. The control plane
  // validates this field as one AND stores it as the message's `turn_id`, a
  // uuid column — so a 32-character hash was rejected before any of the rest of
  // this ran. Every call this tool has ever made returned HTTP 400: the tool
  // existed, distillation emitted it, workflows dispatched it, and it could not
  // succeed. v5 keeps the property the hash was chosen for, since it is itself
  // a hash of the same name.
  const deliveryId = uuidv5(
    `${ctx.invocationId ?? ''}|${input.title ?? ''}|${body}`,
    DELIVERY_NAMESPACE,
  );

  try {
    const { openEscalationThread } = await import('../platform-callback/client');
    const threadId = await openEscalationThread({
      tenantId: ctx.tenantId,
      internalAgentId,
      escalationId: deliveryId,
      reason: body,
      threadId: ctx.threadId ?? null,
      title: input.title ?? null,
      kind: 'delivery',
    });
    if (!threadId) {
      return { success: false, error: 'open_chat_thread: the platform callback is not configured for this runtime' };
    }
    return { success: true, result: { threadId, delivered: true } };
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: ctx.tenantId, agentId: ctx.agentId },
      'open_chat_thread failed',
    );
    return { success: false, error: 'open_chat_thread could not reach the workspace chat' };
  }
}
