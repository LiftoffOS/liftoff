// Plans Router
// Per Section 13: Control plane owns plans

import { Router, Request, Response, NextFunction } from 'express';
import { PlanService } from './service';
import { CreatePlanInput, UpdatePlanInput } from './types';

export const plansRouter = Router();
const service = new PlanService();

// List all active plans (public)
plansRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const plans = await service.listActive();
    res.json({ plans });
  } catch (error) {
    next(error);
  }
});

// Get plan by ID
plansRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const plan = await service.getById(req.params.id);
    if (!plan) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }
    res.json({ plan });
  } catch (error) {
    next(error);
  }
});

// Create plan (admin only)
plansRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: CreatePlanInput = req.body;
    const plan = await service.create(input);
    res.status(201).json({ plan });
  } catch (error) {
    next(error);
  }
});

// Update plan (admin only)
plansRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: UpdatePlanInput = req.body;
    const plan = await service.update(req.params.id, input);
    res.json({ plan });
  } catch (error) {
    next(error);
  }
});

// Archive plan (admin only)
plansRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const plan = await service.archive(req.params.id);
    res.json({ plan });
  } catch (error) {
    next(error);
  }
});
