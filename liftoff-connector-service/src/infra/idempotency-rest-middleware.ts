// Express/REST counterpart to the Connect-RPC interceptor — applied to
// `POST /api/connectors/oauth/:connectorType/start` where HRBP kicks
// off an OAuth grant and may retry after crash.

import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { hashCanonicalJson, lookupIdempotency, storeIdempotency } from './idempotency.js';

export interface IdempotencyRestOptions {
  /** Stable RPC/endpoint identifier, e.g. `POST /api/connectors/oauth/:type/start`. */
  endpoint: string;
  extractTenantId?: (req: Request) => string | null;
  extractUserId?: (req: Request) => string | null;
}

export function withIdempotencyRest(options: IdempotencyRestOptions) {
  return async function middleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const raw = req.headers['idempotency-key'];
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || typeof key !== 'string') return next();

    const tenantId = (options.extractTenantId ?? defaultTenant)(req);
    if (!tenantId) {
      res.status(400).json({ error: 'idempotency_requires_tenant' });
      return;
    }
    const userId = (options.extractUserId ?? defaultUser)(req);
    const requestHash = hashCanonicalJson(req.body);

    const lookup = await lookupIdempotency({
      tenantId,
      userId,
      rpcName: options.endpoint,
      key,
      requestHash,
    });

    if (lookup.hit === 'conflict') {
      res.status(422).json({
        error: 'idempotency_key_conflict',
        message: 'Same Idempotency-Key used with a different request body',
      });
      return;
    }
    if (lookup.hit === 'match') {
      if (lookup.responseHeaders) {
        for (const [k, v] of Object.entries(lookup.responseHeaders)) res.setHeader(k, v);
      }
      res.setHeader('x-idempotent-replay', 'true');
      res.status(lookup.responseStatus ?? 200).json(lookup.responseBody ?? null);
      return;
    }

    // Miss → capture response + store after handler completes.
    const captured: { status?: number; body?: unknown; headers: Record<string, string> } = {
      headers: {},
    };
    const origStatus = res.status.bind(res);
    res.status = (code: number) => {
      captured.status = code;
      return origStatus(code);
    };
    const origJson = res.json.bind(res);
    res.json = (body: unknown) => {
      captured.body = body;
      const hdrs = res.getHeaders();
      for (const [k, v] of Object.entries(hdrs)) {
        if (typeof v === 'string') captured.headers[k] = v;
      }
      return origJson(body);
    };

    res.on('finish', () => {
      const status = captured.status ?? 200;
      if (status >= 500) return;
      void storeIdempotency({
        tenantId,
        userId,
        rpcName: options.endpoint,
        key,
        requestHash,
        responseStatus: status,
        responseBody: captured.body ?? null,
        responseHeaders: captured.headers,
      });
    });
    next();
  };
}

function defaultTenant(req: Request): string | null {
  const ctx = (req as Request & { ctx?: { tenantId?: string } }).ctx;
  return ctx?.tenantId ?? null;
}

function defaultUser(req: Request): string | null {
  const ctx = (req as Request & { ctx?: { userId?: string } }).ctx;
  const headerUser = req.headers['x-account-id'];
  return ctx?.userId ?? (typeof headerUser === 'string' ? headerUser : null);
}
// Re-export for symmetry with infra/idempotency.ts consumers.
export { createHash as _sha256 };
