// Claude Code Proxy forward router.
//
// Forwards the runtime hot path `/proxy/*` (Claude Code → Anthropic) to the
// private liftoff-developer-proxy Cloud Run service. developer-proxy is
// `--no-allow-unauthenticated` and reachable only via platform-backend's SA, so
// this router is the sole ingress for the BYOK proxy (INV-DP-007). It reuses:
//   - `pipeToDeveloperProxy` — attaches the OIDC bearer for Cloud Run IAM and
//     forwards the `liftoff_sk_*` key (`x-api-key`) plus `anthropic-*` /
//     `x-claude-code-session-id` headers.
//   - `originGuard` — blocks browser-originated (CSRF) requests via `Origin`.
// It streams the response verbatim (Readable.fromWeb → pipe), mirroring the
// connector proxy in src/connectors/proxy.ts; it does NOT interpret payloads.

import express, { Router, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { log } from '../infrastructure/logging';
import { originGuard } from './proxy-auth';
import { isDevProxyEnabled, pipeToDeveloperProxy } from './developer-proxy-client';

// Hop-by-hop response headers we never surface downstream (RFC 7230).
// `content-encoding`/`content-length` are already resolved by undici fetch;
// re-sending them would mislead the client.
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

function anthropicError(res: Response, status: number, type: string, message: string): void {
  res.status(status).json({
    type: 'error',
    error: { type, message },
  });
}

export function createProxyForwardRouter(): Router {
  const router = Router();

  // Capture the Anthropic request body byte-exact before the app-level
  // express.json() can consume it (this router is mounted before it).
  router.use(express.raw({ type: '*/*', limit: '20mb' }));

  // Reject browser-originated requests (CSRF) — Claude Code sends no Origin.
  router.use(originGuard);

  router.all('*', async (req: Request, res: Response) => {
    // Same "not configured" gate the management router uses (router.ts). The
    // DEVELOPER_PROXY_SERVICE_URL env var stays encapsulated in
    // developer-proxy-client.ts; if it is somehow unset while enabled,
    // pipeToDeveloperProxy throws and the catch below returns 502.
    if (!isDevProxyEnabled()) {
      anthropicError(res, 503, 'api_error', 'Developer proxy is not configured');
      return;
    }

    const body = Buffer.isBuffer(req.body) ? req.body : undefined;

    let upstream: globalThis.Response;
    try {
      upstream = await pipeToDeveloperProxy(req.method, req.url, req.headers, body);
    } catch (err) {
      log.error(
        { event: 'proxy_forward_fetch_error', err: (err as Error).message, path: req.url },
        'proxy-forward: failed to reach developer-proxy',
      );
      anthropicError(res, 502, 'api_error', 'Failed to reach developer proxy');
      return;
    }

    // Copy status + response headers (minus hop-by-hop), then stream the body.
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
        { event: 'proxy_forward_stream_error', err: err.message, path: req.url },
        'proxy-forward: developer-proxy body stream error',
      );
      if (!res.headersSent) {
        anthropicError(res, 502, 'api_error', 'Developer proxy stream error');
      } else {
        res.end();
      }
    });
    nodeStream.pipe(res);
  });

  return router;
}

/** Default singleton router — the one `index.ts` mounts on `/proxy`. */
export const proxyForwardRouter = createProxyForwardRouter();
