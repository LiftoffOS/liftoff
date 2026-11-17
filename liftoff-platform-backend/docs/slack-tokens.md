# Slack tokens — two systems

> The rule is INV-PB-006 in invariants.md.
> The hard rules are docs/invariants.md. This file holds the detail.

## Slack tokens — read this before touching any of it

There are two Slack token systems. ADR-040 replaced per-agent Slack apps (and the Manifest API config-refresh chain and per-agent bot tokens they needed) with one workspace app.

1. **`var.slack_bot_token` (Terraform, infra repo)** — the platform's observability Slack app, posts alerts to `#platform-observability-alerts` via GCP Monitoring channels. Stored in `YOUR_CI_PROJECT_{env}/secrets/slack-bot-token`. Per-env. Prod has no default, dev/staging default to `""`.
2. **Workspace-app bot tokens (Secret Manager, ADR-040)** — ONE Liftoff Slack app per environment serving the connector AND the workspace bot. The install is the slack CONNECTOR connect in liftoff-connector-service: a dual-grant OAuth (`user_scope` = System-3-style connector user token, kept in connector-service; `scope` = the bot), whose bot token is delivered to `POST /api/internal/agent-slack/workspace-install` (`PLATFORM_CALLBACK_TOKEN` auth) → bot-token-service.ts:storeWorkspaceBotToken. Stored at `slack-ws-bot-{tenantIdShort}-{teamId}`; path persisted in `slack_workspace_installs.slack_bot_token_secret_path` (migration 314). One token serves EVERY agent in the tenant; the speaking agent is named in the message text (the sender is always the Liftoff app). Platform-backend binds only `LIFTOFF_SLACK_APP_ID` / `LIFTOFF_SLACK_SIGNING_SECRET` (Terraform; SAME Secret Manager values as connector-service's `SLACK_APP_ID`/`SLACK_SIGNING_SECRET`) — setup runbook: docs/runbooks/SLACK_WORKSPACE_APP_SETUP.md.

Read this page before changing:
- `bot-token-service.ts`'s secret ID format or storage path
- The dual-grant install flow in liftoff-connector-service (`oauth/router.ts` slack branch + `slack-workspace-handoff.ts`)
- Any Terraform resource matching `*slack*`

**Hard rule:** Do not propose `TF_VAR_slack_bot_token=...` invocations, `gcloud secrets versions add slack-config-refresh-token` invocations, manual `slack-token-rotator` job executions, or any other Slack-token operational command without first confirming which of the two systems you're acting on.
