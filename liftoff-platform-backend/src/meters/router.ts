// Meter Router
// Per Section 13: Control plane owns meter definitions

import { Router, Request, Response } from 'express';
import { MeterService } from './service';

const router = Router();
const service = new MeterService();

// List all meter definitions
router.get('/', async (_req: Request, res: Response) => {
  try {
    const meters = await service.listAll();
    res.json(meters);
  } catch {
    res.status(500).json({ error: 'Failed to list meters' });
  }
});

// Get meter by ID
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const meter = await service.getById(req.params.id);
    if (!meter) {
      return res.status(404).json({ error: 'Meter not found' });
    }
    res.json(meter);
  } catch {
    res.status(500).json({ error: 'Failed to get meter' });
  }
});

// Create meter definition
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, description, stripeMeterId, unit, aggregationType } = req.body;

    if (!name || !unit || !aggregationType) {
      return res.status(400).json({ error: 'name, unit, and aggregationType are required' });
    }

    const meter = await service.create({
      name,
      description: description || '',
      stripeMeterId,
      unit,
      aggregationType,
    });
    res.status(201).json(meter);
  } catch {
    res.status(500).json({ error: 'Failed to create meter' });
  }
});

// Update meter definition
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const meter = await service.update(req.params.id, req.body);
    res.json(meter);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update meter';
    if (message.includes('not found')) {
      return res.status(404).json({ error: message });
    }
    res.status(500).json({ error: message });
  }
});

// Delete meter definition
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await service.delete(req.params.id);
    res.status(204).send();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to delete meter';
    if (message.includes('not found')) {
      return res.status(404).json({ error: message });
    }
    res.status(500).json({ error: message });
  }
});

// Report usage to a meter (called by tenant runtime)
router.post('/:id/usage', async (req: Request, res: Response) => {
  try {
    const { customerId, value, timestamp } = req.body;

    if (!customerId || value === undefined) {
      return res.status(400).json({ error: 'customerId and value are required' });
    }

    await service.reportUsage(
      req.params.id,
      customerId,
      value,
      timestamp ? { timestamp: new Date(timestamp) } : undefined
    );

    res.status(202).json({ accepted: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to report usage';
    if (message.includes('not found')) {
      return res.status(404).json({ error: message });
    }
    res.status(500).json({ error: message });
  }
});

export { router as meterRouter };
