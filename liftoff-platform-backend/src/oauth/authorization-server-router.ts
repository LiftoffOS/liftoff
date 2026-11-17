// OAuth 2.1 Authorization Server endpoints (plan v6.1 Phase 3)
//
//   POST /oauth/register   — RFC 7591 dynamic client registration (public
//                            clients only; target-client compatibility — the
//                            2025-11-25 MCP auth spec prefers CIMD with DCR
//                            as fallback, and both target clients use DCR)
//   GET  /oauth/authorize  — validates the request, parks it, redirects the
//                            browser to the frontend consent page
//   POST /oauth/token      — authorization_code + refresh_token grants
//                            (form-encoded per RFC 6749; no client auth —
//                            PKCE is the proof)
//   POST /oauth/revoke     — RFC 7009 (token bound to the presenting client);
//                            a grant left with no live refresh token is
//                            retired, so the connection leaves the Teams page
//   DELETE /oauth/register/:client_id — RFC 7592: a DCR client deprovisions
//                            its own registration with the registration
//                            access token issued at DCR, ending every
//                            connection made through it (GET/PUT/PATCH/POST
//                            answer 405)
//
// Mounted in index.ts BEFORE CORS and BEFORE the global JSON parser — hence
// the route-local parsers. Deliberately NO CORS on token/register: loopback
// CLI clients don't need it, and browser clients can't use /mcp anyway (the
// origin guard rejects browsers).
//
// All redirect construction uses new URL() + searchParams — never string
// concatenation. Every token-bearing response carries Cache-Control:
// no-store + Pragma: no-cache (RFC 6749 §5.1).
//
// Transactions: withAdminScope wraps ONE atomic transaction (verified:
// BEGIN … COMMIT with rollback on throw), which is exactly the plan's
// single-transaction requirement for redemption and rotation. Lookups are
// pre-tenant-context (the token/code identifies the tenant) — src/oauth/**
// is on the eslint withAdminScope allow-list. The statements themselves live
// in transactions.ts, one function per grant, each following the lock
// discipline in grant-lifecycle.ts; this file keeps parsing, the RFC error
// bodies, and the client last_used_at stamp, which runs after commit.

import crypto from 'crypto';
import express, { Router, Request, Response } from 'express';
import { enforceCanonicalPublicHost } from './canonical-host';
import { frontendUrl } from '../infrastructure/frontend-url';
import { z } from 'zod';
import { pool, withAdminScope } from '../infrastructure/database';
import { hashToken } from '../tenant-members/tokens';
import { log } from '../infrastructure/logging';
import { getBackendUrl } from '../infrastructure/control-plane-url';
import { isMcpOauthEnabled, isCanonicalMcpResource, canonicalMcpResource } from './metadata-router';
import { clientConfigRateLimit, registerRateLimit, tokenRateLimit } from './rate-limiter';
import { isCimdClientId, resolveCimdClient } from './cimd';
import { isLoopbackUri, isPrivateUseUri } from './redirect-uri';
import { DEVICE_CODE_GRANT, SUPPORTED_GRANT_TYPES, negotiateGrantTypes, parseGrantTypes, responseTypesFor, usesDeviceGrant } from './client-grants';
import {
  ACCESS_TOKEN_TTL_MS,
  deprovisionClientTx,
  redeemAuthorizationCodeTx,
  redeemDeviceCodeTx,
  refreshTx,
  revokeTokenTx,
} from './transactions';
import type { CodeOutcome, DeviceOutcome, RefreshOutcome } from './transactions';

export const oauthAuthorizationServerRouter = Router();
// Root-mounted router: the guard must stay scoped to /oauth/* — unscoped it
// would run for every request in the app and reject internal *.run.app
// callers (see the note in metadata-router.ts).
oauthAuthorizationServerRouter.use('/oauth', enforceCanonicalPublicHost);

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function gate(req: Request, res: Response): boolean {
  if (!isMcpOauthEnabled()) {
    res.status(404).json({ error: 'not_found' });
    return false;
  }
  return true;
}

// ── Redirect URI validation (RFC 8252 §7.1 + §7.3) ────────────────────

