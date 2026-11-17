# Platform Backend Troubleshooting Guide

Common issues and their solutions for the Platform Backend service.

---

## Quick Diagnostics

### Check Service Health

```bash
# Health endpoint
curl https://api.example.com/health

# Readiness endpoint
curl https://api.example.com/ready

# Expected: {"status":"ok"}
```

### View Recent Logs

```bash
# All logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=platform-backend" \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --limit 50

# Error logs only
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=platform-backend AND severity>=ERROR" \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --limit 20
```

---

## Authentication Issues

### "Unauthorized" (401) on API Requests

**Symptoms**: API returns 401 for authenticated requests

**Possible Causes**:
1. Firebase token expired
2. Token not included in request
3. Firebase project mismatch

**Solutions**:
```bash
# Verify token is being sent
curl -v https://api.example.com/api/accounts \
  -H "Authorization: Bearer YOUR_TOKEN"

# Decode and inspect token (jwt.io or similar)
# Check: exp (expiration), aud (audience), iss (issuer)
```

### Passkey Registration Fails

**Symptoms**: WebAuthn registration returns error

**Possible Causes**:
1. `PASSKEY_RP_ID` doesn't match domain
2. `PASSKEY_ORIGIN` doesn't match frontend URL
3. Browser doesn't support WebAuthn

**Solutions**:
```bash
# Check environment variables
gcloud run services describe platform-backend \
  --region us-west1 \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --format="yaml(spec.template.spec.containers[0].env)" \
  | grep PASSKEY

# RP_ID should match domain (e.g., "example.com")
# ORIGIN should match frontend URL with protocol
```

---

## Database Issues

### Connection Pool Exhausted

**Symptoms**:
- API returns 500 errors
- Logs show "too many connections" or "connection pool exhausted"

**Solutions**:
```bash
# Check active connections
gcloud sql connect control-plane-pg-dev \
  --project YOUR_CONTROL_PROJECT_STAGING \
  -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"

# Kill idle connections
gcloud sql connect control-plane-pg-dev \
  --project YOUR_CONTROL_PROJECT_STAGING \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle' AND query_start < now() - interval '10 minutes';"

# Restart Cloud Run to reset connections
gcloud run services update platform-backend \
  --region us-west1 \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --no-traffic && \
gcloud run services update-traffic platform-backend \
  --region us-west1 \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --to-latest
```

### Migration Failed

**Symptoms**: Deployment succeeds but app errors with "relation does not exist"

**Solutions**:
```bash
# Check migration status
gcloud run jobs describe platform-backend-migrate \
  --region us-west1 \
  --project YOUR_CONTROL_PROJECT_STAGING

# Run migration manually
gcloud run jobs execute platform-backend-migrate \
  --region us-west1 \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --wait

# Check migration history in database
gcloud sql connect control-plane-pg-dev \
  --project YOUR_CONTROL_PROJECT_STAGING \
  -c "SELECT * FROM pgmigrations ORDER BY id DESC LIMIT 10;"
```

### Direct Database Inspection / Repair (Break-Glass)

The control-plane Cloud SQL instance is on a private IP inside the
platform-control VPC and isn't reachable from operator laptops.

**Two break-glass paths** (full runbook in
`Liftoff-Infrastructure-GCP/docs/BREAK_GLASS_DB_ACCESS.md`):

**Option A — Cloud SQL Studio (browser, casual)**
GCP Console → SQL → instance `control-plane-pg-<env>` → Cloud SQL Studio.
Database `liftoff_control`, user `liftoff_app`, password from:
```bash
gcloud secrets versions access latest --secret=control-plane-db-password \
  --project=YOUR_GCP_PROJECT<env>
```

**Option B — `platform-backend-psql` Cloud Run job (scriptable)**
```bash
gcloud run jobs execute platform-backend-psql \
  --project=YOUR_GCP_PROJECT<env> \
  --region=us-west1 \
  --update-env-vars 'QUERY=SELECT COUNT(*) FROM internal_agents;' \
  --wait
```
Output is in Cloud Logging:
```bash
gcloud logging read 'resource.labels.job_name="platform-backend-psql"' \
  --project=YOUR_GCP_PROJECT<env> --limit=10
```
For queries with commas/quotes use the `^@^` alternate delimiter:
```bash
gcloud run jobs execute platform-backend-psql \
  --project=... --region=us-west1 \
  --update-env-vars=^@^"QUERY=SELECT id, name FROM internal_agents WHERE tenant_id = '...';" \
  --wait
```

**WARNING**: this job runs as the default compute SA with full DB
access. Anything you can express in SQL — including `DROP TABLE` — will
execute. Treat like ssh-to-prod. SELECT first, UPDATE second.

---

## OAuth/Connector Issues

### OAuth Redirect Fails

