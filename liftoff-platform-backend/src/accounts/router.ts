// Accounts Router
// Per Section 1: Control plane owns accounts

import { Router } from 'express';
import { z } from 'zod';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import crypto from 'crypto';
import { getAuth } from 'firebase-admin/auth';
import { AccountService } from './service';
import type { Account } from './types';
import { log, logAudit } from '../infrastructure/logging';
import { requireVerifiedEmail } from '../auth/requireVerifiedEmail';
import { sendSignupVerification, sendSignupNotification, sendWelcomeEmail } from '../infrastructure/email';
import { buildSignupApprovalToken } from './signup-approval-tokens';
import { isSignupOpen } from '../config/allowedDomains';
import { ReferralService } from '../referrals/service';

// Fields surfaced in account.updated audit rows. Covers Settings → Profile
// (firstName / lastName / email) and Settings → Communication
// (notificationFrequency / notificationTypes / notificationDelivery).
// gettingStartedHidden is a UI
// preference and intentionally omitted from compliance audit output.
function pickAuditFields(a: Account): Record<string, unknown> {
  return {
    firstName: a.firstName,
    lastName: a.lastName,
    email: a.email,
    notificationFrequency: a.preferences?.notificationFrequency ?? null,
    notificationTypes: a.preferences?.notificationTypes ?? null,
    notificationDelivery: a.preferences?.notificationDelivery ?? null,
  };
}

// Email format validation (BE-004, SE-003)
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321

function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_REGEX.test(email);
}

// Two-tier rate limiting (BE-002)
// Uses in-memory store (sufficient for single-instance Cloud Run)
// Tier 1: IP-based - generous for shared IPs
const ipRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // 20 req/min per IP (generous for corporate NAT)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip || 'unknown'),
  message: { error: 'Too many requests. Please try again later.' },
});

// Tier 2: Email-based - strict per-email
const emailRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minute window
  max: 5, // 5 checks per email per 10 min
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `email:${req.body.email?.toLowerCase()}`,
  message: { error: 'Too many requests for this email. Please try again later.' },
});

// Zod schema for account preferences (BE-003)
const notificationTypesSchema = z.object({
  taskUpdates: z.boolean().optional(),
  teamActivity: z.boolean().optional(),
  escalations: z.boolean().optional(),
  weeklyDigest: z.boolean().optional(),
}).strict();

// Where notifications go, as opposed to which ones you get. Both keys are
// optional here, but the frontend always sends both: preferences are merged
// with a shallow JSONB `||`, so a partial object would replace the whole
// notificationDelivery value and silently switch the other channel off.
const notificationDeliverySchema = z.object({
  email: z.boolean().optional(),
  browser: z.boolean().optional(),
}).strict();

// Exported so its contract can be asserted directly. It is `.strict()`, which
// means a preference key the frontend sends and this schema does not know 400s
// the WHOLE request rather than dropping the field — a failure mode that looks
// like "the setting will not save" and says nothing about why.
export const accountPreferencesSchema = z.object({
  gettingStartedHidden: z.boolean().optional(),
  notificationTypes: notificationTypesSchema.optional(),
  notificationFrequency: z.enum(['realtime', 'daily', 'weekly', 'none']).optional(),
  notificationDelivery: notificationDeliverySchema.optional(),
  newsletter: z.boolean().optional(),
}).strict(); // Reject unknown keys

// Zod schema for updating account (BE-003)
const updateAccountSchema = z.object({
  firstName: z.string().min(1).max(255).optional(),
  lastName: z.string().min(1).max(255).optional(),
  timezone: z.string().max(100).optional(),
  preferences: accountPreferencesSchema.optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

export const accountsRouter = Router();
export const accountsPublicRouter = Router();
const service = new AccountService();
const referralService = new ReferralService();

// POST to keep email out of URL/logs (BE-001)
accountsPublicRouter.post(
  '/email-check',
  ipRateLimiter,
  emailRateLimiter,
  async (req, res) => {
    const startTime = Date.now();
    const email = req.body.email as string;

    // Input validation (BE-004)
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'Invalid email format' });
      return;
    }

    // Security logging (SE-005)
    console.log(JSON.stringify({
      event: 'email_check',
      timestamp: new Date().toISOString(),
      ip: req.ip,
      email_hash: crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16),
    }));

    try {
      const account = await service.getByEmail(email.toLowerCase());
      const exists = !!account;

      // Constant-time response to prevent timing attacks (BE-003)
      const elapsed = Date.now() - startTime;
      const minResponseTime = 200; // Always take at least 200ms
      if (elapsed < minResponseTime) {
        await new Promise(resolve => setTimeout(resolve, minResponseTime - elapsed));
      }

      // Cache control headers (BE-006)
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        'Pragma': 'no-cache',
        'Expires': '0',
      });

      res.json({ exists });
    } catch (err) {
      console.error('Email check error:', err);
      // Don't reveal internal errors - return same response shape
      res.status(500).json({ error: 'Service temporarily unavailable' });
    }
  }
);

