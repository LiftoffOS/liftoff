// Connector proxy router
//
// Phase 2a cutover: every /api/connectors/* request on platform-backend is
// forwarded verbatim to connector-service. This router owns the auth chain
// (OIDC bearer for Cloud Run IAM + X-Service-Auth shared token) and the
// request/response streaming; it does NOT interpret payloads.
//
// Notes on implementation:
//   - Uses globalThis.fetch (Node 20+) on the process's default dispatcher.
//     @liftoffos/service-client no longer installs a global Agent (0.2.0
//     keeps its keep-alive Agent to its own requests), so importing
//     `buildOidcAuthHeader` from it has no transport side effect.
//   - Response body is streamed via `Readable.fromWeb()` so we don't load
//     large payloads into memory.
//   - Network-level failures (ENOTFOUND, ECONNREFUSED, etc.) surface as a
//     503 with a stable JSON shape; callers can distinguish "connector-
//     service is down" from a real 4xx/5xx returned by the service.

import { Router, type Request, type Response as ExpressResponse } from 'express';
import { Readable } from 'stream';
import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { log } from '../infrastructure/logging';

// Headers we never forward upstream. 'host' would point at the wrong origin
// and confuse Cloud Run routing; 'content-length' is re-computed by fetch;
// hop-by-hop headers per RFC 7230 must not be proxied.
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
  // Our own auth is attached per-request — never propagate the caller's
  // Firebase/Bearer token to connector-service.
  'authorization',
  'x-service-auth',
]);

// Headers we never surface downstream (hop-by-hop on the response side).
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Content-encoding is already decoded by undici fetch; re-sending the
  // header would mislead clients.
  'content-encoding',
  'content-length',
]);

function redact<T extends Record<string, unknown>>(headers: T): T {
  const out = { ...headers } as Record<string, unknown>;
  for (const name of ['authorization', 'x-service-auth', 'cookie', 'set-cookie']) {
    if (name in out) out[name] = '[REDACTED]';
  }
  return out as T;
}

export interface ProxyRouterOptions {
  /** Override the target base URL. Defaults to CONNECTOR_SERVICE_URL env. */
  targetBaseUrl?: string;
  /** Override the service-auth token env var. Defaults to CONNECTOR_SERVICE_TOKEN. */
  serviceAuthToken?: string;
  /** Swap fetch implementation (tests use a local http server + globalThis.fetch). */
  fetchImpl?: typeof fetch;
}

