// Agent Slack adapter — internal RPC surface.
//
// Used by tenant-runtime's slack-tool-handler to fetch per-agent bot tokens
// for outbound posting. Authenticated with AGENT_SLACK_SERVICE_TOKEN via
// the standard verifyServiceAuth middleware — tenant-runtime carries the
// token in X-Service-Auth on every call.

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { verifyServiceAuth } from '@liftoffos/service-client';
import { log, logAudit } from '../../infrastructure/logging';
import { withTenantScope } from '../../infrastructure/database';
import { resolveApprovalAudience } from '../../person-assignments/approval-audience';
import { resolveWorkspaceBotToken, storeWorkspaceBotToken } from './bot-token-service';
import { getInstalledWorkspaceInstall, upsertWorkspaceInstall } from './workspace-repository';
import { getLiftoffSlackAppId } from './workspace-app';

export const agentSlackInternalRouter = Router();

const svcAuth = verifyServiceAuth({ tokenEnvVar: 'AGENT_SLACK_SERVICE_TOKEN' });

agentSlackInternalRouter.use(svcAuth);

// ── POST /api/internal/agent-slack/workspace-install ────────────────────────
// Connector-service → PB: the slack connector OAuth is a dual grant (ADR-040)
// — user_scope mints the connector credential (stored in connector-service),
// scope installs the Liftoff app's bot. Connector-service delivers the bot
// token here after the connector row settles; this endpoint is how
// slack_workspace_installs rows come to exist.
//
// Separate router + PLATFORM_CALLBACK_TOKEN (the CS/TR → PB shared callback
// secret): connector-service does not hold AGENT_SLACK_SERVICE_TOKEN, and the
// tokens must not be cross-honoured. verifyServiceAuth pins the exact env var
// (a bare verifyServiceAuth() would silently 401 — see the TR→PB callback
// contract).
export const slackWorkspaceInstallRouter = Router();
slackWorkspaceInstallRouter.use(verifyServiceAuth({ tokenEnvVar: 'PLATFORM_CALLBACK_TOKEN' }));

const workspaceInstallSchema = z.object({
  tenantId: z.string().uuid(),
  slackTeamId: z.string().min(1),
  slackTeamName: z.string().nullable().optional(),
  slackBotUserId: z.string().min(1),
  botToken: z.string().min(1),
  // Connector-service's oauthState.accountId is the FIREBASE uid, not an
  // accounts.id — the first live handoff 400'd on a .uuid() pin here.
  // Accept either; resolution to an account uuid happens in the handler.
  installedByAccountId: z.string().min(1).nullable().optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the installer to an accounts.id: uuid passes through, a Firebase
 *  uid resolves via AccountService, anything unresolvable becomes null
 *  (attribution is best-effort; the install itself must never fail on it). */
async function resolveInstallerAccountId(installedBy: string | null | undefined): Promise<string | null> {
  if (!installedBy) return null;
  if (UUID_RE.test(installedBy)) return installedBy;
  try {
    const { AccountService } = await import('../../accounts/service');
    const account = await new AccountService().getByFirebaseUid(installedBy);
    return account?.id ?? null;
  } catch {
    return null;
  }
}

slackWorkspaceInstallRouter.post('/', async (req: Request, res: Response) => {
  const parsed = workspaceInstallSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.errors });
  }
  const { tenantId, slackTeamId, slackTeamName, slackBotUserId, botToken, installedByAccountId } = parsed.data;

  try {
    const installerAccountId = await resolveInstallerAccountId(installedByAccountId);
    const secretPath = await storeWorkspaceBotToken(tenantId, slackTeamId, botToken);
    await upsertWorkspaceInstall({
      tenantId,
      slackTeamId,
      slackTeamName: slackTeamName ?? null,
      slackBotUserId,
      slackBotTokenSecretPath: secretPath,
      installedByAccountId: installerAccountId,
    });
    logAudit('tenant.slack_workspace_install_completed', {
      tenantId,
      userId: installerAccountId ?? undefined,
      operation: 'slack_workspace_install_handoff',
    }, {
      resourceType: 'tenant',
      resourceId: tenantId,
      newState: { slackTeamId, slackBotUserId, installStatus: 'installed' },
    });
    return res.json({ ok: true });
  } catch (err) {
    log.error(
      { tenantId, slackTeamId, error: (err as Error).message },
      '/workspace-install failed',
    );
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /api/internal/agent-slack/workspace-event ──────────────────────────
// connector-service → PB: a Slack event it has already signature-verified.
//
// Slack allows ONE Events URL per app. connector-service owns it because it
// also publishes every message onto connector-events for reactive
// subscriptions (ADR-019) — routing the URL here instead would silence every
// message this handler chooses not to act on, e.g. ordinary channel chatter
// under the mention-only rule. So it forwards the chat-relevant events here
// and keeps the bus intact.
//
// Auth is PLATFORM_CALLBACK_TOKEN (connector-service does not hold
// AGENT_SLACK_SERVICE_TOKEN); the Slack signature was verified upstream.
export const slackWorkspaceEventRouter = Router();
slackWorkspaceEventRouter.use(verifyServiceAuth({ tokenEnvVar: 'PLATFORM_CALLBACK_TOKEN' }));

const workspaceEventSchema = z.object({
  team_id: z.string().min(1),
  api_app_id: z.string().optional(),
  event_id: z.string().optional(),
  event: z.record(z.unknown()),
});

slackWorkspaceEventRouter.post('/', async (req: Request, res: Response) => {
  const parsed = workspaceEventSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.errors });
  }
  const { handleVerifiedWorkspaceSlackEvent } = await import('./workspace-event-handler');
  await handleVerifiedWorkspaceSlackEvent({
    body: parsed.data as unknown as Record<string, unknown>,
    res,
  });
});