// List all accounts
accountsRouter.get('/', async (_req, res, next) => {
  try {
    const accounts = await service.listAll();
    res.json(accounts);
  } catch (error) {
    next(error);
  }
});

// Create a new account
// requireVerifiedEmail blocks unverified password signups from creating an
// account row (junk-email protection). Google / verified / passkey pass.
accountsRouter.post('/', requireVerifiedEmail, async (req, res, next) => {
  try {
    let account: Account;
    // Whether this request found an account rather than creating one. It is the
    // difference between a referral that earns and one marked
    // `existing_account`: the terms exclude a referred workspace that already
    // had a Liftoff account, and this is the only place that fact is visible.
    let accountPreexisted = false;
    // The account is the verified token's, whatever the body says: the uid
    // comes from the token, and the email must be the token's when the token
    // carries one (Google, password and passkey sign-ins all do), so a caller
    // cannot register an address that is not theirs or a row no sign-in can
    // reach. The body's own casing of the address is not trusted either.
    const tokenUid = req.user?.uid;
    if (!tokenUid) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const tokenEmail = typeof req.user?.email === 'string' ? req.user.email : undefined;
    const bodyEmail = typeof req.body?.email === 'string' ? req.body.email : undefined;
    if (tokenEmail && bodyEmail && tokenEmail.toLowerCase() !== bodyEmail.toLowerCase()) {
      res.status(400).json({ error: 'email_mismatch', message: 'The email must be the signed-in address' });
      return;
    }
    const email = tokenEmail ?? bodyEmail;
    if (!email) {
      res.status(400).json({ error: 'email_required' });
      return;
    }
    const input = { ...req.body, firebaseUid: tokenUid, email };
    try {
      account = await service.create(input);
      logAudit('account.created', req.ctx, {
        accountId: account.id,
        email: account.email,
      });
    } catch (createErr: any) {
      // Handle idempotency: if account already exists with this email, return it
      // instead of failing. This can happen on signup retries when POST /api/accounts
      // succeeds but subsequent operations fail, leaving the account row orphaned.
      if (
        createErr?.message?.includes('duplicate key value violates unique constraint') &&
        createErr?.message?.includes('accounts_email_key')
      ) {
        const existing = await service.getByEmail(email);
        if (existing) {
          // Account exists; return it and let the frontend sort out the inconsistency
          // (mismatched firebase_uid will be caught by auth gate). Log the retry for
          // diagnostics — this should be rare if account creation is succeeding post-INSERT.
          log.warn(
            { email, accountId: existing.id },
            'POST /api/accounts: duplicate email — returning existing account (idempotency fallback)',
          );
          account = existing;
          accountPreexisted = true;
        } else {
          // Email constraint violation but no account found; this is a real error
          throw createErr;
        }
      } else {
        throw createErr;
      }
    }

    // Referral attribution. Bound here rather than inside service.create() for
    // the same reason the signup notification is: provisioning scripts and
    // tests call create() directly, and neither is a signup that followed
    // somebody's link. This is also the only layer that knows whether the
    // account is new, which is what separates an earning referral from one
    // marked `existing_account`.
    //
    // Best-effort by construction — bindOnAccountCreation never throws — so a
    // referral that cannot be recorded costs the attribution and not the
    // signup.
    if (typeof req.body?.referralCode === 'string' && req.body.referralCode.trim().length > 0) {
      const clickedAtRaw = req.body?.referralClickedAt;
      const clickedAt =
        typeof clickedAtRaw === 'string' && !Number.isNaN(Date.parse(clickedAtRaw))
          ? new Date(clickedAtRaw)
          : null;
      await referralService.bindOnAccountCreation({
        accountId: account.id,
        email: account.email,
        code: req.body.referralCode,
        clickedAt,
        accountPreexisted,
      });
    }

    const response = await service.toResponse(account);
    const alreadyGranted = response.accessGranted;

    // Best-effort: notify signups@example.com of the new signup. Never block
    // or fail the signup on an email error. Fires here (router), not in
    // service.create(), so provisioning scripts / tests that call create()
    // directly don't send notifications.
    try {
      // Approve/Waitlist links are only needed for signups that AREN'T already
      // granted (a whitelisted-domain signup gets a button-less FYI). Build the
      // signed token only for that case, and if it can't be built (e.g. the
      // secret is unset) still send the FYI without action buttons rather than
      // dropping the notification entirely.
      let pageUrl: string | undefined;
      if (!alreadyGranted) {
        try {
          const token = buildSignupApprovalToken(account.id);
          const frontendUrl = process.env.FRONTEND_URL ?? 'https://example.com';
          pageUrl = `${frontendUrl}/signup-approval?token=${encodeURIComponent(token)}`;
        } catch (tokenErr) {
          log.error(
            { err: tokenErr, accountId: account.id },
            'signup-approval token build failed; sending notification without action buttons',
          );
        }
      }
      await sendSignupNotification(
        { firstName: account.firstName, lastName: account.lastName, email: account.email },
        { pageUrl, alreadyGranted },
      );
    } catch (notifyErr) {
      log.error({ err: notifyErr, accountId: account.id }, 'Failed to send signup notification email');
    }

    // A signup that spent a pre-approval (migration 341) is granted without
    // anyone pressing Approve, and the welcome email is otherwise sent from
    // that button alone — so it has to be sent here or the person arrives
    // having been told nothing. accessStatus is only ever 'approved' on a
    // brand-new row via the guest list, so it is the exact signal. The same
    // holds while signup is open (the `*` allow-list entry): nobody presses
    // Approve, so a brand-new account granted that way is welcomed here too.
    // A preexisting account returned by the idempotency fallback is not a
    // signup and gets no second welcome.
    //
    // Best-effort, unlike the Approve path which lets failures 500 for the
    // admin to retry: there is no retry here, and failing a signup that has
    // already committed — for a user who IS granted — is far worse than a
    // missing welcome.
    if (account.accessStatus === 'approved' || (isSignupOpen() && alreadyGranted && !accountPreexisted)) {
      try {
        await sendWelcomeEmail(account.email, account.firstName);
      } catch (welcomeErr) {
        log.error(
          { err: welcomeErr, accountId: account.id },
          'Failed to send welcome email to pre-approved signup',
        );
      }
    }

    res.status(201).json(response);
  } catch (error) {
    next(error);
  }
});

