// Rollout Router
// Per Section 17: API endpoints for rollout orchestration

import { Router } from 'express';
import { tenantAuthMiddleware } from '../infrastructure/middleware';
import { rolloutOrchestrationService } from './orchestration-service';
import { logAudit } from '../infrastructure/logging';

export const rolloutRouter = Router();

// Not mounted today, and these routes take the tenant from the request.
// Guarding here rather than at a mount that does not exist means whoever
// wires it up later cannot reintroduce the cross-tenant hole by forgetting.
rolloutRouter.use(tenantAuthMiddleware('viewDashboard'));

// Get rollout progress
rolloutRouter.get('/:id/progress', async (req, res, next) => {
  try {
    const progress = await rolloutOrchestrationService.getRolloutProgress(req.params.id);
    if (!progress) {
      res.status(404).json({ error: 'Rollout not found' });
      return;
    }
    res.json(progress);
  } catch (error) {
    next(error);
  }
});

// Get rollout audit log
rolloutRouter.get('/:id/audit', async (req, res, next) => {
  try {
    const auditLog = await rolloutOrchestrationService.getRolloutAuditLog(req.params.id);
    res.json(auditLog);
  } catch (error) {
    next(error);
  }
});

// Get rollout history for tenant
rolloutRouter.get('/tenant/:tenantId/history', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const history = await rolloutOrchestrationService.getRolloutHistory(req.params.tenantId, limit);
    res.json(history);
  } catch (error) {
    next(error);
  }
});

// Start progressive rollout (after approval)
rolloutRouter.post('/:id/start-progressive', async (req, res, next) => {
  try {
    await rolloutOrchestrationService.startProgressiveRollout(req.params.id);

    logAudit('model_rollout.progressive_started', req.ctx, {
      rolloutId: req.params.id,
    });

    const progress = await rolloutOrchestrationService.getRolloutProgress(req.params.id);
    res.json(progress);
  } catch (error) {
    next(error);
  }
});

// Manually advance rollout to next step
rolloutRouter.post('/:id/advance', async (req, res, next) => {
  try {
    const advanced = await rolloutOrchestrationService.advanceRollout(req.params.id);

    if (!advanced) {
      res.status(400).json({ error: 'Cannot advance rollout' });
      return;
    }

    logAudit('model_rollout.manually_advanced', req.ctx, {
      rolloutId: req.params.id,
    });

    const progress = await rolloutOrchestrationService.getRolloutProgress(req.params.id);
    res.json(progress);
  } catch (error) {
    next(error);
  }
});

// Manually rollback rollout
rolloutRouter.post('/:id/rollback', async (req, res, next) => {
  try {
    const reason = req.body.reason || 'Manual rollback';
    await rolloutOrchestrationService.rollbackRollout(req.params.id, reason);

    logAudit('model_rollout.manually_rolled_back', req.ctx, {
      rolloutId: req.params.id,
      reason,
    });

    res.json({ success: true, reason });
  } catch (error) {
    next(error);
  }
});

// Get current traffic split for tenant
rolloutRouter.get('/tenant/:tenantId/traffic-split', async (req, res, next) => {
  try {
    const split = await rolloutOrchestrationService.getTrafficSplit(req.params.tenantId);
    res.json(split || { percentage: 100, isActive: false });
  } catch (error) {
    next(error);
  }
});

// Check if request should use new model (for traffic splitting)
rolloutRouter.get('/tenant/:tenantId/should-use-new', async (req, res, next) => {
  try {
    const useNew = await rolloutOrchestrationService.shouldUseNewModel(req.params.tenantId);
    res.json({ useNewModel: useNew });
  } catch (error) {
    next(error);
  }
});
