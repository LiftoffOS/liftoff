// Agent Execution Router
// Per Section 1: Agent execution API endpoints

import { Router, Request, Response } from 'express';
import { agentExecutionService } from './service';
import { logger } from '../infrastructure/logging';

const router = Router();

// Execute a task for an agent
router.post('/execute', async (req: Request, res: Response) => {
  try {
    const { tenantId, agentId, workflowId, taskId, objective, inputData } = req.body;

    if (!tenantId || !agentId || !workflowId || !taskId || !objective) {
      return res.status(400).json({
        error: 'Missing required fields: tenantId, agentId, workflowId, taskId, objective',
      });
    }

    const result = await agentExecutionService.executeTask({
      tenantId,
      agentId,
      workflowId,
      taskId,
      objective,
      inputData,
    });

    if (!result.success && result.error === 'agent_already_running') {
      return res.status(409).json({ error: 'agent_already_running' });
    }
    // 409 Conflict — agent is not in ACTIVE state (PAUSED / ARCHIVED /
    // unknown). The executeTask service-level guard fast-fails on the
    // lifecycle check and we surface it at the HTTP layer so callers can
    // distinguish "this agent will never run right now" from generic
    // 500-shaped failures. Previously this returned 200 with success=false,
    // which made the runtime look healthy to Envoy while quietly
    // discarding the request.
    if (!result.success && result.error?.includes('is not in ACTIVE state')) {
      return res.status(409).json({ error: result.error });
    }
    // 402-style "admission denied" — out of credits, suspended tenant,
    // governance kill switch. Surface as 403 so the caller knows the
    // request reached the runtime but was refused by policy, not by an
    // internal failure.
    if (!result.success && result.error?.startsWith('Admission denied:')) {
      return res.status(403).json({ error: result.error });
    }

    // Progress workflow based on result
    await agentExecutionService.progressWorkflow(workflowId, taskId, result);

    return res.status(200).json(result);
  } catch (error) {
    logger.error('Agent execution failed', { error: (error as Error).message });
    return res.status(500).json({ error: (error as Error).message });
  }
});

// Get execution status (for polling)
router.get('/status/:taskId', async (req: Request, res: Response) => {
  try {
    // This would query the execution state from the database
    // For now, return a placeholder
    return res.status(200).json({
      taskId: req.params.taskId,
      status: 'unknown',
      message: 'Status endpoint - implementation pending',
    });
  } catch (error) {
    logger.error('Failed to get execution status', { error: (error as Error).message });
    return res.status(500).json({ error: (error as Error).message });
  }
});

export { router as agentExecutionRouter };
