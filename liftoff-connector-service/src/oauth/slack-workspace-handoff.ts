// Slack workspace-install handoff.
//
// The slack connector OAuth is a dual grant: user_scope mints the connector's
// as-user credential (stored here in connector-service), and scope installs
// the Liftoff app's bot into the workspace. The bot token is platform-
// backend's concern — it drives agent chat routing, HITL cards, and the
// slack_* bot tools (PB migration 314 slack_workspace_installs, PB ADR-040).
// This module delivers that bot token to platform-backend after the
// connector row settles.
//
// Best-effort by design: a failed handoff must not fail the connector
// connect (the user token is already stored and the connector is active).
// A reconnect re-delivers the bot token, so the recovery path is the same
// Reconnect button the rest of the OAuth flow already leans on.
//
// Auth: PLATFORM_CALLBACK_TOKEN via X-Service-Auth — the same shared-secret
// service auth the TR→PB platform-callback routes use; platform-backend
// validates it with verifyServiceAuth({ tokenEnvVar: 'PLATFORM_CALLBACK_TOKEN' }).
// URL: BACKEND_URL is the environment's API load-balancer origin, which also
// fronts platform-backend.

import { logger } from '../infra/logging.js';

export interface SlackWorkspaceHandoffInput {
  tenantId: string;
  slackTeamId: string;
  slackTeamName: string | null;
  slackBotUserId: string;
  botToken: string;
  installedByAccountId: string | null;
}

export async function handoffSlackWorkspaceInstall(
  input: SlackWorkspaceHandoffInput,
): Promise<boolean> {
  const base = process.env.BACKEND_URL;
  const token = process.env.PLATFORM_CALLBACK_TOKEN;
  if (!base || !token) {
    logger.warn(
      { hasBase: !!base, hasToken: !!token },
      'slack workspace handoff skipped — BACKEND_URL/PLATFORM_CALLBACK_TOKEN not set',
    );
    return false;
  }

  try {
    const res = await fetch(`${base}/api/internal/agent-slack/workspace-install`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Service-Auth': token,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error(
        { status: res.status, body: body.slice(0, 300), slackTeamId: input.slackTeamId },
        'slack workspace handoff rejected by platform-backend',
      );
      return false;
    }
    logger.info(
      { tenantId: input.tenantId, slackTeamId: input.slackTeamId },
      'slack workspace install handed off to platform-backend',
    );
    return true;
  } catch (err) {
    logger.error(
      { err: (err as Error).message, slackTeamId: input.slackTeamId },
      'slack workspace handoff failed',
    );
    return false;
  }
}

/**
 * Forward a signature-verified Slack event to platform-backend's chat router.
 *
 * Slack allows ONE Events URL per app and this service owns it, because it
 * also publishes every message onto connector-events for reactive
 * subscriptions (ADR-019). Platform-backend's chat handler only acts on
 * messages addressed to an agent, so pointing the URL there instead would
 * silence the bus for everything else. Forwarding keeps both.
 *
 * AWAITED by the caller before it acks Slack: this service runs with Cloud
 * Run's default CPU throttling, so work queued after the response can be
 * frozen mid-flight. A dropped forward means someone's DM never gets a
 * reply, which is not a loss worth taking. Capped below Slack's 3s retry
 * budget; on timeout Slack retries and platform-backend dedups.
 */
export async function forwardSlackEventToChat(envelope: {
  team_id: string;
  api_app_id?: string;
  event_id?: string;
  event: Record<string, unknown>;
}): Promise<boolean> {
  const base = process.env.BACKEND_URL;
  const token = process.env.PLATFORM_CALLBACK_TOKEN;
  if (!base || !token) return false;

  try {
    const res = await fetch(`${base}/api/internal/agent-slack/workspace-event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Service-Auth': token },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, teamId: envelope.team_id },
        'slack chat forward rejected by platform-backend',
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, teamId: envelope.team_id },
      'slack chat forward failed (slack will retry; platform-backend dedups)',
    );
    return false;
  }
}
