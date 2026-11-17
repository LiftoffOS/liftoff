// Governance Engine proxy router
//
// Phase 3 cutover: every /api/governance/* request on platform-backend is
// forwarded verbatim to the governance-engine Cloud Run service. Mirrors
// the connector-service proxy at src/connectors/proxy.ts — same OIDC auth
// chain, same hop-by-hop filtering, same 503-on-network-failure contract.
//
// Why proxy instead of re-implement HTTP routes locally:
//   - The dashboard hits `/api/governance/approvals`, `/api/governance/actions`,
//     `/api/governance/late-feedback`, etc. Routing these through platform-
//     backend lets the browser keep its single-origin Firebase auth token
//     while we attach service-to-service credentials at the edge.
//   - Keeps governance-engine behind `--no-allow-unauthenticated` so only
//     platform-backend + tenant-runtime can reach it.
//
// Notes on implementation:
//   - Uses globalThis.fetch (Node 20+). @liftoffos/service-client wires up
//     the shared undici Agent the first time any helper is called.
//   - Response body is streamed via `Readable.fromWeb()` so we don't load
//     large payloads into memory (useful for action-ledger list endpoints).
//   - Network-level failures surface as 503 so callers can distinguish
//     "governance-engine is down" from a real 4xx/5xx.

import { Router, type Request, type Response as ExpressResponse } from 'express';
import { Readable } from 'stream';
import { buildOidcAuthHeader } from '@liftoffos/service-client';
import { log } from '../infrastructure/logging';

// Headers we never forward upstream. Hop-by-hop headers per RFC 7230 plus
// the caller's own auth — we re-mint service auth per request.
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
  // Firebase/Bearer token to governance-engine.
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
  /** Override the target base URL. Defaults to GOVERNANCE_SERVICE_URL env. */
  targetBaseUrl?: string;
  /** Override the service-auth token env var. Defaults to GOVERNANCE_SERVICE_TOKEN. */
  serviceAuthToken?: string;
  /** Swap fetch implementation (tests use a local http server + globalThis.fetch). */
  fetchImpl?: typeof fetch;
}

export function createGovernanceProxyRouter(opts: ProxyRouterOptions = {}): Router {
  const router = Router({ mergeParams: true });
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  router.use(async (req: Request, res: ExpressResponse) => {
    const targetBase = (opts.targetBaseUrl ?? process.env.GOVERNANCE_SERVICE_URL ?? '').replace(/\/$/, '');
    if (!targetBase) {
      log.error({ path: req.path }, 'governance-proxy: GOVERNANCE_SERVICE_URL is not set');
      res.status(503).json({ error: 'governance-engine not configured' });
      return;
    }

    // Express strips the mount prefix ('/api/governance') from req.url; we
    // re-prepend it so the downstream path is identical to what the dashboard
    // sent.
    const downstreamPath = `/api/governance${req.url.startsWith('/') ? req.url : `/${req.url}`}`;
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

    const serviceAuthToken = opts.serviceAuthToken ?? process.env.GOVERNANCE_SERVICE_TOKEN;
    if (serviceAuthToken) {
      outboundHeaders['X-Service-Auth'] = serviceAuthToken;
    }

    try {
      const oidc = await buildOidcAuthHeader(new URL(targetUrl).origin);
      for (const [k, v] of Object.entries(oidc)) {
        outboundHeaders[k] = v;
      }
    } catch (err) {
      // Local dev / test environments without a metadata server land here.
      // governance-engine still requires X-Service-Auth, so this is fine;
      // in production the IAM check will fail if the OIDC header is
      // genuinely missing.
      log.debug(
        { err: (err as Error).message, targetUrl },
        'governance-proxy: OIDC token build failed (ok in local/test)',
      );
    }

    // Body: methods without a body skip it entirely. Express's JSON parser
    // has already consumed the stream, so we re-serialize from req.body.
    let body: BodyInit | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      if (req.body !== undefined && req.body !== null && Object.keys(req.body).length > 0) {
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
        event: 'governance_proxy_request',
        method,
        path: downstreamPath,
        target: targetBase,
      },
      'governance-proxy: forwarding request',
    );

    let upstream: Awaited<ReturnType<typeof fetchImpl>>;
    try {
      upstream = await fetchImpl(targetUrl, {
        method,
        headers: outboundHeaders,
        body,
      });
    } catch (err) {
      log.error(
        {
          event: 'governance_proxy_network_error',
          method,
          path: downstreamPath,
          target: targetBase,
          err: (err as Error).message,
          headers: redact(outboundHeaders),
        },
        'governance-proxy: network error reaching governance-engine',
      );
      res.status(503).json({ error: 'governance-engine unreachable' });
      return;
    }

    log.info(
      {
        event: 'governance_proxy_response',
        method,
        path: downstreamPath,
        status: upstream.status,
      },
      'governance-proxy: received response',
    );

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
        { event: 'governance_proxy_stream_error', err: err.message, path: downstreamPath },
        'governance-proxy: upstream body stream error',
      );
      if (!res.headersSent) {
        res.status(502).json({ error: 'governance-engine stream error' });
      } else {
        res.end();
      }
    });
    nodeStream.pipe(res);
  });

  return router;
}

/** Default singleton router — the one `index.ts` mounts on `/api/governance`. */
export const governanceProxyRouter = createGovernanceProxyRouter();
