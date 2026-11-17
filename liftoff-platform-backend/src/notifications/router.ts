// Three routers because three auth contexts:
//   1. Authed (Firebase JWT) — for the user's own inbox lookup
//   2. Public (no auth — token IS the auth) — for unsubscribe clicks from email
//   3. Internal (X-Service-Auth HMAC) — for cross-service callbacks + Cloud Scheduler
// Splitting prevents the auth middleware from accidentally gating a public endpoint.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { logger as log } from '../infrastructure/logging';
import { getPool, withTenantScope } from '../infrastructure/database';
import { AccountRepository } from '../accounts/repository';
import { validateServiceAuth } from '../jobs/_serviceAuth';
import { normalizeEscalationRecipient, DEFAULT_ESCALATION_RECIPIENT } from './escalation-recipient';
import { buildEmail, sendEmail } from '../infrastructure/email';
import { enqueueNotification } from './service';
import { findOrCreateLink } from '../notification-links';
import { frontendUrl } from '../infrastructure/frontend-url';
import { runDigestTick } from './digest';
import { verifyAndDecodeToken, type UnsubscribeAction } from './unsubscribe';
import { appendUnsubscribeFooter, sanitizeForHeader, styleAnchorsInHtml } from './email';

export const notificationsAuthedRouter = Router();
export const notificationsPublicRouter = Router();
export const notificationsInternalRouter = Router();

const accountsRepo = new AccountRepository();

// ── Authed: GET /api/notifications/me — recent rows for the calling account ──
notificationsAuthedRouter.get('/me', async (req: Request, res: Response, next) => {
  try {
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const account = await accountsRepo.findByFirebaseUid(firebaseUid);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    const pool = getPool();
    const r = await pool.query(
      `SELECT id, type, payload, cadence, created_at, delivered_at
         FROM notifications WHERE account_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [account.id],
    );
    res.json({ notifications: r.rows });
  } catch (err) {
    next(err);
  }
});

// ── Public: POST /api/notifications/unsubscribe (token in body) ─────────────
//            POST /api/notifications/unsubscribe-direct (token in query) ─────
// No auth middleware — the token IS the auth (HMAC verified).

const unsubBodySchema = z.object({ token: z.string().min(1) });

const FRIENDLY: Record<UnsubscribeAction, string> = {
  'disable:taskUpdates': 'task updates',
  'disable:teamActivity': 'team activity',
  'disable:escalations': 'escalations and approvals',
  'disable:weeklyDigest': 'the weekly performance recap',
  'disable:newsletter': 'the Liftoff newsletter',
  'cadence:none': 'digest emails',
};

async function handleUnsubscribe(token: string, res: Response): Promise<void> {
  const decoded = verifyAndDecodeToken(token);
  if (!decoded) {
    res.status(400).json({ success: false, error: 'Invalid or expired token' });
    return;
  }

  if (decoded.action.startsWith('disable:')) {
    const key = decoded.action.slice('disable:'.length);
    const path = key === 'newsletter' ? ['newsletter'] : ['notificationTypes', key];
    await accountsRepo.setPreferenceField(decoded.accountId, path, false);
  } else if (decoded.action === 'cadence:none') {
    await accountsRepo.setPreferenceField(decoded.accountId, ['notificationFrequency'], 'none');
  }

  res.json({ success: true, action: decoded.action, friendlyLabel: FRIENDLY[decoded.action] });
}

notificationsPublicRouter.post('/unsubscribe', async (req: Request, res: Response) => {
  const parsed = unsubBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Missing token' });
    return;
  }
  await handleUnsubscribe(parsed.data.token, res);
});

notificationsPublicRouter.post('/unsubscribe-direct', async (req: Request, res: Response) => {
  const token = String(req.query.token ?? '');
  if (!token) {
    res.status(400).json({ success: false, error: 'Missing token' });
    return;
  }
  await handleUnsubscribe(token, res);
});

// ── Internal: POST /api/internal/notifications/enqueue ──────────────────────
//             POST /api/internal/notifications/run-tick ──────────────────────
//             POST /api/internal/newsletter/broadcast ───────────────────────

const enqueueSchema = z.object({
  accountIds: z.array(z.string().uuid()).min(1).max(500),
  tenantId: z.string().uuid().nullable(),
  type: z.enum(['task_update', 'agent_activity', 'escalation']),
  payload: z.record(z.unknown()),
});

notificationsInternalRouter.post('/notifications/enqueue', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  const parsed = enqueueSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
    return;
  }
  const { accountIds, tenantId, type, payload } = parsed.data;
  await Promise.allSettled(
    accountIds.map((accountId) => enqueueNotification({ accountId, tenantId, type, payload })),
  );
  res.json({ ok: true, enqueued: accountIds.length });
});

notificationsInternalRouter.post('/notifications/run-tick', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  const result = await runDigestTick();
  res.json({ ok: true, ...result });
});

// ── WS-3.6: recipient resolution endpoints (used by tenant-runtime
// notifications_send) ──────────────────────────────────────────────────────

notificationsInternalRouter.get(
  '/tenants/:tenantId/members/by-role/:role',
  async (req: Request, res: Response) => {
    if (!validateServiceAuth(req, res)) return;
    const { tenantId, role } = req.params;
    const rows = await withTenantScope(tenantId, (client) => client.query(
      `SELECT account_id FROM tenant_members
       WHERE tenant_id = $1 AND role = $2`,
      [tenantId, role],
    ));
    res.json({ account_ids: rows.rows.map((r) => r.account_id) });
  },
);

// Per D42 internal_agents has no owner_account_id column. The implementation
// reads ai_team_audit, finds the earliest row with action='created' for this
// agent_id, and returns the actor_id (which is an account_id). Returns null if
// no audit trail exists or actor_id is null (very old rows pre-audit).
notificationsInternalRouter.get(
  '/agents/:tenantId/:agentId/owner',
  async (req: Request, res: Response) => {
    if (!validateServiceAuth(req, res)) return;
    const { tenantId, agentId } = req.params;
    const r = await withTenantScope(tenantId, (client) => client.query(
      `SELECT actor_id FROM internal_agent_audit
       WHERE tenant_id = $1 AND internal_agent_id = $2 AND action = 'created'
       ORDER BY created_at ASC LIMIT 1`,
      [tenantId, agentId],
    ));
    res.json({ account_id: r.rows[0]?.actor_id ?? null });
  },
);

// Default escalation recipients for an agent.
//   1. agent.escalation_recipient column (if set; D4 override)
//   2. role:admin fallback (D42 — no owner column)
notificationsInternalRouter.get(
  '/agents/:tenantId/:agentId/escalation-recipients',
  async (req: Request, res: Response) => {
    if (!validateServiceAuth(req, res)) return;
    const { tenantId, agentId } = req.params;
    const r = await withTenantScope(tenantId, (client) => client.query(
      `SELECT escalation_recipient FROM internal_agents
       WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [tenantId, agentId],
    ));
    // Normalised here so the runtime always receives a selector it can parse,
    // including for rows stored as bare account ids before this was fixed.
    const normalized = normalizeEscalationRecipient(r.rows[0]?.escalation_recipient);
    if (normalized) {
      res.json({ recipients: [normalized] });
      return;
    }
    if (r.rows[0]?.escalation_recipient) {
      log.warn('escalation recipient unrecognised; falling back to admins', {
        tenantId, agentId, stored: r.rows[0].escalation_recipient,
      });
    }
    res.json({ recipients: [DEFAULT_ESCALATION_RECIPIENT] });
  },
);

