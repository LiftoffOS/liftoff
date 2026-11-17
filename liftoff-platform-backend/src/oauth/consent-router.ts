// OAuth consent API (plan v6.1 Phase 3) — the Firebase-authed pair behind
// the frontend /oauth/consent page. Mounted under /api AFTER authMiddleware
// (app.use('/api', authMiddleware) covers it — verified).
//
//   GET  /api/oauth/consent/:requestId — request metadata for display:
//        client name, redirect HOST (shown to the user), scope, expiry.
//   POST /api/oauth/consent/park       — { requestId, tenantId }
//        The page calls this on load, before any picker, when every workspace
//        the person could connect is one they own that has not finished
//        onboarding: the request is parked rather than claimed, stays live
//        for 60 minutes from the stamp (parked_for_onboarding_at, migration
//        467), and the same request approves when they return from
//        /onboarding. An already-expired request answers 410 and is never
//        revived; a workspace that is not an unfinished one of the caller's
//        answers 400 not_parkable.
//   POST /api/oauth/consent            — { requestId, tenantId?, approve }
//        Approving an unfinished workspace of one's own is refused the same
//        way (409 setup_required, the request parked), so a client that
//        skipped the park call cannot connect a tool to a workspace that
//        cannot run anything yet.
//        Single-use claim; deny → redirectTo with error=access_denied;
//        approve → ONE transaction (approveConsentTx) running the consent
//        lifecycle branch machine (v5 blocker 5):
//          - active grant + live anchor  → REUSE (create nothing)
//          - anything else               → revoke old grant/tokens/anchor,
//                                          then create anchor + assignment
//                                          + grant
//        then mint the authorization code and return { redirectTo }. A
//        client deprovisioned meanwhile (RFC 7592) answers 410.
//
// The frontend only ever redirects to the backend-supplied redirectTo,
// which is built from the registration-validated redirect_uri via new URL().

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { enforceCanonicalPublicHost } from './canonical-host';
import { z } from 'zod';
import { pool, withTenantScope } from '../infrastructure/database';
import { hashToken } from '../tenant-members/tokens';
import { log, logAudit } from '../infrastructure/logging';
import { auditCtx } from '../infrastructure/audit-context';
import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members';
import { isMcpOauthEnabled } from './metadata-router';
import { isPrivateUseUri } from './redirect-uri';
import { brandMcpClient } from './client-brand';
import { LIVE_PREDICATE } from './grant-lifecycle';
import { approveConsentTx, approveDeviceCodeTx } from './transactions';
import { checkWindow, deviceLookupRateLimit } from './rate-limiter';
import { getBackendUrl } from '../infrastructure/control-plane-url';

export const oauthConsentRouter = Router();
oauthConsentRouter.use(enforceCanonicalPublicHost);
const accountService = new AccountService();

const CODE_TTL_MS = 10 * 60 * 1000;

// A request is live under LIVE_PREDICATE (grant-lifecycle.ts): until its own
// expiry, or for sixty minutes after it was parked for onboarding —
// whichever is later. The GET, the parking UPDATE, the single-use claim and
// a client's deprovisioning all use the one predicate, so none can disagree.
const PARK_WINDOW_MINUTES = 60;

function gate(req: Request, res: Response): boolean {
  if (!isMcpOauthEnabled()) {
    res.status(404).json({ error: 'not_found' });
    return false;
  }
  return true;
}

async function getAccount(req: Request): Promise<{ id: string } | null> {
  const firebaseUid = (req as unknown as { user?: { uid?: string } }).user?.uid;
  if (!firebaseUid) return null;
  return accountService.getByFirebaseUid(firebaseUid);
}

// ── GET /api/oauth/consent/:requestId ─────────────────────────────────

oauthConsentRouter.get('/consent/:requestId', async (req: Request, res: Response) => {
  if (!gate(req, res)) return;
  const account = await getAccount(req);
  if (!account) return res.status(401).json({ error: 'Authentication required' });

  try {
    // oauth_authorization_requests + oauth_clients are platform-global
    // (non-RLS) — default pool per the repo classification rule.
    const r = await pool.query(
      `SELECT r.request_id, r.redirect_uri, r.scope, r.expires_at, r.consumed_at, c.client_name,
              ${LIVE_PREDICATE} AS live
       FROM oauth_authorization_requests r
       JOIN oauth_clients c ON c.client_id = r.client_id AND c.deleted_at IS NULL
       WHERE r.request_id = $1`,
      [req.params.requestId],
    );
    if (r.rows.length === 0 || r.rows[0].consumed_at !== null) {
      return res.status(404).json({ error: 'request_not_found' });
    }
    const row = r.rows[0];
    if (!row.live) {
      return res.status(410).json({ error: 'request_expired' });
    }
    // The host is the page's phishing signal, so it names a web destination
    // only. A private-use scheme (`cursor://…`) is the desktop app itself, the
    // same class as loopback, and its "host" is an app identifier the person
    // cannot act on.
    let redirectHost = '';
    try {
      const target = new URL(row.redirect_uri as string);
      redirectHost = isPrivateUseUri(target) ? '' : target.host;
    } catch { /* display-only */ }
    const brand = brandMcpClient(row.client_name as string);
    return res.json({
      clientName: row.client_name,
      clientSlug: brand.slug,
      clientLabel: brand.label,
      redirectHost,
      scope: row.scope,
      expiresAt: row.expires_at,
    });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'oauth consent GET failed');
    return res.status(500).json({ error: 'server_error' });
  }
});

