// Carrying a resumed answer back to the conversation the person was reading.
//
// When Liftoff hands a turn to an agent, the team answers into its OWN thread
// and Liftoff copies the reply into the Liftoff thread as a message attributed
// to that team. That works because the reply arrives while the Liftoff turn is
// still running.
//
// A gate breaks that. The team stops for an approval, the Liftoff turn ends, and
// the answer is written minutes or hours later by the resume, which knows only
// the approval and the thread it was filed against: the TEAM'S thread. Delivered
// there and nowhere else, the answer lands in a conversation the person never
// opened, while the one they were reading still shows the question and the
// stall.
//
// So the resume mirrors it, on exactly the terms the live path already uses:
//
//   - The team's thread stays the system of record. It is written first, by the
//     caller, and this runs afterwards; a mirror that fails costs a copy, never
//     the answer.
//   - The copy is attributed with `author` / `author_label`, the columns that
//     exist precisely so a colleague's reply can live in a Liftoff thread. The
//     person reads one conversation with two voices in it, which is what they
//     saw before the gate.
//
// Two kinds of colleague answer late, for two different reasons.
//
// A 'team' resumes after an approval gate, which is the case above.
//
// The Chief AI Officer has no gate, and this file used to say that settled it.
// It did not. An approved workforce plan provisions as one Cloud Task per team,
// each a full model run, so even a two-team plan takes minutes. The CAIO
// promises "they will appear on the Teams page shortly" and the
// Liftoff turn ends; the teams are created minutes later by a background path
// that, until now, could not write to a conversation at all. The person was told
// "shortly" and then never told anything, whether provisioning succeeded or
// failed. Same shape as the gate, different cause: an answer produced after the
// turn that carried the question.
//
// The Insights Manager still has neither, so it is still absent here.

import { log } from '../infrastructure/logging';
import { internalAgentService } from '../internal-agents/service';
import {
  appendMessage,
  getDelegationByDelegateThread,
  getThread,
  type LiftoffChatMessage,
} from './chat-repository';
import { CAIO_DELEGATION_TARGET } from './delegation-targets';

/**
 * Mirror a team's resumed reply into the Liftoff conversation that asked for it.
 *
 * Returns the mirrored message, or null when this thread is not paired with a
 * Liftoff conversation, which is the ordinary case: most team threads are people
 * talking to their team directly.
 *
 * Never throws. Every caller is a settlement path that has already delivered the
 * reply to the team's own thread, and a failed copy must not undo that or fail
 * the callback that drove it.
 */
export async function mirrorDelegatedReplyToLiftoff(input: {
  tenantId: string;
  /** The team's thread, which is what the approval was filed against. */
  delegateThreadId: string;
  replyText: string;
}): Promise<LiftoffChatMessage | null> {
  try {
    const pairing = await getDelegationByDelegateThread(input.delegateThreadId, 'team');
    if (!pairing) return null;

    // The team as the person will see it named. Resolved WITHOUT the active
    // filter delegation uses: an answer that has already been produced is
    // delivered even if the team was paused while the approval sat waiting, and
    // a team deleted in that window takes its pairing with it through the
    // foreign key, so this lookup never runs for one.
    let authorLabel: string | null = null;
    if (pairing.targetId) {
      try {
        const team = await internalAgentService.getById(pairing.targetId, input.tenantId);
        authorLabel = team?.role ?? null;
      } catch (err) {
        // An unattributed reply is worth more than no reply, so a failed name
        // lookup degrades the copy rather than cancelling it.
        log.warn(
          { tenantId: input.tenantId, targetId: pairing.targetId, error: (err as Error).message },
          'Liftoff could not name the team behind a resumed reply',
        );
      }
    }

    const message = await appendMessage({
      threadId: pairing.liftoffThreadId,
      role: 'assistant',
      content: input.replyText,
      author: pairing.targetId,
      authorLabel,
      // Token counts belong to the team's own surface, which already logged and
      // billed them against this turn. Repeating them here would double-count
      // nothing, but claiming a second spend on a copy is worse than claiming
      // none, so the copy claims none.
    });

    log.info(
      {
        tenantId: input.tenantId,
        liftoffThreadId: pairing.liftoffThreadId,
        delegateThreadId: input.delegateThreadId,
      },
      'Resumed team reply mirrored into the Liftoff conversation that asked for it',
    );
    return message;
  } catch (err) {
    log.warn(
      {
        tenantId: input.tenantId,
        delegateThreadId: input.delegateThreadId,
        error: (err as Error).message,
      },
      'Could not mirror a resumed team reply into its Liftoff conversation',
    );
    return null;
  }
}

/**
 * Mirror a Chief AI Officer notice into the Liftoff conversation that asked for
 * the plan.
 *
 * The CAIO's identity is fixed rather than looked up: it is not a row anywhere,
 * and CAIO_DELEGATION_TARGET is the same constant the live delegation writes, so
 * a notice that arrives ten minutes late is attributed identically to the reply
 * that arrived during the turn. Attributing it any other way would render the
 * same colleague as two.
 *
 * Returns the mirrored message, or null when this CAIO thread is not paired with
 * a Liftoff conversation. That is the ordinary case rather than a fault: most
 * team-plan threads belong to people using the CAIO surface directly, and they
 * have already been told in the thread they are reading.
 *
 * Never throws, for the same reason the team resume does not: the notice is
 * already in the CAIO's own thread before this runs, so a failed copy costs a
 * copy and never the notice.
 */
export async function mirrorCAIONoticeToLiftoff(input: {
  tenantId: string;
  /** The CAIO's own team-plan thread, which is what the pairing is keyed on. */
  delegateThreadId: string;
  content: string;
}): Promise<LiftoffChatMessage | null> {
  try {
    const pairing = await getDelegationByDelegateThread(input.delegateThreadId, 'caio');
    if (!pairing) return null;

    // The delegation table is not keyed by tenant, and this is reached from an
    // internal route where the tenant id arrives in the request body. Confirming
    // the resolved thread against that tenant is what stops a wrong or forged id
    // writing into another workspace's conversation, and it is what makes the
    // tenantId parameter load-bearing rather than something we only log.
    // getThread applies the tenant scope and re-checks the row's own tenant_id.
    const thread = await getThread(pairing.liftoffThreadId, input.tenantId);
    if (!thread) {
      log.warn(
        {
          tenantId: input.tenantId,
          delegateThreadId: input.delegateThreadId,
          liftoffThreadId: pairing.liftoffThreadId,
        },
        'Refused to mirror a CAIO notice: the paired Liftoff thread does not belong to that tenant',
      );
      return null;
    }

    const message = await appendMessage({
      threadId: pairing.liftoffThreadId,
      role: 'assistant',
      content: input.content,
      author: CAIO_DELEGATION_TARGET.id,
      authorLabel: CAIO_DELEGATION_TARGET.label,
      // No token counts. The notice is composed in code, not generated, so
      // there is no spend to attribute to it on either surface.
    });

    log.info(
      {
        tenantId: input.tenantId,
        liftoffThreadId: pairing.liftoffThreadId,
        delegateThreadId: input.delegateThreadId,
      },
      'CAIO notice mirrored into the Liftoff conversation that asked for the plan',
    );
    return message;
  } catch (err) {
    log.warn(
      {
        tenantId: input.tenantId,
        delegateThreadId: input.delegateThreadId,
        error: (err as Error).message,
      },
      'Could not mirror a CAIO notice into its Liftoff conversation',
    );
    return null;
  }
}
