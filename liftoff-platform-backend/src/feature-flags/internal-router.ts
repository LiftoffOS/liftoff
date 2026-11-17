// Service-auth-gated mirror of the feature-flags admin router.
//
// The public `/api/feature-flags` router sits behind `authMiddleware` (Firebase
// JWT). Operator/scripted/CI callers carry an X-Service-Auth header instead,
// so they can't reach the public router. This internal mirror provides the
// same write surface, gated by `validateServiceAuth` (matches the existing
// /api/internal/maintenance and /api/internal/jobs convention), mounted
// BEFORE authMiddleware in src/index.ts.
//
// Each handler delegates to the same FeatureFlagService methods the public
// router uses — same outbox-published event, same audit trail.

import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import { FeatureFlagService } from './service';
import { log, logAudit } from '../infrastructure/logging';

export const featureFlagsInternalRouter = Router();
const service = new FeatureFlagService();

function validateServiceAuth(req: Request, res: Response): boolean {
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

// Audit actor for service-auth-gated flag changes. Distinguishable from
// human-driven flag changes (which carry a Firebase uid).
const SERVICE_ACTOR = 'service:platform-callback-token';

// GET /api/internal/feature-flags — list all global flag rows.
// Useful for ops scripts to confirm state without going through the public
// list endpoint (which is also Firebase-gated).
featureFlagsInternalRouter.get('/feature-flags', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const flags = await service.list();
    res.json(flags);
  } catch (err) {
    log.error({ error: (err as Error).message }, 'internal-feature-flags list failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/internal/feature-flags/key/:key — fetch single flag by key.
featureFlagsInternalRouter.get('/feature-flags/key/:key', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const flag = await service.getByKey(req.params.key);
    if (!flag) { res.status(404).json({ error: 'Feature flag not found' }); return; }
    res.json(flag);
  } catch (err) {
    log.error({ error: (err as Error).message }, 'internal-feature-flags getByKey failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/internal/feature-flags — create a new global flag.
// Same shape as the public POST. Delegates to FeatureFlagService.create()
// which publishes `tenant.feature_flag.created` via the outbox so the
// runtime sentinel row updates within seconds.
featureFlagsInternalRouter.post('/feature-flags', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const { key, name, description, enabled, value_num: valueNum } = req.body ?? {};
    if (typeof key !== 'string' || typeof name !== 'string' || typeof description !== 'string') {
      res.status(400).json({ error: 'key, name, description (strings) are required' });
      return;
    }
    if (valueNum !== undefined && valueNum !== null && (typeof valueNum !== 'number' || !Number.isFinite(valueNum))) {
      res.status(400).json({ error: 'value_num must be a finite number when provided' });
      return;
    }
    // Numeric-only tunables (e.g. concurrency caps) don't have a meaningful
    // boolean — callers can omit `enabled` and we default it to true. For
    // pure-boolean toggles `enabled` is still required. This is the
    // resolution of ADR-018's "value_num couples numerics to flag rows"
    // concern: numeric tunables become a one-field operation.
    const isNumericOnly = (valueNum !== undefined && valueNum !== null) && enabled === undefined;
    const resolvedEnabled = isNumericOnly ? true : enabled;
    if (typeof resolvedEnabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required when value_num is not provided' });
      return;
    }
    const flag = await service.create({ key, name, description, enabled: resolvedEnabled, valueNum });
    logAudit('feature_flag.created', { userId: SERVICE_ACTOR, operation: 'feature_flag.created' }, {
      flagId: flag.id, flagKey: flag.key, enabled: flag.enabled,
    });
    res.status(201).json(flag);
  } catch (err) {
    log.error({ error: (err as Error).message }, 'internal-feature-flags create failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/internal/feature-flags/key/:key — upsert by key.
// Convenience for ops: callers don't need to look up the flag id first.
// If the flag exists, it's updated (publishes tenant.feature_flag.updated).
// If it doesn't, it's created (publishes tenant.feature_flag.created) using
// `name` / `description` from the body (required only on first write).
featureFlagsInternalRouter.put('/feature-flags/key/:key', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const { name, description, enabled, value_num: valueNum } = req.body ?? {};
    if (valueNum !== undefined && valueNum !== null && (typeof valueNum !== 'number' || !Number.isFinite(valueNum))) {
      res.status(400).json({ error: 'value_num must be a finite number when provided' });
      return;
    }
    // Numeric-only tunables don't need `enabled` — see ADR-018. When the
    // caller omits `enabled` but passes `value_num`, we default to true.
    const isNumericOnly = (valueNum !== undefined && valueNum !== null) && enabled === undefined;
    const resolvedEnabled = isNumericOnly ? true : enabled;
    if (typeof resolvedEnabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required when value_num is not provided' });
      return;
    }
    const existing = await service.getByKey(req.params.key);
    if (existing) {
      const flag = await service.update(existing.id, {
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof description === 'string' ? { description } : {}),
        ...(valueNum !== undefined ? { valueNum } : {}),
        enabled: resolvedEnabled,
      });
      logAudit('feature_flag.updated', { userId: SERVICE_ACTOR, operation: 'feature_flag.updated' }, {
        flagId: flag.id, flagKey: flag.key, enabled: flag.enabled,
      });
      res.json(flag);
      return;
    }
    if (typeof name !== 'string' || typeof description !== 'string') {
      res.status(400).json({
        error: 'flag does not exist; first write must include name and description (strings)',
      });
      return;
    }
    const flag = await service.create({ key: req.params.key, name, description, enabled: resolvedEnabled, valueNum });
    logAudit('feature_flag.created', { userId: SERVICE_ACTOR, operation: 'feature_flag.created' }, {
      flagId: flag.id, flagKey: flag.key, enabled: flag.enabled,
    });
    res.status(201).json(flag);
  } catch (err) {
    log.error({ error: (err as Error).message }, 'internal-feature-flags upsert failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/internal/feature-flags/key/:key — delete a global flag.
// Publishes tenant.feature_flag.deleted via the outbox. Removing the global
// row leaves the runtime sentinel value (which is keyed by flag key on the
// JSON column) in place — call PUT with enabled=false instead if you want to
// guarantee the runtime sees the disable.
featureFlagsInternalRouter.delete('/feature-flags/key/:key', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;
  try {
    const flag = await service.getByKey(req.params.key);
    if (!flag) { res.status(404).json({ error: 'Feature flag not found' }); return; }
    await service.delete(flag.id);
    logAudit('feature_flag.deleted', { userId: SERVICE_ACTOR, operation: 'feature_flag.deleted' }, {
      flagId: flag.id, flagKey: flag.key,
    });
    res.status(204).send();
  } catch (err) {
    log.error({ error: (err as Error).message }, 'internal-feature-flags delete failed');
    res.status(500).json({ error: (err as Error).message });
  }
});
