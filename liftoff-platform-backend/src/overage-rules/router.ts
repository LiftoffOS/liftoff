// Overage Rules Router
// Per Section 13: Control plane owns overage rules

import { Router, Request, Response } from 'express';
import { OverageRuleService } from './service';

const router = Router();
const service = new OverageRuleService();

// List all overage rules
router.get('/', async (_req: Request, res: Response) => {
  try {
    const rules = await service.listAll();
    res.json(rules);
  } catch {
    res.status(500).json({ error: 'Failed to list overage rules' });
  }
});

// Get overage rule by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const rule = await service.getById(req.params.id);
    if (!rule) {
      return res.status(404).json({ error: 'Overage rule not found' });
    }
    res.json(rule);
  } catch {
    res.status(500).json({ error: 'Failed to get overage rule' });
  }
});

// Get overage rule by tenant ID
router.get('/tenant/:tenantId', async (req: Request, res: Response) => {
  try {
    const rule = await service.getByTenantId(req.params.tenantId);
    if (!rule) {
      return res.status(404).json({ error: 'Overage rule not found for tenant' });
    }
    res.json(rule);
  } catch {
    res.status(500).json({ error: 'Failed to get overage rule' });
  }
});

// Create overage rule
router.post('/', async (req: Request, res: Response) => {
  try {
    const { tenantId, planId, overageRatePerCredit, overageCeiling, billingThreshold, notificationThreshold } = req.body;

    if (!tenantId || !planId || overageRatePerCredit === undefined) {
      return res.status(400).json({ error: 'tenantId, planId, and overageRatePerCredit are required' });
    }

    const rule = await service.create({
      tenantId,
      planId,
      overageRatePerCredit,
      overageCeiling,
      billingThreshold,
      notificationThreshold,
    });
    res.status(201).json(rule);
  } catch {
    res.status(500).json({ error: 'Failed to create overage rule' });
  }
});

// Update overage rule
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const rule = await service.update(req.params.id, req.body);
    res.json(rule);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update overage rule';
    if (message.includes('not found')) {
      return res.status(404).json({ error: message });
    }
    res.status(500).json({ error: message });
  }
});

// Upsert overage rule for tenant
router.put('/tenant/:tenantId', async (req: Request, res: Response) => {
  try {
    const { planId, overageRatePerCredit, overageCeiling, billingThreshold, notificationThreshold } = req.body;

    if (!planId || overageRatePerCredit === undefined) {
      return res.status(400).json({ error: 'planId and overageRatePerCredit are required' });
    }

    const rule = await service.upsertForTenant(req.params.tenantId, {
      tenantId: req.params.tenantId,
      planId,
      overageRatePerCredit,
      overageCeiling,
      billingThreshold,
      notificationThreshold,
    });
    res.json(rule);
  } catch {
    res.status(500).json({ error: 'Failed to upsert overage rule' });
  }
});

// Delete overage rule
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await service.delete(req.params.id);
    res.status(204).send();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to delete overage rule';
    if (message.includes('not found')) {
      return res.status(404).json({ error: message });
    }
    res.status(500).json({ error: message });
  }
});

// Check overage limit (called by tenant runtime)
router.post('/tenant/:tenantId/check', async (req: Request, res: Response) => {
  try {
    const { currentOverage, additionalUsage } = req.body;

    if (currentOverage === undefined || additionalUsage === undefined) {
      return res.status(400).json({ error: 'currentOverage and additionalUsage are required' });
    }

    const result = await service.checkOverageLimit(
      req.params.tenantId,
      currentOverage,
      additionalUsage
    );
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Failed to check overage limit' });
  }
});

export { router as overageRuleRouter };
