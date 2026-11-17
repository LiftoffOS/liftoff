// Participant Router — manage thread participants (add/remove/list agents)
//
// REST endpoints for multi-agent thread participant management (Phase 4.7).
//
// POST   /threads/:threadId/participants          — add agent to thread
// DELETE /threads/:threadId/participants/:agentId  — remove agent from thread
// GET    /threads/:threadId/participants           — list thread participants
//
// Auth: Firebase UID from req.ctx.userId → account lookup → tenant
// membership check. Same inline auth pattern as router.ts.

import { Router, json as expressJson, type Request, type Response } from 'express';
import { z } from 'zod';
import { log, logAudit } from '../infrastructure/logging';
import { getPool, withTenantScope } from '../infrastructure/database';
import { AccountService } from '../accounts/service';
import { tenantMembersService } from '../tenant-members';
import * as chatRepo from './chat-repository';
import { absorbConversationContext } from './context-absorption';
import { refusedAsViewer } from '../common/agent-conversation-gate';
import type { TenantMemberRole } from '../tenant-members/types';

export const participantRouter = Router();
const accountService = new AccountService();

// Same 50KB body limit as other agent-chat routes.
participantRouter.use(expressJson({ limit: '50kb' }));

// ── Validation schemas ────────────────────────────────────────────────────

const addParticipantBodySchema = z.object({
  tenantId: z.string().uuid(),
  agentId: z.string().uuid(),
  role: z.string().max(50).optional().default('participant'),
});

const tenantIdQuerySchema = z.object({
  tenantId: z.string().uuid(),
});

// ── Helper: resolve caller ────────────────────────────────────────────────

interface CallerContext {
  accountId: string;
  tenantId: string;
  /** Workspace role. The membership is already read to prove tenancy; carrying
   *  the role costs nothing and is what lets a route ask about authority. */
  role: TenantMemberRole;
}

type CallerResolution =
  | { ok: true; caller: CallerContext }
  | { ok: false; status: number; error: string };

async function resolveCaller(
  firebaseUid: string | undefined,
  tenantId: string,
): Promise<CallerResolution> {
  if (!firebaseUid) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }

  const account = await accountService.getByFirebaseUid(firebaseUid);
  if (!account) {
    return { ok: false, status: 401, error: 'Account not found' };
  }

  const membership = await tenantMembersService.getMembership(
    tenantId,
    account.id,
  );
  if (!membership) {
    // Don't confirm tenant existence to non-members.
    return { ok: false, status: 404, error: 'Tenant not found' };
  }

  return { ok: true, caller: { accountId: account.id, tenantId, role: membership.role } };
}

// ── POST /threads/:threadId/participants — Add agent to thread ────────────

participantRouter.post(
  '/threads/:threadId/participants',
  async (req: Request, res: Response) => {
    try {
      const parseResult = addParticipantBodySchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }
      const { tenantId, agentId, role } = parseResult.data;
      const { threadId } = req.params;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }
      const { caller } = resolution;

      // Binding an agent into a thread starts its work on the transcript, so it is a turn by another name.
      if (refusedAsViewer(caller.role, res)) return;

      // 1. Verify the thread exists in this tenant.
      const thread = await chatRepo.getThread(threadId, tenantId);
      if (!thread) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      // 2. Verify the agent exists and is active.
      const agentResult = await withTenantScope(tenantId, (client) => client.query(
        `SELECT id, status FROM internal_agents
         WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [agentId, tenantId],
      ));
      if (agentResult.rows.length === 0) {
        return res.status(404).json({ error: 'agent not found' });
      }
      const agent = agentResult.rows[0] as { id: string; status: string };
      if (agent.status !== 'active' && agent.status !== 'paused') {
        return res.status(422).json({ error: 'That agent is not available' });
      }

      // 3. Add participant (idempotent — ON CONFLICT DO NOTHING).
      await chatRepo.addParticipant(threadId, agentId, caller.accountId, role);

      // 4. If the thread already has messages, fire-and-forget context
      //    absorption so the new agent gets caught up on what it missed.
      const messageCheck = await chatRepo.listMessages(threadId, tenantId, {
        limit: 1,
      });
      if (messageCheck.messages.length > 0) {
        // Load more history for the absorption summary.
        const recentHistory = await chatRepo.listMessages(
          threadId,
          tenantId,
          { limit: 20 },
        );
        const recentMessages = [...recentHistory.messages].reverse();

        absorbConversationContext(tenantId, agentId, threadId, recentMessages)
          .catch((err) => {
            log.warn(
              {
                tenantId,
                threadId,
                agentId,
                error: (err as Error).message,
              },
              'Context absorption for new participant failed — non-fatal',
            );
          });
      }

      logAudit(
        'agent_chat.participant_added',
        { tenantId, userId: caller.accountId },
        { threadId, agentId, role },
      );

      // Return the participant list so the caller sees the updated state.
      const participants = await chatRepo.getParticipants(threadId);
      const added = participants.find((p) => p.agentId === agentId);

      return res.status(201).json(added ?? { agentId, role, addedBy: caller.accountId });
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to add participant to agent chat thread',
      );
      return res.status(500).json({ error: 'Failed to add participant' });
    }
  },
);

// ── DELETE /threads/:threadId/participants/:agentId — Remove agent ─────────

participantRouter.delete(
  '/threads/:threadId/participants/:agentId',
  async (req: Request, res: Response) => {
    try {
      const queryParse = tenantIdQuerySchema.safeParse(req.query);
      if (!queryParse.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: queryParse.error.errors,
        });
      }
      const { tenantId } = queryParse.data;
      const { threadId, agentId } = req.params;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }
      const { caller } = resolution;

      // The other half of that control: a view-only seat changes no thread's members.
      if (refusedAsViewer(caller.role, res)) return;

      // Verify the thread exists in this tenant.
      const thread = await chatRepo.getThread(threadId, tenantId);
      if (!thread) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      // Delete participant directly.
      const pool = getPool();
      const result = await pool.query(
        `DELETE FROM agent_chat_thread_participants
         WHERE thread_id = $1 AND agent_id = $2`,
        [threadId, agentId],
      );

      if ((result.rowCount ?? 0) === 0) {
        return res.status(404).json({ error: 'Participant not found' });
      }

      logAudit(
        'agent_chat.participant_removed',
        { tenantId, userId: caller.accountId },
        { threadId, agentId },
      );

      return res.status(204).send();
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to remove participant from agent chat thread',
      );
      return res.status(500).json({ error: 'Failed to remove participant' });
    }
  },
);

// ── GET /threads/:threadId/participants — List participants ────────────────

participantRouter.get(
  '/threads/:threadId/participants',
  async (req: Request, res: Response) => {
    try {
      const queryParse = tenantIdQuerySchema.safeParse(req.query);
      if (!queryParse.success) {
        return res.status(400).json({
          error: 'Validation failed',
          details: queryParse.error.errors,
        });
      }
      const { tenantId } = queryParse.data;
      const { threadId } = req.params;

      const resolution = await resolveCaller(req.ctx?.userId, tenantId);
      if (!resolution.ok) {
        return res.status(resolution.status).json({ error: resolution.error });
      }

      // Verify the thread exists in this tenant.
      const thread = await chatRepo.getThread(threadId, tenantId);
      if (!thread) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      const participants = await chatRepo.getParticipants(threadId);

      return res.json({ participants });
    } catch (error) {
      log.error(
        { error: (error as Error).message, stack: (error as Error).stack },
        'Failed to list agent chat thread participants',
      );
      return res.status(500).json({ error: 'Failed to list participants' });
    }
  },
);
