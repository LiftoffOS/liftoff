// Notification links — resolve an opaque /notification/<id> to its destination.
//
//   GET /api/notification-links/:id → {tenantId, destination, ...}
//
// There is no create endpoint. Links are minted server-side when a notification
// is enqueued; nothing a client sends should be able to create one.
//
// Mounted below the global authMiddleware + accessGateMiddleware (index.ts), so
// req.ctx.userId is always the verified Firebase UID.
//
// Access model, copied deliberately from chat-shares: tenant membership is the
// floor, and unknown id / non-member / deleted target all answer with the SAME
// 404 body. Distinguishing them would turn this endpoint into an oracle for
// which link ids exist and which tenants a person does not belong to.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members';
import { log } from '../infrastructure/logging';
import { findLinkById } from './repository';

export const notificationLinksRouter = Router();
const accountService = new AccountService();

const NOT_FOUND = { error: 'Notification link not found' };

notificationLinksRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    // Non-UUID ids are indistinguishable from unknown ids, and never reach pg,
    // whose uuid cast would 500 on them.
    if (!z.string().uuid().safeParse(req.params.id).success) {
      return res.status(404).json(NOT_FOUND);
    }

    // Manual caller chain rather than resolveCaller, matching chat-shares: its
    // non-member 404 body would differ from the unknown-id body and leak that
    // the link exists.
    if (!req.ctx?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const account = await accountService.getByFirebaseUid(req.ctx.userId);
    if (!account) {
      return res.status(401).json({ error: 'Account not found' });
    }

    const link = await findLinkById(req.params.id);
    if (!link) return res.status(404).json(NOT_FOUND);

    // Membership is re-checked on every read, with this reader's identity. A
    // link is a shortcut to a destination, never a grant of access to one, so
    // it stops working the moment somebody leaves the workspace.
    const membership = await tenantMembersService.getMembership(link.tenantId, account.id);
    if (!membership) return res.status(404).json(NOT_FOUND);

    return res.status(200).json(link);
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to resolve notification link',
    );
    return res.status(500).json({ error: 'Failed to resolve notification link' });
  }
});
