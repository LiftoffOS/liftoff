// Daily Cloud Scheduler job — flips every pending invitation past its 7-day
// expiry to 'expired' and emails each inviter one aggregated notice listing the
// people they invited who never accepted, with a re-invite call to action.
//
// One email per inviter+workspace however many invitations lapsed, so several
// people expiring on the same day arrive as a single message, not one each.
//
// Triggered by Cloud Scheduler (invite-expiry-sweep-daily) with the shared
// X-Service-Auth / PLATFORM_CALLBACK_TOKEN convention used by the other PB
// internal jobs (see subscription-ending-reminders.ts). Safe to run more than
// once a day: the pending->expired flip is the dedupe, so a second run in the
// same day finds nothing left to notify.

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import { validateServiceAuth } from './_serviceAuth';
import { tenantMembersService } from '../tenant-members/service';
import { sendInvitesExpiredEmail } from '../infrastructure/email';

// The workspace members surface, where an inviter re-sends invitations. Deep
// link resolved against the environment's public frontend (dev vs prod).
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://example.com';
const WORKSPACE_MEMBERS_PATH = '/dashboard/settings/workspace';

export const inviteExpirySweepRouter = Router();

inviteExpirySweepRouter.post('/invite-expiry-sweep', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;

  const groups = await tenantMembersService.collectExpiredInvitationsForNotification();

  let sent = 0;
  let failed = 0;
  let invitations = 0;

  for (const group of groups) {
    invitations += group.invitees.length;
    try {
      await sendInvitesExpiredEmail(group.inviterEmail, group.inviterFirstName ?? 'there', {
        tenantName: group.tenantName,
        inviteUrl: `${FRONTEND_URL}${WORKSPACE_MEMBERS_PATH}`,
        invitees: group.invitees,
      });
      sent++;
    } catch (err) {
      // The invitations are already flipped to 'expired', so a failed send is
      // not retried (the next run will not re-select them) — we log it rather
      // than risk spamming the inviter on the following day. Same convention as
      // subscription-ending-reminders.
      failed++;
      log.warn(
        {
          inviterEmail: group.inviterEmail,
          tenantId: group.tenantId,
          invitees: group.invitees.length,
          error: (err as Error).message,
        },
        'invite-expiry-sweep: notification send failed (invitations already expired; not retried)',
      );
    }
  }

  log.info({ groups: groups.length, invitations, sent, failed }, 'invite-expiry-sweep: completed');
  res.status(200).json({ groups: groups.length, invitations, sent, failed });
});
