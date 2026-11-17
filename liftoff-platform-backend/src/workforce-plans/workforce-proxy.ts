// Workforce Service proxy
//
// Follows the same pattern as src/billing/billing-proxy.ts: WORKFORCE_SERVICE_URL is resolved lazily
// inside each request handler, never at module load time. This lets the
// process start cleanly in environments where the service is not yet
// deployed (returns 503 on those routes instead of crashing on startup).
//
// Auth forwarding:
//   - Forwards: x-tenant-id, x-account-id, x-tenant-role (set by auth middleware),
//     x-caller-name (the person's name, for the Chief AI Officer's prompt and
//     for a colleague it brings in), content-type, x-correlation-id, traceparent
//   - Strips: authorization, x-service-auth (re-minted per request)
//
// Path reconstruction:
//   workforce-service routes are registered WITHOUT the /api prefix
//   (e.g. /workforce-plans/:id, /team-plan/threads). Strip the leading /api
//   segment from req.originalUrl before forwarding.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { log } from '../infrastructure/logging';
import { AccountService } from '../accounts/service';
import { accountDisplayName } from '../accounts/display-name';
import { tenantMembersService } from '../tenant-members/service';
import { callerNameHeader } from './team-plan-thread-client';
import { canConverseWithAgents } from '../common/agent-conversation-gate';

/** Methods that only read, so a view-only seat keeps them. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Re-minted per request — never propagate the caller's Firebase token
  'authorization',
  'x-service-auth',
  // Set from the authenticated account below, never taken from the client: a
  // name is what a colleague attributes the message to.
  'x-caller-name',
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Already decoded by undici; re-sending would mislead clients
  'content-encoding',
  'content-length',
]);

export function createWorkforceProxyRouter(opts: { targetBaseUrl?: string } = {}): Router {
  const router = Router();

  router.all('*', async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const targetBase = (opts.targetBaseUrl ?? process.env['WORKFORCE_SERVICE_URL'] ?? '').replace(/\/$/, '');
    if (!targetBase) {
      log.error({ path: req.path }, 'workforce-proxy: WORKFORCE_SERVICE_URL not configured');
      res.status(503).json({ error: 'WORKFORCE_SERVICE_NOT_CONFIGURED' });
      return;
    }

    const targetUrl = `${targetBase}${req.originalUrl.replace(/^\/api/, '')}`;
    const method = req.method.toUpperCase();

    // Build outbound headers — start from inbound minus hop-by-hop
    const outboundHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const lname = name.toLowerCase();
      if (HOP_BY_HOP_REQUEST_HEADERS.has(lname)) continue;
      if (Array.isArray(value)) {
        outboundHeaders[name] = value.join(', ');
      } else if (typeof value === 'string') {
        outboundHeaders[name] = value;
      }
    }

    // Attach X-Service-Auth if configured
    const serviceAuthToken = process.env['WORKFORCE_SERVICE_TOKEN'];
    if (serviceAuthToken) {
      outboundHeaders['X-Service-Auth'] = serviceAuthToken;
    }

    // Attach OIDC bearer for Cloud Run IAM.
    // Audience must be the base service URL (no path/query). Cloud Run validates
    // that the aud claim in the token exactly matches the service URL. billing-proxy
    // uses ServiceClient, which passes baseUrl — match that here.
    try {
      const oidc = await buildOidcAuthHeader(targetBase);
      for (const [k, v] of Object.entries(oidc)) {
        outboundHeaders[k] = v;
      }
    } catch (err) {
      // Normal in local/test environments without a GCP metadata server.
      log.debug(
        { err: (err as Error).message, targetBase },
        'workforce-proxy: OIDC token build failed (ok in local/test)',
      );
    }

    // Inject trusted auth headers for workforce-service's resolveCallerFromHeaders().
    // authMiddleware has already verified the Firebase token; we translate to the
    // platform account ID and tenant membership here so the downstream service
    // never needs to re-verify the Firebase token.
    if (req.user) {
      try {
        const accountService = new AccountService();
        const account = await accountService.getByFirebaseUid(req.user.uid);
        if (account) {
          outboundHeaders['x-account-id'] = account.id;
          // The person's name, as Liftoff's and the Insights Manager's turns
          // already carry it: the Chief AI Officer's prompt names the caller,
          // and a colleague it brings in attributes the message to them.
          Object.assign(outboundHeaders, callerNameHeader(accountDisplayName(account)));
          const tenantId =
            (req.query as Record<string, string>)['tenantId'] ??
            (req.body as Record<string, string> | undefined)?.['tenantId'];
          if (tenantId) {
            outboundHeaders['x-tenant-id'] = tenantId;
            const membership = await tenantMembersService.getMembership(tenantId, account.id);
            if (membership) {
              outboundHeaders['x-tenant-role'] = membership.role;
              // A view-only seat does not converse with the Chief AI Officer, and
              // the refusal belongs on this side: forwarding the role only asks
              // the other service to decide, and a request that never leaves
              // cannot be decided wrongly. Reads pass — this is the same line the
              // dashboard's own chat surfaces draw.
              if (!SAFE_METHODS.has(req.method.toUpperCase())
                && !canConverseWithAgents(membership.role)) {
                res.status(403).json({
                  error: 'FORBIDDEN',
                  message: 'Your access to this workspace is view only, so you cannot send a message to the Chief AI Officer. Ask an owner or an admin of the workspace if you need to.',
                });
                return;
              }
            }
          }
        }
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'workforce-proxy: auth header injection failed');
      }
    }

    // Body: re-serialize from req.body (express.json already consumed the stream)
    let body: BodyInit | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      if (req.body !== undefined && req.body !== null && Object.keys(req.body as object).length > 0) {
        body = JSON.stringify(req.body);
        if (!outboundHeaders['content-type']) {
          outboundHeaders['content-type'] = 'application/json';
        }
      } else if (typeof req.body === 'string' && (req.body as string).length > 0) {
        body = req.body as string;
      }
    }

    log.info(
      { event: 'workforce_proxy_request', method, path: req.originalUrl, target: targetBase },
      'workforce-proxy: forwarding request',
    );

    let upstream: globalThis.Response;
    try {
      upstream = await globalThis.fetch(targetUrl, { method, headers: outboundHeaders, body });
    } catch (err) {
      log.error(
        {
          event: 'workforce_proxy_network_error',
          method,
          path: req.originalUrl,
          target: targetBase,
          err: (err as Error).message,
        },
        'workforce-proxy: network error reaching liftoff-workforce-service',
      );
      res.status(502).json({ error: 'WORKFORCE_SERVICE_UNAVAILABLE' });
      return;
    }

    log.info(
      { event: 'workforce_proxy_response', method, path: req.originalUrl, status: upstream.status },
      'workforce-proxy: received response',
    );

    res.status(upstream.status);
    upstream.headers.forEach((value, name) => {
      if (HOP_BY_HOP_RESPONSE_HEADERS.has(name.toLowerCase())) return;
      res.setHeader(name, value);
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.on('error', (err: Error) => {
      log.error(
        { event: 'workforce_proxy_stream_error', err: err.message, path: req.originalUrl },
        'workforce-proxy: upstream body stream error',
      );
      if (!res.headersSent) {
        res.status(502).json({ error: 'WORKFORCE_SERVICE_UNAVAILABLE' });
      } else {
        res.end();
      }
    });
    nodeStream.pipe(res);
  });

  return router;
}
