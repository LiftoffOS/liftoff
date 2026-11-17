// Non-blocking admin-status middleware.
//
// authMiddleware only attaches req.user from the Firebase token; it never
// looks up accounts.is_platform_admin. adminAuthMiddleware does, but 403s
// non-admins — exactly what the redaction plan must avoid (the ?raw=true
// flag is silently ignored for non-admin callers).
//
// attachAdminStatus runs after authMiddleware on routers that need to know
// admin status but must NOT reject non-admins. It sets req.isPlatformAdmin
// to a boolean. Errors degrade to false; never blocks the request.

import { Request, Response, NextFunction } from 'express';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

declare module 'express-serve-static-core' {
  interface Request {
    isPlatformAdmin?: boolean;
    adminAccountId?: string | null;
  }
}

export async function attachAdminStatus(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  req.isPlatformAdmin = false;
  req.adminAccountId = null;

  const uid = req.user?.uid;
  if (!uid) {
    return next();
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT id, is_platform_admin FROM accounts WHERE firebase_uid = $1`,
      [uid],
    );
    if (result.rows[0]?.is_platform_admin === true) {
      req.isPlatformAdmin = true;
      req.adminAccountId = result.rows[0].id as string;
    }
  } catch (err) {
    log.warn(
      { err: (err as Error).message, uid },
      'attachAdminStatus: lookup failed; defaulting non-admin',
    );
  }

  next();
}
