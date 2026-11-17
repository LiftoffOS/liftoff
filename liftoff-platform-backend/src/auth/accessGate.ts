// Access Gate Middleware
// Per implementation plan 1c: backend enforcement of domain-based access control
// Blocks non-granted users from all API routes except whitelisted endpoints

import { Request, Response, NextFunction } from 'express';
import { AccountService } from '../accounts/service';
import { log } from '../infrastructure/logging';

// Method + exact path matching (not prefix)
const UNGATED_ENDPOINTS = [
  { method: 'GET',  path: '/api/accounts/me' },
  { method: 'POST', path: '/api/accounts' },
  { method: 'POST', path: '/api/invite-requests' },
  // New signups have a valid Firebase token but no account row yet; the
  // send-verification endpoint must run before access can be computed.
  { method: 'POST', path: '/api/accounts/me/send-verification' },
];

function isUngatedEndpoint(method: string, originalUrl: string): boolean {
  // Strip query string — originalUrl may include ?key=value
  const path = originalUrl.split('?')[0];
  return UNGATED_ENDPOINTS.some(
    (ep) => ep.method === method && ep.path === path
  );
}

// Extend Express Request to include access decision
declare global {
  namespace Express {
    interface Request {
      accessDecision?: {
        accessGranted: boolean;
        accessReason: 'domain' | 'approved' | 'invitation' | null;
      };
    }
  }
}

const service = new AccountService();

export async function accessGateMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Skip for ungated endpoints
  // Use req.originalUrl (full path) since req.path strips the mount prefix
  // when middleware is mounted via app.use('/api', ...)
  if (isUngatedEndpoint(req.method, req.originalUrl)) {
    next();
    return;
  }

  // Must have authenticated user (authMiddleware should have run first)
  const firebaseUid = req.user?.uid;
  if (!firebaseUid) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const account = await service.getByFirebaseUid(firebaseUid);
    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const accessDecision = await service.computeAccess(account);

    // Cache on request context for downstream use (e.g., toResponse)
    req.accessDecision = accessDecision;

    if (!accessDecision.accessGranted) {
      log.info({
        event: 'access_gate_blocked',
        uid: firebaseUid,
        email: account.email,
        path: req.originalUrl,
        method: req.method,
      }, 'Access gate blocked request');

      res.status(403).json({ error: 'Access not granted' });
      return;
    }

    next();
  } catch (error) {
    log.error({ error, uid: firebaseUid }, 'Access gate error');
    next(error);
  }
}
