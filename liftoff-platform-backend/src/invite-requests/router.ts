// Invite Requests Router
// Per implementation plan 1e: authenticated endpoint for requesting platform access

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { AccountService } from '../accounts/service';
import { sendEmail, buildEmail } from '../infrastructure/email';
import { escapeHtml, sanitizeForEmail } from '../infrastructure/email/sanitize';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

const RATE_LIMIT_HOURS = 1;

// Zod validation: empty body, reject unknown fields
const inviteRequestSchema = z.object({}).strict();

function buildInviteTableHtml(firstName: string, lastName: string, email: string, timezone: string): string {
  const rows: string[] = [];

  const addRow = (label: string, value: string) => {
    rows.push(`<tr><td style="padding:8px 12px;font-weight:bold;vertical-align:top;white-space:nowrap;">${label}</td><td style="padding:8px 12px;">${escapeHtml(value)}</td></tr>`);
  };

  addRow('Name', `${escapeHtml(firstName)} ${escapeHtml(lastName)}`);
  addRow('Email', escapeHtml(email));
  addRow('Timezone', escapeHtml(timezone));

  return `<table style="border-collapse:collapse;width:100%;border:1px solid #e0e0e0;">${rows.join('')}</table>`;
}

export const inviteRequestsRouter = Router();
const service = new AccountService();

inviteRequestsRouter.post('/', async (req: Request, res: Response) => {
  // Validate empty body
  const parseResult = inviteRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: 'Invalid request. No body expected.' });
    return;
  }

  const firebaseUid = req.user?.uid;
  if (!firebaseUid) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const account = await service.getByFirebaseUid(firebaseUid);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    // DB-backed rate limit: check invite_requested_at
    const pool = getPool();
    const rateCheck = await pool.query(
      `SELECT invite_requested_at FROM accounts WHERE id = $1`,
      [account.id]
    );
    const lastRequested = rateCheck.rows[0]?.invite_requested_at as Date | null;
    if (lastRequested) {
      const hoursSince = (Date.now() - new Date(lastRequested).getTime()) / (1000 * 60 * 60);
      if (hoursSince < RATE_LIMIT_HOURS) {
        res.status(429).json({ error: 'Please wait before requesting again' });
        return;
      }
    }

    // Build and send email using the standard template
    const safeName = sanitizeForEmail(account.firstName);
    const safeLastName = sanitizeForEmail(account.lastName);
    const tableHtml = buildInviteTableHtml(account.firstName, account.lastName, account.email, account.timezone);
    const { html } = buildEmail('invite-request', {
      firstName: `${safeName} ${safeLastName}`,
      rawHtml: tableHtml,
    });

    await sendEmail({
      to: 'contact@example.com',
      subject: `Invite Request: ${safeName} ${safeLastName} (${account.email})`,
      html,
      emailType: 'invite-request',
      replyTo: account.email,
    });

    // Update invite_requested_at
    await pool.query(
      `UPDATE accounts SET invite_requested_at = NOW() WHERE id = $1`,
      [account.id]
    );

    log.info({
      event: 'invite_request_submitted',
      accountId: account.id,
      email: account.email,
    }, 'Invite request submitted');

    res.json({ success: true });
  } catch (err) {
    log.error({ err, event: 'invite_request_failed' }, 'Failed to process invite request');
    res.status(500).json({ error: 'Failed to send invite request. Please try again later.' });
  }
});
