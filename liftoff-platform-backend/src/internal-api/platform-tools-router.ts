// Platform Tool Callback Router
//
// Internal API endpoints that the Tenant Runtime calls back into the
// Platform Backend for tools that need control-plane database access.
//
// Endpoints:
//   GET  /find-teammates         — search internal_agents by keyword
//   POST /send-agent-message     — insert into agent_messages queue
//   GET  /agent-messages         — atomic read pending messages for agent
//   GET  /cc-routing             — check if platform agent has CC key users (Phase 4c)
//
// Auth: PLATFORM_CALLBACK_TOKEN via X-Service-Auth header (timing-safe).
// Mounted BEFORE authMiddleware in index.ts since this uses service auth,
// not user/Firebase auth.

import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { withTenantScope } from '../infrastructure/database';
import { findOrCreateThread, appendMessage } from '../agent-chat/chat-repository';
import { frontendUrl } from '../infrastructure/frontend-url';
import { getBackendUrl } from '../infrastructure/control-plane-url';
import { log } from '../infrastructure/logging';
import { guardWholeText } from '../common/guarded-stream';
import { oversightService } from '../internal-agent-oversight/service';
import { narrationSqlList } from '../agent-chat/transcript-context';
import { resolveAgentHitlLevel } from '../internal-agent-oversight/types';
import type { SkillFeedbackEntry } from '../internal-agents/skill-feedback-service';

export const platformToolsRouter = Router();

// ── UUID regex ────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const oauthClient = new OAuth2Client();

// ── Agent id space (ADR-039 / INV-PB-009) ─────────────────────────────
//
// Every route in this file is called BY THE RUNTIME, which derives agent ids
// from its own ExecutionContext and therefore sends runtime-space `agents.id`.
// Every table here is keyed on control-plane `internal_agents.id`, and the two
// spaces are disjoint — a runtime id matches zero rows rather than the wrong
// row, so the failure is always "nothing found", never a mis-attribution.
//
// That failure mode is why it goes unnoticed: an empty result reads
// as "no messages", "no teammates", "not a member" — all plausible answers.
// /skill-feedback already carries its own copy of this translation for exactly
// the same reason; this helper exists so the next route does not need a fourth.
//
// Identity on a miss, so a control-plane caller passing internal ids keeps
// working. Guarded, because the map is network-backed (it asks the runtime for
// its provisioning list) and no request should fail because a lookup did — on
// failure the id passes through untranslated, which is precisely the behaviour
// that existed before, with a warning naming the route.
async function toInternalIds(
  tenantId: string,
  ids: Array<string | undefined>,
  route: string,
): Promise<Array<string | undefined>> {
  try {
    const { getRuntimeToInternalMap, toInternalAgentId } = await import('../internal-agents/runtime-agent-id-map');
    const map = await getRuntimeToInternalMap(tenantId);
    return ids.map((id) => (id ? (toInternalAgentId(map, id) ?? id) : id));
  } catch (err) {
    log.warn(
      { tenantId, route, error: (err as Error).message },
      'agent id translation unavailable; using the ids as sent',
    );
    return ids;
  }
}

// ── Service auth middleware ───────────────────────────────────────────
// Two-layer auth:
//   1. X-Service-Auth: shared PLATFORM_CALLBACK_TOKEN (timing-safe)
//   2. OIDC identity token: verifies the caller's GCP service account
//      matches the tenant's registered runtime project (Issue #1)

function serviceAuth(req: Request, res: Response, next: () => void): void {
  const serviceToken = req.headers['x-service-auth'] as string | undefined;
  const expectedToken = process.env.PLATFORM_CALLBACK_TOKEN;

  if (!expectedToken) {
    res.status(500).json({ error: 'Service authentication not configured' });
    return;
  }

  const isValid =
    serviceToken &&
    Buffer.byteLength(serviceToken) === Buffer.byteLength(expectedToken) &&
    crypto.timingSafeEqual(Buffer.from(serviceToken), Buffer.from(expectedToken));

  if (!isValid) {
    res.status(401).json({ error: 'Invalid service authentication' });
    return;
  }

  next();
}

// ── OIDC tenant isolation ────────────────────────────────────────────
// Verifies the caller's OIDC identity token belongs to the GCP project
// that hosts the requested tenant's runtime. Prevents Tenant A's runtime
// from querying Tenant B's agents using a shared callback token.
//
// In local dev (no OIDC token), this check is skipped — the shared token
// provides sufficient auth for dev environments.

async function verifyTenantIsolation(req: Request, tenantId: string): Promise<{ ok: boolean; reason?: string }> {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // No OIDC token — allow in dev, but log a warning in production
    if (process.env.NODE_ENV === 'production') {
      log.warn({ tenantId }, 'platform-tools: OIDC token missing in production — tenant isolation not enforced');
    }
    return { ok: true };
  }

  try {
    const token = authHeader.substring(7);
    const ticket = await oauthClient.verifyIdToken({ idToken: token });
    const payload = ticket.getPayload();
    if (!payload?.email) {
      return { ok: false, reason: 'OIDC token has no email claim' };
    }

    // Look up the tenant's registered runtime URL
    const result = await withTenantScope(tenantId, (client) =>
      client.query('SELECT runtime_url FROM tenants WHERE id = $1', [tenantId]),
    );
    const runtimeUrl = result.rows[0]?.runtime_url;
    if (!runtimeUrl) {
      return { ok: false, reason: 'Tenant has no registered runtime URL' };
    }

    // Extract project number from Cloud Run URL
    // Format: https://<service>-<project-number>.<region>.run.app
    const urlMatch = runtimeUrl.match(/-(\d{10,14})\./);
    if (!urlMatch) {
      log.warn({ tenantId, runtimeUrl }, 'platform-tools: could not extract project number from runtime URL');
      return { ok: true }; // Can't verify — allow but warn
    }
    const expectedProjectNumber = urlMatch[1];

    // Verify caller's service account belongs to the tenant's GCP project
    // Default compute SA: <project-number>-compute@developer.gserviceaccount.com
    // Custom SA: <name>@<project-id>.iam.gserviceaccount.com
    if (!payload.email.includes(expectedProjectNumber)) {
      return { ok: false, reason: `Caller ${payload.email} does not match tenant project ${expectedProjectNumber}` };
    }

    return { ok: true };
  } catch (err) {
    log.warn({ tenantId, error: (err as Error).message }, 'platform-tools: OIDC verification failed');
    // In production, reject. In dev, allow.
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, reason: 'OIDC token verification failed' };
    }
    return { ok: true };
  }
}

// ── GET /find-teammates ─────────────────────────────────────────────