**Symptoms**: Users see "Error connecting" after OAuth

**Possible Causes**:
1. Redirect URI mismatch
2. Client ID/Secret incorrect
3. Scopes not authorized
4. Connector Service unreachable (platform-backend proxy returning 502)

**Where to look**: OAuth start + callback happen inside `liftoff-connector-service` now. Platform-backend is a thin proxy; its logs will show a forwarded request and the Connector Service response code, but the useful error detail is in the Connector Service logs.

**Solutions**:
```bash
# 1. Platform-backend proxy view — did the request make it through?
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name="liftoff-platform-backend" AND jsonPayload.msg:"connector proxy"' \
  --project YOUR_CONTROL_PROJECT_STAGING --limit 20

# 2. Connector Service logs — the actual OAuth handler
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name="connector-service" AND (jsonPayload.msg:oauth OR severity>=WARNING)' \
  --project YOUR_CONTROL_PROJECT_STAGING --limit 20

# 3. Verify the OAuth client secrets are set on the Connector Service
gcloud secrets versions access latest --secret=google-oauth-client-id-dev \
  --project YOUR_CONTROL_PROJECT_STAGING

# Check redirect URI in provider console matches exactly:
# https://api.example.com/api/connectors/oauth/callback
```

### Token Refresh Fails

**Symptoms**: Connector shows "expired" but refresh doesn't work

**Where to look**: Token refresh runs inside the Connector Service (both static OAuth and DCR). The `connectors` / `oauth_dynamic_registrations` rows live in the Connector Service database (`connector_service` on `connector-pg-<env>`), not in platform-backend's DB.

**Solutions**:
```sql
-- Connect to connector-pg (via the service's psql job or Cloud SQL Studio)
SELECT id, type, status, oauth_expires_at, error_message
FROM connectors
WHERE tenant_id = 'YOUR_TENANT_ID'
  AND type = 'google_drive';
```

```bash
# User may need to re-authorize (refresh token revoked)
# Direct them to disconnect and reconnect in dashboard
```

---

## Agent ID / Cost Attribution Issues

### Per-agent cost looks far too low, or disagrees with /insights

**Symptoms**: `monthlyCost` / `tasks30d` on the internal-agents API are near zero (or much
lower than reality) while `/insights` shows a plausible figure for the same window.

**Cause**: `cost_attribution_events.agent_id` is holding **Tenant Runtime** `agents.id` values
instead of `internal_agents.id`. The two id spaces are disjoint, and the column is `TEXT`, so a
wrong-space id stores without a type error and then matches nothing. `getAllAgentsCosts` /
`getAgentCostSummary` key on `internal_agents.id`, so those rows vanish from per-agent
surfaces; `/insights` reads the runtime's already-translated `getAgentCosts` and is unaffected.
See INV-PB-009 and adr/039-agent-id-spaces.md.

**Diagnose** — this should return no rows:

```sql
SELECT source, event_type, count(*), sum(cost_usd)
  FROM cost_attribution_events e
 WHERE e.agent_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM internal_agents ia WHERE ia.id::text = e.agent_id)
 GROUP BY 1, 2 ORDER BY 3 DESC;
```

Any row names the producer still emitting runtime ids.

**Fix**:
1. Confirm the producer sends the internal id. The three tenant-runtime seams
   (`invocation-completed` payload, `/api/invocations/ingestion-feed`, `/sandbox-feed`) must
   include `internalAgentId` alongside `agentId`; the governance feed is translated on this
   side by `src/internal-agents/runtime-agent-id-map.ts`.
2. Re-key history:
   Cloud SQL is private-IP only, so run it as a Cloud Run Job from the deployed image
   (it compiles to `dist/scripts/`), not from a laptop:
   ```bash
   gcloud run jobs create attribution-agent-id-backfill \
     --image=<platform-backend image> --region=us-west1 --project=YOUR_CONTROL_PROJECT_STAGING \
     --service-account=YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com \
     --vpc-connector=serverless-connector --vpc-egress=private-ranges-only \
     --set-secrets=DB_PASSWORD=control-plane-db-password:latest \
     --set-env-vars="DB_HOST=<private ip>,DB_USER=liftoff_app,DB_NAME=liftoff_control,DB_ADMIN_USER=liftoff_admin" \
     --args="node,dist/scripts/backfill-attribution-agent-ids.js"          # dry run
   # then re-create/update with ,--apply appended to the args to write
   ```
   The script's guard fails the run unless per-tenant `customer_cost_usd` and row count are
   unchanged **and** zero rows remain unresolvable. Safe to re-run.

Billing is not affected by this class of bug — `event-classification` only tests
`agentId !== null`, never which id space it is in, so OU/meter/Stripe output is unchanged.

### An agent id returns nothing / can't correlate a uuid to an agent

