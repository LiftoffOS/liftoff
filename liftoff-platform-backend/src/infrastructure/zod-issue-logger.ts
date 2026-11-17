// WS-A1 — captureZodIssueResponses
//
// Internal endpoints (notificationsInternalRouter, knowledgeInternalRouter,
// etc.) reject malformed bodies with:
//   res.status(400).json({ error: 'invalid body', issues: parsed.error.issues })
// The `issues` array goes into the response body, which Cloud Logging does
// NOT capture — so when tenant-runtime callers see HTTP 400 we can't tell
// WHICH field failed validation.
//
// This middleware wraps res.json on intercepted paths. When the handler
// answers 4xx with an `issues` field, we emit a structured log line carrying
// the array (capped to 50 entries) + path/method/status/tenant hint.
//
// Mount AFTER body-parser and BEFORE the route handlers being wrapped.

import type { Request, Response, NextFunction } from 'express';
import { log } from './logging';

export function captureZodIssueResponses(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const originalJson = res.json.bind(res);
  res.json = function (body: unknown): Response {
    // Routes disagree on the field name: the internal endpoints answer with
    // `issues`, while internal-agents answers `{ error: 'Validation failed',
    // details: [...] }`. Only `issues` was recognised, so a rejected team
    // create logged nothing at all and the response — the only place the failing
    // field was named — went to the browser and nowhere else. Diagnosing one
    // meant guessing which field the payload had violated.
    const zodArray = ((): unknown[] | null => {
      if (res.statusCode < 400 || res.statusCode >= 500) return null;
      if (!body || typeof body !== 'object') return null;
      const rec = body as Record<string, unknown>;
      if (Array.isArray(rec.issues)) return rec.issues;
      if (Array.isArray(rec.details)) return rec.details;
      return null;
    })();
    if (zodArray) {
      // Cap issues array at 50 entries to bound log size — practically
      // every real zod rejection has <5 issues but a malicious caller could
      // construct a deeply-nested body that produces many.
      const issues = zodArray.slice(0, 50);
      const tenantIdHint =
        (req.body && typeof req.body === 'object' && 'tenantId' in req.body
          ? ((req.body as { tenantId?: unknown }).tenantId as string | null | undefined)
          : null) ?? null;
      const requestBodySize = (() => {
        try {
          return JSON.stringify(req.body ?? {}).length;
        } catch {
          return -1;
        }
      })();

      // WS-A1 diagnostic extension (post-deploy): the first batch of zod-400s
      // post-ADR-024 ALL showed request_body_size=2 (empty req.body) despite
      // wire reqSize being 3-3.6 KB. That points at body-parser not seeing
      // the body — probably a Content-Type mismatch or a downstream middleware
      // consuming the stream. Log Content-Type + a short safe sample of any
      // raw stringified body the route may have stashed on the request, so we
      // can correlate without re-deploying.
      const contentType = req.headers['content-type'] ?? null;
      const transferEncoding = req.headers['transfer-encoding'] ?? null;
      const userAgent = req.headers['user-agent'] ?? null;
      const contentLength = req.headers['content-length'] ?? null;
      const bodyTypeof = typeof req.body;
      const bodyKeys = req.body && typeof req.body === 'object'
        ? Object.keys(req.body as object).slice(0, 20)
        : null;

      log.warn(
        {
          event: 'internal_endpoint_zod_400',
          path: req.path,
          method: req.method,
          status: res.statusCode,
          issues,
          tenant_id_hint: tenantIdHint,
          request_body_size: requestBodySize,
          // diagnostic
          content_type: contentType,
          transfer_encoding: transferEncoding,
          user_agent: userAgent,
          content_length: contentLength,
          body_typeof: bodyTypeof,
          body_keys: bodyKeys,
        },
        'internal endpoint rejected request with zod issues',
      );
    }
    return originalJson(body);
  };
  next();
}
