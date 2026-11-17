// Shared service-auth helper for internal endpoints that authenticate via the
// PLATFORM_CALLBACK_TOKEN shared secret in the X-Service-Auth header.
// Used by:
//   • src/jobs/annual-plan-allocation-reset.ts
//   • src/notifications/router.ts
//
// Cross-service callers (Cloud Scheduler, governance-engine, tenant-runtime)
// pass the same shared secret. Timing-safe compare prevents byte-by-byte
// secret extraction.

import * as crypto from 'crypto';
import type { Request, Response } from 'express';

export function validateServiceAuth(req: Request, res: Response): boolean {
  const serviceToken = req.headers['x-service-auth'] as string | undefined;
  const expectedToken = process.env.PLATFORM_CALLBACK_TOKEN;

  if (!expectedToken) {
    res.status(500).json({ error: 'Service authentication not configured' });
    return false;
  }

  const isValid =
    serviceToken &&
    Buffer.byteLength(serviceToken) === Buffer.byteLength(expectedToken) &&
    crypto.timingSafeEqual(Buffer.from(serviceToken), Buffer.from(expectedToken));

  if (!isValid) {
    res.status(401).json({ error: 'Invalid service authentication' });
    return false;
  }

  return true;
}