The runtime owns the mapping. `GET <runtime_url>/internal/agents/resolve?tenantId=&id=` accepts
an id from **either** space and returns both ids plus the agent name. Full procedure:
`liftoff-tenant-runtime/docs/runbooks/resolve-agent-id.md`.

## Billing Issues

### Webhook Not Processing

**Symptoms**: Stripe events not updating subscriptions

**Solutions**:
```bash
# Test webhook endpoint
curl -X POST https://api.example.com/api/webhooks/stripe \
  -H "Content-Type: application/json" \
  -d '{}'
# Should return 400 (bad signature), not 404 or 500

# Check webhook secret
gcloud secrets versions access latest --secret=stripe-webhook-secret-dev \
  --project YOUR_CONTROL_PROJECT_STAGING

# Check Stripe webhook logs
# Dashboard → Developers → Webhooks → Event attempts
```

### Subscription Status Wrong

**Symptoms**: Tenant can't access features despite active subscription

**Solutions**:
```sql
-- Check subscription in database
SELECT t.id, t.name, s.status, s.plan_id, s.stripe_subscription_id
FROM tenants t
JOIN subscriptions s ON t.id = s.tenant_id
WHERE t.id = 'TENANT_ID';

-- Compare with Stripe
-- stripe subscriptions retrieve sub_xxx
```

---

## Pub/Sub Issues

### Events Not Publishing

**Symptoms**: Tenant Runtime not receiving configuration updates

**Solutions**:
```bash
# Check topic exists
gcloud pubsub topics describe control-plane-events-dev \
  --project YOUR_CONTROL_PROJECT_STAGING

# Check publishing permissions
gcloud pubsub topics get-iam-policy control-plane-events-dev \
  --project YOUR_CONTROL_PROJECT_STAGING

# Try publishing manually
gcloud pubsub topics publish control-plane-events-dev \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --message '{"type":"test"}'
```

### Events Publishing but Not Received

**Symptoms**: Events in topic but Tenant Runtime not processing

**Solutions**:
```bash
# Check subscription
gcloud pubsub subscriptions describe control-plane-events-tenant-runtime-<env> \
  --project YOUR_TENANT_PROJECT

# Check dead letter queue
gcloud pubsub subscriptions pull control-plane-events-dlq \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --auto-ack \
  --limit 5
```

---

## Reactive Triggering Issues (ADR 019)

### "My reactive subscription is not firing"

**Symptoms**: subscription rows exist with `status='active'`, but the agent never runs.

**Solutions**:
```bash
# 1. Confirm subscription router is running (look for "Subscription router started" log)
gcloud logging read 'resource.type=cloud_run_revision AND textPayload:"Subscription router started"' \
  --project YOUR_CONTROL_PROJECT_STAGING --limit=5

# 2. Check the predicate references a path the connector actually publishes.
#    The CONNECTOR ENTITY SCHEMAS section in the distill prompt is the authoritative
#    list — anything outside it returns false silently. Path missing →
#    custom.googleapis.com/liftoff/reactive_subscriptions/matched_count stays flat.

# 3. Check the row status — repeated errors flip status='errored' after 5 fails.
SELECT id, label, status, consecutive_errors, last_error
  FROM reactive_subscriptions WHERE agent_id=$1 ORDER BY updated_at DESC;
```

**Root causes**:
- Connector author hasn't called `registerConnectorEntitySchemas` for that entity type → distill emitted a `computed_metric` source kind (slower path) or the field doesn't exist on the synced payload.
- `changed_to` predicate cannot fire on the first event after subscription creation (no prior state to diff). Documented behavior.
- Per-record cooldown is suppressing repeats. Default 1h per `(subscription, entity_id)` key.
- Pub/Sub `-rs` subscription not provisioned in Terraform (see modules/pubsub/main.tf). The router logs a warning and continues without it, but no events arrive.

### "Workflow delay step won't resume"

**Symptoms**: workflow agent stops at a `delay` step and never continues.

**Solutions**:
```bash
# Check agent_scheduled_invocations row
SELECT id, status, fires_at, cloud_task_name, last_error
  FROM agent_scheduled_invocations
  WHERE context_ref LIKE '<workflowId>:%';

# If status='pending' past fires_at — Cloud Task didn't fire or 401/403 on receiver
# If status='errored' — read last_error
# If status='cancelled' — the workflow was cancelled (cancelWorkflow) before resume
```

**Root causes**:
- Receiver `/api/tasks/resume-execution` rejected with 401 (OIDC token audience mismatch).
- Workflow steps were edited between suspend and resume — `resumeAfterStepId` no longer exists.
- Agent was paused/archived between suspend and resume — guard in `resumeWorkflow` skips.

### "Companion cron not running"

**Symptoms**: `triggerConfig.companionCrons[]` has entries but only the primary cron fires.

