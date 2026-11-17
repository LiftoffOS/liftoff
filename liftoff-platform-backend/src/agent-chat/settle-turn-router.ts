// POST /api/internal/agent-chat/settle-turn
//
// At-least-once persistence for a completed chat turn's assistant reply. The
// primary path is the SSE consumer (chat-service `case 'complete'` persisting
// via appendMessage); this callback from tenant-runtime is the backstop for
// the consumer vanishing mid-turn (browser tab closed → the stream is
// abandoned and the reply would otherwise never reach the thread, while the
// engine session still remembers saying it).
//
// Idempotent: the partial unique index acm_assistant_turn_uniq (migration 316)
// allows at most one assistant message per turn; a duplicate insert from the
// race with the live SSE path lands as 23505 and is answered 200.
//
// Auth: X-Service-Auth === PLATFORM_CALLBACK_TOKEN (the TR→PB shared secret,
// same pattern as settle-by-approval and the other platform callbacks).

import { Router, type Request, type Response, json as expressJson } from 'express';
import { screenPersistedContent } from '../injection-detection/gating';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { guardWholeText } from '../common/guarded-stream';
import { notifyReplyPersisted } from './out-of-turn-delivery';
import { RUN_PROGRESS_MESSAGE_TYPE } from './run-progress';
import * as chatRepo from './chat-repository';
import { resolveContributors } from './contributors';
import { checkAttachmentClaim, recordAttachmentClaimFinding } from './attachment-claims';

export const settleTurnRouter = Router();
settleTurnRouter.use(expressJson({ limit: '1mb' }));

const settleTurnSchema = z.object({
  tenantId: z.string().uuid(),
  threadId: z.string().uuid(),
  agentId: z.string().uuid(),
  turnId: z.string().uuid(),
  replyText: z.string().min(1),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  // A settled row is ordinarily the team's reply. The one exception is a run
  // that outgrew its turn and is continuing in the background: that notice is
  // narration, so it must not stamp the reply clock or read as an answer.
  //
  // Enumerated rather than accepted as free text. The message type decides
  // whether a row counts as a reply, whether it reaches the model as history
  // and how it renders, so it is not something a caller gets to name.
  messageType: z.literal(RUN_PROGRESS_MESSAGE_TYPE).optional(),
  /** The runtime's own run id, for the attachment-claim log lines to cite.
   *  Optional: an older runtime image sends none, and the check does not
   *  depend on it. */
  invocationId: z.string().uuid().optional(),
  /** True when this is the turn's FINAL reply. The runtime settles two kinds
   *  of text through this route: the reply a finished turn produced, and the
   *  partial a turn wrote before it paused for an approval or a question.
   *  Only the first is held to its attachment claims — a partial stops
   *  mid-work, often on the very tool that will produce the card, and the
   *  card lands under the continuation. Absent from an older runtime image,
   *  which is read as "not known to be final" and left unchecked. */
  final: z.boolean().optional(),
  /** Runtime agent ids of the teammates the turn handed work to, unique and
   *  in the order they were brought in, from the runtime's durable record of
   *  the delegations that ran. Resolved here to the names the person sees and
   *  persisted as the reply's contributors, the same way the live stream
   *  consumer does it, so a closed tab reads the same chips as an open one.
   *  Sent on the paused settle as well as the final one. Absent from an older
   *  runtime image, which is read as nobody. */
  delegatedTo: z.array(z.string().min(1)).optional(),
});

const UNIQUE_VIOLATION = '23505';

settleTurnRouter.post('/settle-turn', async (req: Request, res: Response) => {
  if (!process.env.PLATFORM_CALLBACK_TOKEN
    || req.headers['x-service-auth'] !== process.env.PLATFORM_CALLBACK_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const parsed = settleTurnSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  const { tenantId, threadId, agentId, turnId, replyText, inputTokens, outputTokens, messageType, invocationId, final, delegatedTo } = parsed.data;

  // E2: the one persistence path that had no screening at all. This writes an
  // assistant reply straight into a thread transcript without the chat
  // service's pre-turn screen ever running, so it is the natural gap.
  //
  // Shadow-first in practice: this only refuses when the tenant is in enforce
  // mode, and a refusal is reported as a normal (non-retryable) response rather
  // than an error — a retry would re-screen the same text and fail identically.
  try {
    const screen = await screenPersistedContent('settled_reply', replyText, { tenantId, agentId, threadId });
    if (screen.block) {
      log.warn({ tenantId, agentId, threadId, turnId }, 'settle-turn: reply refused by injection screening');
      return res.json({ persisted: false, blocked: true });
    }
  } catch (screenErr) {
    // Screening must never cost a delivered reply: on a screening failure the
    // persistence goes ahead.
    log.warn({ tenantId, error: (screenErr as Error).message }, 'settle-turn: screening failed, persisting anyway');
  }

  // The same check the live path runs before it persists, because this is
  // the other place a completed reply becomes a row: a reply that reaches the
  // thread through this backstop would otherwise claim an attachment nothing
  // verified. Only the turn's FINAL reply: narration about a run
  // (`run_progress`) is not the team's reply, and the partial a paused turn
  // settles is not final — see the schema.
  // The team's words, read the way the live stream reads them before a
  // person sees them (common/guarded-stream.ts): this is the other place a
  // reply becomes a row. Narration about a run (`run_progress`) is the
  // runtime's sentence, not the model's, and is not read.
  const shownText = messageType
    ? replyText
    : await guardWholeText(replyText, { tenantId, speaker: agentId, threadId });
  const attachmentClaim = final === true && !messageType
    ? await checkAttachmentClaim({ tenantId, threadId, turnId, text: shownText })
    : null;
  const textToPersist = attachmentClaim?.text ?? shownText;
  // Same resolver as the stream consumer, so both writers of this row agree
  // on who the reply is attributed to. Narration about a run (`run_progress`)
  // is not the team's reply and is never attributed, on this path or the
  // live one.
  const contributors = messageType ? [] : await resolveContributors(tenantId, delegatedTo ?? []);

  try {
    const message = await chatRepo.appendMessage(
      tenantId,
      threadId,
      'assistant',
      textToPersist,
      agentId,
      undefined,
      inputTokens ?? 0,
      outputTokens ?? 0,
      messageType,
      undefined,
      undefined,
      turnId,
      undefined,
      undefined,
      contributors,
    );
    if (attachmentClaim) {
      recordAttachmentClaimFinding(attachmentClaim.finding, {
        tenantId, threadId, turnId, invocationId: invocationId ?? null,
      });
    }
    // This branch is reached when the live stream did NOT persist the reply,
    // which usually means it had already dropped. So this is precisely the case
    // where the person cannot have seen the answer, and the notification is the
    // only thing that will tell them.
    // Only for an actual reply. Telling someone "your work is still running" is
    // not an answer arriving, and a push that says it is trains people to open
    // a thread that has nothing new to read in it.
    if (!messageType) {
      void notifyReplyPersisted({ tenantId, threadId, agentId, text: textToPersist });
    }

    return res.json({ persisted: true, messageId: message.id });
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      // The live SSE path already persisted this turn's reply.
      return res.json({ persisted: false, alreadyPersisted: true });
    }
    log.error(
      { error: (err as Error).message, tenantId, threadId, turnId },
      'settle-turn persistence failed',
    );
    return res.status(500).json({ error: 'settle failed' });
  }
});
