// WS-3.2 — notifications_send standard tool handler.
//
// Sends a notification to a human recipient. Wires into the existing
// `enqueueNotification` pipeline via the platform-callback transport so the
// recipient's stored preferences (Slack DM / in-app / email) drive delivery —
// the agent does NOT pick the channel.

import crypto from 'crypto';
import { logger } from '../infrastructure/logging';
import { getPool } from '../infrastructure/database';
import {
  enqueueNotificationViaCallback,
  resolveAccountsByRole,
  resolveAgentOwnerAccount,
  resolveDefaultEscalationRecipients,
} from '../platform-callback/client';
import type { StandardToolContext, StandardToolResult } from './standard-tool-handler';

interface NotificationsSendInput {
  // Optional: defaults to the agent's escalation_recipient on the internal_agents
  // row (which defaults to role:admin per D42; no owner_account_id column today).
  recipients?: string[];
  // Required: the agent's message. Markdown allowed.
  body: string;
  // Optional: 'normal' or 'urgent'. Currently advisory; cadence comes from
  // recipient preferences.
  priority?: 'normal' | 'urgent';
  // Optional: a short headline. Defaults to the agent's name.
  subject?: string;
  // Optional: a deep-link URL the recipient can click to take action.
  action_url?: string;
  // Optional: whether the recipient is expected to act.
  action_required?: boolean;
}

interface DeliveryRow {
  recipient: string;
  account_id: string;
  notification_id?: string;
  status: 'enqueued' | 'deduped' | 'skipped_no_recipient' | 'failed';
  error?: string;
}

export async function handleNotificationsSend(
  payload: Record<string, unknown>,
  ctx: StandardToolContext,
): Promise<StandardToolResult> {
  const input = payload as unknown as NotificationsSendInput;

  if (!input.body || typeof input.body !== 'string') {
    return { success: false, error: 'notifications_send requires a non-empty "body" string' };
  }
  if (input.priority && !['normal', 'urgent'].includes(input.priority)) {
    return { success: false, error: 'notifications_send "priority" must be "normal" or "urgent"' };
  }

  // Resolve recipients. If omitted, fall back to the agent's configured
  // escalation_recipient (resolved by platform-backend, which knows owner +
  // admin fallback per D4 + D42).
  let recipients = input.recipients ?? [];
  if (recipients.length === 0) {
    const fallback = await resolveDefaultRecipientsForAgent(ctx.tenantId, ctx.agentId);
    if (fallback.length === 0) {
      return {
        success: false,
        error: 'notifications_send: no recipients provided and no default escalation_recipient configured for this agent',
      };
    }
    recipients = fallback;
  }

  // Expand recipients to (recipient_string, account_id) pairs.
  const expanded = await expandRecipientsToAccountIds(ctx.tenantId, recipients);

  // Idempotency: skip if (tenantId, agentId, invocationId, sha256(body)) exists
  // in the last 24h.
  const bodyHash = crypto.createHash('sha256').update(input.body).digest('hex');
  const dedupKey = `${ctx.tenantId}:${ctx.agentId}:${ctx.invocationId ?? ''}:${bodyHash}`;

  const deliveries: DeliveryRow[] = [];

  for (const exp of expanded) {
    if (!exp.account_id) {
      deliveries.push({ recipient: exp.recipient, account_id: '', status: 'skipped_no_recipient' });
      continue;
    }
    // Per-(account, body-hash) dedup, for 24 hours. The window is stated here
    // rather than left to the sweep's cadence: the row outlives 24 h until the
    // daily sweep removes it, and an older row is reclaimed, not a duplicate.
    const dedupRow = await getPool().query(
      `INSERT INTO notification_dedup (tenant_id, agent_id, invocation_id, recipient_account_id, body_sha256, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (recipient_account_id, body_sha256) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         agent_id = EXCLUDED.agent_id,
         invocation_id = EXCLUDED.invocation_id,
         created_at = NOW()
       WHERE notification_dedup.created_at < NOW() - INTERVAL '24 hours'
       RETURNING id`,
      [ctx.tenantId, ctx.agentId, ctx.invocationId ?? null, exp.account_id, bodyHash],
    );
    if (dedupRow.rowCount === 0) {
      deliveries.push({ recipient: exp.recipient, account_id: exp.account_id, status: 'deduped' });
      continue;
    }

    try {
      // Calls the existing PB endpoint POST /api/internal/notifications/enqueue.
      // PB's enqueueNotification reads the recipient's account preferences and
      // routes to realtime email / digest / Slack via the configured channels.
      // type: 'escalation' is forced to realtime in PB's service.ts.
      // PB no-ops silently when NOTIFICATION_DELIVERY_ENABLED !== 'true'; see
      // WS-3 deploy checklist for the env-var requirement.
      await enqueueNotificationViaCallback({
        accountIds: [exp.account_id],
        tenantId: ctx.tenantId,
        type: 'escalation',
        payload: {
          internalAgentName: await fetchAgentName(ctx.tenantId, ctx.agentId),
          eventTitle: input.subject ?? 'Action from your agent',
          eventSummary: input.body,
          eventLink: input.action_url,
          actionRequired: input.action_required ?? false,
          priority: input.priority ?? 'normal',
          agentId: ctx.agentId,
          invocationId: ctx.invocationId,
        },
      });
      deliveries.push({
        recipient: exp.recipient,
        account_id: exp.account_id,
        status: 'enqueued',
        notification_id: dedupRow.rows[0].id,
      });
    } catch (err) {
      const msg = (err as Error).message;
      logger.warn(
        { tenant_id: ctx.tenantId, agent_id: ctx.agentId, account_id: exp.account_id, err: msg },
        'notifications_send: enqueueNotification failed',
      );
      deliveries.push({ recipient: exp.recipient, account_id: exp.account_id, status: 'failed', error: msg });
    }
  }

  const anyFailures = deliveries.some((d) => d.status === 'failed');
  const anyEnqueued = deliveries.some((d) => d.status === 'enqueued');

  return {
    success: !anyFailures && (anyEnqueued || deliveries.every((d) => d.status === 'deduped')),
    result: { deliveries, dedup_key: dedupKey },
    error: anyFailures
      ? `notifications_send: ${deliveries.filter((d) => d.status === 'failed').length} of ${deliveries.length} deliveries failed`
      : undefined,
  };
}