**Solutions**:
```bash
# List companion jobs for an agent (should see one per label)
gcloud scheduler jobs list \
  --project tenant-<tenant>-<env> \
  --location us-west1 \
  --filter="name:liftoffos-agent-<tenant>-<agent>-companion-"
```

**Root causes**:
- Canonical reconciler hasn't run since the companion was added (≤5 min lag).
- Cloud Scheduler per-project quota reached (500 jobs default). Check `agent-scheduler/missing_count` metric.
- Companion label format invalid (must be lowercase + hyphens + start with letter, 1–32 chars) — the validator rejects it on save, so this only happens for hand-edited DB rows.

---

## Performance Issues

### Slow API Responses

**Symptoms**: API latency > 500ms consistently

**Solutions**:
```bash
# Check Cloud Run metrics
gcloud monitoring metrics list --filter="metric.type:cloudrun"

# Common causes:
# 1. Cold starts - increase min instances
# 2. Database queries - add indexes
# 3. External API calls - add caching

# Increase min instances (reduces cold starts)
gcloud run services update platform-backend \
  --region us-west1 \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --min-instances 1
```

### High Error Rate

**Symptoms**: >1% of requests returning 500

**Solutions**:
```bash
# Get error breakdown
gcloud logging read "resource.type=cloud_run_revision AND severity=ERROR" \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --limit 100 \
  --format="table(timestamp, jsonPayload.msg, jsonPayload.err)"

# Check for patterns:
# - Same endpoint? Add specific handling
# - Same tenant? Check their data
# - Same time? External dependency issue
```

---

## Deployment Issues

### Build Fails

**Symptoms**: Cloud Build returns error

**Solutions**:
```bash
# Check build logs
gcloud builds list --project YOUR_CI_PROJECT_STAGING --limit 5
gcloud builds log BUILD_ID --project YOUR_CI_PROJECT_STAGING

# Common causes:
# - npm install fails: Check package-lock.json
# - TypeScript errors: Run locally first
# - Docker build fails: Check Dockerfile
```

### Deployment Succeeds but App Broken

**Symptoms**: New revision deployed but returning errors

**Solutions**:
```bash
# Check revision logs
gcloud run revisions list --service platform-backend \
  --region us-west1 \
  --project YOUR_CONTROL_PROJECT_STAGING

gcloud logging read "resource.type=cloud_run_revision AND resource.labels.revision_name=REVISION_NAME" \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --limit 50

# Rollback to previous revision
gcloud run services update-traffic platform-backend \
  --region us-west1 \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --to-revisions=PREVIOUS_REVISION=100
```

---

## Environment Variable Issues

### Missing Environment Variable

**Symptoms**: App crashes or feature doesn't work, logs show "undefined"

**Solutions**:
```bash
# List current environment variables
gcloud run services describe platform-backend \
  --region us-west1 \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --format="yaml(spec.template.spec.containers[0].env)"

# Check if secret is mounted
gcloud run services describe platform-backend \
  --region us-west1 \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --format="yaml(spec.template.spec.containers[0].volumeMounts)"

# Verify secret exists
gcloud secrets list --project YOUR_CONTROL_PROJECT_STAGING --filter="name:YOUR_SECRET"
```

---

## External Agent (A2A) Issues

### Discovery Fails

**Symptoms**: "Discover" button shows error, no tools found

**Possible Causes**:
1. External agent endpoint unreachable
2. Endpoint doesn't support MCP protocol
3. Transport type not supported (must be Streamable HTTP or SSE)
4. **MCP server returned tools with invalid input schemas** (see next section)

**Solutions**:
```bash
# Test MCP endpoint manually
curl -X POST https://agent.example.com/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'

# Should return: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"...","capabilities":{},"serverInfo":{...}}}

# Check logs for discovery errors
gcloud logging read "resource.type=cloud_run_revision AND jsonPayload.msg:external-agent AND severity>=WARNING" \
  --project YOUR_CONTROL_PROJECT_STAGING \
  --limit 20
```

### Discovery Rejected with Schema Validation Error

**Symptoms**: Discovery progresses past `discovering` stage but fails with
a structured error like:
```
Connected to your MCP server and fetched its tools, but 2 tool schema(s)
are invalid and would be rejected by the LLM at execution time. Fix your
server's tools/list response and retry. Details:
  • myTool at inputSchema.properties.options: type:array missing items
  • otherTool at inputSchema.properties.payload: ...
```

**Cause**: `MCPClient.discover()` validates every tool's `input_schema`
against `ajv` plus a custom recursive walker BEFORE persisting anything
to `external_agents.raw_mcp_tools` (see
`src/external-agents/mcp-tool-validator.ts` and
`docs/ARCHITECTURE.md` "Discovery Flow"). The validator catches:

