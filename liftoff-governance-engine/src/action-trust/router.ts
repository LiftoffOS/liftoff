// Action-trust router. Mounted in server.ts at `/api/governance/action-trust`, BEHIND the
// global verifyServiceAuth({ tokenEnvVar: 'GOVERNANCE_SERVICE_TOKEN' }) middleware — the
// same service-token gate as every other REST route.
//
//   GET /            → Trust standing: the tier computed on-read from the
//                      `action_trust_decisions` ledger (the table POST /decisions populates),
//                      using the calibrated TRUST_AUTO/QUEUE pass-rate operating points →
//                      TrustResult {tier,runs,passRate,distinctApprovers} | 404. SHADOW /
//                      read-only: consumed by tenant-runtime's shadow HITL gate + the autonomy
//                      advisor; it never changes a gate today. Unset thresholds ⇒ 404 so
//                      uncalibrated numbers never leak. (getAgentActionTrust — the separate
//                      `agent_action_trust` rollup — is a parallel substrate, not served here.)
//   POST /decisions  → ingestion of approval-resolution + late-feedback trust decisions from
//                      platform-backend / tenant-runtime, idempotent on sourceKey, into the
//                      decisions ledger (action_trust_decisions).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { withTenantScope } from '../infrastructure/database';
import { insertDecisions } from './repository';
import { getTrust } from './service';
import type { DecisionRow } from './types';
import { log } from '../infrastructure/logging';

export const actionTrustRouter = Router();

// GET /api/governance/action-trust?tenantId=&agentId=&actionClass=
// Returns TrustResult {tier, runs, passRate, distinctApprovers} for the (tenant, agent,
// action_class), or 404 when there is no calibrated tier yet (thresholds unset, or runs
// below TRUST_MIN_RUNS — never leak an uncalibrated number).
actionTrustRouter.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    const agentId = req.query.agentId as string | undefined;
    const actionClass = req.query.actionClass as string | undefined;

    if (!tenantId || !agentId || !actionClass) {
      return res
        .status(400)
        .json({ error: 'tenantId, agentId, and actionClass are required' });
    }

    const trust = await getTrust(tenantId, agentId, actionClass);
    if (!trust) {
      return res.status(404).json({ error: 'No trust record found' });
    }
    res.json(trust);
  } catch (error) {
    log.error(
      { error: (error as Error).message },
      'Failed to get action trust',
    );
    res.status(500).json({ error: (error as Error).message });
  }
});

const decisionSchema = z.object({
  actionClass: z.string().min(1),
  decision: z.enum(['approved', 'rejected']),
  decidedBy: z.string().min(1),
  decidedAt: z.string().min(1),
  sourceKey: z.string().min(1),
});

const postBodySchema = z
  .object({
    tenantId: z.string().min(1),
    agentId: z.string().min(1),
    gateReason: z.string().min(1),
    approvalId: z.string().min(1).optional(),
    feedbackId: z.string().min(1).optional(),
    decisions: z.array(decisionSchema).min(1),
  })
  .refine((b) => (b.approvalId ? 1 : 0) + (b.feedbackId ? 1 : 0) === 1, {
    message: 'exactly one of approvalId | feedbackId is required',
  });

// POST /api/governance/action-trust/decisions → { inserted }
actionTrustRouter.post('/decisions', async (req: Request, res: Response) => {
  const parsed = postBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.issues });
  }
  const body = parsed.data;
  // source is INFERRED from which id is present (the body has no source field).
  const sourceIdentity = body.approvalId ?? body.feedbackId!;
  const source: DecisionRow['source'] = body.approvalId ? 'hitl_resolve' : 'late_feedback';
  // Every decisions[i].sourceKey must equal '<thatId>:<actionClass>'.
  for (const d of body.decisions) {
    if (d.sourceKey !== `${sourceIdentity}:${d.actionClass}`) {
      return res.status(400).json({ error: 'sourceKey_mismatch', actionClass: d.actionClass });
    }
  }
  const rows: DecisionRow[] = body.decisions.map((d) => ({
    tenantId: body.tenantId,
    agentId: body.agentId,
    actionClass: d.actionClass,
    gateReason: body.gateReason,
    decision: d.decision,
    decidedBy: d.decidedBy,
    decidedAt: d.decidedAt,
    source,
    sourceKey: d.sourceKey,
  }));
  try {
    const inserted = await withTenantScope(body.tenantId, (client) => insertDecisions(client, rows));
    return res.json({ inserted });
  } catch (err) {
    log.error({ err: (err as Error).message, tenantId: body.tenantId }, 'action-trust decisions insert failed');
    return res.status(500).json({ error: 'insert_failed' });
  }
});
