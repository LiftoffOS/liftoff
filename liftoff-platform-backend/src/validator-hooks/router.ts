// Validator Hook Router
// Per Section 17: Validator hook versions

import { Router, Request, Response, NextFunction } from 'express';
import { ValidatorHookService } from './service';

export const validatorHooksRouter = Router();
const service = new ValidatorHookService();

// Async error handler wrapper
const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// List all validator hooks (optionally filter by tenant)
validatorHooksRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const tenantId = req.query.tenantId as string | undefined;
    const hooks = await service.list(tenantId);
    res.json(hooks);
  })
);

// Get active hooks for tenant
validatorHooksRouter.get(
  '/tenant/:tenantId/active',
  asyncHandler(async (req, res) => {
    const hooks = await service.getActive(req.params.tenantId);
    res.json(hooks);
  })
);

// Get hooks by type for tenant
validatorHooksRouter.get(
  '/tenant/:tenantId/type/:type',
  asyncHandler(async (req, res) => {
    const hooks = await service.getByType(req.params.tenantId, req.params.type);
    res.json(hooks);
  })
);

// Get validator hook by ID
validatorHooksRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const hook = await service.getById(req.params.id);
    if (!hook) {
      res.status(404).json({ error: 'Validator hook not found' });
      return;
    }
    res.json(hook);
  })
);

// Create new validator hook
validatorHooksRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const hook = await service.create({
      tenantId: req.body.tenantId,
      name: req.body.name,
      description: req.body.description,
      type: req.body.type,
      config: req.body.config,
      createdBy: req.body.createdBy,
    });
    res.status(201).json(hook);
  })
);

// Update validator hook (creates new version)
validatorHooksRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const hook = await service.update(req.params.id, {
      config: req.body.config,
      changeLog: req.body.changeLog,
      updatedBy: req.body.updatedBy,
    });
    res.json(hook);
  })
);

// Start testing
validatorHooksRouter.post(
  '/:id/test-mode',
  asyncHandler(async (req, res) => {
    const hook = await service.startTesting(req.params.id);
    res.json(hook);
  })
);

// Activate hook
validatorHooksRouter.post(
  '/:id/activate',
  asyncHandler(async (req, res) => {
    const hook = await service.activate(req.params.id);
    res.json(hook);
  })
);

// Deprecate hook
validatorHooksRouter.post(
  '/:id/deprecate',
  asyncHandler(async (req, res) => {
    const hook = await service.deprecate(req.params.id);
    res.json(hook);
  })
);

// Delete hook
validatorHooksRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await service.delete(req.params.id);
    res.status(204).send();
  })
);

// Version management

// Get all versions for a hook
validatorHooksRouter.get(
  '/:id/versions',
  asyncHandler(async (req, res) => {
    const versions = await service.getVersions(req.params.id);
    res.json(versions);
  })
);

// Get specific version
validatorHooksRouter.get(
  '/:id/versions/:version',
  asyncHandler(async (req, res) => {
    const version = await service.getVersion(
      req.params.id,
      parseInt(req.params.version, 10)
    );
    if (!version) {
      res.status(404).json({ error: 'Version not found' });
      return;
    }
    res.json(version);
  })
);

// Rollback to specific version
validatorHooksRouter.post(
  '/:id/rollback/:version',
  asyncHandler(async (req, res) => {
    const hook = await service.rollback(
      req.params.id,
      parseInt(req.params.version, 10),
      req.body.rolledBackBy
    );
    res.json(hook);
  })
);

// Test hook with sample data
validatorHooksRouter.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const result = await service.test(req.params.id, req.body.testData);
    res.json(result);
  })
);