- `type: 'array'` properties without `items` (OpenAI's tool API rejects
  these at request time, even though JSON Schema considers `items`
  optional — this is the most common bug)
- Invalid `type` values, malformed `enum`, broken nested structures
- Tools missing `name` or `inputSchema`

**Why we fail loudly here instead of persisting and failing later**:
A persisted bad schema would only be discovered when an agent tries to
use the tool, at which point the LLM provider rejects the entire tools
list with an opaque "Invalid schema for function X" 400 that's hard to
attribute back to the source. By validating at discovery, the tenant
gets a precise error pointing at the exact field on their MCP server
that needs fixing, before anything is committed to the database.

**To fix**:
1. Read the structured error in the SSE response — it lists every
   `(toolName, fieldPath, error)` triple.
2. Fix the corresponding field on your MCP server's `tools/list`
   response. The most common fix: add `items: { type: 'string' }`
   (or appropriate type) to every property declared as `type: 'array'`.
3. Retry discovery via the UI's "Re-discover" button.

**To audit existing rows for the bug class** (post-migration 077):
```bash
gcloud run jobs execute platform-backend-psql \
  --project=YOUR_GCP_PROJECT<env> --region=us-west1 \
  --update-env-vars=^@^"QUERY=SELECT id, tenant_id, name FROM external_agents WHERE deleted_at IS NULL AND raw_mcp_tools IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(raw_mcp_tools) tool, jsonb_each(COALESCE(tool->'inputSchema'->'properties','{}'::jsonb)) prop WHERE prop.value->>'type' = 'array' AND NOT (prop.value ? 'items'));" \
  --wait
```
Any rows returned were persisted before the validator existed and
should be re-discovered via the UI to repair them. Migration 077 is a
diagnostic-only audit — it does not auto-mutate the data because only
the MCP server itself knows what `items` should be for each array.

**Related**: the symmetric validation gate for built-in connector
functions (Google Sheets, Slack, etc.) lives in the tenant runtime as
`validateRegistryAtStartupOrThrow()` — see
`Liftoff-Tenant-Runtime/docs/TROUBLESHOOTING.md` "Tool Schema Validation
Failures" for that side. Together they form a five-layer defense
against malformed schemas reaching an LLM call.

### Tool Calls Fail at Runtime

**Symptoms**: Agent can't use external agent tools, 5-layer enforcement errors

**Solutions by Layer**:

| Error | Layer | Fix |
|-------|-------|-----|
| "Agent not connected" | 1 | Check agent status, trigger rediscovery |
| "Internal agent not authorized" | 2 | Add internal agent to `allowedInternalAgentIds` |
| "Collaboration mode mismatch" | 3 | Change mode to `two_way` or correct direction |
| "Request blocked" | 4 | Update per-team rule from `blocked` |
| "Requires approval" | 5 | Expected for sensitive tools, approve in queue |

```sql
-- Check external agent configuration
SELECT id, name, status, collaboration_mode, allowed_internal_agent_ids
FROM external_agents
WHERE tenant_id = 'YOUR_TENANT_ID';
```

### External Agent Tools Missing from Agent

**Symptoms**: Internal agent can't see external agent tools

**Possible Causes**:
1. External agent not assigned to the team
2. Tenant Runtime hasn't received the Pub/Sub event
3. Cache stale

**Solutions**:
```bash
# Check if external agent is assigned to team
curl "https://api.example.com/api/external-agents/for-team?tenantId=TENANT&teamId=TEAM" \
  -H "Authorization: Bearer TOKEN"

# Trigger rediscovery to refresh
curl -X POST "https://api.example.com/api/external-agents/:id/rediscover?tenantId=TENANT" \
  -H "Authorization: Bearer TOKEN"

# Check Tenant Runtime logs for event processing
gcloud logging read "resource.type=cloud_run_revision AND jsonPayload.msg:external_agent" \
  --project YOUR_TENANT_PROJECT \
  --limit 20
```

### Tool Classification Wrong

**Symptoms**: Tool shows wrong sensitivity, HITL not gating when expected

**Solutions**:
```sql
-- Check tool classifications
SELECT id, name, tool_classifications
FROM external_agents
WHERE id = 'AGENT_ID';
```

To fix, trigger rediscovery or manually update classifications in the dashboard.

### Credential Issues

**Symptoms**: "Authentication failed" when calling external agent

**Solutions**:
```bash
# Update credentials
curl -X POST "https://api.example.com/api/external-agents/:id/credentials" \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"bearer","token":"new-token"}'

# Verify secret was stored
gcloud secrets list --project YOUR_CONTROL_PROJECT_STAGING \
  --filter="name:external-agent-"
```

### Timeout on Tool Calls

**Symptoms**: External agent calls take > 30s and timeout

