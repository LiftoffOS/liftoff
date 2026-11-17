// Chat share links — workspace-scoped share URLs for every chat surface.
//
//   POST /api/chat-shares          → find-or-create the canonical link for a thread
//   GET  /api/chat-shares/:shareId → resolve a link to {tenantId, threadId, threadKind}
//                                    plus agentId on the kinds that have one
//
// Mounted below the global authMiddleware + accessGateMiddleware (index.ts),
// so req.ctx.userId is always the verified Firebase UID.
//
// Access model: tenant membership is the floor, and each kind then answers with
// its own surface's visibility rule (threadVisibleToCaller, visibility.ts, shared
// with the MCP conversation-id resolver). On GET, unknown
// id / non-member / thread the caller cannot see are all the same 404 so nothing
// about a share's existence leaks to outsiders.

import { Router, json as expressJson, Request, Response } from 'express';
import { z } from 'zod';
import { resolveCaller } from '../auth/resolve-caller';
import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members';
import * as chatRepo from '../agent-chat/chat-repository';
import { log, logAudit } from '../infrastructure/logging';
import { upsertShare, findShareById } from './repository';
import type { ChatThreadKind } from './repository';
import { threadVisibleToCaller } from './visibility';

export const chatSharesRouter = Router();
const accountService = new AccountService();

chatSharesRouter.use(expressJson({ limit: '10kb' }));

// Kinds addressed by an agent as well as a thread. The other two are platform
// surfaces with no internal_agents row and no agent in their URLs, so an agent
// id sent with them would be meaningless (migration 350).
const AGENT_BEARING_KINDS: ReadonlySet<ChatThreadKind> = new Set(['agent', 'team_plan']);

const createShareBodySchema = z.object({
  tenantId: z.string().uuid(),
  // Optional here, then required or rejected per kind below, so the request
  // cannot disagree with what the row is allowed to hold.
  agentId: z.string().uuid().optional(),
  threadId: z.string().uuid(),
  // Absent means agent chat: every client that predates the CAIO share button
  // omits it, and every row written before migration 326 is an agent-chat share.
  threadKind: z.enum(['agent', 'team_plan', 'insights', 'liftoff']).default('agent'),
}).superRefine((body, ctx) => {
  const needsAgent = AGENT_BEARING_KINDS.has(body.threadKind);
  if (needsAgent && !body.agentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['agentId'],
      message: 'agentId is required for this thread kind',
    });
  }
  if (!needsAgent && body.agentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['agentId'],
      message: 'agentId is not valid for this thread kind',
    });
  }
});

const NOT_FOUND = { error: 'Share link not found' };

// ── POST / — find-or-create a share link ────────────────────────────────

chatSharesRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parseResult = createShareBodySchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.errors,
      });
    }
    const { tenantId, agentId, threadId, threadKind } = parseResult.data;

    const resolution = await resolveCaller(req.ctx?.userId, tenantId);
    if (!resolution.ok) {
      return res.status(resolution.status).json({ error: resolution.error });
    }
    const { caller } = resolution;

    const visible = await threadVisibleToCaller({
      threadKind,
      threadId,
      tenantId,
      accountId: caller.accountId,
      role: caller.role,
    });
    if (!visible) {
      return res.status(404).json({ error: 'Thread not found' });
    }

    if (threadKind === 'agent') {
      // The agent id is denormalized for URL reconstruction, so it has to be one
      // of the thread's own agents. No equivalent for team_plan: that thread has
      // exactly one participant, the CAIO, and the agent id is the seeded system
      // row.
      const participants = await chatRepo.getParticipants(threadId);
      if (!participants.some((p) => p.agentId === agentId)) {
        return res.status(400).json({ error: 'That agent is not part of this conversation' });
      }
    }

    const id = await upsertShare(tenantId, agentId ?? null, threadId, caller.accountId, threadKind);

    logAudit(
      'chat_share.created',
      { tenantId, userId: caller.accountId },
      { shareId: id, threadId, agentId, threadKind },
    );

    return res.status(200).json({ id });
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to create chat share link',
    );
    return res.status(500).json({ error: 'Failed to create share link' });
  }
});

// ── GET /:shareId — resolve a share link ────────────────────────────────

chatSharesRouter.get('/:shareId', async (req: Request, res: Response) => {
  try {
    // Non-UUID ids are indistinguishable from unknown ids (and never reach
    // pg, whose uuid cast would 500).
    if (!z.string().uuid().safeParse(req.params.shareId).success) {
      return res.status(404).json(NOT_FOUND);
    }

    // Manual caller chain instead of resolveCaller: its non-member 404 body
    // ('Tenant not found') would differ from the unknown-id body and leak
    // that the share exists.
    if (!req.ctx?.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const account = await accountService.getByFirebaseUid(req.ctx.userId);
    if (!account) {
      return res.status(401).json({ error: 'Account not found' });
    }

    const share = await findShareById(req.params.shareId);
    if (!share) return res.status(404).json(NOT_FOUND);

    const membership = await tenantMembersService.getMembership(share.tenantId, account.id);
    if (!membership) return res.status(404).json(NOT_FOUND);

    // Re-checked on every read, with this reader's identity rather than the
    // sharer's: the thread may have been soft-deleted since the link was
    // created, and on team_plan a link only opens for someone that surface would
    // show the thread to anyway. A link is a shortcut to a thread, never a grant
    // of access to one.
    const visible = await threadVisibleToCaller({
      threadKind: share.threadKind,
      threadId: share.threadId,
      tenantId: share.tenantId,
      accountId: account.id,
      role: membership.role,
    });
    if (!visible) return res.status(404).json(NOT_FOUND);

    return res.status(200).json(share);
  } catch (error) {
    log.error(
      { error: (error as Error).message, stack: (error as Error).stack },
      'Failed to resolve chat share link',
    );
    return res.status(500).json({ error: 'Failed to resolve share link' });
  }
});
