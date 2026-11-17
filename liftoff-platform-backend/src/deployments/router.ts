// Deployments Router
// Per Section 1: Control plane owns approved deployment revisions

import { Router } from 'express';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { DeploymentService } from './service';
import { logAudit } from '../infrastructure/logging';

export const deploymentsRouter = Router();

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
export const deploymentsServiceRouter = Router();

// Fetched when tenant.deployment.approved arrives.
deploymentsServiceRouter.get('/:id', verifyServiceAuth(), async (req, res, next) => {
  try {
    const deployment = await service.getById(req.params.id);
    if (!deployment) {
      return res.status(404).json({ error: 'Deployment not found' });
    }
    res.json(deployment);
  } catch (error) {
    next(error);
  }
});

// The runtime's cache-miss refetch. This route did not exist at all: the
// runtime has always called it, always got 404, and its client reads 404 as
// "no approved deployment" — so a missing endpoint looked like a valid answer.
// Registered before '/:id' would be ambiguous, so it is spelled out in full.
deploymentsServiceRouter.get('/tenant/:tenantId/approved', verifyServiceAuth(), async (req, res, next) => {
  try {
    const deployment = await service.getLatestApproved(req.params.tenantId);
    if (!deployment) {
      return res.status(404).json({ error: 'No approved deployment found' });
    }
    res.json(deployment);
  } catch (error) {
    next(error);
  }
});

const service = new DeploymentService();

// List all deployments
deploymentsRouter.get('/', async (req, res, next) => {
  try {
    const deployments = await service.listAll();
    res.json(deployments);
  } catch (error) {
    next(error);
  }
});

// Get deployment by ID
deploymentsRouter.get('/:id', async (req, res, next) => {
  try {
    const deployment = await service.getById(req.params.id);
    if (!deployment) {
      res.status(404).json({ error: 'Deployment not found' });
      return;
    }
    res.json(deployment);
  } catch (error) {
    next(error);
  }
});

// Get deployments for a tenant
deploymentsRouter.get('/tenant/:tenantId', async (req, res, next) => {
  try {
    const deployments = await service.getByTenantId(req.params.tenantId);
    res.json(deployments);
  } catch (error) {
    next(error);
  }
});

// Get pending deployments for a tenant
deploymentsRouter.get('/tenant/:tenantId/pending', async (req, res, next) => {
  try {
    const deployments = await service.getPendingByTenantId(req.params.tenantId);
    res.json(deployments);
  } catch (error) {
    next(error);
  }
});

// Get latest deployed for a tenant
deploymentsRouter.get('/tenant/:tenantId/latest', async (req, res, next) => {
  try {
    const deployment = await service.getLatestDeployed(req.params.tenantId);
    if (!deployment) {
      res.status(404).json({ error: 'No deployed deployments found' });
      return;
    }
    res.json(deployment);
  } catch (error) {
    next(error);
  }
});

// Create a new deployment
deploymentsRouter.post('/', async (req, res, next) => {
  try {
    const deployment = await service.create(req.body);

    logAudit('deployment.created', req.ctx, {
      deploymentId: deployment.id,
      tenantId: deployment.tenantId,
      artifactRef: deployment.artifactRef,
      version: deployment.version,
    });

    res.status(201).json(deployment);
  } catch (error) {
    next(error);
  }
});

// Approve a deployment
deploymentsRouter.post('/:id/approve', async (req, res, next) => {
  try {
    const deployment = await service.approve(req.params.id);

    logAudit('deployment.approved', req.ctx, {
      deploymentId: deployment.id,
      tenantId: deployment.tenantId,
      version: deployment.version,
    });

    res.json(deployment);
  } catch (error) {
    next(error);
  }
});

// Deploy an approved deployment
deploymentsRouter.post('/:id/deploy', async (req, res, next) => {
  try {
    const deployment = await service.deploy(req.params.id);

    logAudit('deployment.deployed', req.ctx, {
      deploymentId: deployment.id,
      tenantId: deployment.tenantId,
      version: deployment.version,
    });

    res.json(deployment);
  } catch (error) {
    next(error);
  }
});

// Rollback a deployment
deploymentsRouter.post('/:id/rollback', async (req, res, next) => {
  try {
    const deployment = await service.rollback(req.params.id);

    logAudit('deployment.rolled_back', req.ctx, {
      deploymentId: deployment.id,
      tenantId: deployment.tenantId,
      version: deployment.version,
    });

    res.json(deployment);
  } catch (error) {
    next(error);
  }
});
