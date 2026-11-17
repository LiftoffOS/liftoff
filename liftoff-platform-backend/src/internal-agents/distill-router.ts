// Internal Agents Distill Router
// Endpoint for generating internal agent configuration via LLM

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { distillInternalAgent } from './distill-service';
import { createDistillArtifact } from './distill-artifact-store';
import { computeWorkflowVisualizationSteps } from './workflow-visualization-steps-service';
import { teamAttachmentsArraySchema } from './attachment-schema';
import { log } from '../infrastructure/logging';

export const distillRouter = Router();

const integrationInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  selectedObjects: z.array(z.string()).default([]),  // User-selected subset of available objects
});

const distillInputSchema = z.object({
  role: z.string().min(1).max(255),
  responsibilities: z.string().min(1).max(10000),
  integrations: z.array(integrationInfoSchema).max(50).default([]),
  additionalContext: z.string().max(10000).optional().nullable(),  // Optional advanced user guidance
  // Cadences the caller parsed deterministically from the person's words; the
  // analyzer requires the derived trigger set to contain each one.
  expectedCadences: z
    .array(z.object({ prose: z.string().min(1).max(2000), cronExpr: z.string().min(9).max(100) }))
    .max(5)
    .optional(),
  attachments: teamAttachmentsArraySchema.optional(),
  // Declared so zod stops silently dropping it. `z.object()` strips unknown
  // keys, so a templateId the client sent never reached distill-service: the
  // template-seeding hint never fired, and `shouldInjectReviewCycle` never
  // fired either, leaving every Explore hire of the five software-delivery
  // templates without the review-cycle convergence contract.
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
 *  `additionalContext` can be asserted without standing up the route. */
export const __testOnlyDistillInputSchema = distillInputSchema;

// POST /api/internal-agents/distill
// Generate summary, system prompt, and user instructions for an internal agent
distillRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.query.tenantId as string;

    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    // Validate input
    const parseResult = distillInputSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.errors,
      });
    }

    // Spread rather than destructure-and-rebuild. Naming each field here is how
    // a validated key gets dropped one line after being accepted: the schema
    // above declares templateInputs, and rebuilding the object by hand would
    // discard it just as surely as leaving it undeclared.
    const { role, templateId } = parseResult.data;

    log.info({ tenantId, role, templateId }, 'Processing distill request');

    const result = await distillInternalAgent({ ...parseResult.data, tenantId });

    // Persist before responding, so the caller can never hold a handle we did
    // not store. Not best-effort: unlike the fingerprint cache, a write failure
    // here leaves the caller with nothing to create the agent from.
    const distillId = await createDistillArtifact(tenantId, result);

    // Generate visualization steps while the user is still on the page (sequential — needs distilled prompts).
    // Best-effort: failures don't block the response.
    let workflowVisualizationSteps = null;
    try {
      workflowVisualizationSteps = await computeWorkflowVisualizationSteps(
        role, result.systemPrompt, result.userInstructions,
        result.workflowSteps ?? null,
      );
    } catch {
      // non-blocking
    }

    log.info({ tenantId, role, distillId }, 'Distill request completed successfully');

    // Same withholding as the streaming route. workflowVisualizationSteps
    // stays: the update page's Optimize renders it, and it is derived from the
    // prompt rather than being the prompt.
    const { systemPrompt: _sp, userInstructions: _ui, instructionsMd: _im, ...clientResult } = result;
    res.json({ ...clientResult, workflowVisualizationSteps, distillId });
  } catch (error) {
    // Log the error with context, then pass to global error middleware
    // The middleware will return a sanitized error response without exposing internal details
    log.error({ error, tenantId: req.query.tenantId }, 'Distill request failed');
    next(error);
  }
});
