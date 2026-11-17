// Host-discipline middleware: hard-partitions the URL namespace between the
// platform-backend's two customer-facing hostnames.
//
//   webhooks.example.com  → ONLY POST /v1/<token>
//   api.example.com       → everything else; /v1/* is rejected
//
// Why this exists: a Cloud Run domain mapping for webhooks.example.com
// routes by host → service. Express then dispatches by path regardless of
// host. Without this middleware, mapping the new subdomain to platform-backend
// would expose every /api/* route via the new host — exactly what we want
// to avoid by putting webhooks on a dedicated subdomain in the first place.
//
// Returns 404 (not 403) so the api surface is not enumerable from the
// webhook host: a probe gets the same response whether the route doesn't
// exist or whether it's blocked.
//
// The middleware is a factory taking an explicit Set of webhook hostnames
// rather than reading process.env directly. This keeps it unit-testable
// without module-cache fights. src/index.ts is the single place that
// reads the env var.

import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Parse the comma-separated WEBHOOKS_HOST env var into a Set of lowercased
 * hostnames. Empty / unset → empty Set (middleware no-ops).
 */
export function parseWebhookHosts(raw: string | undefined): Set<string> {
  if (!raw) return new Set<string>();
  return new Set(
    raw
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
  );
}

/**
 * Builds the host-discipline middleware. Behavior:
 *  - Empty hosts set → no-op (dev / test without env config)
 *  - Request host IS a webhook host → only POST /v1/<anything> passes; else 404
 *  - Request host is NOT a webhook host → /v1/* is rejected (404); everything
 *    else falls through. Cloud Run liveness/readiness probes hit the direct
 *    *.run.app URL (not the custom domain) so they always land in this branch
 *    and continue to work.
 */
export function makeHostDisciplineMiddleware(hosts: Set<string>): RequestHandler {
  return function hostDisciplineMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (hosts.size === 0) {
      next();
      return;
    }
    const host = (req.hostname || '').toLowerCase();
    const isWebhookHost = hosts.has(host);

    if (isWebhookHost) {
      // On the webhook host, only the inbound POST is served.
      if (req.method === 'POST' && req.path.startsWith('/v1/') && req.path.length > '/v1/'.length) {
        next();
        return;
      }
      res.status(404).end();
      return;
    }

    // Non-webhook host: reject /v1/* (defensive — operators or attackers
    // probing api.example.com/v1/<token> get the same 404 as random paths).
    if (req.path.startsWith('/v1/') || req.path === '/v1') {
      res.status(404).end();
      return;
    }
    next();
  };
}
