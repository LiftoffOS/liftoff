// Prompt Registry Router
// Per Section 1: Control plane owns approved prompt bundles
// Per Section 17: Prompt template versions

import { Router } from 'express';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { PromptRegistryService } from './service';
import { logAudit } from '../infrastructure/logging';

export const promptRegistryRouter = Router();

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
export const promptRegistryServiceRouter = Router();

// Fetched when tenant.prompt_bundle.approved arrives.
promptRegistryServiceRouter.get('/bundles/:id', verifyServiceAuth(), async (req, res, next) => {
  try {
    const bundle = await service.getBundleById(req.params.id);
    if (!bundle) {
      return res.status(404).json({ error: 'Bundle not found' });
    }
    res.json(bundle);
  } catch (error) {
    next(error);
  }
});

const service = new PromptRegistryService();

// List all bundles
promptRegistryRouter.get('/bundles', async (req, res, next) => {
  try {
    const bundles = await service.listBundles();
    res.json(bundles);
  } catch (error) {
    next(error);
  }
});

// List approved bundles only
promptRegistryRouter.get('/bundles/approved', async (req, res, next) => {
  try {
    const bundles = await service.listApprovedBundles();
    res.json(bundles);
  } catch (error) {
    next(error);
  }
});

// ===========================================
// GAP-017 FIX: Tenant-scoped bundle endpoints
// Per Section 4: Runtime fetches /tenant/:tenantId/bundles and /bundles/approved
// ===========================================

// Get bundles for a specific tenant (includes tenant-specific overrides)
promptRegistryRouter.get('/tenant/:tenantId/bundles', async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const includeApprovedOnly = req.query.approved === 'true';

    const bundles = await service.getBundlesForTenant(tenantId, { includeApprovedOnly });

    logAudit('prompt_bundle.tenant_fetch', req.ctx, {
      tenantId,
      bundleCount: bundles.length,
      approvedOnly: includeApprovedOnly,
    });

    res.json(bundles);
  } catch (error) {
    next(error);
  }
});

// Get approved bundles for a specific tenant
promptRegistryRouter.get('/tenant/:tenantId/bundles/approved', async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const bundles = await service.getApprovedBundlesForTenant(tenantId);

    res.json(bundles);
  } catch (error) {
    next(error);
  }
});

// Get latest approved bundle version for a tenant
promptRegistryRouter.get('/tenant/:tenantId/bundles/latest', async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const bundleName = req.query.name as string;

    if (!bundleName) {
      res.status(400).json({ error: 'Bundle name is required' });
      return;
    }

    const bundle = await service.getLatestApprovedBundleForTenant(tenantId, bundleName);

    if (!bundle) {
      res.status(404).json({ error: 'No approved bundle found for tenant' });
      return;
    }

    res.json(bundle);
  } catch (error) {
    next(error);
  }
});

// Check if tenant has access to a specific bundle
promptRegistryRouter.get('/tenant/:tenantId/bundles/:bundleId/access', async (req, res, next) => {
  try {
    const { tenantId, bundleId } = req.params;
    const access = await service.checkTenantBundleAccess(tenantId, bundleId);
    res.json(access);
  } catch (error) {
    next(error);
  }
});

// Override bundle settings for a tenant
promptRegistryRouter.post('/tenant/:tenantId/bundles/:bundleId/override', async (req, res, next) => {
  try {
    const { tenantId, bundleId } = req.params;
    const override = await service.setTenantBundleOverride(tenantId, bundleId, req.body);

    logAudit('prompt_bundle.tenant_override', req.ctx, {
      tenantId,
      bundleId,
      overrideType: req.body.type,
    });

    res.json(override);
  } catch (error) {
    next(error);
  }
});

// Get bundle by ID
promptRegistryRouter.get('/bundles/:id', async (req, res, next) => {
  try {
    const bundle = await service.getBundleById(req.params.id);
    if (!bundle) {
      res.status(404).json({ error: 'Bundle not found' });
      return;
    }
    res.json(bundle);
  } catch (error) {
    next(error);
  }
});

// Create a new bundle
promptRegistryRouter.post('/bundles', async (req, res, next) => {
  try {
    const bundle = await service.createBundle(req.body);

    logAudit('prompt_bundle.created', req.ctx, {
      bundleId: bundle.id,
      bundleName: bundle.name,
      version: bundle.version,
    });

    res.status(201).json(bundle);
  } catch (error) {
    next(error);
  }
});

// Approve a bundle
promptRegistryRouter.post('/bundles/:id/approve', async (req, res, next) => {
  try {
    const bundle = await service.approveBundle(req.params.id);

    logAudit('prompt_bundle.approved', req.ctx, {
      bundleId: bundle.id,
      bundleName: bundle.name,
      version: bundle.version,
    });

    res.json(bundle);
  } catch (error) {
    next(error);
  }
});

// Deprecate a bundle
promptRegistryRouter.post('/bundles/:id/deprecate', async (req, res, next) => {
  try {
    const bundle = await service.deprecateBundle(req.params.id);

    logAudit('prompt_bundle.deprecated', req.ctx, {
      bundleId: bundle.id,
      bundleName: bundle.name,
      version: bundle.version,
    });

    res.json(bundle);
  } catch (error) {
    next(error);
  }
});

