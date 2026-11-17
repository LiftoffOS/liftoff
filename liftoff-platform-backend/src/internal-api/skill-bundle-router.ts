// Reading a skill's files back, for the runtime to materialize (internal).
//
// A skill's bundle lives in the control plane's bucket, addressed by its own
// sha256. The runtime holds only pointers, so this is how the bytes reach a
// sandbox.
//
// The digest is verified before the content is returned, so a runtime that
// trusts this endpoint is trusting a check that actually ran. The storageRef is
// checked against the caller's tenant prefix as well: it always arrives from a
// skill row, but an endpoint that returns any object in the bucket when handed
// any path is one bad row away from being a bucket reader.

import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { log } from '../infrastructure/logging';
import { readSkillBundleFile } from '../internal-agents/skill-bundle';

export const skillBundleInternalRouter = Router();

const INTERNAL_SERVICE_TOKEN_VARS = [
  'TENANT_RUNTIME_SERVICE_TOKEN',
  'WORKFORCE_SERVICE_TOKEN',
] as const;

function serviceAuth(req: Request, res: Response, next: () => void): void {
  const token = req.headers['x-service-auth'] as string | undefined;
  if (!token) {
    res.status(401).json({ error: 'Missing service authentication' });
    return;
  }
  const candidates = INTERNAL_SERVICE_TOKEN_VARS
    .map((v) => process.env[v])
    .filter((t): t is string => Boolean(t));
  if (candidates.length === 0) {
    res.status(503).json({ error: 'Skill bundle reads are not configured' });
    return;
  }
  const matched = candidates.some((expected) => {
    try {
      return (
        Buffer.byteLength(token) === Buffer.byteLength(expected) &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
      );
    } catch {
      return false;
    }
  });
  if (!matched) {
    res.status(401).json({ error: 'Invalid service authentication' });
    return;
  }
  next();
}

/** GET /api/internal/skill-bundle-file?tenantId=…&storageRef=…&sha256=… */
skillBundleInternalRouter.get(
  '/skill-bundle-file',
  serviceAuth,
  async (req: Request, res: Response) => {
    const storageRef = String(req.query.storageRef ?? '');
    const sha256 = String(req.query.sha256 ?? '');
    const tenantId = String(req.query.tenantId ?? '');

    if (!storageRef || !sha256 || !tenantId) {
      res.status(400).json({ error: 'tenantId, storageRef and sha256 are required' });
      return;
    }
    if (!storageRef.startsWith(`skill-bundles/${tenantId}/`) || storageRef.includes('..')) {
      log.warn({ tenantId, storageRef }, 'skill-bundle: refused a ref outside the tenant prefix');
      res.status(403).json({ error: 'forbidden' });
      return;
    }

    try {
      const content = await readSkillBundleFile(storageRef, sha256);
      if (content === null) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({ content });
    } catch (error) {
      log.error(
        { tenantId, storageRef, error: (error as Error).message },
        'skill-bundle: read failed',
      );
      res.status(500).json({ error: 'internal_error' });
    }
  },
);