// Get current user's account
accountsRouter.get('/me', async (req, res, next) => {
  try {
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const account = await service.getByFirebaseUid(firebaseUid);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    // Use cached access from gate middleware if available, otherwise compute fresh
    const cachedAccess = (req as any).accessDecision;
    res.json(await service.toResponse(account, cachedAccess));
  } catch (error) {
    next(error);
  }
});

// Update current user's account
accountsRouter.put('/me', requireVerifiedEmail, async (req, res, next) => {
  try {
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Validate request body (BE-003)
    const parseResult = updateAccountSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
      return;
    }

    const account = await service.getByFirebaseUid(firebaseUid);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const updatedAccount = await service.update(account.id, parseResult.data);

    // Capture before/after on the fields users actually edit from the
    // Settings → Profile / Communication tabs. notificationFrequency +
    // notificationTypes belong here so compliance reports can show how a
    // user's notification preferences changed over time.
    logAudit('account.updated', req.ctx, {
      resourceType: 'account',
      resourceId: updatedAccount.id,
      previousState: pickAuditFields(account),
      newState: pickAuditFields(updatedAccount),
    });

    res.json(await service.toResponse(updatedAccount));
  } catch (error) {
    next(error);
  }
});

// Initiate email change (sends verification email)
accountsRouter.post('/me/email', async (req, res, next) => {
  try {
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const account = await service.getByFirebaseUid(firebaseUid);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const { newEmail } = req.body;
    if (!newEmail || typeof newEmail !== 'string') {
      res.status(400).json({ error: 'New email is required' });
      return;
    }

    // Get base URL from request or environment
    const baseUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;

    await service.initiateEmailChange(account.id, newEmail, baseUrl);

    logAudit('account.email_change_initiated', req.ctx, {
      accountId: account.id,
      newEmail,
    });

    res.json({ message: 'Verification email sent' });
  } catch (error) {
    if (error instanceof Error && error.message === 'Email address is already in use') {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.message === 'Email must use a company domain') {
      res.status(400).json({ error: 'domain_not_allowed', message: error.message });
      return;
    }
    next(error);
  }
});

// Cancel pending email change
accountsRouter.delete('/me/email', async (req, res, next) => {
  try {
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const account = await service.getByFirebaseUid(firebaseUid);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const updatedAccount = await service.cancelEmailChange(account.id);

    logAudit('account.email_change_canceled', req.ctx, {
      accountId: account.id,
    });

    res.json(updatedAccount);
  } catch (error) {
    next(error);
  }
});

