// POST /api/internal/agent-chat/escalation-thread
//
// Gives an escalation somewhere a person can actually find it.
//
// An escalated run has ENDED: it is not a parked run, so it is deliberately
// absent from the /review queue, which holds only work that resumes when
// someone answers it. Until this existed the record's only delivery was the
// Slack DM and the Teams card. Miss the DM and there was no screen to go and
// look at, and no honest link to send anyone to — the notification path says so
// in as many words, and left its button off rather than point at a queue the
// record would never appear in.
//
// So the escalation opens a chat thread instead, which is where a person
// already looks for what a team said. It is a real thread, not a notice: the
// reply box works, and the message carries the team as its author.
//
// Append or create, decided by lookup rather than by a flag:
//
//   - A run that started from a chat turn carries THAT thread's id. The runtime
//     mirrors the platform's thread id into its own `threads` table under the
//     same uuid (chat-turn-handler upserts it to satisfy an FK), so the id it
//     hands back is one of ours and the escalation belongs in the conversation
//     it came from.
//   - An autonomous run mints its thread id locally and it exists nowhere here,
//     so the lookup misses and the escalation opens a thread of its own.
//
// The lookup IS the discriminator. A caller-supplied "this is a chat run" hint
// would be a second source of truth about an id space that has already caused
// exactly this class of bug (INV-TR-010), and a wrong hint would either strand
// the message in a thread nobody reads or bolt it onto an unrelated
// conversation. A miss is unambiguous and self-correcting.
//
// Idempotent on escalationId, which matters because the caller is a
// fire-and-forget path that retries:
//   - create: `external_thread_ref = 'escalation:<id>'` against the
//     (tenant_id, channel, external_thread_ref) unique index.
//   - append: `external_ref = '<kind>:<id>'` against acm_external_ref_uniq
//     (migration 414), which permits one message per ref per tenant.
// Either way a redelivery lands as 23505 and is answered 200.
//
// The append key used to be `turn_id`, which is a FOREIGN KEY into
// agent_chat_turns. An escalation id is not a turn id, so it deduped nothing —
// it rejected every insert this route ever made, for both kinds, from the day
// it was written a month after that constraint landed. Both callers log the
// failure as non-fatal, which is why two shipped features had never once
// worked and nothing said so.
//
// Auth: X-Service-Auth === PLATFORM_CALLBACK_TOKEN, the same TR->PB shared
// secret settle-turn and the other platform callbacks validate.

import { Router, type Request, type Response, json as expressJson } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import * as chatRepo from './chat-repository';

export const escalationThreadRouter = Router();
escalationThreadRouter.use(expressJson({ limit: '1mb' }));

const escalationThreadSchema = z.object({
  tenantId: z.string().uuid(),
  /** CONTROL-PLANE internal_agents.id. The runtime resolves it through
   *  internal_agent_runtime_mapping before calling (INV-TR-010); its own
   *  agents.id addresses nothing here and would attach the message to no team. */
  internalAgentId: z.string().uuid(),
  escalationId: z.string().uuid(),
  /** The blocker, as the team wrote it. Becomes the message body. */
  reason: z.string().min(1),
  /** The run's thread id. Ours when the run came from chat, the runtime's own
   *  when it did not — this route does not need to know which, see above. */
  threadId: z.string().uuid().nullable().optional(),
  /** Thread title for the created case. Ignored when appending, since that
   *  thread already has a name and the escalation is not entitled to rename it. */
  title: z.string().max(200).nullable().optional(),
  /** What this thread is FOR, which decides how it reads and how it counts.
   *
   *  'escalation' (the default, and every historical caller) means the run
   *  stopped and somebody has to act. 'delivery' means the opposite: the work
   *  finished and here it is. The two share every mechanism below — thread,
   *  participant, message_type, idempotency, unread — and must not share a
   *  label, because escalation counts are read as "runs that got stuck" and a
   *  delivered checklist is not one. */
  kind: z.enum(['escalation', 'delivery']).default('escalation'),
});

