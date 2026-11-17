// Agent Teams adapter — internal RPC surface.
//
// Used by tenant-runtime's agent-teams-handler + hitl-side-effects to resolve
// conversations for posting and to fan out HITL review cards. Authenticated
// with AGENT_TEAMS_SERVICE_TOKEN via verifyServiceAuth (X-Service-Auth).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { log } from '../../infrastructure/logging';
import { resolveApprovalAudience } from '../../person-assignments/approval-audience';
import {
  listConversationsForAgent,
  getTenantInstall,
  findPersonalConversationByUser,
  getChannelMetaByConversation,
} from './repository';
import { postReviewCardFanout } from './review-card-notifier';
import { sendToConversation } from './teams-sender';
import { getUserInfo, getChannelThreadReplies, proactiveInstallForUser } from './teams-app-service';

export const agentTeamsInternalRouter = Router();
agentTeamsInternalRouter.use(verifyServiceAuth({ tokenEnvVar: 'AGENT_TEAMS_SERVICE_TOKEN' }));

// ── GET /conversations ──────────────────────────────────────────────────────
const conversationsQuerySchema = z.object({
  tenantId: z.string().uuid(),
  agentId: z.string().uuid(),
});

agentTeamsInternalRouter.get('/conversations', async (req: Request, res: Response) => {
  const parsed = conversationsQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_query', details: parsed.error.errors });
  const { tenantId, agentId } = parsed.data;
  try {
    const rows = await listConversationsForAgent(tenantId, agentId);
    return res.json({
      conversations: rows.map((r) => ({
        conversationId: r.conversationId,
        scope: r.scope,
        conversationReference: r.conversationReference,
      })),
    });
  } catch (err) {
    log.error({ tenantId, agentId, error: (err as Error).message }, '/conversations failed');
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /post-review-card ──────────────────────────────────────────────────
const postReviewCardSchema = z.object({
  reviewId: z.string().uuid(),
  tenantId: z.string().uuid(),
  agentId: z.string().uuid(),
  // Messaging specialization: the draft to preview.
  draftText: z.string().min(1).optional(),
  assigneeAccountIds: z.array(z.string().uuid()).min(1),
  // Generic gated-tool card content (hitl-card-content.ts).
  action: z.string().min(1).optional(),
  why: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
}).refine((d) => !!d.draftText || !!d.action, {
  message: 'either draftText (messaging) or action (generic) is required',
});

agentTeamsInternalRouter.post('/post-review-card', async (req: Request, res: Response) => {
  const parsed = postReviewCardSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.errors });
  try {
    return res.json(await postReviewCardFanout(parsed.data));
  } catch (err) {
    log.error({ err: (err as Error).message }, '/post-review-card failed');
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /send ──────────────────────────────────────────────────────────────
// Outbound posting for the runtime teams_* tools (one shared bot; PB holds the
// bot adapter + credentials).
const sendSchema = z.object({
  tenantId: z.string().uuid(),
  agentId: z.string().uuid(),
  conversationId: z.string().min(1),
  text: z.string().min(1),
  kind: z.enum(['message', 'reply', 'update']),
  messageId: z.string().optional(),
});

agentTeamsInternalRouter.post('/send', async (req: Request, res: Response) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.errors });
  try {
    const result = await sendToConversation({
      tenantId: parsed.data.tenantId,
      conversationId: parsed.data.conversationId,
      text: parsed.data.text,
      kind: parsed.data.kind,
      messageId: parsed.data.messageId,
    });
    return res.json(result);
  } catch (err) {
    log.error({ err: (err as Error).message }, '/send failed');
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── GET /user-info ──────────────────────────────────────────────────────────
const userInfoQuerySchema = z.object({ tenantId: z.string().uuid(), aadUserId: z.string().min(1) });
agentTeamsInternalRouter.get('/user-info', async (req: Request, res: Response) => {
  const parsed = userInfoQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_query', details: parsed.error.errors });
  try {
    const install = await getTenantInstall(parsed.data.tenantId);
    if (!install) return res.status(404).json({ error: 'teams_not_connected' });
    const info = await getUserInfo(install.azureAdTenantId, parsed.data.aadUserId);
    return res.json(info);
  } catch (err) {
    log.error({ err: (err as Error).message }, '/user-info failed');
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /send-dm ───────────────────────────────────────────────────────────
const sendDmSchema = z.object({
  tenantId: z.string().uuid(),
  agentId: z.string().uuid(),
  aadUserId: z.string().min(1),
  text: z.string().min(1),
});
agentTeamsInternalRouter.post('/send-dm', async (req: Request, res: Response) => {
  const parsed = sendDmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.errors });
  const { tenantId, agentId, aadUserId, text } = parsed.data;
  try {
    const conv = await findPersonalConversationByUser(tenantId, agentId, aadUserId);
    if (conv) {
      const result = await sendToConversation({ tenantId, conversationId: conv.conversationId, text, kind: 'message' });
      return res.json({ delivered: true, ...result });
    }
    // No existing DM — best-effort proactive install so the bot becomes available.
    const install = await getTenantInstall(tenantId);
    if (install?.consentState === 'published' && install.catalogTeamsAppId) {
      await proactiveInstallForUser(install.azureAdTenantId, aadUserId, install.catalogTeamsAppId).catch(() => {});
    }
    return res.json({ delivered: false, installed: true });
  } catch (err) {
    log.error({ err: (err as Error).message }, '/send-dm failed');
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── GET /thread ─────────────────────────────────────────────────────────────
const threadQuerySchema = z.object({
  tenantId: z.string().uuid(),
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
});
agentTeamsInternalRouter.get('/thread', async (req: Request, res: Response) => {
  const parsed = threadQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_query', details: parsed.error.errors });
  const { tenantId, conversationId, messageId } = parsed.data;
  try {
    const meta = await getChannelMetaByConversation(tenantId, conversationId);
    if (!meta?.teamId || !meta.channelId) {
      return res.json({ messages: [], note: 'thread reads require a channel conversation' });
    }
    const install = await getTenantInstall(tenantId);
    if (!install) return res.status(404).json({ error: 'teams_not_connected' });
    const messages = await getChannelThreadReplies(install.azureAdTenantId, meta.teamId, meta.channelId, messageId);
    return res.json({ messages });
  } catch (err) {
    log.error({ err: (err as Error).message }, '/thread failed');
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── GET /assignees ──────────────────────────────────────────────────────────
const assigneesQuerySchema = z.object({
  tenantId: z.string().uuid(),
  agentId: z.string().uuid(),
  // Authority is per level: owners and admins can take level 1 and 2, members
  // only level 2. Defaults to 2, the level the callers used before this
  // existed, so an older caller keeps its previous behaviour.
  //
  // NOT capped at 2. Approval authority is only defined for 1 and 2, but the
  // caller passes the level the approval was RAISED at, and that is a wider
  // range — a gate forced by external content fires at whatever level the
  // workspace sits at, and 3 is a real value that reaches here. Rejecting it
  // does not degrade the audience, it fails the whole lookup: the caller's
  // catch then records the approval as reaching nobody and no human is told
  // that a run is paused. An unknown level falls back to the default below,
  // which announces to someone, and announcing to a slightly wider audience is
  // the safe direction to be wrong in.
  hitlLevel: z.coerce.number().int().min(1).optional(),
});

agentTeamsInternalRouter.get('/assignees', async (req: Request, res: Response) => {
  const parsed = assigneesQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_query', details: parsed.error.errors });
  const { tenantId, agentId } = parsed.data;
  const hitlLevel: 1 | 2 = parsed.data.hitlLevel === 1 ? 1 : 2;

  // Shared with the Slack adapter — this was a byte-identical second copy,
  // and neither filtered out assignees who cannot approve.
  const audience = await resolveApprovalAudience(tenantId, agentId, hitlLevel);
  return res.json({
    assigneeAccountIds: audience.notifyAccountIds,
    visibility: audience.visibility,
    ...(audience.fellBackToAdmins ? { fallback: 'admin_owner' } : {}),
  });
});
