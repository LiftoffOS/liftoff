// Feature Flags Router
// Per Section 1: Control plane owns feature flags

import { Router } from 'express';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { FeatureFlagService } from './service';
import { logAudit } from '../infrastructure/logging';

export const featureFlagsRouter = Router();

// ── Service surface ─────────────────────────────────────────────────────
//
// The tenant runtime calls this with X-Service-Auth, not a Firebase token, so
// it cannot go through the user router: that one sits behind
// app.use('/api', authMiddleware) and answers a service token with 401.
//
// Mounted BEFORE the auth gate in index.ts, exactly as entitlementsServiceRouter
// is. verifyServiceAuth() defaults to TENANT_RUNTIME_SERVICE_TOKEN, which is the
// token the runtime sends. Only the routes the runtime actually calls are
// exposed here; everything else stays behind the user gate.
export const featureFlagsServiceRouter = Router();

// The runtime refetches a tenant's whole flag set when a tenant-scoped flag
// event arrives. Without this route that event failed on 401, was retried ten
// times and dead-lettered, so tenant overrides never reached the runtime while
// global flags (which never take this path) kept working.
featureFlagsServiceRouter.get('/tenant/:tenantId', verifyServiceAuth(), async (req, res, next) => {
  try {
    res.json(await service.getForTenant(req.params.tenantId));
  } catch (error) {
    next(error);
  }
});

const service = new FeatureFlagService();

// List all feature flags
featureFlagsRouter.get('/', async (req, res, next) => {
  try {
    const flags = await service.list();
    res.json(flags);
  } catch (error) {
    next(error);
  }
});

// Get evaluated flags for a tenant
// Per Section 4: Tenant runtime may pull feature flags
featureFlagsRouter.get('/tenant/:tenantId', async (req, res, next) => {
  try {
    const flags = await service.getForTenant(req.params.tenantId);
    res.json(flags);
  } catch (error) {
    next(error);
  }
});

// Get single flag by ID
featureFlagsRouter.get('/:id', async (req, res, next) => {
  try {
    const flag = await service.getById(req.params.id);
    if (!flag) {
      res.status(404).json({ error: 'Feature flag not found' });
      return;
    }
    res.json(flag);
  } catch (error) {
    next(error);
  }
});

// Create feature flag
featureFlagsRouter.post('/', async (req, res, next) => {
  try {
    const flag = await service.create(req.body);

    logAudit('feature_flag.created', req.ctx, {
      flagId: flag.id,
      flagKey: flag.key,
    });

    res.status(201).json(flag);
  } catch (error) {
    next(error);
  }
});

// Update feature flag
featureFlagsRouter.put('/:id', async (req, res, next) => {
  try {
    const flag = await service.update(req.params.id, req.body);

    logAudit('feature_flag.updated', req.ctx, {
      flagId: flag.id,
      flagKey: flag.key,
    });

    res.json(flag);
  } catch (error) {
    next(error);
  }
});

// Delete feature flag
featureFlagsRouter.delete('/:id', async (req, res, next) => {
  try {
    const flag = await service.getById(req.params.id);
    if (!flag) {
      res.status(404).json({ error: 'Feature flag not found' });
      return;
    }

    await service.delete(req.params.id);

    logAudit('feature_flag.deleted', req.ctx, {
      flagId: flag.id,
      flagKey: flag.key,
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// Set tenant override
featureFlagsRouter.put('/key/:key/tenant/:tenantId', async (req, res, next) => {
  try {
    const { enabled } = req.body;
    const flag = await service.setTenantOverride(
      req.params.key,
      req.params.tenantId,
      enabled
    );

    logAudit('feature_flag.tenant_override_set', req.ctx, {
      flagKey: req.params.key,
      tenantId: req.params.tenantId,
      enabled,
    });

    res.json(flag);
  } catch (error) {
    next(error);
  }
});

// Remove tenant override
featureFlagsRouter.delete('/key/:key/tenant/:tenantId', async (req, res, next) => {
  try {
    const flag = await service.removeTenantOverride(
      req.params.key,
      req.params.tenantId
    );

    logAudit('feature_flag.tenant_override_removed', req.ctx, {
      flagKey: req.params.key,
      tenantId: req.params.tenantId,
    });

    res.json(flag);
  } catch (error) {
    next(error);
  }
});