const UNIQUE_VIOLATION = '23505';

/** `message_type` on the assistant row.
 *
 *  Load-bearing beyond labelling: the thread list and the unread counts both
 *  select on IS_CONVERSATION_PREDICATE, which admits an assistant message only
 *  when it carries a turn or a type. Without this the thread would exist and
 *  never be listed, which is the failure this route exists to end. */
const MESSAGE_TYPE_BY_KIND = {
  escalation: 'escalation',
  delivery: 'agent_delivery',
} as const;

escalationThreadRouter.post('/escalation-thread', async (req: Request, res: Response) => {
  if (!process.env.PLATFORM_CALLBACK_TOKEN
    || req.headers['x-service-auth'] !== process.env.PLATFORM_CALLBACK_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const parsed = escalationThreadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  }
  const { tenantId, internalAgentId, escalationId, reason, threadId, title, kind } = parsed.data;

  try {
    // Append when the run's thread is one of ours, create otherwise.
    const existing = threadId ? await chatRepo.getThread(threadId, tenantId) : null;
    let targetThreadId: string;
    let created = false;

    if (existing) {
      targetThreadId = existing.id;
    } else {
      // findOrCreateThread rather than a bare insert: it resolves the
      // external-ref collision a redelivery causes, and it adds the
      // participant row without which the thread neither lists under this team
      // nor counts toward its unread badge.
      //
      // No account: nobody started this conversation, the team did. Thread
      // reads are tenant-scoped rather than owner-scoped, so a null owner keeps
      // it open to whoever picks it up instead of binding it to one person.
      const thread = await chatRepo.findOrCreateThread(
        tenantId,
        null,
        internalAgentId,
        'web',
        `${kind}:${escalationId}`,
      );
      targetThreadId = thread.id;
      created = true;
      // Titled separately because findOrCreateThread takes none. Best-effort:
      // an untitled thread still lists and still opens, so a failed rename must
      // not cost the message.
      if (title) {
        await chatRepo
          .updateThreadTitleInternal(targetThreadId, tenantId, title)
          .catch((err) => log.warn(
            { err: (err as Error).message, tenantId, escalationId },
            'escalation-thread: could not title the thread',
          ));
      }
    }

    const message = await chatRepo.appendMessage(
      tenantId,
      targetThreadId,
      'assistant',
      reason,
      internalAgentId,
      undefined,
      0,
      0,
      MESSAGE_TYPE_BY_KIND[kind],
      undefined,
      undefined,
      // No turn. Nobody asked for this message — the team is speaking because
      // something happened — and `turn_id` is a foreign key into
      // agent_chat_turns, so borrowing it for idempotency did not dedupe
      // anything: it rejected every insert this route ever attempted.
      undefined,
      // The idempotency key, on the column that exists for it (migration 414).
      // Same value the thread's external ref carries, so a redelivery lands on
      // one thread AND one message.
      `${kind}:${escalationId}`,
    );

    return res.json({ threadId: targetThreadId, created, messageId: message.id });
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      // A redelivery of an escalation already threaded: the assistant message
      // lost the race on acm_external_ref_uniq. The caller still wants the
      // thread id, so resolve the row this escalation owns rather than
      // answering with nothing and costing the Slack link its target.
      const existing = await chatRepo
        .findOrCreateThread(tenantId, null, internalAgentId, 'web', `${kind}:${escalationId}`)
        .catch(() => null);
      return res.json({
        threadId: existing?.id ?? threadId ?? null,
        created: false,
        alreadyThreaded: true,
      });
    }
    log.error(
      { err: (err as Error).message, tenantId, escalationId, internalAgentId },
      'escalation-thread: failed to open the escalation thread',
    );
    return res.status(500).json({ error: 'Failed to open escalation thread' });
  }
});
