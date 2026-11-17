// Internal Agents Distill Stream Router
// SSE endpoint for streaming progress during internal agent configuration generation

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { distillInternalAgentWithProgress, type DistillStage } from './distill-service';
import { DistillationGraphNotConvergedError } from './distill-errors';
import { createDistillArtifact } from './distill-artifact-store';
import { DistillationStructuralError } from './trigger-config-analyzer';
import { checkAndIncrementChatRateLimit, type ChatRateLimitCaps } from '../common/chat-rate-limiter';
import { teamAttachmentsArraySchema } from './attachment-schema';
import { AccountService } from '../accounts/service';
import { log } from '../infrastructure/logging';
import type { DistillErrorCode, DistillStructuralViolation } from '@liftoffos/shared-types';

// D-5.10: Tighter rate-limit caps for distill (LLM-heavy, expensive)
const DISTILL_RATE_LIMITS: ChatRateLimitCaps = {
  tenant: { maxPerMinute: 10, maxPerHour: 60, maxPerDay: 200 },
  user: { maxPerMinute: 5, maxPerHour: 30, maxPerDay: 100 },
};

export const distillInternalAgentStreamRouter = Router();

const accountService = new AccountService();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const integrationInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  selectedObjects: z.array(z.string()).default([]),
});

const distillInputSchema = z.object({
  role: z.string().min(1).max(255),
  responsibilities: z.string().min(1).max(10000),
  integrations: z.array(integrationInfoSchema).max(50).default([]),
  additionalContext: z.string().max(10000).optional().nullable(),
  attachments: teamAttachmentsArraySchema.optional(),
  // Declared so zod stops silently dropping it. The handler spreads
  // `parseResult.data` into distillInternalAgent, and `z.object()` strips
  // unknown keys, so the templateId the Explore page has always sent was
  // discarded here: template seeding never fired, and neither did
  // `shouldInjectReviewCycle`, so an Explore hire of software-engineer,
  // code-reviewer, security-engineer, performance-engineer or incident-manager
  // never received the review-cycle convergence contract.
  templateId: z.string().max(200).optional(),
  // Answers to the inputs the template declared, keyed by input id. Declared
  // for the same reason as templateId above: undeclared keys are stripped here
  // without a word, and this one fails in the worst way — the team is hired,
  // runs, and produces work for a company nobody named.
  templateInputs: z.record(z.string().max(60), z.string().max(2000)).optional(),
  // Destinations the person named in the pickers, keyed by template object id.
  // Same stripping hazard, same invisible failure: undeclared, every pick is
  // dropped here and the prose falls back to "your team channel" as though
  // nobody had chosen anything.
  templatePicks: z.record(
    z.string().max(100),
    z.object({
      id: z.string().max(500),
      title: z.string().max(500),
      // Only a DESTINATION sends this, and it is the difference between a place
      // to work in and the deliverable itself. Undeclared here, both routers
      // stripped it — so the file/folder rule could never fire on a
      // distillation, and a person who picked a document got a graph that
      // created new ones beside it. The create route has always declared it.
      kind: z.enum(['folder', 'file']).optional(),
    }),
  ).optional(),
});

/** Test-only handle on the schema above, so the passthrough of `templateId` and
 *  `additionalContext` can be asserted without standing up the SSE route. */
export const __testOnlyDistillInputSchema = distillInputSchema;

