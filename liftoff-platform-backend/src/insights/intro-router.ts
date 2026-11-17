// Insights Intro Router
//
// GET /api/insights/report/intro?tenantId=<uuid>&period=<preset>
//
// Server-Sent Events endpoint that streams the LLM-generated "insight
// intro text" — the one-paragraph summary that opens the dashboard,
// rendered above the four metric cards. Mirrors observation-router
// (Phase 7) exactly: Phase A (the report data) loads instantly, this
// endpoint is Phase B and takes ~2 seconds because it makes an LLM call,
// so the frontend pulls it lazily and shows a skeleton row in the
// meantime.
//
// SSE event types:
//   event: thinking      sent immediately on connect
//   event: intro         { content: string } — the generated paragraph
//   event: complete      { hasIntro: boolean }
//   event: error         { code, message }
//
// Like observations, the intro is a pure enhancement — if generation
// fails (LLM unreachable, empty tenant, malformed JSON) the frontend
// silently hides the section. The error event tells the browser to
// stop listening but is NOT surfaced as a toast.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { log, logAudit } from '../infrastructure/logging';
import { generateInsightsIntro } from './intro-service';
import type { TimeRangeInput } from './shared-types';

export const introRouter = Router();

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

const introQuerySchema = z.object({
  tenantId: z.string().uuid(),
  period: z.enum(PERIOD_PRESETS).optional().default('this_week'),
  start: z.string().optional(),
  end: z.string().optional(),
});

function sendSseEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

introRouter.get('/report/intro', async (req: Request, res: Response) => {
  // 1. Validate input.
  const parseResult = introQuerySchema.safeParse(req.query);
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

  // 3. Run the intro service and stream the result.
  //
  // intro-service.ts catches all internal errors and returns null. We
  // only need to guard against truly unexpected throws here (e.g.
  // res.write failing after a client disconnect).
  try {
    sendSseEvent(res, 'thinking', {});

    const intro: string | null = await generateInsightsIntro(tenantId, timeRangeInput);

    if (!aborted && !res.writableEnded) {
      if (intro) {
        sendSseEvent(res, 'intro', { content: intro });
      }
      sendSseEvent(res, 'complete', { hasIntro: intro !== null });
    }

    logAudit(
      'insights.intro_generated',
      req.ctx || { tenantId },
      {
        period,
        hasIntro: intro !== null,
        introLength: intro?.length ?? 0,
      },
    );
  } catch (err) {
    log.error(
      {
        tenantId,
        error: (err as Error).message,
        stack: (err as Error).stack,
      },
      'Intro stream endpoint failed unexpectedly',
    );
    if (!aborted && !res.writableEnded) {
      sendSseEvent(res, 'error', {
        code: 'INTERNAL',
        message: 'Failed to generate intro',
      });
    }
  } finally {
    req.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
});
