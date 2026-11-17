// Service-to-service router: tenant-runtime → platform-backend wake settlement.
//
// When a self-woken run's continuation completes, TR's settleWakeDelivery calls this to deliver the
// result to the owning chat surface. Keyed by wakeId; TR settles exactly once (fenced lease), but the
// TR->PB callback itself can be retried, so delivery is made idempotent by a claim in
// wake_settlement_ledger (migration 310). Channel is derived from the PB thread (authoritative), not
// from the TR-passed hint. Delivery per channel:
//   web / mcp   → insert an assistant message (surfaced on the user's next poll/open)
//   slack       → insert the message (cross-channel history) + active chat.postMessage to the thread
//   teams       → insert the message + active sendToConversation to the Teams conversation
//   autonomous  → no thread → no-op
// Also serves GET /thread-revision: the canonical message-count cursor TR reads at pause and at resume
// to gate native session-resume. PB owns canonical messages, so PB owns the cursor.
// Service-auth via PLATFORM_CALLBACK_TOKEN — TR reaches both endpoints through its platform-callback
// client, which sends X-Service-Auth: PLATFORM_CALLBACK_TOKEN (the shared TR->PB callback secret),
// the same token every other TR-callback route validates.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { withTenantScope } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { guardWholeText } from '../common/guarded-stream';
import { touchThreadOnClient } from '../agent-chat/chat-repository';
import { resolveContributors } from '../agent-chat/contributors';
import { collectRunArtifacts, withArtifacts, fileOutputAttachments } from '../agent-chat/run-artifacts';

export const wakeSettlementInternalRouter = Router();
const svcAuth = verifyServiceAuth({ tokenEnvVar: 'PLATFORM_CALLBACK_TOKEN' });

const bodySchema = z.object({
  tenantId: z.string().uuid(),
  wakeId: z.string(),
  threadId: z.string().uuid().nullable().optional(),
  /** Accepted for wire compatibility and NOT trusted: the caller names agents
   *  in a different id space from the one this database's foreign keys point
   *  at. The thread is the authority. */
  agentId: z.string().uuid().nullable().optional(),
  channel: z.enum(['web', 'slack', 'teams', 'mcp']).nullable().optional(),
  replyText: z.string(),
  /** Runtime agent ids of the teammates the delivered run handed work to, so
   *  the reply it posts carries the same contributors a streamed reply would.
   *  Absent from an older runtime image, which is read as nobody. */
  delegatedTo: z.array(z.string().min(1)).optional(),
});

interface ThreadRow {
  channel: 'web' | 'slack' | 'teams' | 'mcp';
  external_thread_ref: string | null;
  slack_channel_id: string | null;
  agent_id: string | null;
}

