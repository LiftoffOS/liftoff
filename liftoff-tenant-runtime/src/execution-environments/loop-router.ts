import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AutonomousLoopController } from './loop-controller';

const loopController = new AutonomousLoopController();
export const loopRouter = Router({ mergeParams: true });

const startSchema = z.object({
  objective: z.string().min(1).max(4000),
  maxIterations: z.number().int().min(1).max(100),
  cooldownMs: z.number().int().min(0).default(60_000),
  budgetCredits: z.number().int().min(1),
  userId: z.string().optional(),
});

const withLoopId = z.object({
  loopId: z.string().uuid(),
  reason: z.string().optional(),
});

loopRouter.post('/start', async (req: Request, res: Response) => {
  const tenantId = req.ctx?.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'tenantId required (x-tenant-id header)' });
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  const { objective, maxIterations, cooldownMs, budgetCredits, userId } = parsed.data;
  const agentId = req.params.agentId;
  try {
    const loop = await loopController.startLoop({
      tenantId, agentId, objective, maxIterations, cooldownMs, budgetCredits,
      triggeredBy: userId ? `human:${userId}` : `agent:${agentId}`,
    });
    return res.json({ loopId: loop.id, status: loop.status });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

loopRouter.post('/stop', async (req: Request, res: Response) => {
  const tenantId = req.ctx?.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'tenantId required (x-tenant-id header)' });
  const parsed = withLoopId.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  try {
    const loop = await loopController.getLoop(parsed.data.loopId);
    if (loop.tenantId !== tenantId) return res.status(403).json({ error: 'forbidden' });
    await loopController.stopLoop(parsed.data.loopId, parsed.data.reason ?? 'user requested');
    return res.json({ ok: true });
  } catch (err) {
    if ((err as Error).message.startsWith('Loop not found')) return res.status(404).json({ error: 'loop not found' });
    return res.status(500).json({ error: (err as Error).message });
  }
});

loopRouter.post('/resume', async (req: Request, res: Response) => {
  const tenantId = req.ctx?.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'tenantId required (x-tenant-id header)' });
  const parsed = withLoopId.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues });
  try {
    const loop = await loopController.getLoop(parsed.data.loopId);
    if (loop.tenantId !== tenantId) return res.status(403).json({ error: 'forbidden' });
    await loopController.resumeLoop(parsed.data.loopId);
    return res.json({ ok: true });
  } catch (err) {
    if ((err as Error).message.startsWith('Loop not found')) return res.status(404).json({ error: 'loop not found' });
    return res.status(500).json({ error: (err as Error).message });
  }
});

loopRouter.get('/status', async (req: Request, res: Response) => {
  const tenantId = req.ctx?.tenantId ?? (req.query.tenantId as string);
  if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
  try {
    const loop = await loopController.getActiveLoop(tenantId, req.params.agentId);
    return res.json({ loop: loop ?? null });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});