// A registration is all-or-nothing, so rejecting one entry rejects the client
// entirely and it never reaches the consent page. Cursor registers a
// loopback URI and its private-use scheme together.
function validateRegistrableUri(raw: string): { uri: string; loopback_port_wildcard: boolean } | null {
  if (raw.length > 2000) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.hash) return null;
  if (isLoopbackUri(parsed)) {
    return { uri: raw, loopback_port_wildcard: true };
  }
  if (parsed.protocol === 'https:' || isPrivateUseUri(parsed)) {
    return { uri: raw, loopback_port_wildcard: false };
  }
  return null;
}

/** Exact match, EXCEPT the port for registered loopback URIs (RFC 8252 §7.3). */
function redirectUriMatches(
  registered: Array<{ uri: string; loopback_port_wildcard: boolean }>,
  presented: string,
): boolean {
  let presentedUrl: URL;
  try {
    presentedUrl = new URL(presented);
  } catch {
    return false;
  }
  for (const entry of registered) {
    if (entry.uri === presented) return true;
    if (!entry.loopback_port_wildcard) continue;
    let reg: URL;
    try {
      reg = new URL(entry.uri);
    } catch {
      continue;
    }
    if (
      isLoopbackUri(presentedUrl) &&
      reg.protocol === presentedUrl.protocol &&
      reg.hostname === presentedUrl.hostname &&
      reg.pathname === presentedUrl.pathname &&
      reg.search === presentedUrl.search
    ) {
      return true;
    }
  }
  return false;
}

// ── POST /oauth/register (DCR) ────────────────────────────────────────

// redirect_uris is required for a client that will use the authorization
// code grant and optional for one registered for the device grant alone: a
// tool with no browser of its own has nowhere to be redirected to (RFC 8628
// clients register no redirect). The requirement is checked after the grants
// are negotiated, below.
const registerSchema = z.object({
  client_name: z.string().min(1).max(255),
  redirect_uris: z.array(z.string()).max(5).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  // OIDC application_type (2026-07-28). MCP clients SHOULD send "native" for
  // desktop/CLI/localhost clients so loopback redirect URIs aren't rejected.
  // We already permit loopback for public clients, so this is persisted for
  // fidelity; absence leaves it null (our existing loopback-friendly behavior).
  application_type: z.enum(['native', 'web']).optional(),
});

oauthAuthorizationServerRouter.post(
  '/oauth/register',
  express.json({ limit: '20kb' }),
  registerRateLimit,
  async (req: Request, res: Response) => {
    if (!gate(req, res)) return;
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'client_name and 1-5 redirect_uris required' });
    }
    if (parsed.data.token_endpoint_auth_method && parsed.data.token_endpoint_auth_method !== 'none') {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'only public clients (token_endpoint_auth_method "none") are supported' });
    }

    // The grants this registration gets: what was asked for, narrowed to what
    // we serve, defaulting to the pair every earlier client got. Persisted and
    // echoed as one list (RFC 7591), so the token endpoint, the device
    // endpoint and the client all agree on it.
    const grantTypes = negotiateGrantTypes(parsed.data.grant_types);
    if (!grantTypes) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: `grant_types must include one of ${SUPPORTED_GRANT_TYPES.join(', ')}` });
    }
    const redirectUris = parsed.data.redirect_uris ?? [];
    if (redirectUris.length === 0 && !usesDeviceGrant(grantTypes)) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required unless registering for the device grant' });
    }

    const validated: Array<{ uri: string; loopback_port_wildcard: boolean }> = [];
    for (const raw of redirectUris) {
      const v = validateRegistrableUri(raw);
      if (!v) {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: `redirect URIs must be HTTPS, loopback or a private-use scheme, without a fragment (got: ${raw.slice(0, 100)})` });
      }
      validated.push(v);
    }

    const clientId = `liftoff_oc_${crypto.randomBytes(16).toString('hex')}`;
    // RFC 7592: the registration access token is the one credential that can
    // deprovision this registration (DELETE on registration_client_uri). It
    // is issued once, here, and stored hashed like every other secret in
    // this family; a registration made before it existed cannot manage
    // itself.
    const registrationAccessToken = `liftoff_rat_${crypto.randomBytes(32).toString('base64url')}`;
    try {
      // oauth_clients is platform-global (non-RLS) — default pool per the
      // repo classification rule (audit BUG-5: admin scope is reserved for
      // the RLS-joining token/revoke paths).
      await pool.query(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, application_type, grant_types, registration_access_token_hash)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [clientId, parsed.data.client_name, JSON.stringify(validated), parsed.data.application_type ?? null, JSON.stringify(grantTypes), hashToken(registrationAccessToken)],
      );
    } catch (err) {
      log.error({ error: (err as Error).message }, 'oauth register failed');
      return res.status(500).json({ error: 'server_error' });
    }

    noStore(res);
    return res.status(201).json({
      client_id: clientId,
      client_name: parsed.data.client_name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: grantTypes,
      response_types: responseTypesFor(grantTypes),
      // Echo the effective application_type (OIDC default is "web" when omitted).
      application_type: parsed.data.application_type ?? 'web',
      registration_access_token: registrationAccessToken,
      registration_client_uri: `${getBackendUrl()}/oauth/register/${clientId}`,
    });
  },
);

