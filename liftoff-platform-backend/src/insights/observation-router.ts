// Insights Observation Router — Phase 7
//
// GET /api/insights/report/observations?tenantId=<uuid>&period=<preset>
//
// Server-Sent Events endpoint that streams the LLM-generated "Key
// Observations" section of the dashboard report. Phase A (the instant
// dashboard data) lives on /api/insights/report; this endpoint is
// Phase B — takes 2-3 seconds to return because it makes an LLM call,
// so the frontend loads it lazily and shows a skeleton in the meantime.
//
// SSE event types:
//   event: thinking      sent immediately on connect
//   event: observation   { block: ObservationBlock } — one per parsed block
//   event: complete      { count }                   — all observations emitted
//   event: error         { code, message }           — terminal failure
//
// The plan treats observations as a pure enhancement — if generation
// fails the frontend silently hides the section. We still emit an error
// event so the browser knows to stop listening, but the frontend does
// NOT surface it as a toast or alert.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { log, logAudit } from '../infrastructure/logging';
import { generateInsightsObservations } from './observation-service';
import type { ObservationBlock, TimeRangeInput } from './shared-types';

export const observationRouter = Router();

const PERIOD_PRESETS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'last_7_days',
  'last_30_days',
  'last_90_days',
  'this_quarter',
  'last_quarter',
  'this_year',
  'last_year',
] as const;

const observationQuerySchema = z.object({
  tenantId: z.string().uuid(),
  period: z.enum(PERIOD_PRESETS).optional().default('this_week'),
  start: z.string().optional(),
  end: z.string().optional(),
});

function sendSseEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

observationRouter.get('/report/observations', async (req: Request, res: Response) => {
  // 1. Validate input.
  const parseResult = observationQuerySchema.safeParse(req.query);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: parseResult.error.errors,
    });
  }
  const { tenantId, period, start, end } = parseResult.data;
  const timeRangeInput: TimeRangeInput =
    start && end ? { start, end } : { preset: period };

  // 2. Set up SSE response.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  res.flushHeaders();

  let aborted = false;
  const onClose = () => {
    aborted = true;
  };
  req.on('close', onClose);

  // 3. Run the observation service and stream results.
  //
  // observation-service.ts catches all internal errors and returns an
  // empty array — we only need to guard against truly unexpected throws
  // here (e.g. the res.write itself failing after a client disconnect).
  try {
    sendSseEvent(res, 'thinking', {});

    const observations: ObservationBlock[] = await generateInsightsObservations(
      tenantId,
      timeRangeInput,
    );

    if (!aborted && !res.writableEnded) {
      for (const block of observations) {
        if (aborted || res.writableEnded) break;
        sendSseEvent(res, 'observation', { block });
      }
      sendSseEvent(res, 'complete', { count: observations.length });
    }

    logAudit(
      'insights.observations_generated',
      req.ctx || { tenantId },
      {
        period,
        observationCount: observations.length,
      },
    );
  } catch (err) {
    log.error(
      {
        tenantId,
        error: (err as Error).message,
        stack: (err as Error).stack,
      },
      'Observation stream endpoint failed unexpectedly',
    );
    if (!aborted && !res.writableEnded) {
      sendSseEvent(res, 'error', {
        code: 'INTERNAL',
        message: 'Failed to generate observations',
      });
    }
  } finally {
    req.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
});
