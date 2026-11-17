// Account profile lookup for other services.
//
// workforce-service renders the facepile on the CAIO chat, but presence lives
// in the `workforce` database and `accounts` lives here, so it cannot join the
// two. It asks instead.
//
// Auth: WORKFORCE_SERVICE_TOKEN only, not the wider set the LLM relay accepts.
// Nothing else needs this, and a narrower token scope is a smaller blast radius.
//
// Access model: the caller names a tenant and the query joins tenant_members,
// so it can only ever learn about people who already share that workspace.
// A leaked token buys a facepile, not the accounts table.
//
// Mounted BEFORE authMiddleware in index.ts.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { AccountRepository } from '../accounts/repository';
import { log } from '../infrastructure/logging';
import { workforceServiceAuth } from './workforce-service-auth';

export const accountProfilesInternalRouter = Router();

const repository = new AccountRepository();

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  accountIds: z.array(z.string().uuid()).min(1).max(100),
});

// POST /profiles
// Body: { tenantId, accountIds[] }
// Returns: { profiles: [{ accountId, firstName, lastName, email, avatarUrl, role }] }
// `role` is the person's tenant role, read live, so the workforce service can
// run a continuation of a Chief AI Officer turn as the person whose message
// started it when no request of theirs is in hand.
accountProfilesInternalRouter.post(
  '/profiles',
  workforceServiceAuth,
  async (req: Request, res: Response) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Validation failed', details: parsed.error.errors });
    }

    try {
      const profiles = await repository.findProfilesByIds(
        parsed.data.tenantId,
        parsed.data.accountIds,
      );
      return res.json({ profiles });
    } catch (err) {
      log.error({ error: (err as Error).message }, 'account profile lookup failed');
      return res.status(500).json({ error: 'Account profile lookup failed' });
    }
  },
);