// ── DELETE /oauth/register/:client_id (RFC 7592 §2.3) ─────────────────

// A DELETE signs out every person connected through that registration: for
// a per-install client that is one person; for a hosted agent that
// registered once for many people it is all of them — what the RFC asks for
// and what a service does when it shuts its integration down. The client
// operator's own act, bound to one client_id by the registration access
// token (INV-PB-014). Every refusal is a bodiless 401 (RFC 6750 §3): a
// request with no Bearer credential at all is challenged without an error
// code, and a Bearer token that is malformed or wrong — for an unknown, an
// already-deleted or a CIMD client alike — is `invalid_token`, so the
// answer never says which.

/** The Bearer credential, RFC 6750 §2.1: absent (no header, or another
 *  scheme), malformed (the Bearer scheme with nothing usable), or a token. */
function bearerToken(req: Request): { kind: 'absent' } | { kind: 'malformed' } | { kind: 'token'; value: string } {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !/^Bearer(\s|$)/i.test(header.trim())) return { kind: 'absent' };
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? { kind: 'token', value: m[1] } : { kind: 'malformed' };
}

function registrationChallenge(res: Response, error: 'invalid_token' | null): void {
  res.setHeader('WWW-Authenticate', error ? `Bearer error="${error}"` : 'Bearer');
  res.status(401).end();
}

oauthAuthorizationServerRouter.delete(
  '/oauth/register/:client_id',
  clientConfigRateLimit,
  async (req: Request, res: Response) => {
    if (!gate(req, res)) return;
    const clientId = req.params.client_id;
    const presented = bearerToken(req);
    if (presented.kind === 'absent') return registrationChallenge(res, null);
    if (presented.kind === 'malformed') return registrationChallenge(res, 'invalid_token');

    try {
      const outcome = await withAdminScope(
        { caller: 'oauth.register.delete', reason: 'RFC 7592 client deprovisioning (pre-tenant lookup)', actor: clientId.slice(0, 24) },
        (client) => deprovisionClientTx(client, { clientId, bearerHash: hashToken(presented.value) }),
      );
      if (!outcome.authorized) return registrationChallenge(res, 'invalid_token');
      log.info({ event: 'oauth_client_deprovisioned', clientId, grants: outcome.grants }, 'OAuth client deprovisioned its registration');
    } catch (err) {
      log.error({ error: (err as Error).message }, 'oauth register delete failed');
      return res.status(500).json({ error: 'server_error' });
    }

    noStore(res);
    return res.status(204).end();
  },
);

oauthAuthorizationServerRouter.all(
  '/oauth/register/:client_id',
  clientConfigRateLimit,
  (req: Request, res: Response) => {
    if (!gate(req, res)) return;
    res.setHeader('Allow', 'DELETE');
    return res.status(405).json({ error: 'method_not_allowed' });
  },
);

// ── Registered clients ────────────────────────────────────────────────

export interface RegisteredClient {
  client_name: string;
  redirect_uris: Array<{ uri: string; loopback_port_wildcard: boolean }>;
  grant_types: string[];
}

/**
 * The client behind a client_id, for the authorize and device endpoints.
 *
 * CIMD (2026-07-28): a URL-form client_id is resolved from its metadata
 * document (SSRF-guarded fetch + validate) and upserted into oauth_clients so
 * the rest of the flow (grant/code/token binding) keys off the same string
 * client_id as DCR (opaque liftoff_oc_* clients still come from DCR). We
 * resolve when there is no row OR the cached document has expired,
 * respecting the document's HTTP cache headers, so a client that rotates its
 * redirect_uris is picked up automatically. On a fetch/validation failure we
 * keep serving the last-known-good row if one exists (stale-but-valid), else
 * answer null, which the caller reports as invalid_client.
 *
 * Throws only on a database failure of the lookup itself.
 */