// ── Parking a request for onboarding ──────────────────────────────────

/** Whether `tenantId` is a workspace the caller owns that has not finished
 *  onboarding: the one case a coding tool cannot be connected yet. */
async function ownsUnfinishedWorkspace(accountId: string, tenantId: string): Promise<boolean> {
  const gate = await pool.query(
    `SELECT onboarding_completed_at FROM tenants WHERE id = $1`,
    [tenantId],
  );
  if (gate.rows.length === 0 || gate.rows[0].onboarding_completed_at !== null) return false;
  const membership = await tenantMembersService.getMembership(tenantId, accountId);
  return membership?.role === 'owner';
}

/** Park a LIVE request so the same one approves when onboarding is done; an
 *  expired request is never revived. Idempotent: the stamp is kept on a
 *  request already parked. */
async function parkRequest(requestId: string, tenantId: string): Promise<'parked' | 'expired'> {
  const parked = await pool.query(
    `UPDATE oauth_authorization_requests r
     SET parked_for_onboarding_at = COALESCE(r.parked_for_onboarding_at, NOW())
     WHERE r.request_id = $1 AND r.consumed_at IS NULL AND ${LIVE_PREDICATE}
     RETURNING r.request_id`,
    [requestId],
  );
  if (parked.rows.length === 0) return 'expired';
  log.info({ requestId, tenantId, parkWindowMinutes: PARK_WINDOW_MINUTES }, 'oauth consent parked for onboarding');
  return 'parked';
}

const parkSchema = z.object({
  requestId: z.string().min(1).max(200),
  tenantId: z.string().uuid(),
});

oauthConsentRouter.post('/consent/park', async (req: Request, res: Response) => {
  if (!gate(req, res)) return;
  const account = await getAccount(req);
  if (!account) return res.status(401).json({ error: 'Authentication required' });

  const parsed = parkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  }
  const { requestId, tenantId } = parsed.data;
  try {
    if (!(await ownsUnfinishedWorkspace(account.id, tenantId))) {
      return res.status(400).json({ error: 'not_parkable' });
    }
    const outcome = await parkRequest(requestId, tenantId);
    if (outcome === 'expired') return res.status(410).json({ error: 'request_expired' });
    return res.json({ parked: true, onboardingUrl: '/onboarding' });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'oauth consent park failed');
    return res.status(500).json({ error: 'server_error' });
  }
});

// ── POST /api/oauth/consent ───────────────────────────────────────────

const consentSchema = z.object({
  requestId: z.string().min(1).max(200),
  tenantId: z.string().uuid().optional(),
  approve: z.boolean(),
});

interface ClaimedRequest {
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  resource: string;
  client_name: string;
}

