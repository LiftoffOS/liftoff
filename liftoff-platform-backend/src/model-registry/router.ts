// Model Registry Router
// Per Section 17: Control plane owns approved model list, routing policy

import { Router } from 'express';
import { ModelRegistryService } from './service';
import { logAudit } from '../infrastructure/logging';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { verifyTenantOwnership, verifyTenantScopeIfNamed } from '../infrastructure/tenant-role-auth';

export const modelRegistryRouter = Router();
const service = new ModelRegistryService();

// Service-auth router for tenant-runtime to fetch model configs.
// Mounted BEFORE authMiddleware in index.ts. Mirrors the entitlements
// service-router pattern. Required by tenant-runtime's
// /api/internal/model-configs/resync endpoint and the periodic
// reconciler — without this, TR cannot refresh its cached_model_configs
// from PB after a routing-policy migration that doesn't fire
// tenant.model_config.updated events.
export const modelRegistryServiceRouter = Router();

modelRegistryServiceRouter.get('/tenant/:tenantId/configs', verifyServiceAuth(), async (req, res, next) => {
  try {
    const configs = await service.getConfigsForTenant(req.params.tenantId);
    res.json(configs);
  } catch (error) {
    next(error);
  }
});

// List all models
modelRegistryRouter.get('/', async (req, res, next) => {
  try {
    const models = await service.listAll();
    res.json(models);
  } catch (error) {
    next(error);
  }
});

// List approved models only
modelRegistryRouter.get('/approved', async (req, res, next) => {
  try {
    const models = await service.listApproved();
    res.json(models);
  } catch (error) {
    next(error);
  }
});

// Get model by ID
modelRegistryRouter.get('/:id', async (req, res, next) => {
  try {
    const model = await service.getById(req.params.id);
    if (!model) {
      res.status(404).json({ error: 'Model not found' });
      return;
    }
    res.json(model);
  } catch (error) {
    next(error);
  }
});

// Register a new model
modelRegistryRouter.post('/', async (req, res, next) => {
  try {
    const model = await service.register(req.body);

    logAudit('model.registered', req.ctx, {
      modelId: model.id,
      modelName: model.name,
      provider: model.provider,
    });

    res.status(201).json(model);
  } catch (error) {
    next(error);
  }
});

// Approve a model
modelRegistryRouter.post('/:id/approve', async (req, res, next) => {
  try {
    const model = await service.approve(req.params.id);

    logAudit('model.approved', req.ctx, {
      modelId: model.id,
      modelName: model.name,
    });

    res.json(model);
  } catch (error) {
    next(error);
  }
});

// Deprecate a model
modelRegistryRouter.post('/:id/deprecate', async (req, res, next) => {
  try {
    const model = await service.deprecate(req.params.id);

    logAudit('model.deprecated', req.ctx, {
      modelId: model.id,
      modelName: model.name,
    });

    res.json(model);
  } catch (error) {
    next(error);
  }
});

// Disable a model
modelRegistryRouter.post('/:id/disable', async (req, res, next) => {
  try {
    const model = await service.disable(req.params.id);

    logAudit('model.disabled', req.ctx, {
      modelId: model.id,
      modelName: model.name,
    });

    res.json(model);
  } catch (error) {
    next(error);
  }
});