export async function resolveRegisteredClient(clientId: string): Promise<RegisteredClient | null> {
  let clientRow: RegisteredClient | null = null;
  let existingClientType: string | null = null;
  let existingCimdCachedUntil: Date | null = null;
  // Non-RLS lookup — default pool (audit BUG-5). A deprovisioned client is
  // unknown here: 400 invalid_client at /oauth/authorize and at
  // /oauth/device_authorization.
  const r = await pool.query(
    `SELECT client_name, redirect_uris, client_type, cimd_cached_until, grant_types FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL`,
    [clientId],
  );
  if (r.rows.length > 0) {
    clientRow = {
      client_name: r.rows[0].client_name as string,
      redirect_uris: r.rows[0].redirect_uris as Array<{ uri: string; loopback_port_wildcard: boolean }>,
      grant_types: parseGrantTypes(r.rows[0].grant_types),
    };
    existingClientType = (r.rows[0].client_type as string | null) ?? null;
    existingCimdCachedUntil = r.rows[0].cimd_cached_until ? new Date(r.rows[0].cimd_cached_until as string) : null;
  }

  if (isCimdClientId(clientId)) {
    const cimdStale =
      clientRow !== null &&
      existingClientType === 'cimd' &&
      (existingCimdCachedUntil === null || existingCimdCachedUntil <= new Date());
    if (!clientRow || cimdStale) {
      try {
        const cimd = await resolveCimdClient(clientId, validateRegistrableUri);
        if (cimd) {
          await pool.query(
            `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, client_type, cimd_cached_until, grant_types)
             VALUES ($1, $2, $3, 'cimd', $4, $5)
             ON CONFLICT (client_id) DO UPDATE
               SET client_name = EXCLUDED.client_name,
                   redirect_uris = EXCLUDED.redirect_uris,
                   cimd_cached_until = EXCLUDED.cimd_cached_until,
                   grant_types = EXCLUDED.grant_types`,
            [clientId, cimd.client_name, JSON.stringify(cimd.redirect_uris), cimd.cachedUntil, JSON.stringify(cimd.grant_types)],
          );
          clientRow = { client_name: cimd.client_name, redirect_uris: cimd.redirect_uris, grant_types: cimd.grant_types };
        }
        // cimd === null: keep the existing (stale) clientRow if present; a
        // missing row is reported as null.
      } catch (err) {
        log.error({ error: (err as Error).message, clientId }, 'oauth CIMD resolution failed');
        // Keep the existing clientRow if present (graceful stale-serve).
      }
    }
  }
  return clientRow;
}

// ── GET /oauth/authorize ──────────────────────────────────────────────

// 43-char base64url string — the S256 code_challenge is base64url(SHA-256),
// which is always exactly 43 chars unpadded. The VERIFIER (43–128 chars) is
// validated at /oauth/token; RFC 7636 keeps them distinct.
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

