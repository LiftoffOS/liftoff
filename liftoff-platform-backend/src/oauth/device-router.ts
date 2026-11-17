// OAuth 2.0 device authorization grant, RFC 8628 (migration 485).
//
//   POST /oauth/device_authorization — the tool asks for a device code (its
//   secret, polled with) and a user code (what the person types). The
//   person opens <site>/activate on any device, and the token endpoint's
//   device grant (authorization-server-router.ts) hands the tool its tokens
//   once they have approved.
//
// This is the front door for a coding tool that cannot reach a browser on
// its own machine: a container, a remote host, a tool driven from a phone.
// The authorization code flow assumes the tool and the browser share
// localhost, and its consent page ends by navigating to a loopback redirect
// that such a tool never sees. Here nothing is redirected: the tool polls.
//
// Mounted at the app root like the authorization server (index.ts), before
// CORS and the JSON parser, with the same release flag and canonical-host
// guard. No CORS on purpose: the callers are CLIs and agents, never browsers.

import crypto from 'crypto';
import express, { Router, Request, Response } from 'express';
import { pool } from '../infrastructure/database';
import { hashToken } from '../tenant-members/tokens';
import { log } from '../infrastructure/logging';
import { getBackendUrl } from '../infrastructure/control-plane-url';
import { enforceCanonicalPublicHost } from './canonical-host';
import { isMcpOauthEnabled, isCanonicalMcpResource, canonicalMcpResource } from './metadata-router';
import { deviceAuthorizationRateLimit } from './rate-limiter';
import { resolveRegisteredClient } from './authorization-server-router';
import { usesDeviceGrant } from './client-grants';
import { skillSiteOrigin } from './skill-document';

export const oauthDeviceRouter = Router();
oauthDeviceRouter.use('/oauth', enforceCanonicalPublicHost);

/** Both codes live this long; the tool is told so as expires_in. */
export const DEVICE_CODE_TTL_SECONDS = 600;
/** The minimum gap between two polls, told to the tool as interval. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

// RFC 8628 §6.1: a short code from an alphabet without vowels or look-alikes,
// so no code reads as a word and 0/O, 1/I never collide. 20^8 codes.
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
const USER_CODE_LENGTH = 8;

export function mintUserCode(): string {
  const bytes = crypto.randomBytes(USER_CODE_LENGTH);
  let letters = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) letters += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

/** The page's address, on the site domain: what the tool shows the person. */
export function verificationUri(): string {
  return `${skillSiteOrigin()}/activate`;
}

function deviceError(res: Response, status: number, error: string, description?: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json({ error, ...(description ? { error_description: description } : {}) });
}

oauthDeviceRouter.post(
  '/oauth/device_authorization',
  express.urlencoded({ extended: false, limit: '10kb' }),
  deviceAuthorizationRateLimit,
  async (req: Request, res: Response) => {
    if (!isMcpOauthEnabled()) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = req.body as Record<string, string | undefined>;
    const clientId = body.client_id ?? '';
    if (!clientId) return deviceError(res, 400, 'invalid_request', 'client_id required');

    let client;
    try {
      client = await resolveRegisteredClient(clientId);
    } catch (err) {
      log.error({ error: (err as Error).message }, 'oauth device_authorization client lookup failed');
      return deviceError(res, 500, 'server_error');
    }
    if (!client) return deviceError(res, 400, 'invalid_client', 'unknown client_id');
    // A client is registered for the grants it negotiated; one registered
    // before the device grant existed re-registers (DCR is one request).
    if (!usesDeviceGrant(client.grant_types)) {
      return deviceError(res, 400, 'unauthorized_client', 'client is not registered for the device grant; register with grant_types including urn:ietf:params:oauth:grant-type:device_code');
    }

    const scopes = (body.scope ?? 'mcp').split(' ').filter(Boolean);
    if (scopes.some((s) => s !== 'mcp')) {
      return deviceError(res, 400, 'invalid_scope', 'only the "mcp" scope is supported');
    }
    // RFC 8707 resource: one resource here, so an omitted one is that one.
    const resource = body.resource ?? canonicalMcpResource();
    if (!isCanonicalMcpResource(resource)) {
      return deviceError(res, 400, 'invalid_target', `resource must be ${getBackendUrl()}/mcp`);
    }

    const deviceCodeRaw = `liftoff_dc_${crypto.randomBytes(32).toString('base64url')}`;
    const deviceCodeHash = hashToken(deviceCodeRaw);
    let userCode = '';
    let inserted = 0;
    try {
      // The user code must be unique among pending codes (the partial unique
      // index). A collision is a 1 in 20^8 event per live code; retry a few
      // times rather than fail the request on one.
      //
      // The row is inserted off the client row held FOR SHARE for this one
      // statement (tier 1 of the lock discipline in grant-lifecycle.ts), so
      // a deprovisioning DELETE and this insert never overlap: a client
      // deleted since the lookup above inserts nothing, and the name the
      // code carries is the one on the row.
      for (let attempt = 0; attempt < 5; attempt++) {
        userCode = mintUserCode();
        try {
          const r = await pool.query(
            `INSERT INTO oauth_device_codes
               (device_code_hash, user_code, client_id, client_name, scope, resource, interval_seconds, expires_at)
             SELECT $1, $2, c.client_id, c.client_name, 'mcp', $4, $5, NOW() + ($6::int * INTERVAL '1 second')
             FROM oauth_clients c WHERE c.client_id = $3 AND c.deleted_at IS NULL FOR SHARE`,
            [deviceCodeHash, userCode, clientId, resource, DEVICE_POLL_INTERVAL_SECONDS, DEVICE_CODE_TTL_SECONDS],
          );
          inserted = r.rowCount ?? 0;
          break;
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === '23505' && attempt < 4) continue;
          throw err;
        }
      }
    } catch (err) {
      log.error({ error: (err as Error).message, clientId }, 'oauth device_authorization insert failed');
      return deviceError(res, 500, 'server_error');
    }
    if (inserted === 0) return deviceError(res, 400, 'invalid_client', 'unknown client_id');

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      device_code: deviceCodeRaw,
      user_code: userCode,
      verification_uri: verificationUri(),
      verification_uri_complete: `${verificationUri()}?code=${encodeURIComponent(userCode)}`,
      expires_in: DEVICE_CODE_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    });
  },
);