// Record a model's context window, in tokens. `{ "contextWindow": null }`
// clears it back to unrecorded.
//
// The registry is where a window becomes authoritative: the runtime labels a
// reading from here `registry` and one derived from a provider family `floor`,
// and only the former may retire a session. So a model with no recorded window
// is not broken, it is un-actionable — which is why this route exists rather
// than leaving the column INSERT-only.
modelRegistryRouter.put('/:id/context-window', async (req, res, next) => {
  try {
    const raw = req.body?.contextWindow;
    if (raw !== null && typeof raw !== 'number') {
      res.status(400).json({ error: 'contextWindow must be a number, or null to clear it' });
      return;
    }

    const model = await service.setContextWindow(req.params.id, raw);
    if (!model) {
      res.status(404).json({ error: 'Model not found' });
      return;
    }

    logAudit('model.context_window_set', req.ctx, {
      modelId: model.id,
      modelName: model.name,
      provider: model.provider,
      contextWindow: model.contextWindow ?? null,
    });

    res.json(model);
  } catch (error) {
    // A non-integer or non-positive window is the caller's mistake, not a
    // server fault: reject it as a 400 rather than letting it surface as a 500.
    if (error instanceof Error && error.message.startsWith('contextWindow must be')) {
      res.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

// Get model configs for a tenant
modelRegistryRouter.get('/tenant/:tenantId/configs', verifyTenantOwnership, async (req, res, next) => {
  try {
    const configs = await service.getConfigsForTenant(req.params.tenantId);
    res.json(configs);
  } catch (error) {
    next(error);
  }
});

// Update model config for a tenant
modelRegistryRouter.put('/tenant/:tenantId/model/:modelId/config', verifyTenantOwnership, async (req, res, next) => {
  try {
    const config = await service.updateConfig(
      req.params.tenantId,
      req.params.modelId,
      req.body.routingPolicy
    );

    logAudit('model_config.updated', req.ctx, {
      tenantId: req.params.tenantId,
      modelId: req.params.modelId,
      configId: config.id,
    });

    res.json(config);
  } catch (error) {
    next(error);
  }
});

// Delete model config for a tenant
modelRegistryRouter.delete('/tenant/:tenantId/model/:modelId/config', verifyTenantOwnership, async (req, res, next) => {
  try {
    await service.deleteConfig(req.params.tenantId, req.params.modelId);

    logAudit('model_config.deleted', req.ctx, {
      tenantId: req.params.tenantId,
      modelId: req.params.modelId,
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// ==========================================
// Per Section 17: Rollout Approval Endpoints
// ==========================================

// List all rollouts (optionally filter by tenant)
modelRegistryRouter.get('/rollouts', verifyTenantScopeIfNamed, async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    const rollouts = await service.listRollouts(tenantId);
    res.json(rollouts);
  } catch (error) {
    next(error);
  }
});

// List pending rollouts
modelRegistryRouter.get('/rollouts/pending', verifyTenantScopeIfNamed, async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    const rollouts = await service.listPendingRollouts(tenantId);
    res.json(rollouts);
  } catch (error) {
    next(error);
  }
});

// List in-progress rollouts
modelRegistryRouter.get('/rollouts/in-progress', verifyTenantScopeIfNamed, async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    const rollouts = await service.listInProgressRollouts(tenantId);
    res.json(rollouts);
  } catch (error) {
    next(error);
  }
});

// Get rollout by ID
modelRegistryRouter.get('/rollouts/:id', async (req, res, next) => {
  try {
    const rollout = await service.getRolloutById(req.params.id);
    if (!rollout) {
      res.status(404).json({ error: 'Rollout not found' });
      return;
    }
    res.json(rollout);
  } catch (error) {
    next(error);
  }
});

// Create a new rollout request
modelRegistryRouter.post('/rollouts', verifyTenantScopeIfNamed, async (req, res, next) => {
  try {
    const rollout = await service.createRollout({
      tenantId: req.body.tenantId,
      modelId: req.body.modelId,
      strategy: req.body.strategy,
      config: req.body.config,
      requestedBy: req.body.requestedBy,
    });

    logAudit('model_rollout.requested', req.ctx, {
      rolloutId: rollout.id,
      tenantId: req.body.tenantId,
      modelId: req.body.modelId,
      strategy: req.body.strategy,
    });

    res.status(201).json(rollout);
  } catch (error) {
    next(error);
  }
});

// Approve a rollout
modelRegistryRouter.post('/rollouts/:id/approve', async (req, res, next) => {
  try {
    const rollout = await service.approveRollout(req.params.id, {
      approvedBy: req.body.approvedBy,
      comment: req.body.comment,
    });

    logAudit('model_rollout.approved', req.ctx, {
      rolloutId: rollout.id,
      tenantId: rollout.tenantId,
      modelId: rollout.modelId,
      approvedBy: req.body.approvedBy,
    });

    res.json(rollout);
  } catch (error) {
    next(error);
  }
});

// Reject a rollout
modelRegistryRouter.post('/rollouts/:id/reject', async (req, res, next) => {
  try {
    const rollout = await service.rejectRollout(req.params.id, {
      rejectedBy: req.body.rejectedBy,
      reason: req.body.reason,
    });

    logAudit('model_rollout.rejected', req.ctx, {
      rolloutId: rollout.id,
      tenantId: rollout.tenantId,
      modelId: rollout.modelId,
      rejectedBy: req.body.rejectedBy,
    });

    res.json(rollout);
  } catch (error) {
    next(error);
  }
});

// Start an approved rollout
modelRegistryRouter.post('/rollouts/:id/start', async (req, res, next) => {
  try {
    const rollout = await service.startRollout(req.params.id);

    logAudit('model_rollout.started', req.ctx, {
      rolloutId: rollout.id,
      tenantId: rollout.tenantId,
      modelId: rollout.modelId,
    });

    res.json(rollout);
  } catch (error) {
    next(error);
  }
});

// Complete a rollout
modelRegistryRouter.post('/rollouts/:id/complete', async (req, res, next) => {
  try {
    const rollout = await service.completeRollout(req.params.id);

    logAudit('model_rollout.completed', req.ctx, {
      rolloutId: rollout.id,
      tenantId: rollout.tenantId,
      modelId: rollout.modelId,
    });

    res.json(rollout);
  } catch (error) {
    next(error);
  }
});

// Rollback a rollout
modelRegistryRouter.post('/rollouts/:id/rollback', async (req, res, next) => {
  try {
    const rollout = await service.rollbackRollout(req.params.id, req.body.reason);

    logAudit('model_rollout.rolled_back', req.ctx, {
      rolloutId: rollout.id,
      tenantId: rollout.tenantId,
      modelId: rollout.modelId,
      reason: req.body.reason,
    });

    res.json(rollout);
  } catch (error) {
    next(error);
  }
});

// Update rollout metrics
modelRegistryRouter.put('/rollouts/:id/metrics', async (req, res, next) => {
  try {
    await service.updateRolloutMetrics(req.params.id, req.body);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
