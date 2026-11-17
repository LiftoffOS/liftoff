// The three endpoints behind /dashboard/refer.
//
// Mounted at /api/referrals in src/index.ts behind
// tenantAuthMiddleware('viewDashboard'), which verifies the caller is a member
// of the workspace they named before setting req.ctx.tenantId. That middleware
// is the only place a verified tenant id reaches a request, so every handler
// here reads it from there and never from the query string it was resolved
// from. viewDashboard is true for every role, matching the page's place in the
// account menu: anyone who can see the workspace can share its link.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import {
  InvitesNotPermittedError,
  NoReferralProgramError,
  ReferralService,
} from './service';
import { REFERRAL_INVITE_BATCH_MAX, REFERRAL_INVITE_MESSAGE_MAX } from './constants';

export const referralsRouter = Router();

const service = new ReferralService();

const tenantQuerySchema = z.object({ tenantId: z.string().uuid() });

/** The page asks for 50 and pages with a cursor. The ceiling is its own
 *  defence: an unbounded limit turns one request into a full-table read. */
const listQuerySchema = tenantQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

const inviteBodySchema = z.object({
  emails: z.array(z.string().min(1).max(254)).min(1).max(REFERRAL_INVITE_BATCH_MAX),
  message: z.string().max(REFERRAL_INVITE_MESSAGE_MAX).optional(),
});

/**
 * The tenant the middleware actually verified.
 *
 * tenantAuthMiddleware resolves the id from the query string and then checks
 * membership against it before setting req.ctx.tenantId. Reading the verified
 * value, and refusing when it disagrees with what was parsed, keeps the two
 * from drifting.
 */
function verifiedTenant(req: Request, res: Response, claimed: string): string | null {
  const verified = req.ctx?.tenantId;
  if (!verified || verified !== claimed) {
    res.status(403).json({ error: 'Not a member of this tenant' });
    return null;
  }
  return verified;
}

referralsRouter.get('/program', async (req: Request, res: Response) => {
  const parsed = tenantQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.issues });
  }
  const tenantId = verifiedTenant(req, res, parsed.data.tenantId);
  if (!tenantId) return undefined;

  try {
    return res.json(await service.getProgram(tenantId));
  } catch (error) {
    // A workspace with no programme is a legitimate answer, not a fault — an
    // enterprise contract, say. The frontend does not retry 4xx, so this costs
    // one request and the page shows its error state rather than spinning.
    if (error instanceof NoReferralProgramError) {
      return res.status(404).json({ error: 'No referral program for this workspace' });
    }
    log.error(
      { tenantId, error: (error as Error).message },
      'referrals: failed to build the programme payload',
    );
    return res.status(500).json({ error: 'Failed to load referral program' });
  }
});

referralsRouter.get('/', async (req: Request, res: Response) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.issues });
  }
  const tenantId = verifiedTenant(req, res, parsed.data.tenantId);
  if (!tenantId) return undefined;

  try {
    const page = await service.listReferrals(
      tenantId,
      parsed.data.limit,
      parsed.data.cursor ?? null,
    );
    return res.json(page);
  } catch (error) {
    log.error(
      { tenantId, error: (error as Error).message },
      'referrals: failed to list referrals',
    );
    return res.status(500).json({ error: 'Failed to load referrals' });
  }
});

referralsRouter.post('/invites', async (req: Request, res: Response) => {
  const parsedQuery = tenantQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res
      .status(400)
      .json({ error: 'Invalid query parameters', details: parsedQuery.error.issues });
  }
  const tenantId = verifiedTenant(req, res, parsedQuery.data.tenantId);
  if (!tenantId) return undefined;

  const parsedBody = inviteBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsedBody.error.issues });
  }

  try {
    const result = await service.sendInvites(
      tenantId,
      parsedBody.data.emails,
      parsedBody.data.message,
      req.user?.uid,
    );
    return res.json(result);
  } catch (error) {
    if (error instanceof InvitesNotPermittedError) {
      // 402 for both causes. This endpoint sends mail from a Liftoff domain to
      // addresses the caller chooses; ungated it is a mail relay wearing our
      // sending reputation, and the damage lands on password resets and
      // verification links rather than on the programme.
      return res.status(402).json({ error: error.message });
    }
    if (error instanceof NoReferralProgramError) {
      return res.status(404).json({ error: 'No referral program for this workspace' });
    }
    log.error(
      { tenantId, error: (error as Error).message },
      'referrals: failed to send invitations',
    );
    return res.status(500).json({ error: 'Failed to send invitations' });
  }
});