// List all templates
promptRegistryRouter.get('/templates', async (req, res, next) => {
  try {
    const templates = await service.listTemplates();
    res.json(templates);
  } catch (error) {
    next(error);
  }
});

// Get template by ID
promptRegistryRouter.get('/templates/:id', async (req, res, next) => {
  try {
    const template = await service.getTemplateById(req.params.id);
    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }
    res.json(template);
  } catch (error) {
    next(error);
  }
});

// Create a new template
promptRegistryRouter.post('/templates', async (req, res, next) => {
  try {
    const template = await service.createTemplate(req.body);

    logAudit('prompt_template.created', req.ctx, {
      templateId: template.id,
      templateName: template.name,
      version: template.version,
    });

    res.status(201).json(template);
  } catch (error) {
    next(error);
  }
});

// Update a template
promptRegistryRouter.put('/templates/:id', async (req, res, next) => {
  try {
    const { content, variables } = req.body;
    const template = await service.updateTemplate(req.params.id, content, variables);

    logAudit('prompt_template.updated', req.ctx, {
      templateId: template.id,
      templateName: template.name,
      version: template.version,
    });

    res.json(template);
  } catch (error) {
    next(error);
  }
});

// ==========================================
// Per Section 15: Prompt Rollout Approval Workflow
// ==========================================

// List all rollouts
promptRegistryRouter.get('/rollouts', async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    const rollouts = await service.listRollouts(tenantId);
    res.json(rollouts);
  } catch (error) {
    next(error);
  }
});

// List pending rollouts
promptRegistryRouter.get('/rollouts/pending', async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    const rollouts = await service.listPendingRollouts(tenantId);
    res.json(rollouts);
  } catch (error) {
    next(error);
  }
});

// List in-progress rollouts
promptRegistryRouter.get('/rollouts/in-progress', async (req, res, next) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    const rollouts = await service.listInProgressRollouts(tenantId);
    res.json(rollouts);
  } catch (error) {
    next(error);
  }
});

// Get rollout by ID
promptRegistryRouter.get('/rollouts/:id', async (req, res, next) => {
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
promptRegistryRouter.post('/rollouts', async (req, res, next) => {
  try {
    const rollout = await service.createRollout(req.body);

    logAudit('prompt_rollout.requested', req.ctx, {
      rolloutId: rollout.id,
      bundleId: rollout.bundleId,
      strategy: rollout.strategy,
      requestedBy: rollout.requestedBy,
    });

    res.status(201).json(rollout);
  } catch (error) {
    next(error);
  }
});

// Approve a rollout
promptRegistryRouter.post('/rollouts/:id/approve', async (req, res, next) => {
  try {
    const rollout = await service.approveRollout(req.params.id, req.body);

    logAudit('prompt_rollout.approved', req.ctx, {
      rolloutId: rollout.id,
      bundleId: rollout.bundleId,
      approvedBy: req.body.approvedBy,
    });

    res.json(rollout);
  } catch (error) {
    next(error);
  }
});

// Reject a rollout
promptRegistryRouter.post('/rollouts/:id/reject', async (req, res, next) => {
  try {
    const rollout = await service.rejectRollout(req.params.id, req.body);

    logAudit('prompt_rollout.rejected', req.ctx, {
      rolloutId: rollout.id,
      bundleId: rollout.bundleId,
      rejectedBy: req.body.rejectedBy,
      reason: req.body.reason,
    });

    res.json(rollout);
  } catch (error) {
    next(error);
  }
});

// Start an approved rollout
promptRegistryRouter.post('/rollouts/:id/start', async (req, res, next) => {
  try {
    const rollout = await service.startRollout(req.params.id);

    logAudit('prompt_rollout.started', req.ctx, {
      rolloutId: rollout.id,
      bundleId: rollout.bundleId,
      strategy: rollout.strategy,
    });

    res.json(rollout);
  } catch (error) {
    next(error);
  }
});

// Complete a rollout
promptRegistryRouter.post('/rollouts/:id/complete', async (req, res, next) => {
  try {
    const rollout = await service.completeRollout(req.params.id);

    logAudit('prompt_rollout.completed', req.ctx, {
      rolloutId: rollout.id,
      bundleId: rollout.bundleId,
    });

    res.json(rollout);
  } catch (error) {
    next(error);
  }
});

// Rollback a rollout
promptRegistryRouter.post('/rollouts/:id/rollback', async (req, res, next) => {
  try {
    const reason = req.body.reason || 'Manual rollback';
    const rollout = await service.rollbackRollout(req.params.id, reason);

    logAudit('prompt_rollout.rolled_back', req.ctx, {
      rolloutId: rollout.id,
      bundleId: rollout.bundleId,
      reason,
    });

    res.json(rollout);
  } catch (error) {
    next(error);
  }
});

// Update rollout metrics
promptRegistryRouter.post('/rollouts/:id/metrics', async (req, res, next) => {
  try {
    await service.updateRolloutMetrics(req.params.id, req.body);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});
