// Liftoff workspace Slack app — shared app identity (ADR-040).
//
// ONE Slack app per environment (dev/prod have separate apps because the
// Events/Interactivity request URLs are single-valued per app). The install
// is the slack CONNECTOR OAuth in connector-service — a dual grant whose
// bot token arrives via POST /api/internal/agent-slack/workspace-install —
// so this module holds only what inbound event handling needs: the app id
// (webhook/interactivity fork discriminator) and the signing secret.
// Individual agents are never registered with Slack — routing happens in our
// DB (slack_conversation_agents), and an agent-authored message names the
// speaking agent in its text (the sender is always this one app).
//
// Env (bound in Terraform; same values as connector-service's SLACK_APP_ID /
// SLACK_SIGNING_SECRET secrets — one app, one credential set): when unset,
// the workspace surface is disabled — getLiftoffSlackAppId() returns null so
// neither the webhook nor the interactivity fork ever matches.
//
// Setup: docs/runbooks/SLACK_WORKSPACE_APP_SETUP.md (manifest).

/** The workspace app's Slack app id, or null when the app is not configured. */
export function getLiftoffSlackAppId(): string | null {
  return process.env.LIFTOFF_SLACK_APP_ID || null;
}

/** True when the inbound payload's api_app_id is the Liftoff workspace app. */
export function isWorkspaceAppEvent(apiAppId: string | undefined): boolean {
  const appId = getLiftoffSlackAppId();
  return !!appId && apiAppId === appId;
}

