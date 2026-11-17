import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';

export interface VerifyServiceAuthOptions {
  /** Env var name holding the expected shared bearer token. Default: TENANT_RUNTIME_SERVICE_TOKEN. */
  tokenEnvVar?: string;
}

/**
 * Express middleware that verifies a shared bearer token passed in the
 * X-Service-Auth header. Constant-time comparison protects against timing
 * attacks. Used by internal routers that other Liftoff services call.
 *
 * Returns 500 if the token is not configured, 401 if missing or invalid.
 */
export function verifyServiceAuth(options: VerifyServiceAuthOptions = {}) {
  const tokenEnvVar = options.tokenEnvVar ?? 'TENANT_RUNTIME_SERVICE_TOKEN';

  return function verifyServiceAuthMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const expectedToken = process.env[tokenEnvVar];
    if (!expectedToken) {
      res.status(500).json({ error: 'Service auth not configured' });
      return;
    }

    const providedToken = req.headers['x-service-auth'];
    if (typeof providedToken !== 'string' || providedToken.length === 0) {
      res.status(401).json({ error: 'Missing X-Service-Auth header' });
      return;
    }

    const expected = Buffer.from(expectedToken);
    const provided = Buffer.from(providedToken);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      res.status(401).json({ error: 'Invalid service token' });
      return;
    }

    next();
  };
}
