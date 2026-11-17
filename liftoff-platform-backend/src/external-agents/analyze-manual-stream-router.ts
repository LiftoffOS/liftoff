// External Agents Analyze Manual Stream Router
// SSE endpoint for streaming progress during manual capability analysis
// Follows discover-stream-router.ts pattern exactly

import { randomUUID } from 'crypto';
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { analyzeManualCapabilities } from './manual-analyzer';
import { log } from '../infrastructure/logging';
import type { AnalyzeManualStage, ManualCapability } from './types';
import type { SensitivityCategory } from '../mcp/tool-classifier';

export const analyzeManualStreamRouter = Router();

// Zod validation schema for manual capability
const manualCapabilitySchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  description: z.string().max(2000),
  toolName: z.string().min(1).max(255),
  sensitivityCategories: z.array(
    z.enum(['customerCommunication', 'financialActions', 'dataChanges', 'externalPublishing', 'hiringDecisions'])
  ).default([]),
});

// Zod validation schema for analyze manual input
const analyzeManualInputSchema = z.object({
  capabilities: z.array(manualCapabilitySchema).min(1).max(50),
  agentName: z.string().min(1).max(255),
  agentDescription: z.string().max(10000).optional().default(''),
});

// POST /api/external-agents/analyze-manual-stream
// SSE endpoint for manual capability analysis with progress updates
analyzeManualStreamRouter.post('/', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  const agentId = req.query.agentId as string | undefined;

  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId is required' });
  }

  // Validate input before setting up SSE
  const parseResult = analyzeManualInputSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: parseResult.error.errors,
    });
  }

  const input = parseResult.data;

  log.info(
    { tenantId, name: input.agentName, capabilityCount: input.capabilities.length },
    'Starting analyze manual stream'
  );

  // Set up SSE headers (same as discover-stream-router.ts)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx/Cloud Run buffering

  // Prevent response compression which can buffer SSE
  res.setHeader('Content-Encoding', 'identity');

  res.flushHeaders();

  // Helper to send SSE events
  const sendEvent = (event: string, data: object) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Handle client disconnect
  let aborted = false;
  req.on('close', () => {
    aborted = true;
    log.info({ tenantId, name: input.agentName }, 'Analyze manual stream client disconnected');
  });

  try {
    // Send progress stages
    sendEvent('progress', { stage: 'connected' as AnalyzeManualStage });

    if (aborted) {
      res.end();
      return;
    }

    sendEvent('progress', { stage: 'validating' as AnalyzeManualStage });

    if (aborted) {
      res.end();
      return;
    }

    sendEvent('progress', { stage: 'analyzing' as AnalyzeManualStage });

    // Convert validated input to ManualCapability type
    const capabilities: ManualCapability[] = input.capabilities.map(c => ({
      id: c.id,
      name: c.name,
      description: c.description,
      toolName: c.toolName,
      sensitivityCategories: c.sensitivityCategories as SensitivityCategory[],
    }));

    const correlationId = agentId ? undefined : randomUUID();

    // Run LLM analysis
    const result = await analyzeManualCapabilities({
      capabilities,
      agentName: input.agentName,
      agentDescription: input.agentDescription,
      tenantId,
      agentId,
      correlationId,
    });

    if (aborted) {
      res.end();
      return;
    }

    sendEvent('progress', { stage: 'classifying' as AnalyzeManualStage });

    if (aborted) {
      res.end();
      return;
    }

    sendEvent('progress', { stage: 'finalizing' as AnalyzeManualStage });

    if (!aborted) {
      sendEvent('complete', { ...result, correlationId });
      log.info({ tenantId, name: input.agentName }, 'Analyze manual stream completed successfully');
    }
  } catch (error) {
    if (!aborted) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      sendEvent('error', { message });
    }
    log.error({ error, tenantId, name: input.agentName }, 'Analyze manual stream failed');
  } finally {
    res.end();
  }
});