**Solutions**:
- External agent may be slow - contact provider
- Network latency - check connectivity
- Break large operations into smaller steps

---

## Notification Delivery Issues

See docs/runbooks/NOTIFICATION_OPS.md for operational procedures and docs/adr/011-notification-delivery-system.md for design rationale.

### No notifications are being sent at all

**Probable cause**: kill switch is flipped, scheduler is misconfigured, or the producer-side service-auth token is wrong.

```bash
# 1. Is the kill switch on?
gcloud run revisions describe $(gcloud run services describe platform-backend \
  --project=YOUR_CONTROL_PROJECT --region=us-west1 \
  --format='value(status.latestReadyRevisionName)') \
  --project=YOUR_CONTROL_PROJECT --region=us-west1 \
  --format='value(spec.containers[0].env)' | grep NOTIFICATION_DELIVERY_ENABLED

# 2. Is the tick firing? It is a maintenance Cloud Task armed for the next
#    09:00 anyone has (digest-schedule.ts), re-armed daily by housekeeping.
gcloud logging read \
  'resource.type="cloud_tasks_queue" AND resource.labels.queue_id="maintenance-tasks-prod"' \
  --project=YOUR_CONTROL_PROJECT --limit=200 --format=json | grep -B3 -A12 due-digest

# 3. Are producers hitting enqueue but getting 401?
gcloud logging read \
  'resource.type=cloud_run_revision AND resource.labels.service_name="platform-backend" AND httpRequest.requestUrl:"/api/internal/notifications/enqueue" AND httpRequest.status>=400' \
  --project=YOUR_CONTROL_PROJECT --limit=20
```

If the task attempts show 401s, the `X-Service-Auth` header doesn't match `PLATFORM_CALLBACK_TOKEN`. Make sure `terraform/environments/{env}/main.tf` reads the secret directly via the `google_secret_manager_secret_version` data source (see ADR-011 §11).

### Digest emails aren't going out, but realtime works

**Probable cause**: the digest tick is failing (or was never armed), not the enqueue path.

```bash
# Tick errors in the last 24 h
gcloud logging read \
  'resource.type=cloud_run_revision AND severity>=ERROR AND textPayload:"runDigestTick"' \
  --project=YOUR_CONTROL_PROJECT \
  --freshness=24h --limit=20
```

Also check `notifications` pending count by cadence (see runbook "Inspecting the queue"). If pending is climbing across consecutive ticks but no errors, the tick may be returning early — confirm `NOTIFICATION_DELIVERY_ENABLED=true`.

To drain manually after fixing, see runbook "Manually triggering the digest tick."

### User reports duplicate emails for the same event

**Probable cause**: a producer is calling `enqueueNotification` and the audit-log fan-out is ALSO firing for the same action.

The skiplist `DOMAIN_HANDLED_ACTIONS` in `src/agent-audit-logs/service.ts` exists to prevent this. If a new action type was added to the audit log without being added to the skiplist (and that action has a dedicated producer like HITL escalations or late-feedback), both paths fire.

Fix: add the action name to `DOMAIN_HANDLED_ACTIONS` and add a unit test.

### Unsubscribe link returns "invalid or expired"

**Probable causes** (in order of likelihood):