oauthAuthorizationServerRouter.get('/oauth/authorize', async (req: Request, res: Response) => {
  if (!gate(req, res)) return;
  const q = req.query as Record<string, string | undefined>;
  const clientId = q.client_id ?? '';
  const redirectUri = q.redirect_uri ?? '';

  // Client + redirect must validate before ANY error redirect is allowed
  // (open-redirect discipline). Failures before that render plain 400s.
  let clientRow: RegisteredClient | null;
  try {
    clientRow = await resolveRegisteredClient(clientId);
  } catch (err) {
    log.error({ error: (err as Error).message }, 'oauth authorize client lookup failed');
    return res.status(500).json({ error: 'server_error' });
  }

  if (!clientRow) {
    return res.status(400).json({ error: 'invalid_client', error_description: 'unknown client_id' });
  }
  if (!redirectUriMatches(clientRow.redirect_uris, redirectUri)) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri does not match a registered value' });
  }

  // From here on, errors go BACK to the validated redirect_uri.
  const redirectError = (error: string, description: string): void => {
    const target = new URL(redirectUri);
    target.searchParams.set('error', error);
    target.searchParams.set('error_description', description);
    if (q.state) target.searchParams.set('state', q.state);
    res.redirect(302, target.toString());
  };

  if (q.response_type !== 'code') {
    return redirectError('unsupported_response_type', 'response_type must be "code"');
  }
  if (!q.code_challenge || !CODE_CHALLENGE_RE.test(q.code_challenge) || q.code_challenge_method !== 'S256') {
    return redirectError('invalid_request', 'PKCE S256 code_challenge required');
  }
  // RFC 8707 resource: required by the MCP spec, but there is exactly one
  // resource here, so a client that omits it gets that one rather than an
  // invalid_target it then has to debug (Muse burned two round trips on
  // it). A named resource still has to be ours.
  const resource = q.resource ?? canonicalMcpResource();
  if (!isCanonicalMcpResource(resource)) {
    return redirectError('invalid_target', `resource must be ${getBackendUrl()}/mcp`);
  }
  // Unknown scopes are a hard invalid_scope error (RFC 6749 — no silent
  // downgrade). Absent scope defaults to 'mcp'.
  const scopes = (q.scope ?? 'mcp').split(' ').filter(Boolean);
  if (scopes.some((s) => s !== 'mcp')) {
    return redirectError('invalid_scope', 'only the "mcp" scope is supported');
  }

  const requestId = crypto.randomBytes(24).toString('base64url');
  try {
    // Non-RLS insert — default pool (audit BUG-5). The row is inserted off
    // the client row held FOR SHARE for this one statement (tier 1 of the
    // lock discipline), so a deprovisioning DELETE and this insert never
    // overlap: a client deleted since the lookup above inserts nothing.
    const inserted = await pool.query(
      `INSERT INTO oauth_authorization_requests
         (request_id, client_id, redirect_uri, state, code_challenge, resource, scope)
       SELECT $1, c.client_id, $3, $4, $5, $6, 'mcp'
       FROM oauth_clients c WHERE c.client_id = $2 AND c.deleted_at IS NULL FOR SHARE`,
      [requestId, clientId, redirectUri, q.state ?? null, q.code_challenge, resource],
    );
    if ((inserted.rowCount ?? 0) === 0) {
      // An unknown client never gets a redirect (the open-redirect rule above).
      return res.status(400).json({ error: 'invalid_client', error_description: 'unknown client_id' });
    }
  } catch (err) {
    log.error({ error: (err as Error).message }, 'oauth authorize request insert failed');
    return redirectError('server_error', 'temporary failure, retry');
  }

  const consentUrl = new URL(`${frontendUrl()}/oauth/consent`);
  consentUrl.searchParams.set('request_id', requestId);
  return res.redirect(302, consentUrl.toString());
});

// ── POST /oauth/token ─────────────────────────────────────────────────

const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

function tokenSuccess(res: Response, accessRaw: string, refreshRaw: string): void {
  noStore(res);
  res.json({
    access_token: accessRaw,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refreshRaw,
    scope: 'mcp',
  });
}

function tokenError(res: Response, status: number, error: string, description?: string): void {
  noStore(res);
  res.status(status).json({ error, ...(description ? { error_description: description } : {}) });
}

/**
 * The client's last_used_at stamp, after the grant's transaction has
 * committed and only on success: it is outside the lock tiers, so it runs
 * on the pool rather than inside the scope, and a failure to stamp is not a
 * failure to issue.
 */
function stampClientUsed(clientId: string): void {
  void pool.query('UPDATE oauth_clients SET last_used_at = NOW() WHERE client_id = $1', [clientId])
    .catch((err: unknown) => log.warn({ error: (err as Error).message, clientId }, 'oauth client last_used_at stamp failed'));
}