// ── GET /installs ─────────────────────────────────────────────────────────
// Returns all currently-installed Slack workspaces for an agent, with the
// resolved bot token for each. tenant-runtime caches the response for ~60s.

const installsQuerySchema = z.object({
  tenantId: z.string().uuid(),
  agentId: z.string().uuid(),
  // Optional: caller can ask for a specific workspace only.
  slackTeamId: z.string().optional(),
});

agentSlackInternalRouter.get('/installs', async (req: Request, res: Response) => {
  const parsed = installsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_query',
      details: parsed.error.errors,
    });
  }
  const { tenantId, agentId, slackTeamId } = parsed.data;

  // The wire shape tenant-runtime's agent-slack-client consumes. kind/postAs
  // are present only on the workspace-app virtual install (ADR-040).
  interface InstallEntry {
    installId: string;
    slackAppId: string;
    slackTeamId: string;
    slackTeamName: string | null;
    slackBotUserId: string | null;
    installedAt: string;
    botToken: string | null;
    kind?: 'workspace';
    postAs?: { username: string };
  }

  try {
    const installs: InstallEntry[] = [];

    // The single Liftoff app serves every agent (ADR-040), so this is a
    // virtual install: tenant-keyed, resolved live, and therefore available
    // to agents created after the workspace was connected. postAs carries the
    // agent's display name, which opens each message it authors.
    const wsInstall = await getInstalledWorkspaceInstall(tenantId);
    if (wsInstall && (!slackTeamId || wsInstall.slackTeamId === slackTeamId)) {
      const botToken = await resolveWorkspaceBotToken(wsInstall);
      if (botToken) {
        const displayName = await withTenantScope(tenantId, async (c) => {
          const r = await c.query<{ display_name: string | null }>(
            `SELECT COALESCE(messaging_nickname, role) AS display_name
               FROM internal_agents
              WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
            [agentId, tenantId],
          );
          return r.rows[0]?.display_name ?? null;
        });
        // Unknown/deleted agent ⇒ no install.
        if (displayName) {
          installs.push({
            installId: `ws:${wsInstall.id}`,
            slackAppId: getLiftoffSlackAppId() ?? '',
            slackTeamId: wsInstall.slackTeamId,
            slackTeamName: wsInstall.slackTeamName,
            slackBotUserId: wsInstall.slackBotUserId,
            installedAt: wsInstall.installedAt,
            botToken,
            kind: 'workspace',
            postAs: { username: displayName },
          });
        }
      }
    }

    return res.json({ installs });
  } catch (err) {
    log.error(
      { tenantId, agentId, error: (err as Error).message },
      '/installs failed',
    );
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /post-review-dm ──
// Body intentionally does NOT carry agentName — review-dm-notifier resolves
// it server-side from internal_agents (tenant-runtime has no agentName on
// ExecutionContext).
const postReviewDmSchema = z.object({
  reviewId: z.string().uuid(),
  tenantId: z.string().uuid(),
  agentId: z.string().uuid(),
  // Messaging specialization: destination channel + draft.
  channelId: z.string().min(1).optional(),
  draftText: z.string().min(1).optional(),
  assigneeAccountIds: z.array(z.string().uuid()).min(1),
  // Generic gated-tool card content (hitl-card-content.ts).
  action: z.string().min(1).optional(),
  why: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
}).refine((d) => (!!d.channelId && !!d.draftText) || !!d.action, {
  message: 'either channelId+draftText (messaging) or action (generic) is required',
});
agentSlackInternalRouter.post('/post-review-dm', async (req: Request, res: Response) => {
  const parsed = postReviewDmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.errors });
  try {
    const { postReviewDmFanout } = await import('./review-dm-notifier');
    return res.json(await postReviewDmFanout(parsed.data));
  } catch (err) {
    log.error({ err: (err as Error).message }, '/post-review-dm failed');
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── POST /post-draft-dm ──
const postDraftDmSchema = z.object({
  tenantId: z.string().uuid(),
  agentId: z.string().uuid(),
  channelId: z.string().min(1),
  draftText: z.string().min(1),
  assigneeAccountIds: z.array(z.string().uuid()).min(1),
});
agentSlackInternalRouter.post('/post-draft-dm', async (req: Request, res: Response) => {
  const parsed = postDraftDmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.errors });
  try {
    const { postDraftDmFanout } = await import('./review-dm-notifier');
    return res.json(await postDraftDmFanout(parsed.data));
  } catch (err) {
    log.error({ err: (err as Error).message }, '/post-draft-dm failed');
    return res.status(500).json({ error: 'internal_error' });
  }
});

// ── GET /assignees ──
const assigneesQuerySchema = z.object({
  tenantId: z.string().uuid(),
  agentId: z.string().uuid(),
  // Authority is per level: owners and admins can take level 1 and 2, members
  // only level 2. Defaults to 2, the level the callers used before this
  // existed, so an older caller keeps its previous behaviour.
  //
  // NOT capped at 2 — see the identical note on the Teams adapter's copy. A
  // level outside the authority range must degrade to the default audience,
  // because rejecting it fails the lookup and the caller records the approval
  // as having reached nobody while a run sits paused behind it.
  hitlLevel: z.coerce.number().int().min(1).optional(),
});
agentSlackInternalRouter.get('/assignees', async (req: Request, res: Response) => {
  const parsed = assigneesQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_query', details: parsed.error.errors });
  const { tenantId, agentId } = parsed.data;
  const hitlLevel: 1 | 2 = parsed.data.hitlLevel === 1 ? 1 : 2;
  // One shared resolver — this logic previously existed as two identical
  // copies (here and in the Teams adapter) that could drift, and neither
  // filtered out assignees who lack approval authority. A viewer used to be
  // sent a card with Approve and Reject buttons that threw on click.
  const audience = await resolveApprovalAudience(tenantId, agentId, hitlLevel);
  return res.json({
    assigneeAccountIds: audience.notifyAccountIds,
    visibility: audience.visibility,
    ...(audience.fellBackToAdmins ? { fallback: 'admin_owner' } : {}),
  });
});