async function expandRecipientsToAccountIds(
  tenantId: string,
  recipients: string[],
): Promise<Array<{ recipient: string; account_id: string }>> {
  const out: Array<{ recipient: string; account_id: string }> = [];
  for (const r of recipients) {
    if (r.startsWith('user:')) {
      out.push({ recipient: r, account_id: r.slice('user:'.length) });
    } else if (r.startsWith('role:')) {
      const role = r.slice('role:'.length);
      const accounts = await resolveAccountsByRole(tenantId, role);
      for (const a of accounts) out.push({ recipient: r, account_id: a });
    } else if (r.startsWith('agent:')) {
      // Per D42 internal_agents has no owner_account_id column.
      // resolveAgentOwnerAccount falls back through ai_team_audit.actor_id
      // (first 'created' audit row) — see PB side.
      const ownerAccount = await resolveAgentOwnerAccount(tenantId, r.slice('agent:'.length));
      if (ownerAccount) out.push({ recipient: r, account_id: ownerAccount });
    } else {
      logger.warn({ recipient: r, tenant_id: tenantId }, 'notifications_send: unrecognized recipient prefix');
    }
  }
  return out;
}

async function resolveDefaultRecipientsForAgent(tenantId: string, agentId: string): Promise<string[]> {
  // PB endpoint returns:
  //   - the agent's escalation_recipient column if non-null (override; D4)
  //   - else role:admin as the safe-by-default fallback (D42 — no owner column on
  //     internal_agents today, so we can't default to a single owner account).
  return resolveDefaultEscalationRecipients(tenantId, agentId);
}

async function fetchAgentName(tenantId: string, agentId: string): Promise<string> {
  const r = await getPool().query(
    `SELECT name FROM agents WHERE tenant_id = $1 AND id = $2`,
    [tenantId, agentId],
  );
  return r.rows[0]?.name ?? 'agent';
}