platformToolsRouter.get('/find-teammates', serviceAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    const agentId = req.query.agentId as string | undefined;
    const query = req.query.query as string | undefined;

    // Validate required params
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId is required' });
    }
    if (!agentId) {
      return res.status(400).json({ error: 'agentId is required' });
    }
    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }

    // Validate UUID format
    if (!UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: 'tenantId must be a valid UUID' });
    }
    if (!UUID_RE.test(agentId)) {
      return res.status(400).json({ error: 'agentId must be a valid UUID' });
    }

    // Validate query length
    if (query.length > 200) {
      return res.status(400).json({ error: 'query must be at most 200 characters' });
    }

    // OIDC tenant isolation check (Issue #1)
    const isolation = await verifyTenantIsolation(req, tenantId);
    if (!isolation.ok) {
      log.warn({ tenantId, reason: isolation.reason }, 'platform-tools: tenant isolation check failed');
      return res.status(403).json({ error: 'Tenant isolation verification failed' });
    }

    // `id != $2` below is a SELF-exclusion, and it only works in the space the
    // rows are keyed in. Asked with the runtime's own agents.id it excluded
    // nothing, so an agent searching for a teammate found ITSELF in the list —
    // and could then address a message to itself believing it had delegated.
    const [callerId] = await toInternalIds(tenantId, [agentId], 'find-teammates');

    // LIKE-escape the query to prevent wildcard injection
    const escaped = query.replace(/[%_\\]/g, '\\$&');
    const pattern = `%${escaped}%`;

    // Teammates are agents only. Connected tools (mcp_tokens) are not
    // listed: nothing can read a message addressed to one, so offering them
    // as addressable would offer a mailbox with no reader. A person's coding
    // tool talks to teams; teams do not open conversations with it.
    const result = await withTenantScope(tenantId, (client) => client.query(
      `SELECT id, role, messaging_nickname, LEFT(summary, 200) AS summary_preview
       FROM internal_agents
       WHERE tenant_id = $1
         AND id != $2
         AND deleted_at IS NULL
         AND status = 'active'
         AND (role ILIKE $3 OR responsibilities ILIKE $3 OR summary ILIKE $3)
       LIMIT 5`,
      [tenantId, callerId, pattern],
    ));

    log.info(
      { event: 'platform_tool_find_teammates', tenantId, agentId, query, matchCount: result.rows.length },
      'find-teammates callback executed',
    );

    return res.json({
      results: result.rows.map((r: { id: string; messaging_nickname: string | null; role: string; summary_preview: string }) => ({
        id: r.id, type: 'internal_agent',
        name: r.messaging_nickname || r.role,
        role: r.role,
        summary: r.summary_preview,
      })).slice(0, 10),
    });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'find-teammates callback failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /notify-team ──────────────────────────────────────────────────
//
// Where a hired team's notices go when no chat connector is bound.
//
// A template that tells an agent to post to a channel resolves that
// destination to a PHRASE when nothing is connected — "your engineering
// channel" — and the instruction stays live. The agent cannot comply and
// reports having complied: a code reviewer said it had posted to Slack with no
// Slack connector bound and no Slack tool call anywhere in the run.
//
// So the platform provides a destination that always exists. This makes the
// unbound clause TRUE rather than deleting the step, which matters because the
// notice is often the only outward sign the run happened at all.
//
// One thread per agent, reused, so a year of weekly notices reads as one
// conversation rather than fifty-two. Written as an assistant message authored
// by the agent, which is what makes it render in the transcript and mark the
// thread unread — a notice nobody is told about is the same failure one layer
// down.

/**
 * Who sees this agent's notices.
 *
 * `internal_agents` has no owner column (D42), so the owner is the actor on the
 * agent's own creation audit row — the same resolution the escalation-recipient
 * endpoints use. Falls back to an admin rather than to nobody.
 */
async function noticeRecipientAccount(
  tenantId: string,
  agentId: string,
): Promise<string | null> {
  const owner = await withTenantScope(tenantId, (client) => client.query(
    `SELECT actor_id FROM internal_agent_audit
     WHERE tenant_id = $1 AND internal_agent_id = $2 AND action = 'created'
       AND actor_id IS NOT NULL
     ORDER BY created_at ASC LIMIT 1`,
    [tenantId, agentId],
  ));
  if (owner.rows[0]?.actor_id) return owner.rows[0].actor_id as string;

  const admin = await withTenantScope(tenantId, (client) => client.query(
    `SELECT account_id FROM tenant_members
     WHERE tenant_id = $1 AND role = 'admin'
     ORDER BY created_at ASC LIMIT 1`,
    [tenantId],
  ));
  return (admin.rows[0]?.account_id as string | undefined) ?? null;
}