/** Active-post the continuation to a slack thread. Best-effort; returns whether it posted. */
async function postToSlack(
  tenantId: string, agentId: string | null, channelId: string | null, threadTs: string | null, text: string,
): Promise<boolean> {
  if (!agentId || !channelId || !threadTs) return false;

  // One Liftoff app serves every agent (ADR-040); the continuation opens with
  // the agent's name, and the sender is the app.
  const { getInstalledWorkspaceInstall } = await import('../agent-chat/slack-adapter/workspace-repository');
  const install = await getInstalledWorkspaceInstall(tenantId).catch(() => null);
  if (!install) return false;

  const { resolveWorkspaceBotToken } = await import('../agent-chat/slack-adapter/bot-token-service');
  const botToken = await resolveWorkspaceBotToken(install);
  if (!botToken) return false;

  const agentName = await withTenantScope(tenantId, async (c) => {
    const r = await c.query<{ display_name: string | null }>(
      `SELECT COALESCE(messaging_nickname, role) AS display_name
         FROM internal_agents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [agentId, tenantId],
    );
    return r.rows[0]?.display_name ?? null;
  });

  const { slackApiFetch } = await import('../agent-chat/slack-adapter/slack-api');
  const res = await slackApiFetch('chat.postMessage', {
    authToken: botToken,
    body: { kind: 'json', value: {
      channel: channelId, thread_ts: threadTs,
      text: agentName ? `${agentName}: ${text}` : text,
    }},
  });
  return Boolean(res.ok);
}

/** Active-post the continuation to a Teams conversation. Best-effort; returns whether it posted. */
async function postToTeams(tenantId: string, conversationId: string | null, text: string): Promise<boolean> {
  if (!conversationId) return false;
  const { sendToConversation } = await import('../agent-chat/teams-adapter/teams-sender');
  const r = await sendToConversation({ tenantId, conversationId, text, kind: 'message' });
  return Boolean(r.activityId);
}

// POST /api/internal/wake-settlement
wakeSettlementInternalRouter.post('/', svcAuth, async (req: Request, res: Response) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() });
  }
  const { tenantId, wakeId, threadId, replyText: continuationText, delegatedTo } = parsed.data;
  if (!threadId || continuationText.trim().length === 0) {
    return res.status(200).json({ delivered: false, reason: 'no_thread_or_empty' });
  }
  // The team's words, read the way the live stream reads them before a
  // person sees them (common/guarded-stream.ts): the row and every push
  // below carry what came out of that reading.
  const replyText = await guardWholeText(continuationText, { tenantId, speaker: 'team', threadId });

  // Idempotency claim (keyed by wakeId): a retried callback finds the row and returns without
  // re-posting. Released on delivery failure so a genuine retry re-drives delivery.
  const claim = await withTenantScope(tenantId, (c) => c.query(
    `INSERT INTO wake_settlement_ledger (wake_id, tenant_id) VALUES ($1, $2)
     ON CONFLICT (wake_id) DO NOTHING RETURNING wake_id`,
    [wakeId, tenantId],
  ));
  if (claim.rows.length === 0) {
    return res.status(200).json({ delivered: true, deduped: true });
  }

  // What the run MADE, alongside what it did.
  //
  // A run that writes nine documents and delivers only a sentence about how it
  // ended leaves the person with nothing to open: the links were recorded at
  // the moment each document was created and then never shown. Read back here
  // rather than collected in the runtime, because the audit trail already holds
  // them. Best-effort — an empty list leaves the message exactly as it was.
  const artifacts = await collectRunArtifacts(tenantId, threadId);
  const deliveredText = withArtifacts(replyText, artifacts);

  try {
    const delivered = await withTenantScope(tenantId, async (client) => {
      // Chat-origin guard + derive the authoritative channel/refs FROM the thread (not the TR hint).
      const t = await client.query<ThreadRow>(
        `SELECT ct.channel, ct.external_thread_ref, ct.slack_channel_id,
                (SELECT agent_id FROM agent_chat_thread_participants WHERE thread_id = ct.id LIMIT 1) AS agent_id
           FROM agent_chat_threads ct
          WHERE ct.id = $1 AND ct.tenant_id = $2 AND ct.deleted_at IS NULL`,
        [threadId, tenantId],
      );
      if (t.rows.length === 0) return false;
      const thread = t.rows[0];
      // The THREAD's participant, never the caller's hint.
      //
      // The runtime addresses agents in its OWN id space (ADR-039 / INV-PB-009)
      // and this column is an FK into internal_agents, so a runtime id fails the
      // constraint and takes the whole delivery down with it: the settlement
      // 500s, the continuation's answer is lost, and the thread keeps its "still
      // working" notice forever. The channel beside it was already derived from
      // the thread for the same reason; the agent was not.
      const agentId = thread.agent_id ?? null;

      // Always persist the assistant message (cross-channel history; the only delivery for web/mcp).
      //
      // The stored text does NOT carry the artifact list. The transcript has a
      // card for a produced file — it names it, knows which cloud it lives in,
      // and opens it — so pasting raw links into the sentence as well would
      // show the same thing twice, once badly.
      // `contributors` is the reply's attribution — the same resolver, off the
      // same durable record, as a streamed reply.
      await client.query(
        `INSERT INTO agent_chat_messages (tenant_id, thread_id, agent_id, role, content, contributors)
         VALUES ($1, $2, $3, 'assistant', $4, $5)`,
        [tenantId, threadId, agentId, replyText, JSON.stringify(await resolveContributors(tenantId, delegatedTo ?? []))],
      );
      // What it made, as cards. Its own row because that is what `file_output`
      // is: the renderer keys on the message type, so an outcome row carrying
      // attachments would store them and draw nothing.
      if (artifacts.length > 0) {
        await client.query(
          `INSERT INTO agent_chat_messages
             (tenant_id, thread_id, agent_id, role, content, message_type, attachments)
           VALUES ($1, $2, $3, 'assistant', $4, 'file_output', $5)`,
          [
            tenantId, threadId, agentId,
            artifacts.length === 1 ? 'What this run produced' : `What this run produced (${artifacts.length})`,
            JSON.stringify(fileOutputAttachments(artifacts)),
          ],
        );
      }
      // fromAgent: this IS the team speaking, so the reply clock moves and the
      // unread indicators light up. A self-wake continuation is the archetypal
      // case for them — it lands with nobody watching, by definition.
      await touchThreadOnClient(client, threadId, tenantId, true);
      return true;
    });

    if (!delivered) {
      // Thread gone/deleted — nothing to deliver to. Keep the claim (terminal, no retry).
      logger.info({ tenantId, wakeId }, 'wake settlement: thread not found — no delivery');
      return res.status(200).json({ delivered: false, reason: 'thread_not_found' });
    }

    // Active push for slack/teams origins (web/mcp are delivered by the message insert above).
    const thread = (await withTenantScope(tenantId, (c) => c.query<ThreadRow>(
      `SELECT ct.channel, ct.external_thread_ref, ct.slack_channel_id,
              (SELECT agent_id FROM agent_chat_thread_participants WHERE thread_id = ct.id LIMIT 1) AS agent_id
         FROM agent_chat_threads ct WHERE ct.id = $1 AND ct.tenant_id = $2`,
      [threadId, tenantId],
    ))).rows[0];
    let pushed: boolean | null = null;
    if (thread?.channel === 'slack') {
      pushed = await postToSlack(tenantId, thread.agent_id, thread.slack_channel_id, thread.external_thread_ref, deliveredText);
    } else if (thread?.channel === 'teams') {
      pushed = await postToTeams(tenantId, thread.external_thread_ref, deliveredText);
    }

    logger.info({ tenantId, wakeId, channel: thread?.channel ?? null, pushed }, 'wake settlement delivered');
    return res.status(200).json({ delivered: true, pushed });
  } catch (err) {
    // Release the claim so TR's retry (row stays settlement_pending) re-drives delivery.
    await withTenantScope(tenantId, (c) => c.query(
      `DELETE FROM wake_settlement_ledger WHERE wake_id = $1 AND tenant_id = $2`, [wakeId, tenantId],
    )).catch(() => undefined);
    logger.error({ tenantId, wakeId, err: (err as Error).message }, 'wake settlement failed');
    return res.status(500).json({ error: 'settlement failed' });
  }
});

// GET /api/internal/wake-settlement/thread-revision?tenantId=&threadId= — canonical message-count
// cursor for the native-resume staleness gate PLUS the origin channel, stored
// by TR as origin_surface. PB owns canonical messages, so PB is the source: TR reads it at pause
// (stores cursor + channel on the wake row) and at resume (reconciles the cursor).
const revQuery = z.object({ tenantId: z.string().uuid(), threadId: z.string().uuid() });
wakeSettlementInternalRouter.get('/thread-revision', svcAuth, async (req: Request, res: Response) => {
  const parsed = revQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid query' });
  const { tenantId, threadId } = parsed.data;
  try {
    const r = await withTenantScope(tenantId, (c) => c.query<{ n: string; channel: string | null }>(
      `SELECT (SELECT COUNT(*) FROM agent_chat_messages WHERE tenant_id = $1 AND thread_id = $2)::text AS n,
              (SELECT channel FROM agent_chat_threads WHERE id = $2 AND tenant_id = $1) AS channel`,
      [tenantId, threadId],
    ));
    return res.status(200).json({ revision: Number(r.rows[0]?.n ?? 0), channel: r.rows[0]?.channel ?? null });
  } catch (err) {
    logger.error({ tenantId, threadId, err: (err as Error).message }, 'thread-revision lookup failed');
    return res.status(500).json({ error: 'revision lookup failed' });
  }
});