// ── WS-3.9: SDK escalation auto-notify bridge ─────────────────────────────
//
// Called from tenant-runtime's escalation-helper after the audit-log call
// (kind: 'escalation' only). Resolves recipients via the same logic as the
// /escalation-recipients endpoint, then enqueues a notification per
// recipient.

const escalationNotifySchema = z.object({
  tenantId: z.string().uuid(),
  /** RUNTIME-space agent id. Present for rollout compatibility and diagnostics
   *  only — it matches zero internal_agents rows silently, so using it for the
   *  recipient lookup silently discards the configured recipient. */
  agentId: z.string().uuid(),
  /** CONTROL-PLANE internal_agents.id, resolved by TR through
   *  internal_agent_runtime_mapping (INV-TR-010 / ADR-039). Optional-nullable
   *  for the rollout window where an older TR revision does not send it;
   *  absence is logged loudly below, never silently defaulted. */
  internalAgentId: z.string().uuid().nullable().optional(),
  invocationId: z.string().uuid().nullable(),
  escalationId: z.string(),
  reason: z.string(),
  threadId: z.string().nullable(),
  /** The chat thread this escalation was written into, when one was opened
   *  (see agent-chat/escalation-thread-router). Unlike `threadId` above this is
   *  always one of OUR thread ids, which is what makes it linkable. Absent from
   *  a runtime that predates the thread, and on the paths that open none. */
  chatThreadId: z.string().uuid().nullable().optional(),
  /** What the runtime is announcing, which decides the wording below. Optional
   *  so a tenant-runtime revision that predates it keeps the escalation
   *  wording it has always sent. */
  recordKind: z.enum(['escalation', 'blocker', 'clarification']).optional(),
});

