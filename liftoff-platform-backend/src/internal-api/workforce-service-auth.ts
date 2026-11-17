// Service-token guard for the internal routes workforce-service calls.
//
// Deliberately narrower than the LLM relay's guard, which accepts any of four
// registered service tokens: only workforce-service needs these routes, and a
// smaller accepted set is a smaller blast radius.
//
// Used by routes mounted BEFORE authMiddleware — they carry no Firebase token,
// because the caller is a service, not a person.

import crypto from 'crypto';
import type { Request, Response } from 'express';
import { log } from '../infrastructure/logging';

export function workforceServiceAuth(req: Request, res: Response, next: () => void): void {
  const provided = req.headers['x-service-auth'] as string | undefined;
  const expected = process.env['WORKFORCE_SERVICE_TOKEN'];

  if (!expected) {
    log.error({ path: req.path }, 'workforce internal route hit but WORKFORCE_SERVICE_TOKEN is not configured');
    res.status(503).json({ error: 'Not configured' });
    return;
  }
  if (!provided) {
    res.status(401).json({ error: 'Missing service authentication' });
    return;
  }

  let ok = false;
  try {
    ok =
      Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    ok = false;
  }

  if (!ok) {
    log.warn({ path: req.path }, 'workforce internal route: invalid service authentication');
    res.status(401).json({ error: 'Invalid service authentication' });
    return;
  }
  next();
}