oauthAuthorizationServerRouter.post(
  '/oauth/token',
  express.urlencoded({ extended: false, limit: '10kb' }),
  tokenRateLimit,
  async (req: Request, res: Response) => {
    if (!gate(req, res)) return;
    const body = req.body as Record<string, string | undefined>;

    if (body.grant_type === 'authorization_code') {
      const { code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId } = body;
      const resource = body.resource ?? canonicalMcpResource();
      if (!code || !verifier || !redirectUri || !clientId) {
        return tokenError(res, 400, 'invalid_request', 'code, code_verifier, redirect_uri, client_id required');
      }
      if (!VERIFIER_RE.test(verifier)) {
        return tokenError(res, 400, 'invalid_grant', 'malformed code_verifier');
      }
      if (!isCanonicalMcpResource(resource)) {
        return tokenError(res, 400, 'invalid_target', `resource must be ${getBackendUrl()}/mcp`);
      }

      try {
        const outcome = await withAdminScope<CodeOutcome>(
          { caller: 'oauth.token.code', reason: 'code redemption single-tx (pre-tenant lookup)', actor: clientId.slice(0, 24) },
          (client) => redeemAuthorizationCodeTx(client, { codeHash: hashToken(code), clientId, redirectUri, resource, verifier }),
        );
        if ('error' in outcome) return tokenError(res, 400, outcome.error);
        stampClientUsed(clientId);
        return tokenSuccess(res, outcome.tokens.accessRaw, outcome.tokens.refreshRaw);
      } catch (err) {
        log.error({ error: (err as Error).message }, 'oauth token (code) failed');
        return tokenError(res, 500, 'server_error');
      }
    }

    if (body.grant_type === 'refresh_token') {
      const { refresh_token: refreshToken, client_id: clientId } = body;
      const resource = body.resource ?? canonicalMcpResource();
      if (!refreshToken || !clientId) {
        return tokenError(res, 400, 'invalid_request', 'refresh_token and client_id required');
      }
      // resource is verified on refresh too (v6.1 correction list).
      if (!isCanonicalMcpResource(resource)) {
        return tokenError(res, 400, 'invalid_target', `resource must be ${getBackendUrl()}/mcp`);
      }

      try {
        const outcome = await withAdminScope<RefreshOutcome>(
          { caller: 'oauth.token.refresh', reason: 'refresh rotation single-tx (pre-tenant lookup)', actor: clientId.slice(0, 24) },
          (client) => refreshTx(client, { tokenHash: hashToken(refreshToken), clientId, resource }),
        );
        if ('theft' in outcome) {
          log.warn({ event: 'oauth_refresh_replay_revocation', clientId }, 'Stale refresh-token replay — grant family revoked');
          return tokenError(res, 400, 'invalid_grant');
        }
        if ('error' in outcome) return tokenError(res, 400, outcome.error);
        stampClientUsed(clientId);
        return tokenSuccess(res, outcome.tokens.accessRaw, outcome.tokens.refreshRaw);
      } catch (err) {
        log.error({ error: (err as Error).message }, 'oauth token (refresh) failed');
        return tokenError(res, 500, 'server_error');
      }
    }

    if (body.grant_type === DEVICE_CODE_GRANT) {
      const { device_code: deviceCode, client_id: clientId } = body;
      if (!deviceCode || !clientId) {
        return tokenError(res, 400, 'invalid_request', 'device_code and client_id required');
      }
      try {
        const outcome = await withAdminScope<DeviceOutcome>(
          { caller: 'oauth.token.device', reason: 'device code redemption single-tx (pre-tenant lookup)', actor: clientId.slice(0, 24) },
          (client) => redeemDeviceCodeTx(client, { deviceCodeHash: hashToken(deviceCode), clientId }),
        );
        if ('error' in outcome) return tokenError(res, 400, outcome.error);
        stampClientUsed(clientId);
        return tokenSuccess(res, outcome.tokens.accessRaw, outcome.tokens.refreshRaw);
      } catch (err) {
        log.error({ error: (err as Error).message }, 'oauth token (device) failed');
        return tokenError(res, 500, 'server_error');
      }
    }

    return tokenError(res, 400, 'unsupported_grant_type');
  },
);

// ── POST /oauth/revoke (RFC 7009) ─────────────────────────────────────

oauthAuthorizationServerRouter.post(
  '/oauth/revoke',
  express.urlencoded({ extended: false, limit: '10kb' }),
  tokenRateLimit,
  async (req: Request, res: Response) => {
    if (!gate(req, res)) return;
    const body = req.body as Record<string, string | undefined>;
    const { token, client_id: clientId, token_type_hint: hint } = body;
    // RFC 7009: always 200 (except missing params), even for unknown tokens.
    if (!token || !clientId) {
      return tokenError(res, 400, 'invalid_request', 'token and client_id required');
    }
    const tokenHash = hashToken(token);

    try {
      const outcome = await withAdminScope(
        { caller: 'oauth.revoke', reason: 'RFC 7009 revocation (pre-tenant lookup)', actor: clientId.slice(0, 24) },
        (client) => revokeTokenTx(client, { tokenHash, clientId, hint }),
      );
      if (outcome.identified && outcome.retired) {
        log.info({ event: 'oauth_revoke_retired_grant', clientId }, 'Revocation left the grant with no live refresh token — connection retired');
      }
    } catch (err) {
      log.error({ error: (err as Error).message }, 'oauth revoke failed');
      return tokenError(res, 500, 'server_error');
    }

    noStore(res);
    return res.status(200).json({});
  },
);