export function createConnectorsProxyRouter(opts: ProxyRouterOptions = {}): Router {
  const router = Router({ mergeParams: true });
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  router.use(async (req: Request, res: ExpressResponse) => {
    const targetBase = (opts.targetBaseUrl ?? process.env.CONNECTOR_SERVICE_URL ?? '').replace(/\/$/, '');
    if (!targetBase) {
      log.error({ path: req.path }, 'connector-proxy: CONNECTOR_SERVICE_URL is not set');
      res.status(503).json({ error: 'connector-service not configured' });
      return;
    }

    // Express strips the mount prefix ('/api/connectors') from req.url; we
    // re-prepend it so the downstream path is identical.
    const downstreamPath = `/api/connectors${req.url.startsWith('/') ? req.url : `/${req.url}`}`;
    const targetUrl = `${targetBase}${downstreamPath}`;
    const method = req.method.toUpperCase();

    // Build headers: start from inbound (minus hop-by-hop), then attach
    // X-Service-Auth + OIDC bearer for the target URL.
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

    const serviceAuthToken = opts.serviceAuthToken ?? process.env.CONNECTOR_SERVICE_TOKEN;
    if (serviceAuthToken) {
      outboundHeaders['X-Service-Auth'] = serviceAuthToken;
    }

    // connector-service identifies the acting user via x-account-id rather than
    // a Firebase token (it has no Firebase dependency). authMiddleware already
    // verified the Firebase token and populated req.user.uid, so we forward it
    // here. Without this, OAuth start and API-key connect return 401.
    if (req.user?.uid) {
      outboundHeaders['x-account-id'] = req.user.uid;
    }

    // Everything this proxy forwards originated from a person's browser —
    // platform code calls connector-service directly, never through here — so
    // every proxied request is marked as the user-facing catalog view.
    // connector-service filters 'internal'-status connectors out of that view
    // server-side. Set AFTER the inbound copy so a client-supplied value can
    // never widen the view.
    outboundHeaders['x-catalog-view'] = 'user';

    try {
      const oidc = await buildOidcAuthHeader(new URL(targetUrl).origin);
      for (const [k, v] of Object.entries(oidc)) {
        outboundHeaders[k] = v;
      }
    } catch (err) {
      // Local dev / test environments without a metadata server land here.
      // connector-service still requires X-Service-Auth, so this is fine;
      // in production the IAM check will fail if the OIDC header is
      // genuinely missing.
      log.debug(
        { err: (err as Error).message, targetUrl },
        'connector-proxy: OIDC token build failed (ok in local/test)',
      );
    }

    // Body: methods without a body skip it entirely. Express's JSON parser
    // has already consumed the stream, so we re-serialize from req.body.
    let body: BodyInit | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      // A Buffer means an upstream route mounted express.raw() because the
      // BYTES matter — an HMAC-signed webhook. Forward them verbatim and first:
      // re-serializing produces a different digest, and the branch below would
      // do exactly that, because Object.keys() on a Buffer returns its indices
      // and so matches. GitHub's installation webhook is signed this way, and a
      // rejected delivery there means a pending install that never resolves.
      if (Buffer.isBuffer(req.body)) {
        // Copied into a fresh Uint8Array view rather than passed as a Buffer:
        // BodyInit accepts a typed array, and a Buffer's ArrayBuffer may be a
        // slice of a larger pooled allocation, so handing the raw buffer over
        // can send bytes that were never part of this request.
        body = new Uint8Array(req.body);
      } else if (req.body !== undefined && req.body !== null && Object.keys(req.body).length > 0) {
        body = JSON.stringify(req.body);
        if (!outboundHeaders['content-type']) {
          outboundHeaders['content-type'] = 'application/json';
        }
      } else if (typeof req.body === 'string' && req.body.length > 0) {
        body = req.body;
      }
    }

    log.info(
      {
        event: 'connector_proxy_request',
        method,
        path: downstreamPath,
        target: targetBase,
      },
      'connector-proxy: forwarding request',
    );

    let upstream: Awaited<ReturnType<typeof fetchImpl>>;
    try {
      upstream = await fetchImpl(targetUrl, {
        method,
        headers: outboundHeaders,
        body,
        redirect: 'manual',
      });
    } catch (err) {
      log.error(
        {
          event: 'connector_proxy_network_error',
          method,
          path: downstreamPath,
          target: targetBase,
          err: (err as Error).message,
          headers: redact(outboundHeaders),
        },
        'connector-proxy: network error reaching connector-service',
      );
      res.status(503).json({ error: 'connector-service unreachable' });
      return;
    }

    log.info(
      {
        event: 'connector_proxy_response',
        method,
        path: downstreamPath,
        status: upstream.status,
      },
      'connector-proxy: received response',
    );

    if (upstream.status >= 301 && upstream.status <= 308) {
      const location = upstream.headers.get('location');
      if (location) {
        log.info(
          { event: 'connector_proxy_redirect', path: downstreamPath, location, status: upstream.status },
          'connector-proxy: forwarding redirect to browser',
        );
        res.redirect(upstream.status, location);
        return;
      }
    }

    // Copy status + headers (minus hop-by-hop).
    res.status(upstream.status);
    upstream.headers.forEach((value, name) => {
      if (HOP_BY_HOP_RESPONSE_HEADERS.has(name.toLowerCase())) return;
      res.setHeader(name, value);
    });

    // Stream the body. Undici's fetch returns a WHATWG ReadableStream; we
    // convert to Node Readable and pipe. If the upstream has no body
    // (204 / HEAD / empty), end immediately.
    if (!upstream.body) {
      res.end();
      return;
    }
    const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.on('error', (err: Error) => {
      log.error(
        { event: 'connector_proxy_stream_error', err: err.message, path: downstreamPath },
        'connector-proxy: upstream body stream error',
      );
      if (!res.headersSent) {
        res.status(502).json({ error: 'connector-service stream error' });
      } else {
        res.end();
      }
    });
    nodeStream.pipe(res);
  });

  return router;
}

/** Default singleton router — the one `index.ts` mounts on `/api/connectors`. */
export const proxyRouter = createConnectorsProxyRouter();