1. **`UNSUBSCRIBE_SECRET` was rotated.** All in-flight footer links break. Confirm secret version vs. Cloud Run env var; direct user to `/dashboard/settings/account`.
2. **Token is >90 days old.** Same workaround.
3. **Token was hand-copied and got truncated.** Ask the user to click the link directly (don't copy-paste into the URL bar — some clients add a trailing space).

```bash
# Verify the running revision is pointing at the right secret version
gcloud run revisions describe $(gcloud run services describe platform-backend \
  --project=YOUR_CONTROL_PROJECT --region=us-west1 \
  --format='value(status.latestReadyRevisionName)') \
  --project=YOUR_CONTROL_PROJECT --region=us-west1 \
  --format='value(spec.containers[0].env)' | grep -A1 UNSUBSCRIBE_SECRET

# Compare to current Secret Manager version
gcloud secrets versions list unsubscribe-secret \
  --project=YOUR_CONTROL_PROJECT --limit=3
```

### Logo not rendering in Outlook (or shows broken-image icon)

**Probable cause**: `sendEmail()` isn't attaching the CID logo. This regresses if `email/index.ts` is refactored without preserving the auto-attach step.

```bash
# Confirm logo asset exists at runtime
grep -c "LIFTOFF_WORDMARK_PNG_BASE64" src/infrastructure/email/logo-asset.ts
# Should be ≥1
```

Check the actual MIME structure of a test email (Gmail → "Show original"). The footer `<img src="cid:logo">` must have a matching `Content-ID: <logo>` part with `Content-Disposition: inline`.

### Mobile users report image-zoom triggered when tapping the logo

**Fix is already in place**: the wordmark `<img>` carries `pointer-events:none; -webkit-touch-callout:none; -webkit-user-select:none;` in `src/infrastructure/email/shared.ts:FOOTER`. If you see a regression, those three properties were stripped from the FOOTER template.

### Newsletter body links are blue + underlined

**Probable cause**: `styleAnchorsInHtml()` wasn't applied to the operator-supplied HTML. The newsletter broadcast endpoint must run input HTML through this helper before composing the email — search `src/notifications/email.ts` for `styleAnchorsInHtml` to confirm.

### Tuesday performance recap didn't send to a specific user

```sql
-- Did they get one this week?
SELECT account_id, monday_local_date, reserved_at
  FROM notification_perf_recaps_sent
 WHERE account_id = '<uuid>'
   AND monday_local_date >= CURRENT_DATE - INTERVAL '14 days'
 ORDER BY monday_local_date DESC;

-- Did the metrics check return non-zero?
-- (manually run loadPerfMetricsForAccount against their account in a one-off script)
```

If `notification_perf_recaps_sent` shows no row for the current Monday, the metrics check returned zero and the reservation was correctly skipped (see ADR-011 §4). If the row exists but no email arrived, look for `delivery_error` in `notifications`.

---

## Composio-Managed Connectors

For the decision tree, link/poll lifecycle, and bootstrap + migration ops procedures, see **ADR-013** and **`docs/runbooks/COMPOSIO_BOOTSTRAP.md`**. Most common runtime failures:

### Connect button on cal_com / mailchimp / trello / freshbooks / etc. returns 503

The catalog entry's Composio resources haven't been bootstrapped. `/start` rejects with one of:
- `composio_start_missing_auth_config_id` — `authConfigIds[env]` still contains `<from-phase-0>` in `connectors.ts`.
- `composio_start_missing_mcp_server_id` — same for `mcpServerIds[env]`.

Run `npm run composio:bootstrap-toolkit -- --slug=<toolkit>` in `liftoff-connector-service`, paste the resolved ids into `connectors.ts`, and redeploy. The catalog projection auto-downgrades placeholder entries to `coming_soon` on `/api/connectors/catalog`, so users SHOULDN'T see a Connect button when bootstrap hasn't run — if they do, the projection guard regressed.

### `composio_link_pending_at_deadline_oauth_state_retained_for_retry`

User consented through Composio but the connected_account didn't flip ACTIVE within `/callback`'s 30s deadline. **The oauth_state row is kept alive by design** — a browser refresh re-fires `/callback` and polls again. If the user reports it:

1. Have them refresh the `/oauth/callback?error=composio_link_failed` page.
2. If still pending after 2–3 refreshes, check Composio's status page.
3. Last resort: have them start over from `/connections`.

Orphan exposure is bounded: oauth_state rows only delete on terminal Composio status, and Composio doesn't auto-clean INITIATED rows. Operators can grep `composio_link_pending_at_deadline_oauth_state_retained_for_retry` in connector-service logs to find potentially-orphaned `connectedAccountId`s and reconcile in the Composio dashboard.

### `composio_user_id_missing` warns from tenant-runtime

Two possible causes:

1. **Partial deploy** — old connector-service serving new tenant-runtime. proto3's string default is `""` so old responses look like Composio responses to a naive discriminator. Tenant-runtime's correct discriminator (positive `composioUserId` presence) falls back to Bearer cleanly. If the connector in question IS composio_managed in the catalog, fix by deploying connector-service.
2. **RPC handler bug** — connector-service sees the connector as `composio_managed` but didn't set `composioUserId = tenantId`. Inspect `rpc/router.ts` `getMcpServerConfig` handler.

### Agent sees duplicate tools for cal_com / mailchimp / trello

`connector-functions-registry.ts::getConnectorFunctions` should return `[]` for `composio_managed` connectors. If duplicates are visible: either the filter regressed OR a tenant has BOTH a legacy `'error'` row AND a new Composio `'active'` row for the same connector type (the adopt-in-place path didn't fire).

```sql
SELECT id, status, config->>'disconnect_reason' AS reason,
       config->>'composioConnectedAccountId' AS composio_id,
       created_at, updated_at
  FROM connectors
 WHERE tenant_id = '<uuid>' AND type = 'cal_com'
 ORDER BY created_at DESC;
```

Two rows where one has `reason='composio_migration'` and the other has `composio_id` set → adopt-in-place failed (most likely the legacy row's status was manually flipped off `'error'` so `findMigrationMarkedConnector` couldn't see it). Delete the orphan row.

### Composio meter spike

Check `https://app.composio.dev/project/<pr_id>/usage`. If a specific toolkit's call count is way above expectation, grep `vendor_mcp_server_configured mode=composio` log frequency in tenant-runtime for that toolkit. Short-circuit while investigating:

```bash
gcloud run services update connector-service \
  --update-env-vars=COMPOSIO_DISABLED_CONNECTORS=<type> \
  --region=us-west1 --project=YOUR_CONTROL_PROJECT
```

For long-term reduction, HITL-gate the connector's destructive tools to throttle agent calls.

---

## "My agent has a custom_mcp_server integration but isn't using its tools"

Post-F-5 every vendor adapter handles MCP catalogs natively (Anthropic via
`mcpServers` config, OpenAI via `MCPServerStreamableHttp`/`MCPServerSSE`).
Engine-routing no longer gates MCP tool visibility. If a custom MCP
server's tools aren't reaching the LLM, check it at the MCP layer:

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND
  textPayload:"vendor_mcp_server_custom_mcp_tools_discovered" AND
  textPayload:"<tenantId>" AND textPayload:"<integrationId>"' \
  --project=<tenant-runtime-project> --freshness=24h
```

The log line includes `toolCount` and `toolNames`. If `toolCount = 0`, the
MCP server returned an empty `tools/list` — the issue is on the MCP
server side, not Liftoff. If the log is absent entirely, check for
`vendor_mcp_server_custom_mcp_tools_probe_failed` (probe failed —
auth/network/transport) or `vendor_mcp_resolve_failed_custom_mcp` (PB
didn't return the server config — check the integration ID exists in
`custom_mcp_servers` table for this tenant).

---

## MCP OAuth Front Door

### Claude Code / Codex loops on the browser login (401 loop)

The `/mcp` challenge is only advertised when `MCP_OAUTH_ENABLED=true`. If the flag is on and the loop persists: check that `/.well-known/oauth-protected-resource/mcp` returns 200 with the env-correct issuer (a dev deployment leaking prod URLs means `BACKEND_URL` is unset — `getBackendUrl()` should have thrown), and that the token being replayed is `liftoff_oat_*` (an expired one gets `error="invalid_token"` in the challenge, which tells the client to refresh, not re-auth).

### Refresh token rejected with invalid_grant

Three distinct causes, in likelihood order: (1) concurrent refresh — two clients raced; the loser gets `invalid_grant` inside a 30-second grace with NO revocation and should simply retry auth; (2) stale replay AFTER the grace — treated as theft: the whole grant family (grant + tokens + anchor) is revoked and a `oauth_refresh_replay_revocation` warning is logged; the user must re-consent; (3) the grant's anchor hit its 365-day expiry — re-consent runs the revoke-then-recreate branch and issues a fresh grant.

### liftoff_chat stuck in in_progress / failed('worker_lost')

The chat worker runs as a Cloud Tasks delivery to `/api/internal/mcp-chat-runs/execute`. `worker_lost` means the worker's request died mid-turn and the lease expired — deliberately NOT re-executed (chat turns are non-idempotent); the user retries with a new message. Check: the `mcp-chat-runs-{env}` queue exists, `MCP_CHAT_RUNS_INVOKER_SA` matches the queue task OIDC SA, and the worker isn't 401ing (SA mismatch shows as unauthorized deliveries + `never_claimed` sweeps).

### liftoff_chat stuck in `waiting_on_human` / HITL banner never clears

`waiting_on_human` is a **durable, resolvable pause**, not a stuck run (ADR-033): a tool call hit the HITL gate and is waiting for an operator decision in `/dashboard/review`. `liftoff_get_chat_reply` keeps returning `waiting_on_human` (and the web chat keeps showing the "Waiting on your review to continue" banner) until the operator approves/rejects. Normal resolution: the operator decides → TR's `resumeFromHitlApproval` runs → TR calls back `POST /api/internal/mcp-chat-runs/settle-by-approval` → the run flips to `completed` (reply appended to `agent_chat_messages`) or the rejection frees the thread. If it never clears after a decision was made, check, in order: (1) the settle callback is reaching PB — grep PB logs for `settle-by-approval` and a `401` means `PLATFORM_CALLBACK_TOKEN` mismatch between TR and PB; (2) the resume Cloud Task actually fired (TR `enqueueResumeForHitl` → `/api/tasks`); (3) the 24h expiry backstop — a lapsed approval is settled as `failed('approval_expired')` by `finalizeHitlExpired` (same callback), which is the intended terminal state for an ignored approval. A second `liftoff_chat` on the same thread returning `waiting_on_human` pointing to Review is **correct** — the paused run blocks the thread by design (migration 296 index) rather than forking a new run.

## Getting Help

If you can't resolve the issue:

1. **Collect logs**: Last 100 lines around the error
2. **Collect context**: What changed? When did it start?
3. **Check recent deployments**: Did a deploy happen?
4. **Post in #platform-support**: Include logs and context