platformToolsRouter.post('/notify-team', serviceAuth, async (req: Request, res: Response) => {
  try {
    const { tenantId, agentId, message } = req.body as {
      tenantId?: string; agentId?: string; message?: string;
    };
    if (!tenantId || !agentId || !message) {
      return res.status(400).json({ error: 'tenantId, agentId, message required' });
    }
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(agentId)) {
      return res.status(400).json({ error: 'Invalid UUID format' });
    }
    if (message.length > 8000) {
      return res.status(400).json({ error: 'message exceeds 8000 character limit' });
    }

    // The owner's audit row, the thread, and the message are all keyed on
    // internal_agents.id; the runtime sends its own agents.id. Untranslated, the
    // owner lookup matches nothing and the message write fails its foreign key.
    const [internalAgentId] = (await toInternalIds(tenantId, [agentId], 'notify-team')) as [string];

    // Refused up front rather than left to the foreign key: both writes below
    // name the agent, and an agent this workspace does not have gets a status
    // the caller can read instead of a constraint error.
    const known = await withTenantScope(tenantId, (client) => client.query(
      `SELECT 1 FROM internal_agents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [internalAgentId, tenantId],
    ));
    if (known.rows.length === 0) {
      log.warn({ tenantId, agentId, internalAgentId }, 'notify-team: agent is not in this workspace');
      return res.status(404).json({
        error: 'unknown_agent',
        message: 'This agent is not in the workspace, so its notice was not posted.',
      });
    }

    const accountId = await noticeRecipientAccount(tenantId, internalAgentId);
    if (!accountId) {
      // Every tenant has a member, so this is a broken workspace rather than an
      // ordinary state. Said plainly: the alternative is an agent reporting a
      // notice that reached nobody, which is the defect this endpoint removes.
      log.warn({ tenantId, agentId }, 'notify-team: no owner or admin to notify');
      return res.status(409).json({
        error: 'no_recipient',
        message: 'This workspace has nobody to notify. Add a member, or connect a team chat tool.',
      });
    }

    const thread = await findOrCreateThread(tenantId, accountId, internalAgentId, 'web', `notice:${internalAgentId}`);
    // A notice is the team's words to a person, and is read the way a reply
    // is before a person sees it (common/guarded-stream.ts).
    const shown = await guardWholeText(message, { tenantId, speaker: internalAgentId, threadId: thread.id });
    const persisted = await appendMessage(tenantId, thread.id, 'assistant', shown, internalAgentId);

    return res.status(200).json({
      success: true,
      threadId: thread.id,
      messageId: persisted.id,
      url: `${frontendUrl()}/dashboard/agents/chat?thread=${thread.id}`,
    });
  } catch (err) {
    log.error({ err: (err as Error).message }, 'notify-team failed');
    return res.status(500).json({ error: 'notify_team_failed' });
  }
});

// ── POST /send-agent-message ───────────────────────────────────────────
// Called by tenant runtime when an internal agent sends a peer message.
// sender_id is always senderAgentId from the runtime auth context.
//
// FOUR BOUNDS, audited together because A2A is an agent-to-agent write path and
// the only thing standing between it and a loop is what is enforced here:
//
//   1. per-message size    — 50 KB, below (and mirrored by a zod .max on the
//                            runtime tool, so a caller learns before the round trip)
//   2. per-target pending  — MAX_PENDING_PER_RECIPIENT unread messages
//   3. send rate           — MAX_SENDS_PER_MINUTE per (tenant, sender)
//   4. sender identity     — derived from the runtime's own context, never from
//                            model params, and verified to belong to the tenant
//
// 2 and 3 are what stop two agents messaging each other in a tight loop: without
// a pending cap the queue grows without limit and every read costs more, and
// without a rate limit a runaway sender can fill it faster than any reader
// drains it. Both are per-tenant, so one workspace cannot starve another.

/** Unread messages one recipient may have queued before further sends to it are
 *  refused. Generous enough that ordinary fan-in never trips it, low enough that
 *  a loop is stopped while its queue is still readable by a person. */
const MAX_PENDING_PER_RECIPIENT = 200;

/** Sends per minute per (tenant, sender). A sender that hits this is looping:
 *  an agent composing a genuine message spends a model turn on it, so it cannot
 *  legitimately produce one every second. */
const MAX_SENDS_PER_MINUTE = 60;

/** In-process send counters, keyed `tenantId:senderAgentId` and bucketed by
 *  minute. In-process is the right scope here rather than a shortcut: this
 *  endpoint has one caller, the tenant runtime, and the limit exists to stop a
 *  single runaway sender rather than to meter a distributed client. A restart
 *  clears it, which is acceptable for a loop-breaker and would not be for a
 *  quota. */
const sendCounters = new Map<string, { minute: number; count: number }>();

function sendRateExceeded(tenantId: string, senderAgentId: string): boolean {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `${tenantId}:${senderAgentId}`;
  const existing = sendCounters.get(key);
  if (!existing || existing.minute !== minute) {
    // Bounded: a new minute replaces the entry rather than adding one, and the
    // sweep below keeps the map from growing with one-off senders.
    if (sendCounters.size > 10_000) {
      for (const [k, v] of sendCounters) if (v.minute !== minute) sendCounters.delete(k);
    }
    sendCounters.set(key, { minute, count: 1 });
    return false;
  }
  existing.count += 1;
  return existing.count > MAX_SENDS_PER_MINUTE;
}

platformToolsRouter.post('/send-agent-message', serviceAuth, async (req: Request, res: Response) => {
  try {
    // senderAgentId / recipientAgentId are reassigned below: both arrive in
    // whichever id space the caller holds and are normalised to
    // internal_agents.id before any check reads them.
    // eslint-disable-next-line prefer-const
    let { tenantId, senderAgentId, recipientAgentId, content, metadata, originTrust } = req.body as {
      tenantId?: string;
      senderAgentId?: string;
      recipientAgentId?: string;
      content?: string;
      metadata?: Record<string, unknown>;
      // Content trust of the SENDING invocation, threaded server-side by the tenant
      // runtime (never model-provided). Stamped onto the message so the reader's run
      // upgrades when it reads a tainted message. Anything but 'untrusted_inbound'
      // (including absent) is treated as trusted.
      originTrust?: string;
    };
    const stampedOriginTrust = originTrust === 'untrusted_inbound' ? 'untrusted_inbound' : 'trusted';

    if (!tenantId || !senderAgentId || !recipientAgentId || !content) {
      return res.status(400).json({ error: 'tenantId, senderAgentId, recipientAgentId, content required' });
    }
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(recipientAgentId)) {
      return res.status(400).json({ error: 'Invalid UUID format' });
    }
    if (content.length > 51200) {
      return res.status(400).json({ error: 'content exceeds 50 KB limit' });
    }

    const isolation = await verifyTenantIsolation(req, tenantId);
    if (!isolation.ok) {
      return res.status(403).json({ error: 'Tenant isolation verification failed' });
    }

    // Both ids arrive in whichever space the CALLER holds. The runtime derives
    // them from ExecutionContext, so a delegated hand-off sends the RUNTIME
    // agents.id, while every check and column below is keyed on
    // internal_agents.id — and those spaces are disjoint (INV-TR-010).
    //
    // Untranslated, the sender check rejects the message with 403 'sender does
    // not belong to this workspace', and because the runtime does not read the
    // response status, it logs nothing and carries on. The effect is that
    // EVERY detached hand-off silently drops its answer: the teammate does the
    // work, the result is never delivered, and the caller waits on a message
    // that was refused a second after it was sent.
    //
    // Translated here rather than at the caller because this endpoint already
    // owns the boundary between the two spaces — the same map is used further
    // down this file for exactly that reason — and because a control-plane
    // caller passing internal ids must keep working, which `?? original` gives.
    //
    // BOTH ids need this, not just the sender: the 403 fired on the sender
    // first and masked the fact that the recipient lookup would have missed
    // identically.
    [senderAgentId, recipientAgentId] = (await toInternalIds(
      tenantId,
      [senderAgentId, recipientAgentId],
      'send-agent-message',
    )) as [string, string];

    // Bound 3. Checked before any query so a looping sender costs one map
    // lookup rather than a round trip to the database.
    if (sendRateExceeded(tenantId, senderAgentId)) {
      log.warn(
        { tenantId, senderAgentId, recipientAgentId, limit: MAX_SENDS_PER_MINUTE },
        'send-agent-message rate limit exceeded — refusing the send',
      );
      return res.status(429).json({
        error: `Sending too fast: more than ${MAX_SENDS_PER_MINUTE} messages in a minute. Wait before sending again.`,
      });
    }

    const inserted = await withTenantScope(tenantId, async (client) => {
      // Bound 4. The recipient was already verified to belong to this tenant;
      // the SENDER was not, which left the two ends of the same message held to
      // different standards. The runtime derives senderAgentId from its own
      // context and never from model params, so this is defence in depth rather
      // than a live hole — but an unverified id would be written to
      // agent_messages.sender_id verbatim, and every reader downstream trusts
      // that column to name an agent in the same workspace.
      const senderResult = await client.query(
        `SELECT 1 FROM internal_agents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1`,
        [senderAgentId, tenantId],
      );
      if (senderResult.rows.length === 0) {
        return { badSender: true as const };
      }

      // Bound 2. An unread backlog this deep means the recipient is not keeping
      // up — which is either a loop or a stalled reader, and both are made worse
      // by adding to the queue.
      const pendingResult = await client.query<{ pending: string }>(
        `SELECT COUNT(*)::text AS pending
           FROM agent_messages
          WHERE tenant_id = $1 AND recipient_id = $2 AND status <> 'read'`,
        [tenantId, recipientAgentId],
      );
      if (Number(pendingResult.rows[0]?.pending ?? 0) >= MAX_PENDING_PER_RECIPIENT) {
        return { backlogged: true as const };
      }

      // Verify recipient belongs to tenant. agents only: a connected tool
      // (mcp_tokens) is not addressable, because nothing can ever read a
      // message delivered to one — the client-side inbox tools are gone, and
      // no dashboard surface shows an inbox. Refusing here is what keeps a
      // team from writing into a mailbox with no reader and being told it
      // succeeded.
      const recipientResult = await client.query(
        `SELECT id FROM internal_agents WHERE id = $1 AND tenant_id = $2 AND status = 'active' AND deleted_at IS NULL`,
        [recipientAgentId, tenantId],
      );
      if (recipientResult.rows.length === 0) {
        return { notFound: true as const };
      }

      const result = await client.query(
        `INSERT INTO agent_messages
           (tenant_id, sender_type, sender_id, recipient_type, recipient_id, content, metadata, origin_trust)
         VALUES ($1, 'internal_agent', $2, 'internal_agent', $3, $4, $5, $6)
         RETURNING id`,
        [tenantId, senderAgentId, recipientAgentId,
          content, JSON.stringify(metadata ?? {}), stampedOriginTrust],
      );
      return { messageId: result.rows[0].id as string };
    });

    if ('badSender' in inserted) {
      log.warn({ tenantId, senderAgentId }, 'send-agent-message rejected: sender does not belong to this workspace');
      return res.status(403).json({ error: 'Sender not found in this workspace' });
    }
    if ('backlogged' in inserted) {
      log.warn(
        { tenantId, senderAgentId, recipientAgentId, limit: MAX_PENDING_PER_RECIPIENT },
        'send-agent-message refused: the recipient has too many unread messages',
      );
      return res.status(429).json({
        error: `That agent has ${MAX_PENDING_PER_RECIPIENT} or more unread messages and is not keeping up. `
          + 'Wait for them to catch up before sending more.',
      });
    }
    if ('notFound' in inserted) {
      return res.status(404).json({ error: 'Recipient not found in this workspace' });
    }

    return res.status(201).json({ success: true, messageId: inserted.messageId });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'send-agent-message failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /agent-messages ────────────────────────────────────────────────
// Atomic read: marks messages as read, returns them.
// Called by tenant runtime's read_agent_messages tool.

platformToolsRouter.get('/agent-messages', serviceAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string | undefined;
    const agentId = req.query.agentId as string | undefined;
    const limitStr = req.query.limit as string | undefined;

    if (!tenantId || !agentId) {
      return res.status(400).json({ error: 'tenantId and agentId required' });
    }
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(agentId)) {
      return res.status(400).json({ error: 'Invalid UUID format' });
    }

    const limit = Math.min(parseInt(limitStr ?? '20', 10), 50);

    const isolation = await verifyTenantIsolation(req, tenantId);
    if (!isolation.ok) {
      return res.status(403).json({ error: 'Tenant isolation verification failed' });
    }

    // The READ side of the same boundary the send path crosses. Messages are
    // stored under internal_agents.id, and read_agent_messages asks with the
    // runtime's own agents.id — so without this, recipient_id never matches and
    // the agent is told it has no mail while its mail sits in the table.
    //
    // Translating only the send path would have been worse than translating
    // neither: delivery would start working and every delivered message would
    // then be unreadable.
    const [recipientId] = await toInternalIds(tenantId, [agentId], 'agent-messages');

    const result = await withTenantScope(tenantId, (client) =>
      client.query(
        `UPDATE agent_messages
         SET status = 'read', read_at = NOW()
         WHERE id IN (
           SELECT id FROM agent_messages
           WHERE tenant_id = $1 AND recipient_id = $2 AND status = 'pending'
           ORDER BY created_at ASC
           LIMIT $3
           FOR UPDATE SKIP LOCKED
         )
         RETURNING id, sender_type, sender_id, content, metadata, created_at, origin_trust`,
        [tenantId, recipientId, limit],
      ),
    );

    return res.json({
      messages: result.rows.map((r: { id: string; sender_type: string; sender_id: string; content: string; metadata: unknown; created_at: Date; origin_trust: string }) => ({
        id: r.id,
        senderType: r.sender_type,
        senderId: r.sender_id,
        content: r.content,
        metadata: r.metadata,
        createdAt: r.created_at,
        // Content trust of the sending run; the reader's run upgrades on any tainted message.
        originTrust: r.origin_trust,
      })),
      count: result.rows.length,
    });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'agent-messages read failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /cc-routing ────────────────────────────────────────────────────
// Returns CC key IDs (proxy keys + MCP tokens) for users assigned to a platform agent.
// Called by InternalAgentHandler (runtime) before Cloud Tasks dispatch (Phase 4c).

platformToolsRouter.get('/cc-routing', serviceAuth, async (req: Request, res: Response) => {
  try {
    const { tenantId, platformAgentId } = req.query as { tenantId?: string; platformAgentId?: string };
    if (!tenantId || !platformAgentId) {
      return res.status(400).json({ error: 'tenantId and platformAgentId required' });
    }
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(platformAgentId)) {
      return res.status(400).json({ error: 'Invalid UUID format' });
    }

    // Same dropped table as the recipient check above (migration 132). This
    // route answered 500 on every call rather than reporting whether the agent
    // routes to Claude Code — and a 500 here is read as "not Claude Code",
    // so the dispatch silently took the wrong branch instead of failing loudly.
    const result = await withTenantScope(tenantId, (client) =>
      client.query(
        `SELECT m.id AS key_id FROM mcp_tokens m
         JOIN person_agent_assignments pa ON pa.account_id = m.account_id
         WHERE pa.agent_id = $1 AND pa.tenant_id = $2 AND m.status = 'active' AND m.deleted_at IS NULL`,
        [platformAgentId, tenantId],
      ),
    );

    const keyIds = (result.rows as { key_id: string }[]).map((r) => r.key_id);
    return res.json({ isClaudeCode: keyIds.length > 0, keyIds });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'cc-routing check failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /enqueue-agent-task ───────────────────────────────────────────
// Called by liftoff_delegate_task MCP tool (platform-backend MCP server).
// Validates the agent exists and is active in tenant, then calls the runtime.
// Auth: PLATFORM_CALLBACK_TOKEN via X-Service-Auth header.

platformToolsRouter.post('/enqueue-agent-task', serviceAuth, async (req: Request, res: Response) => {
  try {
    const { tenantId, agentId, objective, context, triggeredBy, triggerRef, requestedById } = req.body as {
      tenantId?: string;
      agentId?: string;
      objective?: string;
      context?: Record<string, unknown>;
      triggeredBy?: string;
      triggerRef?: string;
      requestedById?: string;
    };

    if (!tenantId || !agentId || !objective) {
      return res.status(400).json({ error: 'tenantId, agentId, objective required' });
    }
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(agentId)) {
      return res.status(400).json({ error: 'Invalid UUID format' });
    }
    if (objective.length > 10000) {
      return res.status(400).json({ error: 'objective exceeds 10 KB limit' });
    }

    const isolation = await verifyTenantIsolation(req, tenantId);
    if (!isolation.ok) {
      return res.status(403).json({ error: 'Tenant isolation verification failed' });
    }

    const agentRows = await withTenantScope(tenantId, async (client) => {
      const result = await client.query(
        `SELECT id, autonomy_override FROM internal_agents
         WHERE id = $1 AND tenant_id = $2 AND status = 'active' AND deleted_at IS NULL`,
        [agentId, tenantId],
      );
      return result.rows;
    });
    if (agentRows.length === 0) {
      return res.status(404).json({ error: 'agent not found, or not active in this workspace' });
    }

    const oversightSettings = await oversightService.getOrCreateOversightSettings(tenantId);
    const hitlLevel = resolveAgentHitlLevel(agentRows[0].autonomy_override, oversightSettings.autonomy);

    // Dynamically import to avoid circular deps — tenantRuntimeClient is in connectors/
    const { tenantRuntimeClient } = await import('../connectors/tenant-runtime-client');
    try {
      await tenantRuntimeClient.enqueueAgentTask(tenantId, agentId, {
        objective,
        context: context ?? {},
        triggeredBy: triggeredBy ?? 'platform_tool',
        triggerRef: triggerRef ?? `platform-tool:${Date.now()}`,
        hitlLevel,
        escalationLevel: oversightSettings.escalation,
        requestedByType: 'internal',
        requestedById,
      });
    } catch (enqueueErr) {
      // Plan v6.1 Phase 0.4 caller contract: 201 ONLY on a successful
      // enqueue; a dispatch failure is a 502, never a silent success.
      log.error({ error: (enqueueErr as Error).message, tenantId, agentId }, 'enqueue-agent-task dispatch failed');
      return res.status(502).json({ error: 'Task enqueue failed' });
    }

    return res.status(201).json({ success: true });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'enqueue-agent-task failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /skill-feedback ───────────────────────────────────────────────
// Called by the tenant runtime reflection service after each task completion.
// Updates per-skill metrics and optionally publishes a skills_updated event.
//
// Agent id spaces (ADR-039 / INV-PB-009): the runtime's callers historically
// sent their own runtime-space agents.id as `agentId`, which matches zero
// internal_agents rows and FK-failed every insert. Prefer the additive
// `internalAgentId` field; translate a bare `agentId` through the runtime's
// mapping as the legacy fallback; reject cleanly (409) when neither resolves
// to a provisioned agent so the runtime sees a semantic error, not a 500.

platformToolsRouter.post('/skill-feedback', serviceAuth, async (req: Request, res: Response) => {
  const { tenantId, agentId, internalAgentId, taskId, feedback } = req.body;

  if (!tenantId || !agentId || !Array.isArray(feedback)) {
    return res.status(400).json({ error: 'tenantId, agentId, feedback required' });
  }
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(agentId)) {
    return res.status(400).json({ error: 'Invalid UUID format' });
  }
  if (internalAgentId !== undefined && (typeof internalAgentId !== 'string' || !UUID_RE.test(internalAgentId))) {
    return res.status(400).json({ error: 'Invalid UUID format' });
  }
  if (feedback.length === 0 || feedback.length > 50) {
    return res.status(400).json({ error: 'feedback must have 1–50 entries' });
  }

  const VALID_OUTCOMES = new Set(['success', 'failure', 'hitl_approved', 'hitl_rejected']);
  for (const entry of feedback as Record<string, unknown>[]) {
    if (typeof entry.skillId !== 'string' || typeof entry.skillName !== 'string') {
      return res.status(400).json({ error: 'Each entry requires skillId and skillName strings' });
    }
    if (!VALID_OUTCOMES.has(entry.outcome as string)) {
      return res.status(400).json({ error: `Invalid outcome: ${entry.outcome}` });
    }
    if (entry.refinedInstruction !== undefined &&
        (typeof entry.refinedInstruction !== 'string' || (entry.refinedInstruction as string).length > 4000)) {
      return res.status(400).json({ error: 'refinedInstruction must be ≤4000 chars' });
    }
    if (entry.refinedDescription !== undefined &&
        (typeof entry.refinedDescription !== 'string' || (entry.refinedDescription as string).length > 500)) {
      return res.status(400).json({ error: 'refinedDescription must be ≤500 chars' });
    }
  }

  try {
    let resolvedAgentId: string = internalAgentId ?? agentId;
    if (!internalAgentId) {
      const { getRuntimeToInternalMap, toInternalAgentId } = await import('../internal-agents/runtime-agent-id-map');
      resolvedAgentId = toInternalAgentId(await getRuntimeToInternalMap(tenantId), agentId) ?? agentId;
    }

    const provisioned = await withTenantScope(tenantId, async (client) => {
      const check = await client.query(
        `SELECT 1 FROM internal_agents WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [resolvedAgentId, tenantId],
      );
      return (check.rowCount ?? 0) > 0;
    });
    if (!provisioned) {
      log.warn({ tenantId, agentId, internalAgentId, resolvedAgentId }, 'skill-feedback: agent not provisioned');
      return res.status(409).json({ error: 'agent_not_provisioned' });
    }

    const { processSkillFeedback } = await import('../internal-agents/skill-feedback-service');
    await processSkillFeedback({ tenantId, agentId: resolvedAgentId, taskId, feedback: feedback as SkillFeedbackEntry[] });
    return res.status(204).send();
  } catch (err) {
    log.error({ error: (err as Error).message, tenantId, agentId, internalAgentId }, 'skill-feedback endpoint failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /composio-tool-calls ─────────────────────────────────────────
// Called by the tenant runtime after each tool call that was routed to
// a Composio-managed MCP server. Each entry produces one
// cost_attribution_events row with source='composio_mcp', event_type=
// 'connector_call', cost_usd = COMPOSIO_COST_PER_CALL_USD.
//
// Batching: tenant-runtime accumulates per agent-execution turn and
// flushes here; cap at 500 per request matches the developer-proxy
// ingestion-feed BATCH_SIZE.
//
// Idempotency: `sourceId = ${tenantId}:${agentId}:${callId}` and the
// (source, source_id, event_type, occurred_at) unique index in
// cost_attribution_events dedupes retries.

interface ComposioToolCallEntry {
  tenantId: string;
  agentId: string | null;
  invocationId?: string | null;
  callId: string;          // unique per tool call (SDK tool_use_id)
  connectorType: string;   // one of the 11 Composio-managed types
  toolName: string;        // SDK-visible tool name (mcp__<server>__<tool>)
  occurredAt: string;      // ISO-8601
}

// Composio-managed connector types, hardcoded here as a defence against
// the endpoint being used to attribute cost for non-Composio connectors
// (which would inflate the Composio cost ledger and break margin
// reports). MUST stay in sync with `kind: 'composio_managed'` entries in
// liftoff-connector-service src/catalog/connectors.ts. The parity test
// in __tests__/composio-managed-types.test.ts pins the exact set so
// drift can't ship silently — any add/remove there forces an explicit
// edit here. Cross-repo lockstep is enforced by a matching set in
// liftoff-tenant-runtime src/billing/composio-call-reporter.ts.
export const COMPOSIO_MANAGED_CONNECTOR_TYPES = new Set([
  'airtable', 'apollo', 'ashby', 'atlassian_confluence', 'atlassian_jira', 'bitbucket',
  'browseai', 'cal_com', 'canva', 'clickup', 'close', 'coda',
  'datadog', 'discord', 'documint', 'dropbox', 'facebook', 'fathom',
  'figma', 'fireflies', 'freshbooks', 'freshdesk', 'gong', 'google_ads',
  'google_calendar', 'google_docs', 'google_drive', 'google_mail', 'google_sheets', 'google_slides',
  'greenhouse', 'gumroad', 'instagram', 'instantly', 'intercom', 'lever', 'linkedin',
  'mailchimp', 'microsoft_dynamics', 'microsoft_excel', 'microsoft_onedrive', 'microsoft_outlook_mail', 'missive', 'mixpanel', 'pagerduty',
  // 'slack' is absent: it uses our own Slack app + native sidecar dispatch
  // (internal team collaboration is not a fit for Composio). Slack calls
  // produce no Composio cost and must not be attributable to the composio_mcp
  // source.
  'pipedrive', 'posthog', 'quickbooks', 'reddit',
  // 'salesforce' uses Composio's managed OAuth app rather than its own
  // Connected App, so its calls cost OUs like any other composio_managed
  // connector.
  'salesforce', 'shopify',
  'square', 'todoist', 'trello', 'typeform', 'whatsapp', 'workable',
  'youtube',
  // Net-new Composio-managed batch
  'activecampaign', 'apify', 'baserow', 'brevo', 'buildkite', 'codacy',
  'dovetail', 'elevenlabs', 'fibery', 'fillout', 'folk', 'follow_up_boss',
  'heygen', 'imgbb', 'incident_io', 'jotform', 'lemlist', 'lemon_squeezy',
  'loops', 'mailerlite', 'mailersend', 'mem', 'new_relic', 'northflank',
  'paperform', 'scrapingbee', 'supabase', 'tally', 'telegram', 'toggl',
  'clicksend', 'ticktick', 'monday', 'dialpad', 'harvest', 'google_meet',
  // Zoho suite. All seven are `kind: 'composio_managed'`, so all
  // seven are listed — including the four that ship coming_soon because
  // Composio serves them no tools. A type listed here that is never called
  // costs nothing; a type MISSING here the day someone flips coming_soon →
  // available silently drops that connector's OU cost, and that flip is a
  // one-line change in another repo.
  'zoho', 'zoho_bigin', 'zoho_books', 'zoho_desk', 'zoho_inventory', 'zoho_invoice', 'zoho_mail',
  // Capability-absorption composio batch: the three data vendors
  // that ride Composio-managed MCP servers. Listed the day their catalog
  // entries land, per the runbook, so no OU cost is ever silently dropped.
  'pdl', 'hunterio', 'saperly',
  // Marketing composio batch: GA4, Search Console, Reddit Ads,
  // Plausible and DataForSEO ride Composio-managed MCP servers.
  'dataforseo', 'google_analytics', 'google_search_console', 'plausible', 'reddit_ads',
]);

platformToolsRouter.post('/composio-tool-calls', serviceAuth, async (req: Request, res: Response) => {
  const { calls } = req.body as { calls?: unknown };
  if (!Array.isArray(calls)) {
    return res.status(400).json({ error: 'calls[] required' });
  }
  if (calls.length === 0 || calls.length > 500) {
    return res.status(400).json({ error: 'calls must have 1–500 entries' });
  }

  // Validate up-front so a bad batch returns 400, not a partial insert.
  for (const c of calls as ComposioToolCallEntry[]) {
    if (typeof c.tenantId !== 'string' || !UUID_RE.test(c.tenantId)) {
      return res.status(400).json({ error: 'invalid tenantId' });
    }
    if (c.agentId !== null && c.agentId !== undefined && !UUID_RE.test(c.agentId)) {
      return res.status(400).json({ error: 'invalid agentId' });
    }
    if (typeof c.callId !== 'string' || c.callId.length === 0 || c.callId.length > 200) {
      return res.status(400).json({ error: 'invalid callId' });
    }
    if (!COMPOSIO_MANAGED_CONNECTOR_TYPES.has(c.connectorType)) {
      return res.status(400).json({ error: `connector type not Composio-managed: ${c.connectorType}` });
    }
    if (typeof c.toolName !== 'string' || c.toolName.length === 0 || c.toolName.length > 200) {
      return res.status(400).json({ error: 'invalid toolName' });
    }
    if (typeof c.occurredAt !== 'string' || Number.isNaN(Date.parse(c.occurredAt))) {
      return res.status(400).json({ error: 'invalid occurredAt' });
    }
  }

  try {
    const { COMPOSIO_COST_PER_CALL_USD } = await import('../cost-attribution/composio-pricing');
    const { resolveAccountIdForTenant, ingestEventWithBuckets } = await import('../cost-attribution/repository');

    const accountIdCache = new Map<string, string | null>();
    let ingested = 0;
    let skipped = 0;

    for (const c of calls as ComposioToolCallEntry[]) {
      let accountId = accountIdCache.get(c.tenantId);
      if (accountId === undefined) {
        accountId = await resolveAccountIdForTenant(c.tenantId);
        accountIdCache.set(c.tenantId, accountId);
      }
      if (!accountId) { skipped++; continue; }

      const sourceId = `${c.tenantId}:${c.agentId ?? 'none'}:${c.callId}`;
      const inserted = await ingestEventWithBuckets(accountId, sourceId, COMPOSIO_COST_PER_CALL_USD, {
        tenantId:              c.tenantId,
        agentId:               c.agentId ?? null,
        invocationId:          c.invocationId ?? null,
        connector:             c.connectorType,
        purpose:               c.toolName,
        eventType:             'connector_call',
        source:                'composio_mcp',
        correlationConfidence: 'direct',
        occurredAt:            new Date(c.occurredAt),
      });
      if (inserted > 0) ingested++;
      else skipped++;
    }

    return res.status(200).json({ ingested, skipped });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'composio-tool-calls endpoint failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /composio-quota ───────────────────────────────────────────────
// The other half of the loop above. /composio-tool-calls is how a runtime
// REPORTS a Composio call; this is how it learns what it is still allowed to
// spend.
//
// Composio's budget is one organization-wide meter — 20,000 calls/month and
// 100 standard calls/min across every tenant, agent and endpoint on the free
// tier. A per-tenant runtime cannot govern that: it has no counter for the org
// and no view of the month. The control plane already holds every Composio
// call in cost_attribution_events, so it is the only place that can answer
// "how much is left".
//
// Polled on a TTL and cached by the caller — never on a tool call's hot path.
// The runtime enforces locally against the returned numbers, so a control-
// plane outage degrades to the runtime's own conservative fallback rather than
// failing connector tools.
platformToolsRouter.get('/composio-quota', serviceAuth, async (req: Request, res: Response) => {
  const tenantId = req.query.tenantId as string | undefined;
  if (!tenantId || !UUID_RE.test(tenantId)) {
    return res.status(400).json({ error: 'tenantId must be a valid UUID' });
  }

  const isolation = await verifyTenantIsolation(req, tenantId);
  if (!isolation.ok) {
    log.warn({ tenantId, reason: isolation.reason }, 'composio-quota: tenant isolation check failed');
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { getComposioQuotaAllocation } = await import('../composio-quota/service');
    const allocation = await getComposioQuotaAllocation(tenantId);
    return res.status(200).json(allocation);
  } catch (err) {
    log.error({ error: (err as Error).message, tenantId }, 'composio-quota endpoint failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});


// ── POST /agent-conversations ──────────────────────────────────────────
// Agent Conversation Recall (plan v13 Change 3). Called by the TR gateway
// tool `recall_conversations`: returns the CURRENT USER's attributed turn
// windows with this agent, across every channel. TURNS are the unit — no
// thread titles, no rolling summaries (shared threads may contain other
// users' content). POST with a JSON body, not GET: the search text is
// user-conversation content and query strings land in request logs.

const AGENT_CONVERSATIONS_PATH = '/api/internal/platform-tools/agent-conversations';

/**
 * Strict tenant-caller verification for privacy-sensitive endpoints.
 * Deliberately NOT verifyTenantIsolation (fail-open on unparseable runtime
 * URLs and incompatible with custom runtime SAs):
 *   1. In deployed environments (ENVIRONMENT dev|prod) a missing OIDC
 *      Authorization header is a hard 403; only test/local/unset stay
 *      permissive (the ServiceClient caller always sends OIDC).
 *   2. The audience is pinned to the EXACT canonical endpoint URL —
 *      ServiceClient mints its token for the full endpoint URL, not the
 *      origin (@liftoffos/service-client oidc-auth getIdTokenClient(url)).
 *   3. The verified email must belong to the tenant's GCP project:
 *      *@<tenants.gcp_project_id>.iam.gserviceaccount.com. A tenant row
 *      without gcp_project_id FAILS CLOSED.
 */
async function verifyTenantCallerStrict(
  req: Request,
  tenantId: string,
  path: string,
): Promise<{ ok: boolean; reason?: string }> {
  const strictEnv = ['dev', 'prod'].includes(process.env.ENVIRONMENT ?? '');
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    if (strictEnv) return { ok: false, reason: 'Missing OIDC identity token' };
    return { ok: true }; // test/local/unset only
  }

  try {
    const idToken = authHeader.substring(7);
    const ticket = await oauthClient.verifyIdToken({
      idToken,
      audience: `${getBackendUrl()}${path}`,
    });
    const payload = ticket.getPayload();
    if (!payload?.email) {
      return { ok: false, reason: 'OIDC token has no email claim' };
    }

    const result = await withTenantScope(tenantId, (client) =>
      client.query('SELECT gcp_project_id FROM tenants WHERE id = $1', [tenantId]),
    );
    const dedicatedProjectId = result.rows[0]?.gcp_project_id as string | null | undefined;

    // Which project's service accounts may act for this tenant.
    //
    // `gcp_project_id` is set only for DEDICATED tenants — the premium tier that
    // gets its own GCP project. A SHARED tenant has none, and reading that as
    // "fail closed" denied the entire shared tier, every tenant of which is
    // legitimately served by the shared runtime's project. Shared hosting is a
    // supported tier, not a missing configuration, so it needs a project of its
    // own to be checked against rather than an absent one to fail on.
    //
    // SHARED_RUNTIME_PROJECT_ID names the project hosting the shared pool. It is
    // deliberately its own variable rather than derived: it is the value that
    // changes when the shared pool moves out of a tenant project and into a
    // purpose-built one, and that move should be a config change here, not a
    // code change.
    //
    // Still fails closed when NEITHER is known — an unverifiable caller is
    // refused, which is the original and correct posture.
    const sharedProjectId = process.env.SHARED_RUNTIME_PROJECT_ID?.trim() || null;
    const expectedProjectId = dedicatedProjectId || sharedProjectId;
    if (!expectedProjectId) {
      return {
        ok: false,
        reason: 'Tenant has no gcp_project_id and SHARED_RUNTIME_PROJECT_ID is unset — failing closed',
      };
    }
    if (!payload.email.endsWith(`@${expectedProjectId}.iam.gserviceaccount.com`)) {
      return {
        ok: false,
        reason: `Caller ${payload.email} does not belong to project ${expectedProjectId}`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `OIDC verification failed: ${(err as Error).message}` };
  }
}

// Exported for the DB-backed integration test (migrations/__tests__/
// 294_agent_conversations.integration.test.ts) so scoping assertions run
// against the REAL query text.
export const AGENT_CONVERSATIONS_SQL = `
SELECT tr.id AS turn_id, tr.thread_id, th.channel, tr.created_at, x.messages
FROM agent_chat_turns tr
JOIN agent_chat_threads th
  ON th.id = tr.thread_id AND th.tenant_id = tr.tenant_id
CROSS JOIN LATERAL (
  SELECT COALESCE(jsonb_agg(e ORDER BY e.created_at ASC), '[]'::jsonb)
         AS messages
  FROM (
    SELECT m.role, m.created_at,
           CASE
             WHEN $5::text IS NULL THEN LEFT(m.content, 200)
             ELSE substring(m.content
                    FROM greatest(1, position($7::text IN lower(m.content)) - 80)
                    FOR 200)
           END AS preview
    FROM agent_chat_messages m
    WHERE m.turn_id = tr.id AND m.tenant_id = tr.tenant_id
      AND m.role IN ('user','assistant')
    ORDER BY m.created_at ASC
  ) e
) x
WHERE tr.tenant_id = $1
  AND tr.agent_id = $2
  AND tr.sender_account_id = $3
  AND th.deleted_at IS NULL
  AND ($6::uuid IS NULL OR tr.id <> $6)
  AND ($5::text IS NULL OR EXISTS (
        SELECT 1 FROM agent_chat_messages mq
        WHERE mq.turn_id = tr.id AND mq.tenant_id = tr.tenant_id
          AND mq.role IN ('user','assistant')
          AND mq.content ILIKE $5))
ORDER BY tr.created_at DESC
LIMIT $4
`;

// Semantic arm (v2). Same scoping and preview aggregation as the v1 SQL,
// with two deliberate differences: (1) the EXISTS-ILIKE predicate is
// replaced by exact cosine ordering over embedded turns in the SAME
// embedding space as the query vector ($8 provider / $9 model — vectors
// from different providers/models are different spaces and must never be
// compared, m238 precedent); (2) the preview CASE falls back to
// LEFT(content, 200) when position($7)=0 — a semantic hit need not contain
// the literal substring, and a mis-windowed excerpt would be worse than a
// plain head. NO vector index by design: the (tenant, agent, sender)
// filter via idx_turns_recall leaves a small exact-sortable set, and a
// global approximate index post-filters (can miss or empty out results).
// Exported for migrations/__tests__/295_semantic_recall.integration.test.ts.
export /** Messages previewed per conversation hit.
 *
 *  A bound rather than a preference: without one, a single long turn crowds out
 *  every other conversation the search found. Six is enough for the opening and
 *  the resolution of an exchange, which is what makes a hit recognisable. */
const RECALL_MESSAGES_PER_HIT = 6;

/** Row types the conversation preview must not quote back as speech.
 *
 *  A SUPERSET of narration: the run's own rows come from
 *  `NARRATION_MESSAGE_TYPES`, so a type added there is excluded here on the
 *  same edit, and the four named below are the platform's other out-of-turn
 *  rows, which that predicate does not cover. */
const PREVIEW_EXCLUDED_TYPES = narrationSqlList([
  'suggestion', 'learning_confirmation', 'system_note', 'file_output',
]);

export const AGENT_CONVERSATIONS_SEMANTIC_SQL = `
WITH ranked AS (
  -- Lineage dedup: at most ONE hit per conversation. Without it a single
  -- long thread that discussed a topic repeatedly takes every slot, and the
  -- other conversations that also touched it never surface — the person asked
  -- "when did we talk about X" and got one thread back five times.
  SELECT DISTINCT ON (tr.thread_id)
         tr.id AS turn_id, tr.thread_id, th.channel, tr.created_at,
         tr.content_embedding <=> $5::vector AS distance
  FROM agent_chat_turns tr
  JOIN agent_chat_threads th
    ON th.id = tr.thread_id AND th.tenant_id = tr.tenant_id
  WHERE tr.tenant_id = $1
    AND tr.agent_id = $2
    AND tr.sender_account_id = $3
    AND th.deleted_at IS NULL
    AND ($6::uuid IS NULL OR tr.id <> $6)
    AND tr.content_embedding IS NOT NULL
    AND tr.content_embedding_provider = $8
    AND tr.content_embedding_model = $9
  ORDER BY tr.thread_id, tr.content_embedding <=> $5::vector, tr.created_at DESC, tr.id
)
SELECT r.turn_id, r.thread_id, r.channel, r.created_at, x.messages,
       1 - r.distance AS similarity
FROM ranked r
CROSS JOIN LATERAL (
  SELECT COALESCE(jsonb_agg(e ORDER BY e.created_at ASC), '[]'::jsonb)
         AS messages
  FROM (
    SELECT m.role, m.created_at,
           CASE
             WHEN position($7::text IN lower(m.content)) > 0
             THEN substring(m.content
                    FROM greatest(1, position($7::text IN lower(m.content)) - 80)
                    FOR 200)
             ELSE LEFT(m.content, 200)
           END AS preview
    FROM agent_chat_messages m
    WHERE m.turn_id = r.turn_id AND m.tenant_id = $1
      AND m.role IN ('user','assistant')
      -- Only what the two of them actually said to each other. The
      -- platform's own out-of-turn rows — a routine proposal, a learning
      -- confirmation, a HITL status line, a run narrating itself — are
      -- assistant-role but are not conversation, and quoting them back as
      -- "what you discussed" is both confusing and a waste of the preview
      -- budget.
      --
      -- The narration half comes from the ONE predicate that decides what is
      -- speech, not from a hand-written list: this list was written by hand,
      -- it never named run_progress, and "This run took 12 minutes. Work
      -- done: 14 web searches" was being quoted back as something the two of
      -- them said. Only the rows that are NOT narration of a run are named
      -- here.
      AND (m.message_type IS NULL OR m.message_type NOT IN (${PREVIEW_EXCLUDED_TYPES}))
    ORDER BY m.created_at ASC
    -- Bookends: a bound, so one long turn cannot crowd out the other hits.
    LIMIT ${RECALL_MESSAGES_PER_HIT}
  ) e
) x
ORDER BY r.distance, r.created_at DESC, r.turn_id
LIMIT $4
`;

platformToolsRouter.post('/agent-conversations', serviceAuth, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      tenantId?: unknown;
      agentId?: unknown;
      accountId?: unknown;
      query?: unknown;
      excludeTurnId?: unknown;
      limit?: unknown;
    };

    const tenantId = body.tenantId;
    const agentId = body.agentId;
    const accountId = body.accountId;
    if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: 'tenantId must be a valid UUID' });
    }
    if (typeof agentId !== 'string' || !UUID_RE.test(agentId)) {
      return res.status(400).json({ error: 'agentId must be a valid UUID' });
    }
    if (typeof accountId !== 'string' || !UUID_RE.test(accountId)) {
      return res.status(400).json({ error: 'accountId must be a valid UUID' });
    }

    if (body.query !== undefined && typeof body.query !== 'string') {
      return res.status(400).json({ error: 'query must be a string' });
    }
    // Trim FIRST (plan v13): empty/whitespace-only normalizes to recent mode
    // (never ILIKE '%%'); the length limit applies to the trimmed value.
    const trimmedQuery =
      typeof body.query === 'string' && body.query.trim().length > 0
        ? body.query.trim()
        : null;
    if (trimmedQuery !== null && trimmedQuery.length > 200) {
      return res.status(400).json({ error: 'query must be at most 200 characters' });
    }

    if (body.excludeTurnId !== undefined) {
      if (typeof body.excludeTurnId !== 'string' || !UUID_RE.test(body.excludeTurnId)) {
        return res.status(400).json({ error: 'excludeTurnId must be a valid UUID' });
      }
    }
    const excludeTurnId = typeof body.excludeTurnId === 'string' ? body.excludeTurnId : null;

    // parseInt semantics are deliberate and documented: fractional strings
    // truncate ('1.5' -> 1); non-finite -> default 5; clamp 1..10.
    const parsedLimit = Number.parseInt(String(body.limit), 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(10, Math.max(1, parsedLimit)) : 5;

    const strict = await verifyTenantCallerStrict(req, tenantId, AGENT_CONVERSATIONS_PATH);
    if (!strict.ok) {
      log.warn({ tenantId, reason: strict.reason }, 'agent-conversations: strict caller verification failed');
      return res.status(403).json({ error: 'Tenant caller verification failed' });
    }

    // LIKE-escape the query to prevent wildcard injection; keep a lowercased
    // raw copy for excerpt windowing via position().
    const pattern = trimmedQuery ? `%${trimmedQuery.replace(/[%_\\]/g, '\\$&')}%` : null;
    const rawLower = trimmedQuery ? trimmedQuery.toLowerCase() : null;

    let retrieval: 'semantic+keyword' | 'keyword' = 'keyword';
    const readEnabled = process.env.RECALL_SEMANTIC_READ_ENABLED === 'true';

    // Scope 1: keyword retrieval (always). Callback returns rows only — no
    // outer-variable mutation from inside the scope.
    const keywordRows = await withTenantScope(tenantId, (client) =>
      client.query(AGENT_CONVERSATIONS_SQL, [
        tenantId, agentId, accountId, limit, pattern, excludeTurnId, rawLower,
      ]).then((r) => r.rows));

    let rows = keywordRows;
    let telemetry: Record<string, number> | null = null;

    // SHORT-CIRCUIT: keyword already filled every slot → semantic can add
    // nothing, so DON'T embed. No incremental result ⇒ no charge, no latency.
    if (readEnabled && trimmedQuery && keywordRows.length < limit) {
      const { getRecallQueryEmbedding } = await import('../agent-chat/turn-embedding-service');
      // Embed OUTSIDE any DB scope (transport deadline + retries:0; fail-open).
      const queryEmbedding = await getRecallQueryEmbedding(trimmedQuery, { tenantId, agentId });
      if (queryEmbedding) {
        // Scope 2: semantic retrieval, then merge in the outer body.
        const semantic = await withTenantScope(tenantId, (client) =>
          client.query(AGENT_CONVERSATIONS_SEMANTIC_SQL, [
            tenantId, agentId, accountId, limit,
            `[${queryEmbedding.vector.join(',')}]`,
            excludeTurnId, rawLower,
            queryEmbedding.provider, queryEmbedding.model,
          ]).then((r) => r.rows));
        const keywordIds = new Set(keywordRows.map((r: { turn_id: string }) => r.turn_id));
        const fill = semantic.filter((r: { turn_id: string }) => !keywordIds.has(r.turn_id));
        rows = [...keywordRows, ...fill].slice(0, limit);
        retrieval = 'semantic+keyword';
        const sims = semantic.map((r: { similarity: number }) => Number(r.similarity));
        telemetry = {
          semanticCount: semantic.length,
          keywordCount: keywordRows.length,
          ...(sims.length > 0 ? {
            simMax: Number(Math.max(...sims).toFixed(3)),
            simMin: Number(Math.min(...sims).toFixed(3)),
            simMean: Number((sims.reduce((a: number, b: number) => a + b, 0) / sims.length).toFixed(3)),
          } : {}),
        };
      }
      // queryEmbedding null (failure/deadline) → keep keyword rows, retrieval
      // stays 'keyword'. No error surfaced (fail-open).
    }

    log.info(
      {
        event: 'platform_tool_agent_conversations',
        tenantId,
        agentId,
        accountId,
        mode: trimmedQuery ? 'search' : 'recent',
        retrieval,
        matchCount: rows.length,
        ...(telemetry ?? {}),
      },
      'agent-conversations recall executed',
    );

    return res.json({
      turns: rows.map((r: {
        turn_id: string;
        thread_id: string;
        channel: string;
        created_at: Date;
        messages: unknown;
      }) => ({
        turnId: r.turn_id,
        threadId: r.thread_id,
        channel: r.channel,
        at: r.created_at,
        messages: r.messages,
      })),
    });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'agent-conversations endpoint failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});


// ── POST /thread-history ───────────────────────────────────────────────
// Reading further back in the conversation an agent is currently holding,
// for the runtime's `read_conversation_history` tool. The in-process
// assistants call src/chat-recall directly; the Chief AI Officer reads its own
// thread store in its own database and never arrives here.
//
// TEAM SURFACE ONLY, and the surface is not a parameter. A service token that
// could name a surface could read a person's Liftoff or Insights Manager
// conversation through a runtime, which is authority no runtime needs: the
// team chat rows are the ones its own turn is already reading.
//
// The thread is resolved under the caller's tenant, so a thread id from
// another workspace reads as absent rather than as an error.

const THREAD_HISTORY_PATH = '/api/internal/platform-tools/thread-history';

platformToolsRouter.post('/thread-history', serviceAuth, async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tenantId = body.tenantId;
    const threadId = body.threadId;
    if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: 'tenantId must be a valid UUID' });
    }
    if (typeof threadId !== 'string' || !UUID_RE.test(threadId)) {
      return res.status(400).json({ error: 'threadId must be a valid UUID' });
    }
    if (body.match !== undefined && typeof body.match !== 'string') {
      return res.status(400).json({ error: 'match must be a string' });
    }
    if (typeof body.match === 'string' && body.match.trim().length > 200) {
      return res.status(400).json({ error: 'match must be at most 200 characters' });
    }
    if (body.before !== undefined && typeof body.before !== 'string') {
      return res.status(400).json({ error: 'before must be a string' });
    }

    const strict = await verifyTenantCallerStrict(req, tenantId, THREAD_HISTORY_PATH);
    if (!strict.ok) {
      log.warn({ tenantId, reason: strict.reason }, 'thread-history: strict caller verification failed');
      return res.status(403).json({ error: 'Tenant caller verification failed' });
    }

    const { readThreadHistory } = await import('../chat-recall/read-thread-history');
    const text = await readThreadHistory(
      { tenantId, surface: 'team', threadId },
      {
        ...(typeof body.before === 'string' ? { before: body.before } : {}),
        ...(typeof body.match === 'string' ? { match: body.match } : {}),
        ...(body.limit !== undefined ? { limit: Number(body.limit) } : {}),
      },
    );

    log.info(
      {
        event: 'platform_tool_thread_history',
        tenantId,
        threadId,
        mode: typeof body.match === 'string' && body.match.trim().length > 0 ? 'match' : 'page',
        paged: typeof body.before === 'string',
        chars: text.length,
      },
      'thread-history read executed',
    );

    return res.json({ text });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'thread-history endpoint failed');
    return res.status(500).json({ error: 'Internal server error' });
  }
});
