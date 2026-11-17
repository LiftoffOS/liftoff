// Daily Cloud Scheduler job — reminds the RECIPIENT of a still-pending
// invitation 2 to 3 days before it expires, once (never inside 2 days).
//
// For each invitation nearing expiry it mints the reminder's OWN accept token
// and claims the row (reminded_at + reminder_token_hash) BEFORE sending, so:
//   - the claim is the dedupe — nobody is reminded twice, even on a re-run;
//   - the original invite_token_hash is untouched, so BOTH the original
//     invitation link and this reminder link accept (findInvitationByTokenHash
//     matches either hash);
//   - a failed send costs nothing but an unused token — the recipient still has
//     the original link, and we do not retry (no spam).
//
// Triggered by Cloud Scheduler (invite-reminder-sweep-daily) with the shared
// X-Service-Auth / PLATFORM_CALLBACK_TOKEN convention (see the sibling jobs).

import { Router, Request, Response } from 'express';
import { log } from '../infrastructure/logging';
import { validateServiceAuth } from './_serviceAuth';
import { tenantMembersService } from '../tenant-members/service';
import { sendInviteReminderEmail } from '../infrastructure/email';

// Public frontend base for the accept link, per environment (dev vs prod). The
// accept route is `${frontendUrl}/invitation/${token}` — the same shape the
// original invitation email uses.
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://example.com';

export const inviteReminderSweepRouter = Router();

inviteReminderSweepRouter.post('/invite-reminder-sweep', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;

  const candidates = await tenantMembersService.findRemindableInvitations();

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    // Claim first: mint the reminder token and stamp reminded_at atomically. A
    // null result means another run already reminded this invitation — skip it.
    const token = await tenantMembersService.mintReminderToken(candidate.id);
    if (!token) {
      skipped++;
      continue;
    }
    try {
      await sendInviteReminderEmail(candidate.recipientEmail, {
        tenantName: candidate.tenantName,
        inviteUrl: `${FRONTEND_URL}/invitation/${token}`,
        inviterFirstName: candidate.inviterFirstName,
        inviterLastName: candidate.inviterLastName,
        inviterEmail: candidate.inviterEmail,
        expiresAt: candidate.expiresAt,
        inviterTimezone: candidate.inviterTimezone,
      });
      sent++;
    } catch (err) {
      // Already claimed, so not retried; the recipient still holds the original
      // invitation link, and the minted reminder token just goes unused.
      failed++;
      log.warn(
        { invitationId: candidate.id, tenantId: candidate.tenantId, error: (err as Error).message },
        'invite-reminder-sweep: send failed (already marked reminded; original link still valid; not retried)',
      );
    }
  }

  log.info({ candidates: candidates.length, sent, skipped, failed }, 'invite-reminder-sweep: completed');
  res.status(200).json({ candidates: candidates.length, sent, skipped, failed });
});
