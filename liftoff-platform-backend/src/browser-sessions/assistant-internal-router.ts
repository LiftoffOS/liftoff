// The browser, for a platform assistant that runs in ANOTHER service.
//
// Liftoff and the Insights Manager run their tool loops inside this process and
// call executeBrowserAssistantTool directly. The Chief AI Officer runs in
// workforce-service against its own database, so it reaches the identical
// function through this endpoint instead.
//
// Why route it through here rather than giving workforce-service its own
// browser client: the tenant runtime's address is resolved per tenant by this
// service, the session RPCs are ours to call, and the browser tools' behaviour —
// what a refusal says, when a session may be spawned, which address is refused —
// must be the same for all three assistants. A second client would be a second
// implementation of all of that, and the half nobody is watching is where the
// guard goes missing.
//
// Mounted BEFORE the Firebase auth gate: the caller is a service, not a person.

import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { Code, ConnectError } from '@connectrpc/connect';
import { log } from '../infrastructure/logging';
import {
  executeBrowserAssistantToolDetailed,
  isBrowserAssistantTool,
} from './assistant-tools';
import { readTakeoverActivity } from './takeover-activity';
import { buildAssistantBrowserState } from './browser-state';
import { BROWSER_EVENT_NOT_PENDING, verifyBrowserEvent } from './handback';

export const assistantBrowserInternalRouter = Router();

/** WF → PB service auth, the same token and shape the CAIO's other tools use
 *  (see team-provisioning/router.ts). */
function serviceAuth(req: Request, res: Response, next: () => void): void {
  const token = req.headers['x-service-auth'] as string | undefined;
  const expected = process.env.WORKFORCE_SERVICE_TOKEN;
  if (!expected) { res.status(500).json({ error: 'Service authentication not configured' }); return; }
  const ok =
    token &&
    Buffer.byteLength(token) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!ok) { res.status(401).json({ error: 'Invalid service authentication' }); return; }
  next();
}

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  threadId: z.string().uuid(),
  tool: z.string().min(1).max(100),
  input: z.record(z.unknown()).default({}),
  /** The person whose message triggered the CAIO's turn. Required to spawn a
   *  session, and NOT defaulted here: an interactive browser someone can be
   *  asked to take over needs a real person behind it, and inventing one to
   *  satisfy a schema is how that rule would be lost. */
  senderAccountId: z.string().uuid().optional(),
});

/** POST /api/internal/assistant-browser
 *
 *  Runs one browser tool on behalf of a platform assistant in another service.
 *
 *  The thread is NOT re-validated here. workforce-service owns team_plan_threads
 *  and has already established that the thread belongs to the tenant it names —
 *  this endpoint cannot check it without a call back across the boundary, and a
 *  check that cannot be made is better stated than faked. The trust boundary is
 *  the service token, exactly as it is for every other CAIO tool that reaches
 *  into this service. */
assistantBrowserInternalRouter.post('/assistant-browser', serviceAuth, async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
  const { tenantId, threadId, tool, input, senderAccountId } = parsed.data;

  if (!isBrowserAssistantTool(tool)) {
    return res.status(400).json({ error: `${tool} is not a browser tool` });
  }

  // Never throws: the shared executor turns every failure into words the model
  // can act on, so the CAIO gets a reason rather than a dead turn. The
  // detailed form, so the Chief AI Officer's own tool trail keeps the loop's
  // steps and the completeness flags beside the words: `steps` is null only
  // when the tool has no observation mechanism (a navigation, a read).
  const result = await executeBrowserAssistantToolDetailed(tool, input, {
    tenantId,
    threadId,
    surface: 'team_plan',
    ...(senderAccountId ? { senderAccountId } : {}),
  });

  return res.status(200).json({
    message: result.content,
    steps: result.trail.steps,
    stepsTruncated: result.trail.stepsTruncated,
    captureGap: result.trail.captureGap,
    gapReason: result.trail.gapReason,
    safeInstruction: result.safeInstruction,
    instructionTruncated: result.instructionTruncated,
    instructionProtectedDataOmitted: result.instructionProtectedDataOmitted,
  });
});

const takeoversBodySchema = z.object({
  tenantId: z.string().uuid(),
  threadId: z.string().uuid(),
  /** One hold, named: the caller is verifying a claim about the person's
   *  hand-back or point before it writes a row and runs a turn. */
  holdId: z.string().uuid().optional(),
  /** Which claim; a hand-back when absent. */
  // 'point' is still ACCEPTED and answers a 409 rather than a 400: the Option-
  // click gesture is gone from every client, and workforce-service deploys on
  // its own cadence, so a build that still names it gets the honest answer
  // (there is no such pending event) instead of a validation failure that
  // reads like the endpoint broke.
  kind: z.enum(['handback', 'point']).optional(),
});

/** POST /api/internal/assistant-browser/takeovers
 *
 *  The person's own takeover segments on a Chief AI Officer thread, oldest
 *  first, redacted, under the takeover budget: what workforce-service's
 *  `conversation__read` merges into the work record. A runtime failure other
 *  than an older runtime's Unimplemented (read as no holds) is logged and
 *  answered 503, so the caller can say the segments were unavailable rather
 *  than present a record without them as complete.
 *
 *  With `holdId`, the read is the verification the chat surfaces of this
 *  service make themselves before a browser event turn: the hold must be
 *  this thread's, released, and recent. It answers `{ event }` or 409
 *  `handback_not_pending`, exactly as the stream routers here do. A caller
 *  still naming the retired 'point' kind gets the 409, not a 400. */
assistantBrowserInternalRouter.post('/assistant-browser/takeovers', serviceAuth, async (req, res) => {
  const parsed = takeoversBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
  const { tenantId, threadId, holdId, kind } = parsed.data;
  try {
    if (holdId) {
      const event = kind === 'point' ? null : await verifyBrowserEvent(tenantId, threadId, 'handback', holdId);
      if (!event) return res.status(409).json({ error: BROWSER_EVENT_NOT_PENDING });
      return res.status(200).json({ event });
    }
    const { takeovers, truncated } = await readTakeoverActivity(tenantId, threadId);
    return res.status(200).json({ takeovers, truncated });
  } catch (err) {
    const code = err instanceof ConnectError ? Code[err.code] : undefined;
    log.error({ err: (err as Error).message, code, tenantId, threadId }, 'assistant-browser takeovers: the runtime could not answer');
    return res.status(503).json({ error: 'The takeover segments could not be read right now' });
  }
});

const stateBodySchema = z.object({
  tenantId: z.string().uuid(),
  threadId: z.string().uuid(),
  /** When the Chief AI Officer last SPOKE on the thread (a speech row, never
   *  a status row), ISO 8601; null when it has not yet. Its history is in
   *  workforce-service, so it says. */
  sinceLastReply: z.string().datetime({ offset: true }).nullable().optional(),
});

/** POST /api/internal/assistant-browser/state
 *
 *  The Browser section for a Chief AI Officer turn, rendered here so the
 *  three platform assistants read the browser in one phrasing. `block` is
 *  empty when the thread has no session and no record; a runtime failure is
 *  the same empty block, logged, because a turn must never fail over its
 *  Browser section. */
assistantBrowserInternalRouter.post('/assistant-browser/state', serviceAuth, async (req, res) => {
  const parsed = stateBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed' });
  const { tenantId, threadId, sinceLastReply } = parsed.data;
  const block = await buildAssistantBrowserState({ tenantId, threadId, sinceLastReply: sinceLastReply ?? null });
  return res.status(200).json({ block });
});
