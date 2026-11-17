// Who may call the capability surface, and as which caller.
//
// Two routers answer to this: capability discovery + execution, and the
// parking route beside it. They are mounted separately (different body limits
// — a parked payload is orders of magnitude larger than a search spec) but the
// identity question is the same one, and two copies of a timing-safe token
// comparison is two places for it to stop being timing-safe.

import crypto from 'crypto';
import type { Request, Response } from 'express';
import { log } from '../infrastructure/logging';

// Which token maps to which caller. The caller decides whether a write/outbound
// capability may execute: only 'agent' (the tenant-runtime, which pauses for
// human approval at its admission gate) can, and only with an approval. The
// CAIO has no approval flow, so it is read-only on that surface, same as the
// in-process assistant.
const TOKEN_CALLERS: ReadonlyArray<{ var: string; caller: 'agent' | 'caio' }> = [
  { var: 'TENANT_RUNTIME_SERVICE_TOKEN', caller: 'agent' },
  { var: 'WORKFORCE_SERVICE_TOKEN', caller: 'caio' },
];

/** The request's authenticated caller, set by capabilityServiceAuth. */
export type CapabilityCaller = 'agent' | 'caio';

export type CapabilityAuthedRequest = Request & { capabilityCaller?: CapabilityCaller };

export function capabilityServiceAuth(
  req: CapabilityAuthedRequest,
  res: Response,
  next: () => void,
): void {
  const provided = req.headers['x-service-auth'] as string | undefined;
  if (!provided) {
    res.status(401).json({ error: 'Missing service authentication' });
    return;
  }
  const configured = TOKEN_CALLERS.filter((t) => Boolean(process.env[t.var]));
  if (configured.length === 0) {
    log.error('capability internal route hit but no accepted service token is configured');
    res.status(503).json({ error: 'Not configured' });
    return;
  }
  // Compare against every configured token (no short-circuit) and record which
  // caller matched — the identity is what gates write-class execution.
  let matched: CapabilityCaller | null = null;
  for (const t of configured) {
    const expected = process.env[t.var] as string;
    if (
      Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    ) {
      matched = t.caller;
    }
  }
  if (!matched) {
    res.status(401).json({ error: 'Invalid service authentication' });
    return;
  }
  req.capabilityCaller = matched;
  next();
}
