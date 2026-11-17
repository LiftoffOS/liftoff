// Reply notifications for the team plan, on workforce-service's behalf.
//
// The other three chat surfaces notify in-process: this service owns their
// messages, so the persist point and the notifier are one call apart. The team
// plan is not like that. Migration 131 moved team_plan_threads and
// team_plan_messages into workforce-service's own database, so the service that
// knows a reply landed is not the service that can send a notification about
// it. It asks instead — the same shape as the account-profiles lookup next
// door, and for the same reason.
//
// What stays here rather than moving with the caller: minting the opaque link,
// the account's own notification preferences, and the push tokens. None of
// those is workforce-service's to know.
//
// Presence is the one check the caller keeps, because team-plan seats live in
// its database too. It calls only when the person is away.
//
// Auth: WORKFORCE_SERVICE_TOKEN only, matching account-profiles. A leaked token
// buys the ability to notify a member of a workspace about a thread in that
// workspace, which is the same thing the product does on its own.
//
// Mounted BEFORE authMiddleware in index.ts.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { notifyPlatformChatReply } from '../notifications';
import { workforceServiceAuth } from './workforce-service-auth';

export const chatNotifyInternalRouter = Router();

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  accountId: z.string().uuid(),
  threadId: z.string().uuid(),
  // Trimmed by the push builder to what a notification can show. Capped here so
  // a runaway reply cannot be posted as an unbounded body.
  text: z.string().min(1).max(4000),
  /** Where the turn came through; a chat-workspace turn is answered there
   *  and is not notified again. */
  via: z.enum(['mcp', 'slack', 'teams']).nullable().optional(),
});

// POST /team-plan-reply
// Body: { tenantId, accountId, threadId, text }
chatNotifyInternalRouter.post(
  '/team-plan-reply',
  workforceServiceAuth,
  async (req: Request, res: Response) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
    }

    try {
      // Awaited, unlike the in-process callers: the caller is already
      // fire-and-forget on its side, and answering before the work is done
      // would make every failure invisible to both services. The notifier
      // never throws, so this cannot 500 on a delivery problem.
      await notifyPlatformChatReply({
        tenantId: parsed.data.tenantId,
        surface: 'team_plan',
        threadId: parsed.data.threadId,
        accountId: parsed.data.accountId,
        text: parsed.data.text,
        via: parsed.data.via ?? null,
      });
      return res.status(202).json({ accepted: true });
    } catch (err) {
      log.error({ error: (err as Error).message }, 'team plan reply notification failed');
      return res.status(500).json({ error: 'Notification failed' });
    }
  },
);