oauthConsentRouter.post('/consent', async (req: Request, res: Response) => {
  if (!gate(req, res)) return;
  const account = await getAccount(req);
  if (!account) return res.status(401).json({ error: 'Authentication required' });

  const parsed = consentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  }
  const { requestId, tenantId, approve } = parsed.data;

  // Audit BUG-4: validate BEFORE the single-use claim — an approve missing
  // its workspace must not consume (burn) the request.
  if (approve && !tenantId) {
    return res.status(400).json({ error: 'tenantId required to approve' });
  }

  // An owner whose workspace is not set up cannot connect a coding tool to
  // it yet. The page parks such a request before showing any picker (the
  // /park route); this is the same rule applied again on Approve, so a
  // client that skipped it cannot connect a tool to a workspace that cannot
  // run anything. Everyone else (a member of an incomplete workspace
  // included) proceeds to the claim.
  if (approve && tenantId) {
    try {
      if (await ownsUnfinishedWorkspace(account.id, tenantId)) {
        const outcome = await parkRequest(requestId, tenantId);
        if (outcome === 'expired') return res.status(410).json({ error: 'request_expired' });
        return res.status(409).json({ error: 'setup_required', onboardingUrl: '/onboarding' });
      }
    } catch (err) {
      log.error({ error: (err as Error).message }, 'oauth consent onboarding gate failed');
      return res.status(500).json({ error: 'server_error' });
    }
  }

  // Single-use claim (atomic). Non-RLS table → default pool.
  let claimed: ClaimedRequest | null = null;
  try {
    const r = await pool.query(
      `UPDATE oauth_authorization_requests r
       SET consumed_at = NOW()
       FROM oauth_clients c
       WHERE r.request_id = $1 AND r.consumed_at IS NULL AND ${LIVE_PREDICATE}
         AND c.client_id = r.client_id AND c.deleted_at IS NULL
       RETURNING r.client_id, r.redirect_uri, r.state, r.code_challenge, r.resource, c.client_name`,
      [requestId],
    );
    claimed = (r.rows[0] as ClaimedRequest | undefined) ?? null;
  } catch (err) {
    log.error({ error: (err as Error).message }, 'oauth consent claim failed');
    return res.status(500).json({ error: 'server_error' });
  }
  if (!claimed) {
    return res.status(410).json({ error: 'request_expired' });
  }

  const buildRedirect = (params: Record<string, string>): string => {
    const target = new URL(claimed!.redirect_uri);
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    if (claimed!.state) target.searchParams.set('state', claimed!.state);
    // RFC 9207: the authorization response (success AND error) carries the
    // issuer identifier so clients can defend against AS mix-up. Matches the
    // `issuer` published at /.well-known/oauth-authorization-server.
    target.searchParams.set('iss', getBackendUrl());
    return target.toString();
  };

  if (!approve) {
    return res.json({ redirectTo: buildRedirect({ error: 'access_denied' }) });
  }

  // Unreachable (the pre-claim guard enforced this) — kept for TS narrowing.
  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId required to approve' });
  }
  const membership = await tenantMembersService.getMembership(tenantId, account.id);
  if (!membership) {
    // Don't confirm tenant existence to non-members.
    return res.status(403).json({ error: 'Access denied' });
  }

  const codeRaw = `liftoff_ac_${crypto.randomBytes(32).toString('base64url')}`;

  let grantId: string | null = null;
  try {
    // Consent lifecycle branch machine — ONE transaction (withTenantScope
    // wraps BEGIN..COMMIT; verified). Shared with the device flow's
    // approval, which mints no code but needs the same grant.
    grantId = await withTenantScope(tenantId, (client) => approveConsentTx(client, {
      subject: {
        tenantId,
        accountId: account.id,
        clientId: claimed!.client_id,
        clientName: claimed!.client_name,
        resource: claimed!.resource,
      },
      codeHash: hashToken(codeRaw),
      redirectUri: claimed!.redirect_uri,
      codeChallenge: claimed!.code_challenge,
      resource: claimed!.resource,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    }));
  } catch (err) {
    log.error({ error: (err as Error).message, tenantId }, 'oauth consent approve failed');
    return res.status(500).json({ error: 'server_error' });
  }
  if (!grantId) {
    // The client deprovisioned itself between the claim and the approval.
    return res.status(410).json({ error: 'request_expired' });
  }

  // auditCtx merges req.ctx (requestId/operation from middleware) with the
  // explicit tenant; actorAccountId isn't set on this route (no
  // tenantAuthMiddleware), so pin userId to the resolved account directly.
  logAudit('mcp_oauth.consent_approved', { ...auditCtx(req, { tenantId }), userId: account.id }, {
    clientName: claimed.client_name,
    resource: claimed.resource,
  });

  return res.json({ redirectTo: buildRedirect({ code: codeRaw }) });
});

// ── Device flow (RFC 8628): the /activate page ────────────────────────
//
//   POST /api/oauth/device/lookup — { userCode } → who is asking, for the
//        page to render the same consent as /oauth/consent. 404 when no such
//        code is pending, 410 when it has expired.
//   POST /api/oauth/device        — { userCode, tenantId?, approve }. Approve
//        runs in ONE tenant-scoped transaction (approveDeviceCodeTx): hold
//        the client's registration, lock the pending row, create or reuse
//        the grant (ensureGrant, the branch machine the consent page uses),
//        mark the code approved with that grant. Deny marks it denied.
//        Nothing is redirected: the tool is polling the token endpoint and
//        collects its tokens on the next poll.
//
// A code is never parked for onboarding: the tool was told the code lives
// ten minutes and stops polling then, so a longer life on this side would
// approve into the void. An owner whose workspace has not finished setup is
// answered 409 setup_required and comes back to the same code afterwards; if
// it is still live it approves, otherwise the page says so.
//
// Both routes are rate-limited per address (rate-limiter.ts) and, here, per
// account: an eight-character code is guessable in principle, and RFC 8628
// §5.1 asks for exactly this brake on user-code guesses.

const USER_CODE_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/;
const LOOKUPS_PER_ACCOUNT = 20;
const LOOKUP_WINDOW_MS = 10 * 60 * 1000;

