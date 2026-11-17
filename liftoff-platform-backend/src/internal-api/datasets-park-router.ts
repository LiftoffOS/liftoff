// Parking, for the surfaces that do not run in this process: the tenant
// runtime's in-process tool gateway and the Chief AI Officer's tool loop.
//
// WHY THIS IS NOT A ROUTE ON THE CAPABILITY ROUTER, which is where it would
// naturally have gone. That router is mounted at
// `/api/internal/capability-discovery` behind `express.json({ limit: '64kb' })`
// — correct for a search spec, and exactly wrong here. A nested route would
// have sat at the wrong path AND rejected, with a 413 the caller reads as a
// failed park, almost every payload over the threshold that makes parking
// worth doing at all. So this is its own mount, with its own limit, stated:
//
//   MAXIMUM ACCEPTED PAYLOAD: 8 MB.
//
// Above that express answers 413 and the caller falls back to a bounded inline
// result — never the original, which is the outcome parking exists to prevent.
// 8 MB is far above any realistic tool result (results run to kilobytes, not
// megabytes) and far below Cloud Run's own 32 MB request ceiling, so the limit
// is a guard rather than a bound anything real runs into.
//
// Same service auth as the capability routes: the tenant runtime or the
// workforce service, by token, timing-safe. Mounted BEFORE authMiddleware —
// the caller is a service, and the body carries the tenant context it already
// holds.

import { Router, type Response } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { parkOversizedTextBlocks, parkValue, type McpEnvelope } from '../datasets/park';
import type { DatasetScope } from '../datasets/store';
import { capabilityServiceAuth, type CapabilityAuthedRequest } from './capability-service-auth';

export const datasetsParkInternalRouter = Router();

/** The body limit this route is mounted with, named here so the number and the
 *  sentence that explains it cannot drift apart. */
export const PARK_BODY_LIMIT = '8mb';

datasetsParkInternalRouter.use(capabilityServiceAuth);

const SCOPE_KIND = z.enum(['liftoff_thread', 'insights_thread', 'caio_thread', 'agent_run']);

const parkSchema = z.object({
  tenantId: z.string().min(1),
  /** The job the result belongs to — a run, a conversation — which is what
   *  dataset_list lists and what dataset_query reads. */
  scopeKind: SCOPE_KIND,
  scopeId: z.string().min(1).max(200),
  /** Model-facing name for what the records are. Never a vendor. */
  label: z.string().min(1).max(200),
  /** Operator-facing provenance, as capability_usage_evidence names it. */
  source: z.string().min(1).max(120),
  sourceRef: z.string().min(1).max(400),
  /** An MCP result envelope. Its oversized successful TEXT blocks are replaced
   *  with dataset views; `_meta`, `isError`, every non-text block and every
   *  block under the bound come back exactly as they went in. */
  result: z.object({}).passthrough().optional(),
  /** A bare result instead: the model-facing text, and optionally the value
   *  behind it (parked in preference to the text, so a tool that returned an
   *  object lands as the record it is). */
  text: z.string().optional(),
  payload: z.unknown().optional(),
});

datasetsParkInternalRouter.post('/', async (req: CapabilityAuthedRequest, res: Response) => {
  const parsed = parkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  }
  const { tenantId, scopeKind, scopeId, label, source, sourceRef, result, text } = parsed.data;
  if (result === undefined && text === undefined) {
    return res.status(400).json({ error: 'Either `result` (an MCP envelope) or `text` is required' });
  }
  const scope: DatasetScope = { kind: scopeKind, id: scopeId };
  const src = { label, source, sourceRef };
  try {
    if (result !== undefined) {
      const out = await parkOversizedTextBlocks(tenantId, result as McpEnvelope, scope, src);
      return res.json({ result: out.result, parked: out.parked });
    }
    // `payload` rides through as the raw value; `undefined` there means "park
    // the text", which is the correct reading of a caller that sent none.
    //
    // `parked` is answered on this path as well as on the envelope path above.
    // Without it a caller could not tell a park from a bounded copy, and the one
    // caller that must point a model at the dataset read the ABSENCE of it as
    // "nothing was parked" — see the tenant runtime's step-output offload, which
    // reported exactly that on every oversized step output it ever handled.
    const bounded = await parkValue(tenantId, text as string, scope, src, parsed.data.payload);
    return res.json({ text: bounded.text, parked: bounded.parked });
  } catch (error) {
    // The caller's fallback is a bounded inline result, so a failure here must
    // be visible as one rather than as a body it would put in a model's
    // context.
    log.error({ error, tenantId, scope, source, sourceRef }, 'internal dataset park failed');
    return res.status(500).json({ error: 'park failed' });
  }
});
