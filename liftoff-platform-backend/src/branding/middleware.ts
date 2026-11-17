// Branding response middleware.
//
// Wraps res.json on customer-facing GET routers so every response goes
// through the brand translator. Admin and service-token callers can opt out
// via ?raw=true. Admin opt-outs are audit-logged fire-and-forget so the
// response stays synchronous.
//
// Requires attachAdminStatus to have run upstream so req.isPlatformAdmin is
// resolved synchronously.

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { liftoffifyJsonValue, REBRAND_VERSION } from './registry';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

/** Returns whether the current request should bypass brand translation. */
export function shouldServeRaw(req: Request): {
  raw: boolean;
  reason: 'staff' | 'service' | null;
} {
  if (req.query.raw !== 'true') return { raw: false, reason: null };

  const serviceAuth = req.headers['x-service-auth'] as string | undefined;
  const expected = process.env.TENANT_RUNTIME_SERVICE_TOKEN ?? '';
  if (serviceAuth && timingSafeEqualStr(serviceAuth, expected)) {
    return { raw: true, reason: 'service' };
  }

  if (req.isPlatformAdmin === true) {
    return { raw: true, reason: 'staff' };
  }

  return { raw: false, reason: null };
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/** Wraps res.json so every response from downstream handlers goes through
 *  the brand translator, subject to the ?raw=true opt-out. */
export function brandingResponseMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const originalJson = res.json.bind(res);
  res.json = function (body: unknown): Response {
    const { raw, reason } = shouldServeRaw(req);
    if (raw) {
      if (reason === 'staff' && req.adminAccountId) {
        recordRawAccess(req.adminAccountId, req).catch((err) =>
          log.warn(
            { err: (err as Error).message },
            'admin_action_audit write for audit.raw_access failed',
          ),
        );
      }
      return originalJson(body);
    }
    const translated = liftoffifyJsonValue(body);
    const out =
      translated && typeof translated === 'object' && !Array.isArray(translated)
        ? { ...(translated as Record<string, unknown>), _rebrandVersion: REBRAND_VERSION }
        : translated;
    return originalJson(out);
  };
  next();
}

async function recordRawAccess(adminId: string, req: Request): Promise<void> {
  const pool = getPool();
  const ipAddress = req.headers['x-forwarded-for']
    ? (req.headers['x-forwarded-for'] as string).split(',')[0].trim()
    : req.socket?.remoteAddress || null;
  const userAgent = (req.headers['user-agent'] as string) || null;

  await pool.query(
    `INSERT INTO admin_action_audit (admin_id, action, target_type, target_id, details, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6::inet, $7)`,
    [
      adminId,
      'audit.raw_access',
      'response',
      null,
      JSON.stringify({ path: req.originalUrl }),
      ipAddress,
      userAgent,
    ],
  );
}
