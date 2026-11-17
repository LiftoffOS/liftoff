// Redeliver replies whose delivery never completed (C1).
//
// The obligation rows say what we owe; this is what settles them when the
// process that owed them died. Without it the rows would only ever be a record
// of loss — accurate, and useless to the person waiting for an answer.
//
// Conservative on purpose:
//   * only rows untouched for a while, so a live delivery is never raced;
//   * the reply is read back from agent_chat_messages, never re-generated;
//   * every redelivery is marked as recovered, because whether the first
//     attempt landed is genuinely unknowable from here.

import { log } from '../infrastructure/logging';
import * as chatRepo from './chat-repository';
import {
  findOutstanding,
  markDelivered,
  markFailed,
  RECOVERED_REPLY_MARKER,
  type OutstandingObligation,
} from './delivery-obligations';

/** Rows younger than this may belong to a delivery still in flight. */
const MIN_AGE_MINUTES = 10;

async function redeliver(ob: OutstandingObligation): Promise<void> {
  const message = await chatRepo.getAssistantMessageByTurnId(ob.tenantId, ob.turnId);
  if (!message?.content) {
    // The turn never produced a reply — there is nothing to deliver, and
    // nothing to retry. Close it out rather than sweeping it forever.
    await markFailed(ob.tenantId, ob.turnId, 'no assistant reply was ever persisted for this turn');
    return;
  }

  const text = RECOVERED_REPLY_MARKER + message.content;

  if (ob.channel === 'slack') {
    const { postRecoveredSlackReply } = await import('./slack-adapter/recovered-delivery');
    await postRecoveredSlackReply({
      tenantId: ob.tenantId,
      agentId: ob.agentId,
      channelId: ob.targetRef,
      threadId: ob.threadId,
      text,
    });
  } else {
    const { sendToConversation } = await import('./teams-adapter/teams-sender');
    await sendToConversation({
      tenantId: ob.tenantId,
      conversationId: ob.targetRef,
      text,
      kind: 'message',
    });
  }

  await markDelivered(ob.tenantId, ob.turnId);
  log.info(
    { tenantId: ob.tenantId, turnId: ob.turnId, channel: ob.channel, attempts: ob.attempts },
    'delivery-sweep: recovered reply delivered',
  );
}

/**
 * Sweep one tenant. Returns what it did, so the caller can log a total.
 *
 * Per-row failures are contained: one unreachable channel must not stop the
 * rest of the tenant's outstanding replies from going out.
 */
export async function sweepTenantDeliveries(tenantId: string): Promise<{
  considered: number;
  delivered: number;
  failed: number;
}> {
  let outstanding: OutstandingObligation[] = [];
  try {
    outstanding = await findOutstanding(tenantId, MIN_AGE_MINUTES);
  } catch (err) {
    log.warn({ tenantId, error: (err as Error).message }, 'delivery-sweep: could not list obligations');
    return { considered: 0, delivered: 0, failed: 0 };
  }

  let delivered = 0;
  let failed = 0;
  for (const ob of outstanding) {
    try {
      await redeliver(ob);
      delivered += 1;
    } catch (err) {
      failed += 1;
      await markFailed(ob.tenantId, ob.turnId, (err as Error).message);
      log.warn(
        { tenantId, turnId: ob.turnId, channel: ob.channel, error: (err as Error).message },
        'delivery-sweep: redelivery failed',
      );
    }
  }

  if (outstanding.length > 0) {
    log.info({ tenantId, considered: outstanding.length, delivered, failed }, 'delivery-sweep: complete');
  }
  return { considered: outstanding.length, delivered, failed };
}
