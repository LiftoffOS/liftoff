// Canonical-host enforcement for PUBLIC surfaces (plan v6.1 hardening).
//
// The raw *.run.app URL must never circulate externally; the custom domain
// is the only public address. Cloud Run domain mappings cannot block the
// default URL at the infrastructure level without also breaking the
// Google-signed internal deliveries that target the raw service URI
// (Pub/Sub billing push, schedulers, Cloud Tasks — see infrastructure
// main.tf), so the app refuses instead: on a *.run.app host, GET/HEAD
// 301s to the canonical host (self-correcting for agents and browsers)
// and every other method 404s. Internal endpoints stay unguarded on
// purpose — their callers authenticate via Google OIDC and pin hosts.

import { Request, Response, NextFunction } from 'express';
import { getBackendUrl } from '../infrastructure/control-plane-url';

export function enforceCanonicalPublicHost(req: Request, res: Response, next: NextFunction): void {
  const host = req.get('host') ?? '';
  // Cheap suffix check first: getBackendUrl() is only consulted for raw-host
  // requests (it throws when BACKEND_URL is unset, e.g. in unit harnesses).
  if (!host.endsWith('.run.app')) {
    next();
    return;
  }
  const canonicalHost = new URL(getBackendUrl()).host;
  if (host === canonicalHost) {
    // Local/dev setups may point BACKEND_URL at a run.app host; redirecting
    // would loop.
    next();
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.redirect(301, `${getBackendUrl()}${req.originalUrl}`);
    return;
  }
  res.status(404).json({ error: 'not_found' });
}