// Revoke all Firebase refresh tokens for the current user ("Log Out All Devices")
accountsRouter.post('/me/sessions/revoke-all', async (req, res, next) => {
  try {
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    await getAuth().revokeRefreshTokens(firebaseUid);

    logAudit('account.sessions_revoked', req.ctx, { firebaseUid });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// Send (or resend) the signup email-verification link to the current user.
// Generates a Firebase email-verification action link server-side and delivers
// it via Resend using our own template (NOT Firebase's built-in mailer). The
// caller holds a valid Firebase ID token but has no account row yet — the
// account is created only after the email is verified — so this route is
// whitelisted in accessGateMiddleware. Already-verified / federated callers are
// a no-op (204) so the frontend can call this unconditionally on signup.
accountsRouter.post('/me/send-verification', async (req, res, next) => {
  try {
    const user = req.user;
    if (!user?.uid || !user.email) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // Nothing to verify: already verified, or a federated provider (Google)
    // that asserts the email address.
    if (user.emailVerified || user.signInProvider !== 'password') {
      res.status(204).send();
      return;
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://example.com';
    const firebaseLink = await getAuth().generateEmailVerificationLink(user.email, {
      url: `${frontendUrl}/verify-email`,
    });

    // Never expose the project's *.firebaseapp.com action-handler domain in the
    // email — it reads as off-brand / phishy. Keep Firebase's single-use
    // oobCode but deliver it through our own domain; our /auth/action page
    // applies it via applyActionCode(). Fall back to the raw link only if the
    // oobCode can't be parsed, so verification is never silently blocked.
    const oobCode = new URL(firebaseLink).searchParams.get('oobCode');
    const verificationUrl = oobCode
      ? `${frontendUrl}/auth/action?mode=verifyEmail&oobCode=${encodeURIComponent(oobCode)}`
      : firebaseLink;

    const firstName = (user.displayName || '').trim().split(/\s+/)[0] || '';
    await sendSignupVerification(user.email, verificationUrl, firstName);

    logAudit('account.signup_verification_sent', req.ctx, {
      firebaseUid: user.uid,
      email: user.email,
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// Verify email change (public endpoint - no auth required)
accountsRouter.get('/verify-email', async (req, res, next) => {
  try {
    const token = req.query.token as string;
    if (!token) {
      res.status(400).json({ error: 'Verification token is required' });
      return;
    }

    const account = await service.confirmEmailChange(token);

    logAudit('account.email_verified', req.ctx, {
      accountId: account.id,
      email: account.email,
    });

    // Redirect to the Settings → Account tab. The React route is mounted at
    // /dashboard/settings/:tab; SettingsPage reads ?email_verified=true|false
    // and shows the appropriate toast.
    const frontendUrl = process.env.FRONTEND_URL || 'https://example.com';
    res.redirect(`${frontendUrl}/dashboard/settings/account?email_verified=true`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid or expired')) {
      const frontendUrl = process.env.FRONTEND_URL || 'https://example.com';
      res.redirect(`${frontendUrl}/dashboard/settings/account?email_verified=false&error=expired`);
      return;
    }
    next(error);
  }
});

// Get account by ID
accountsRouter.get('/:id', async (req, res, next) => {
  try {
    const account = await service.getById(req.params.id);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }
    res.json(account);
  } catch (error) {
    next(error);
  }
});

// Update account
accountsRouter.put('/:id', async (req, res, next) => {
  try {
    // Validate request body (BE-003)
    const parseResult = updateAccountSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: 'Validation failed', details: parseResult.error.errors });
      return;
    }

    const account = await service.update(req.params.id, parseResult.data);

    logAudit('account.updated', req.ctx, {
      accountId: account.id,
    });

    res.json(account);
  } catch (error) {
    next(error);
  }
});

// Delete account
accountsRouter.delete('/:id', async (req, res, next) => {
  try {
    const accountId = req.params.id;

    // Validate account ID format
    if (!accountId || typeof accountId !== 'string') {
      res.status(400).json({ error: 'Invalid account ID' });
      return;
    }

    // Who is asking, from the verified token's own account row: the owner
    // may delete their account, a platform admin (accounts.is_platform_admin,
    // the same fact adminAuthMiddleware checks) may delete any. Nothing here
    // comes from a request header: a header any caller can set is not an
    // authority. The requester's account id is what deleted_by (a uuid)
    // records; the Firebase uid it used to be handed never fit the column,
    // so every owner's own deletion failed.
    const firebaseUid = req.user?.uid;
    if (!firebaseUid) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const requester = await service.getByFirebaseUid(firebaseUid);
    if (!requester) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const isAdmin = requester.isPlatformAdmin;

    // Get account to check ownership
    const account = await service.getById(accountId);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const isOwner = requester.id === account.id;

    if (!isAdmin && !isOwner) {
      res.status(403).json({ error: 'Forbidden: You can only delete your own account' });
      return;
    }

    const deletedBy = requester.id;
    const deleted = await service.delete(accountId, deletedBy);

    if (!deleted) {
      res.status(404).json({ error: 'Account not found or already deleted' });
      return;
    }

    logAudit('account.deleted', req.ctx, {
      accountId,
      deletedBy,
      isAdmin,
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