/** The form the database holds: uppercase, XXXX-XXXX. */
function normalizeUserCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (!USER_CODE_RE.test(code)) return null;
  const letters = code.replace('-', '');
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

function guessBudgetExceeded(accountId: string): boolean {
  return !checkWindow('device-lookup-account', accountId, LOOKUPS_PER_ACCOUNT, LOOKUP_WINDOW_MS).allowed;
}

const deviceLookupSchema = z.object({ userCode: z.string().min(1).max(20) });

oauthConsentRouter.post('/device/lookup', deviceLookupRateLimit, async (req: Request, res: Response) => {
  if (!gate(req, res)) return;
  const account = await getAccount(req);
  if (!account) return res.status(401).json({ error: 'Authentication required' });

  const parsed = deviceLookupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  }
  if (guessBudgetExceeded(account.id)) return res.status(429).json({ error: 'rate_limited' });
  const userCode = normalizeUserCode(parsed.data.userCode);
  if (!userCode) return res.status(404).json({ error: 'code_not_found' });

  try {
    // oauth_device_codes is platform-global (non-RLS) — default pool.
    const r = await pool.query(
      `SELECT client_name, expires_at, status FROM oauth_device_codes
       WHERE user_code = $1 AND status = 'pending'`,
      [userCode],
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'code_not_found' });
    const row = r.rows[0];
    if (new Date(row.expires_at as string) <= new Date()) return res.status(410).json({ error: 'code_expired' });
    const brand = brandMcpClient(row.client_name as string);
    return res.json({
      clientName: row.client_name,
      clientSlug: brand.slug,
      clientLabel: brand.label,
      expiresAt: row.expires_at,
    });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'oauth device lookup failed');
    return res.status(500).json({ error: 'server_error' });
  }
});

const deviceDecisionSchema = z.object({
  userCode: z.string().min(1).max(20),
  tenantId: z.string().uuid().optional(),
  approve: z.boolean(),
});

oauthConsentRouter.post('/device', deviceLookupRateLimit, async (req: Request, res: Response) => {
  if (!gate(req, res)) return;
  const account = await getAccount(req);
  if (!account) return res.status(401).json({ error: 'Authentication required' });

  const parsed = deviceDecisionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
  }
  if (guessBudgetExceeded(account.id)) return res.status(429).json({ error: 'rate_limited' });
  const { tenantId, approve } = parsed.data;
  const userCode = normalizeUserCode(parsed.data.userCode);
  if (!userCode) return res.status(404).json({ error: 'code_not_found' });
  if (approve && !tenantId) return res.status(400).json({ error: 'tenantId required to approve' });

  if (!approve) {
    try {
      const denied = await pool.query(
        `UPDATE oauth_device_codes SET status = 'denied'
         WHERE user_code = $1 AND status = 'pending' AND expires_at > NOW()
         RETURNING client_name`,
        [userCode],
      );
      if (denied.rows.length === 0) return res.status(410).json({ error: 'code_expired' });
      logAudit('mcp_oauth.device_denied', { ...auditCtx(req, {}), userId: account.id }, {
        clientName: denied.rows[0].client_name,
      });
      return res.json({ approved: false });
    } catch (err) {
      log.error({ error: (err as Error).message }, 'oauth device deny failed');
      return res.status(500).json({ error: 'server_error' });
    }
  }

  // Unreachable (checked above) — kept for TS narrowing.
  if (!tenantId) return res.status(400).json({ error: 'tenantId required to approve' });

  const membership = await tenantMembersService.getMembership(tenantId, account.id);
  if (!membership) {
    // Don't confirm tenant existence to non-members.
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    if (await ownsUnfinishedWorkspace(account.id, tenantId)) {
      return res.status(409).json({ error: 'setup_required', onboardingUrl: '/onboarding' });
    }
  } catch (err) {
    log.error({ error: (err as Error).message }, 'oauth device onboarding gate failed');
    return res.status(500).json({ error: 'server_error' });
  }

  try {
    // ONE transaction: the pending row is locked before the grant exists, so
    // two approvals of one code cannot each build a grant; the loser finds
    // no pending row. A code whose client deprovisioned itself meanwhile is
    // no longer approvable and answers the same way.
    const outcome = await withTenantScope(tenantId, (client) =>
      approveDeviceCodeTx(client, { userCode, tenantId, accountId: account.id }));
    if (!outcome) return res.status(410).json({ error: 'code_expired' });

    logAudit('mcp_oauth.device_approved', { ...auditCtx(req, { tenantId }), userId: account.id }, {
      clientName: outcome.clientName,
      resource: outcome.resource,
    });
    return res.json({ approved: true, workspaceName: outcome.workspaceName });
  } catch (err) {
    log.error({ error: (err as Error).message, tenantId }, 'oauth device approve failed');
    return res.status(500).json({ error: 'server_error' });
  }
});