/** The title a person reads in email, Slack and Teams.
 *
 *  "escalated and needs your attention" is right for a run that ENDED and left
 *  a record behind. It is wrong for a run that is parked and will carry on the
 *  moment somebody acts: it describes a finished failure rather than a live
 *  request, and it tells the reader to go inspect rather than to go do the one
 *  thing being asked of them.
 *
 *  Copy rules this file lives under: never the word "agent" in customer-facing
 *  text (the team's own name stands in), no em dashes, no contractions. */
export function escalationNotificationTitle(
  agentName: string,
  recordKind: 'escalation' | 'blocker' | 'clarification' | undefined,
): string {
  switch (recordKind) {
    case 'blocker':
      return `${agentName} is blocked and needs you to act`;
    case 'clarification':
      return `${agentName} has a question before it can continue`;
    default:
      return `${agentName} escalated and needs your attention`;
  }
}

notificationsInternalRouter.post(
  '/notifications/escalation',
  async (req: Request, res: Response) => {
    if (!validateServiceAuth(req, res)) return;
    const parsed = escalationNotifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
      return;
    }
    const { tenantId, agentId, internalAgentId, invocationId, escalationId, reason, threadId, recordKind, chatThreadId } = parsed.data;

    // The lookup id MUST be the control-plane id. The raw `agentId` is
    // runtime-space and matches zero rows here with no error (ADR-039), so
    // using it would silently discard the recipient configuration.
    const lookupId = internalAgentId ?? null;
    if (!lookupId) {
      log.error(
        { metric: 'escalation_notify.missing_internal_agent_id', tenantId, agentId, escalationId },
        'escalation-notify: no internalAgentId on payload (old TR revision or mapping miss) — recipient config cannot be honoured',
      );
    }

    // Resolve recipient via same logic as /escalation-recipients.
    // `internal_agents` has no `name` column — the user-facing display
    // string is `messaging_nickname` (with `summary` as a longer fallback).
    // A SELECT name FROM internal_agents throws
    // `column "name" does not exist` (PG code 42703), and without a wrapping
    // try/catch in this async handler the rejection would bubble up to the
    // process root, crash the Node.js worker, kill the Cloud Run instance
    // mid-request, and surface as 503 Service Unavailable to whichever other
    // request was in flight on that instance.
    // Defensive try/catch below so a future SQL typo degrades to a
    // soft error rather than a process-killer.
    let escalationRecipient = 'role:admin';
    let agentName = 'agent';
    if (lookupId) {
      try {
        const recipientRow = await withTenantScope(tenantId, (client) => client.query(
          `SELECT escalation_recipient, messaging_nickname
             FROM internal_agents
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [tenantId, lookupId],
        ));
        if (recipientRow.rows.length === 0) {
          // With a resolved internal id this is a genuine anomaly (deleted
          // agent, cross-tenant id). Loud, then the admin fallback below still
          // delivers.
          log.error(
            { metric: 'escalation_notify.agent_lookup_empty', tenantId, internalAgentId: lookupId, escalationId },
            'escalation-notify: internalAgentId matched no internal_agents row',
          );
        }
        escalationRecipient =
          normalizeEscalationRecipient(recipientRow.rows[0]?.escalation_recipient) ??
          DEFAULT_ESCALATION_RECIPIENT;
        agentName = recipientRow.rows[0]?.messaging_nickname ?? 'agent';
      } catch (err) {
        log.warn(
          { err: (err as Error).message, tenantId, internalAgentId: lookupId },
          'escalation-notify: failed to load recipient/name — falling back to role:admin / "agent"',
        );
      }
    }

    // Expand role:/user: prefix into account ids.
    let accountIds: string[] = [];
    if (escalationRecipient.startsWith('user:')) {
      accountIds = [escalationRecipient.slice('user:'.length)];
    } else if (escalationRecipient.startsWith('role:')) {
      const role = escalationRecipient.slice('role:'.length);
      const rs = await withTenantScope(tenantId, (client) => client.query(
        `SELECT account_id FROM tenant_members WHERE tenant_id = $1 AND role = $2`,
        [tenantId, role],
      ));
      accountIds = rs.rows.map((r) => r.account_id);
    } else if (escalationRecipient.startsWith('agent:')) {
      const r = await getPool().query(
        `SELECT actor_id FROM ai_team_audit
         WHERE tenant_id = $1 AND ai_team_id = $2 AND action = 'created'
         ORDER BY created_at ASC LIMIT 1`,
        [tenantId, escalationRecipient.slice('agent:'.length)],
      );
      if (r.rows[0]?.actor_id) accountIds = [r.rows[0].actor_id];
    }

    // An escalation that resolves to nobody is the worst failure this endpoint
    // has: the agent is stuck, the run reports success, and no human is told.
    // Anything unresolvable falls back to the workspace admins.
    if (accountIds.length === 0) {
      log.warn('escalation resolved to no recipients; falling back to admins', {
        tenantId, agentId, escalationRecipient,
      });
      const admins = await withTenantScope(tenantId, (client) => client.query(
        `SELECT account_id FROM tenant_members WHERE tenant_id = $1 AND role IN ('admin', 'owner')`,
        [tenantId],
      ));
      accountIds = admins.rows.map((r) => r.account_id as string);
    }

    const appBaseUrl = frontendUrl();

    // Only send someone to the queue when the queue actually holds the thing
    // they are being told about.
    //
    // A 'blocker' or a 'clarification' PARKED its run: there is a row in the
    // queue, answering it resumes the work, and "Review now" is exactly right.
    //
    // An 'escalation' is the opposite. The run has already ended and left a
    // record behind. Records left the customer queue when it narrowed to parked
    // runs — correctly, since nobody can accept or deny "the connector is
    // broken" — so a link to /dashboard/review promises an item that is not
    // there. The reader arrives at their other pending work, or at an empty
    // queue, having been told something needs their attention.
    //
    // An escalation now has an honest link, which it did not before: it opens a
    // chat thread, and `chatThreadId` is that thread. The escalation's own
    // `threadId` still is not linkable — for an autonomous run it belongs to
    // the RUNTIME's `threads` table while /dashboard/agents/chat reads
    // `agent_chat_threads` here, so sending anyone to it would be a dead end.
    // `chatThreadId` is minted by this service and is safe to point at.
    //
    // Absent it, the old behaviour holds and the surfaces lead with the reason
    // rather than with a button, because a link to the review queue would
    // promise an item that will never appear there.
    //
    // An absent recordKind means a runtime that predates the field, and every
    // such caller is createEscalation, so it reads as 'escalation' too.
    const hasQueueItem = recordKind === 'blocker' || recordKind === 'clarification';
    const canLinkChat = !hasQueueItem && !!chatThreadId && !!lookupId;

    // The destination is resolved through an opaque /notification/<id> rather
    // than encoded in the URL. Internal agent and thread ids must not travel in
    // an address bar, browser history, a referrer header, or the body of an
    // email — the same rule SharePage.tsx already states for share links, where
    // "the share URL is the only public artifact".
    //
    // Best effort: a link that cannot be minted (a DB blip, a thread that has
    // since gone) falls back to `undefined`, which is the same value the old
    // code produced when there was nothing safe to point at. Both cards already
    // handle an absent link by leading with the reason and omitting the button,
    // so the failure mode is a notification that still says the true thing.
    let eventLink: string | undefined;
    if (appBaseUrl && (hasQueueItem || canLinkChat)) {
      try {
        const linkId = await findOrCreateLink({
          tenantId,
          destination: hasQueueItem ? 'review' : 'chat',
          agentId: canLinkChat ? lookupId : null,
          threadId: canLinkChat ? chatThreadId! : null,
          // Only a review link is identified by its record. A chat link is
          // identified by its thread, so passing the escalation id there would
          // mint a fresh row for every escalation on the same conversation
          // instead of reusing the one link that already points at it.
          recordId: hasQueueItem ? (escalationId ?? null) : null,
        });
        eventLink = `${appBaseUrl}/notification/${linkId}`;
      } catch (err) {
        log.warn(
          { err: (err as Error).message, tenantId, escalationId },
          'could not mint a notification link; sending without one',
        );
      }
    }
    // The destination is decided here; how each surface WORDS it is not. Both
    // cards hardcoded review-queue phrasing for whatever url they were handed,
    // so a chat link under that copy would read "answer it in the review
    // queue" and point somewhere else entirely.
    const eventLinkKind: 'review' | 'chat' = canLinkChat ? 'chat' : 'review';
    const truncatedReason = reason.length > 2000
      ? `${reason.slice(0, 2000)}\n\n[…truncated]`
      : reason;

    await Promise.allSettled(
      accountIds.map((accountId) =>
        enqueueNotification({
          accountId,
          tenantId,
          type: 'escalation',
          payload: {
            internalAgentName: agentName,
            eventTitle: escalationNotificationTitle(agentName, recordKind),
            eventSummary: truncatedReason,
            eventLink,
            // The renderer needs this too: its escalation branch falls back to
            // the review link whenever eventLink is absent, so dropping the
            // link here alone would reinstate the dead one.
            recordKind,
            escalationId,
            invocationId,
            threadId,
          },
        }),
      ),
    );

    // All channels, always: the email above plus the same Slack DM and Teams
    // Adaptive Card fan-out HITL approvals already use, with the same assignee
    // list. Notice variant — informational, no Approve/Reject, because none of
    // these is decided on a card. Fire-and-forget: a chat-channel outage must
    // not fail the notification that still has email behind it. Both fan-outs
    // need the CONTROL-PLANE id (conversations and display names key on it),
    // so they are gated on having one.
    //
    // `linkUrl` empty is meaningful, not missing: it tells both cards there is
    // no queue item, so they lead with the reason and omit the button rather
    // than pointing at a queue this record will never appear in.
    if (lookupId) {
      const notice = { reason: truncatedReason, linkUrl: eventLink ?? '', linkKind: eventLinkKind };
      void import('../agent-chat/slack-adapter/review-dm-notifier')
        .then(({ postReviewDmFanout }) => postReviewDmFanout({
          reviewId: escalationId,
          tenantId,
          agentId: lookupId,
          assigneeAccountIds: accountIds,
          notice: true,
          noticeReason: truncatedReason,
          // Undefined for a terminal escalation, which is how the card knows to
          // omit the queue pointer rather than promise an item that is not there.
          noticeLinkUrl: eventLink,
          noticeLinkKind: eventLinkKind,
        }))
        .catch((err) => log.warn({ err: (err as Error).message, escalationId }, 'escalation Slack fan-out failed'));
      void import('../agent-chat/teams-adapter/review-card-notifier')
        .then(({ postReviewCardFanout }) => postReviewCardFanout({
          reviewId: escalationId,
          tenantId,
          agentId: lookupId,
          assigneeAccountIds: accountIds,
          notice,
        }))
        .catch((err) => log.warn({ err: (err as Error).message, escalationId }, 'escalation Teams fan-out failed'));
    }

    res.json({ enqueued: accountIds.length });
  },
);

const broadcastSchema = z.object({
  subject: z.string().min(1).max(200),
  bodyHtml: z.string().min(1).max(100_000),
  preheader: z.string().min(1).max(150).optional(),
});

notificationsInternalRouter.post('/newsletter/broadcast', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  const parsed = broadcastSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', issues: parsed.error.issues });
    return;
  }

  const pool = getPool();
  const recipients = await pool.query<{ id: string; email: string; first_name: string | null }>(
    `SELECT id, email, first_name FROM accounts
      WHERE deleted_at IS NULL AND (preferences->>'newsletter')::boolean = true`,
  );

  let sent = 0;
  let failed = 0;
  const total = recipients.rowCount ?? 0;
  for (let i = 0; i < total; i += 50) {
    const batch = recipients.rows.slice(i, i + 50);
    const results = await Promise.allSettled(
      batch.map((r) => {
        // Render per-recipient because the unsubscribe link is account-specific.
        // appendUnsubscribeFooter only needs the account id; pass a minimal
        // object rather than casting an incomplete row to the full Account type.
        //
        // Auto-style every <a> tag in the operator's body so anchors match
        // the brand (orange, no underline) instead of the email client's
        // default blue + underline. Operators don't need to remember to
        // inline-style each link.
        const styledBody = styleAnchorsInHtml(parsed.data.bodyHtml);
        const { body: bodyWithFooter, headers } = appendUnsubscribeFooter(
          styledBody,
          { id: r.id },
          'newsletter',
        );
        // Sanitize operator-supplied subject/preheader (CRLF strip + < >).
        // bodyHtml is intentional HTML and passes through unchanged.
        const safeSubject = sanitizeForHeader(parsed.data.subject);
        const safePreheader = sanitizeForHeader(parsed.data.preheader ?? parsed.data.subject);
        const { subject, html } = buildEmail('newsletter', {
          firstName: r.first_name ?? 'there',
          newsletterSubject: safeSubject,
          newsletterPreheader: safePreheader,
          rawHtml: bodyWithFooter,
        });
        return sendEmail({ to: r.email, subject, html, emailType: 'newsletter', headers });
      }),
    );
    sent += results.filter((x) => x.status === 'fulfilled').length;
    failed += results.filter((x) => x.status === 'rejected').length;
    if (i + 50 < total) await new Promise((r) => setTimeout(r, 1000)); // 1s between batches
  }
  res.json({ ok: true, sent, failed, total });
});