// POST /api/internal-agents/distill-stream
// SSE endpoint for generating internal agent configuration with progress updates
distillInternalAgentStreamRouter.post('/', async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string;
  const agentId = req.query.agentId as string | undefined;

  // Shape-checked, not just present: it is written to a UUID column by the rate
  // limiter, which now rejects a non-UUID rather than absorbing it as a database
  // error. A bad tenantId is a client mistake and reads as 400 here.
  if (!tenantId || !UUID_RE.test(tenantId)) {
    return res.status(400).json({ error: 'tenantId is required' });
  }

  // Validate input before setting up SSE
  const parseResult = distillInputSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: parseResult.error.errors,
    });
  }

  const input = parseResult.data;

  // ── Rate limiting ───────────────────────────────────────────────────
  // `req.ctx.userId` is the Firebase uid the auth middleware validated, never an
  // account id. The ledger keys on `account_id UUID`, so the uid has to be
  // resolved first — passing it straight through made every insert fail and the
  // limiter fail open, leaving this surface unthrottled. Same resolution the web
  // chat entry point does before its own admission check.
  const firebaseUid = req.ctx?.userId;
  if (!firebaseUid) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const account = await accountService.getByFirebaseUid(firebaseUid);
  if (!account) {
    return res.status(401).json({ error: 'Account not found' });
  }

  const rateResult = await checkAndIncrementChatRateLimit({
    tableName: 'distill_rate_limit_events',
    tenantId,
    accountId: account.id,
    limits: DISTILL_RATE_LIMITS,
  });

  if (!rateResult.allowed) {
    log.info({
      metric: 'distill.rate_limited',
      scope: 'tenant',
      tenantId,
      retryAfter: rateResult.retryAfter,
    }, 'Distill rate limited');

    return res.status(429).json({
      error: 'Rate limit exceeded',
      errorCode: 'rate_limited' as DistillErrorCode,
      retryAfter: rateResult.retryAfter,
    });
  }

  // A/B arm selection.
  //
  // Per request rather than per deployment, so the harness can alternate arms
  // against one build: two arms from two deploys would measure the deploys as
  // much as the change, and the differences being measured are tens of seconds.
  //
  // Refused outright in prod. This is an experiment with a live retry path and
  // six concurrent calls per distillation; letting a query parameter turn it on
  // for a paying workspace is not a risk worth carrying for the convenience of
  // not redeploying. An unrecognised value is ignored rather than rejected, so
  // a stale harness cannot fail a real hire.
  const requestedStrategy = req.query.strategy;
  let strategy: 'single' | 'waved' | undefined;
  if (requestedStrategy === 'waved' || requestedStrategy === 'single') {
    const isProd = (process.env.ENVIRONMENT ?? 'dev') === 'prod';
    if (requestedStrategy === 'waved' && isProd) {
      log.warn({ tenantId }, 'Refusing waved distill strategy in prod; falling back to single');
      strategy = 'single';
    } else {
      strategy = requestedStrategy;
    }
  }

  log.info({ tenantId, role: input.role, strategy: strategy ?? 'single' }, 'Starting distill stream');

  // Set up SSE headers
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

  // Send initial connected event
  sendEvent('progress', { stage: 'connected' as DistillStage });

  // Handle client disconnect
  let aborted = false;
  req.on('close', () => {
    aborted = true;
    log.info({ tenantId, role: input.role }, 'Distill stream client disconnected');
  });

  try {
    // Progress callback - sends SSE events as stages complete
    const onProgress = (stage: DistillStage) => {
      if (!aborted) {
        sendEvent('progress', { stage });
      }
    };

    // Per-branch events for the waved strategy. The summary is the field the
    // confirmation screen actually renders, so announcing it the moment it
    // lands is the whole point of the split; the graph is announced because it
    // is what the create payload waits on.
    //
    // Neither carries a withheld prompt field, so no filtering is needed here —
    // but that is a property of BRANCH_FIELDS rather than of this callback, so
    // the branches are named explicitly rather than forwarding whatever arrives.
    const onBranchReady = (branch: string, value: Record<string, unknown>) => {
      if (aborted) return;
      if (branch === 'summary') {
        sendEvent('summary_ready', { summary: value.summary });
      } else if (branch === 'graph') {
        sendEvent('graph_ready', {
          workflowSteps: value.workflowSteps ?? null,
          triggerConfig: value.triggerConfig ?? null,
        });
      }
    };

    const sessionId = agentId ? undefined : randomUUID();
    const result = await distillInternalAgentWithProgress(
      { ...input, tenantId, agentId, sessionId, ...(strategy && { strategy }) },
      onProgress,
      onBranchReady,
    );

    if (!aborted) {
      // Generation is done; persistence has not happened yet.
      //
      // A distinct moment from `complete` below, not a rename of it. Between
      // the two the artifact is written to distill_artifacts, and that write can
      // fail — so `artifact_complete` says the model is finished and nothing is
      // still being generated, while `complete` says the result is persisted and
      // redeemable. Under the waved strategy this is the event that closes the
      // window the summary opened, which is why the plan asks for it by name.
      sendEvent('artifact_complete', {
        agentType: result.agentType,
        summary: result.summary,
        hasWorkflowSteps: Array.isArray(result.workflowSteps) && result.workflowSteps.length > 0,
      });

      // Persist before announcing, so a handle never names a row we failed to
      // write. A throw here lands in the catch below and surfaces as an SSE
      // error event, which is the honest outcome: a distillation the caller
      // cannot redeem is a failed distillation, not a successful one.
      // Skipped when aborted — nobody is left to redeem it.
      const distillId = await createDistillArtifact(tenantId, result);

      // The compiled prompt is withheld: the caller redeems distillId on
      // create/update and the server reads it from the artifact. Spreading
      // `result` wholesale is what used to put it on the wire, so the three
      // fields are removed by name rather than by hoping the spread narrows.
      const { systemPrompt: _sp, userInstructions: _ui, instructionsMd: _im, ...clientResult } = result;
      const completePayload: Record<string, unknown> = {
        ...clientResult,
        ...(sessionId && { distillSessionId: sessionId }),
        distillId,
      };
      sendEvent('complete', completePayload);
      log.info({ tenantId, role: input.role, agentType: result.agentType, distillId }, 'Distill stream completed successfully');
    }
  } catch (error) {
    if (!aborted) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      // Structural-analyzer rejection is a distinct, instance-checked branch —
      // the frontend renders rule-specific guidance and includes the violation
      // list so users see exactly which field/connector was wrong instead of
      // a generic "distillation failed".
      if (error instanceof DistillationGraphNotConvergedError) {
        // No message on purpose: the wizard renders its own fallback copy for
        // an empty one, and the specific sentence is the product's to write.
        // The code and the rejection types are what a caller can act on.
        sendEvent('error', {
          message: '',
          errorCode: 'graph_not_converged' satisfies DistillErrorCode,
          rejections: error.reasons,
          stepCount: error.stepCount,
        });
      } else if (error instanceof DistillationStructuralError) {
        const violations: DistillStructuralViolation[] = error.violations.map(v => ({
          rule: v.rule,
          severity: v.severity,
          message: v.message,
          ...(v.detail && { detail: v.detail }),
        }));
        sendEvent('error', {
          message,
          errorCode: 'structural_validation_failed' satisfies DistillErrorCode,
          violations,
        });
      } else {
        // Map error to errorCode via message substring — covers transient LLM
        // failures, rate-limit messages, and validator paths that don't carry
        // a typed error.
        let errorCode: DistillErrorCode = 'unknown';
        if (message.match(/rate limit|too many requests/i)) {
          errorCode = 'rate_limited';
        } else if (message.match(/timeout|503|502|504|overloaded|unavailable/i)) {
          errorCode = 'llm_unavailable';
        } else if (message.match(/budget|credit|quota/i)) {
          errorCode = 'llm_budget_exhausted';
        } else if (message.match(/too many integrations/i)) {
          errorCode = 'too_many_integrations';
        } else if (message.match(/catalog/i)) {
          errorCode = 'catalog_fetch_failed';
        } else if (message.match(/validation/i)) {
          errorCode = 'validation_failed';
        } else if (message.match(/semantic/i)) {
          errorCode = 'semantic_validation_failed';
        }

        sendEvent('error', { message, errorCode });
      }
    }
    log.error({ error, tenantId, role: input.role }, 'Distill stream failed');
  } finally {
    res.end();
  }
});
