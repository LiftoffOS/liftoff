# Tenant Runtime Troubleshooting Guide

Common issues and their solutions for the Tenant Runtime service.

---

## Quick Diagnostics

### Check Service Health

```bash
# Health endpoint (replace with your tenant runtime URL)
curl https://tenant-runtime-HASH.run.app/health

# Expected: {"status":"ok"}

# Readiness probe (used by Cloud Run startup probe)
curl https://tenant-runtime-HASH.run.app/startup-ready
# Expected when ready:   {"ready":true,"schemaReady":true,"draining":false}
# Expected when not ready: HTTP 503  {"ready":false,...}
```

### `/startup-ready` Returns `{"ready":false}`

**Symptoms**: Cloud Run startup probe stays in a non-ready state; the revision never receives traffic.

**Possible Causes**:
1. **Schema not yet ready** — the migration job (`tenant-runtime-migrate`) has not finished, or the `schema_version` table's `chat_turn_runtime` row does not yet show the expected version. This is normal during rolling deploys; the instance will become ready once migrations complete.
2. **Service is draining** — a SIGTERM was received and the runtime is waiting for in-flight chat turns to finish (up to 20 s). The instance will exit after draining completes.

**Diagnosis**:
```bash
# Check the startup-ready response body for which flag is false
curl -s https://tenant-runtime-HASH.run.app/startup-ready | jq .

# Check migration job status
gcloud run jobs describe tenant-runtime-migrate \
  --project YOUR_TENANT_PROJECT --region us-west1 \
  --format="table(status.conditions[0].type,status.conditions[0].status)"

# Check migration job logs for errors
gcloud logging read 'resource.labels.job_name="tenant-runtime-migrate"' \
  --project YOUR_TENANT_PROJECT --limit 20
```

**Resolution**: If migrations are stuck, check the migration job logs for a failing SQL statement, fix the migration, commit, and push.

### View Recent Logs

```bash
# All logs
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=tenant-runtime" \
  --project YOUR_TENANT_PROJECT \
  --limit 50

# Error logs only
gcloud logging read "resource.type=cloud_run_revision AND severity>=ERROR" \
  --project YOUR_TENANT_PROJECT \
  --limit 20
```

---

## Interactive Chat Issues

### Chat Turn Returns Tool-Access Errors

**Symptoms**: A chat turn completes but the agent reports it cannot use certain tools (e.g. workspace tools, git operations). Error message in the SSE stream resembles `tool 'workspace_run' not available for capability_tier 'connector_only'`.

**Root cause**: The agent's `compiled_instructions` row has `capability_tier = 'connector_only'`. Workspace MCP tools (`workspace_run`, `workspace_git_*`) require `capability_tier = 'execution_enabled'`. This is set during agent distillation; if the agent's instructions were compiled before execution capability was enabled for the tenant, the tier will be stale.

**Resolution**: Trigger a re-distillation of the agent's instructions from the Platform Backend. In the UI this is "Re-compile instructions" on the agent's settings page; via API:

```bash
curl -X POST -H "X-Tenant-ID: YOUR_TENANT" \
  -H "Authorization: Bearer TOKEN" \
  https://api.example.com/api/agents/AGENT_ID/recompile
```

After distillation completes, the next chat turn will pick up the updated `capability_tier`.

```sql
-- Verify the tier was updated
SELECT id, capability_tier, updated_at
FROM compiled_instructions
WHERE agent_id = 'AGENT_ID';
```

---

## HITL (Human-in-the-Loop) Issues

### An approval expired and the operator says they never saw it

**Symptoms**: a run settled `failed` with `approval_expired`, the record reads
`24h expiry — no operator decision`, and the person it was routed to says nothing
ever arrived.

**Believe them.** Until migration 366 that message was written identically whether
a human ignored the request or was never sent it: the Slack DM / Teams fan-out is
fire-and-forget inside `setImmediate`, and a failure left only a `logger.warn`.

**Diagnose** — the three states are now distinguishable on the approval row:

```sql
SELECT id, created_at, status,
       notify_attempted_at, notify_target_count, notify_delivered_count, notify_error
FROM hitl_approval_requests
WHERE tenant_id = 'YOUR_TENANT'
ORDER BY created_at DESC LIMIT 20;
```

| What you see | What happened |
|---|---|
| `notify_attempted_at` set, `notify_delivered_count = 0` | The gate paused a run and reached NOBODY. Also emitted as a `HITL approval announced to nobody` warn log, and the expiry message says so explicitly. |
| `notify_target_count = 0` | Nobody assigned can take that level — a ROUTING problem, not delivery. Check `listAgentAssignees` and the person-to-agent assignments for the tenant. |
| `notify_attempted_at IS NULL` | No push was attempted, and this is NORMAL for a non-messaging gate with no generic card: the dashboard review queue is its surface. |

All approvals that reached nobody, most recent first:

```sql
SELECT id, agent_id, created_at, notify_target_count, notify_error
FROM hitl_approval_requests
WHERE tenant_id = 'YOUR_TENANT'
  AND notify_attempted_at IS NOT NULL
  AND notify_delivered_count = 0
ORDER BY created_at DESC;
```

**Do NOT diagnose this from `dm_delivery_attempts`.** That table is keyed
`(tenant, assignee, kind, channel)` and tracks whether a TARGET is healthy — it
answers "has this person been failing lately", never "did approval X reach
anyone". A person can be perfectly healthy there while a specific approval
reached nobody.

### Tool Calls Always Getting Gated

**Symptoms**: Even low-risk tools require approval at Level 4

**Possible Causes**:
1. Tool not classified (categories = undefined)
2. Tool has sensitive categories
3. HITL level not synced from Control Plane

**Solutions**:
```sql
-- Check tool classification
SELECT tool_name, categories, classified_at
FROM tool_classification_cache
WHERE connector_type = 'google_drive';

-- Check oversight settings
SELECT * FROM tenant_oversight_cache WHERE tenant_id = 'YOUR_TENANT';
```

### Approval Request Not Created

**Symptoms**: Tool call blocked but no approval appears in queue

**Solutions**:
```sql
-- Check for pending approvals
SELECT id, status, pending_tool_calls, created_at
FROM hitl_approval_requests
WHERE tenant_id = 'YOUR_TENANT'
ORDER BY created_at DESC
LIMIT 10;

-- Check for errors in approval creation
-- Look at logs for "HITL approval" messages
```

### Rate Limit Exceeded at Level 5

**Symptoms**: Autonomous operations blocked with "rate_limit_exceeded"

**Solutions**:
```sql
-- Check recent autonomous operations count
SELECT COUNT(*) FROM audit_logs
WHERE tenant_id = 'YOUR_TENANT'
  AND action IN ('hitl_level_5_operation', 'hitl_level_4_auto_elevated')
  AND created_at > NOW() - INTERVAL '1 hour';

-- Current limit is 1000/hour
-- User needs to wait or switch to lower HITL level
```

---

## Agent Execution Issues

### Agent Invocation Fails Immediately

**Symptoms**: Invocation created but errors instantly

**Possible Causes**:
1. Missing entitlements
2. Agent not found
3. Tenant suspended

**Solutions**:
```bash
# Check entitlements cache
curl -H "X-Tenant-ID: YOUR_TENANT" \
  http://localhost:4000/api/tenant/entitlements

# Check agent exists and is active
curl -H "X-Tenant-ID: YOUR_TENANT" \
  http://localhost:4000/api/agents/AGENT_ID
```

```sql
-- Verify agent status
SELECT id, name, status, hitl_level
FROM agents
WHERE id = 'AGENT_ID';
```

### A step was aborted after a few pages could not be fetched, or a run escalated for "connectivity"

**Symptoms**: a research step stops with `hybrid_loop.identical_tool_failure_cap`, or an
operator-side escalation whose reason describes a service being down beside a step that
fetched most of its pages; a chat thread reads "Passed to a person for review." although
nobody was notified.

**What to expect since ADR-012** (`docs/adr/012-missing-page-is-an-answer-and-step-salvage.md`):

- A page that no vendor could retrieve reaches the model as
  `TOOL_ERROR {code:"not_found", retryable:false, ...}` naming the address. Three
  different addresses are three facts, not a strike: the cap fires only for the SAME
  call (tool + canonical arguments) rejected three times, folded per model turn.
  The code arrives only when EVERY vendor the chain tried (two per call) reported a
  miss by its own shape. A vendor 429 or 5xx in the chain keeps today's
  `internal_error`: `web_fetch_router vendor failed` beside each fetch names the
  vendor and its error. A burst of parallel fetches from one step can 429 the lead
  vendor for all of them at once. A browser vendor reports a miss from the origin's
  own status on the navigation response (`the origin answered 404 for the page`);
  Playwright's bare `net::ERR_HTTP_RESPONSE_CODE_FAILURE` names none and is not one.
- An operator record from a recovery escalate starts with a fact line
  (`<detail> (step <id>; N earlier recoveries on this step, M in the run)`) and carries
  the advisor's sentence under `Advisor:`. Rows dedupe on
  `reason_fingerprint = recovery_decision:<step>:<anomaly kind>` per graph version.
- A step interrupted after read-only work is finished from what it gathered: look for
  the metric `hybrid_loop.step_salvaged {step_id, cause}` and the log line
  `step interrupted after doing read-only work; its output was produced from the
  material it had`. The run's completion audit `outputSummary` ends with
  `finished on partial material from step(s) <ids>`, and `TaskExecutionResult.salvagedSteps`
  names them. A refused salvage logs `step not salvaged: <reason>` at INFO and takes
  today's routing (`onFailure`, the fast escalate, the caps, the advisor).
- The thread's hand-off sentence and the `complete` frame's `escalated` flag follow the
  escalation row's `kind`: only `escalation` rows (a thread opened, a notification sent)
  claim it. A `system_internal` end persists the closing reply alone, or
  `This run did not finish.`

**Checks**:
```sql
-- The escalation rows a run wrote, with their surface and fingerprint
SELECT id, kind, reason_fingerprint, instruction_version, occurrence_count, left(reason, 200)
FROM workflow_escalations
WHERE agent_id = 'AGENT_ID'
ORDER BY created_at DESC LIMIT 10;
```

```bash
# Salvages and refusals for one invocation
gcloud logging read 'jsonPayload.invocationId="INVOCATION_ID" AND (jsonPayload.msg:"step not salvaged" OR jsonPayload.msg:"read-only work")' --limit=20
```

### A Grok step through opencode ends with `reasoning part reasoning-<id> not found`

**Symptoms**: a step's engine error names an `UnknownError` whose message is
`"reasoning part reasoning-<uuid> not found"`; the step had done nothing wrong and the
turn died mid-stream (no `step-finish` part).

**Cause** (ADR-013): opencode reached xAI over `/v1/chat/completions`, whose stream for
`grok-4.3` can carry a chunk with `reasoning_content` and `content` together; the bundled
`@ai-sdk/xai` chat model ends the reasoning block on the content and then emits the same
chunk's reasoning delta against it, the AI SDK core reports that as an in-band error, and
opencode fails the turn on any error part. opencode selects the Responses API model for
xai only when the provider exists from an `XAI_API_KEY` in the server's environment,
which a key in the inline config alone does not create.

**What to expect now**: the runtime spawns the opencode server itself
(`adapter/opencode/server.ts`) with the allow-listed environment plus `XAI_API_KEY`, so
every Grok request goes to `/v1/responses` and each turn carries a reasoning part. The
`code_session` opencode runner does the same for a Grok coding session.

**Checks**: if the text returns, first establish which path the turn took. The id shape
alone does not say (xAI's chat completion ids and Responses `response.id`s share it).
Run the pinned opencode from the runtime image through a logging proxy, as the ADR
describes, and read the request path and the raw event order; on `/v1/responses` the
only known path to the same text is a `reasoning_summary_text.delta` arriving without a
prior `reasoning_summary_part.added` for its item.

### LLM Call Fails

**Symptoms**: Agent runs but model call returns error

**Possible Causes**:
1. API key not set
2. Rate limited by provider
3. Invalid model configuration
4. Malformed tool input_schema (LLM provider rejects the tools list)

**Solutions**:
```bash
# Check OpenAI key is set
gcloud secrets versions access latest --secret=openai-api-key \
  --project YOUR_TENANT_PROJECT

# Check logs for specific error
gcloud logging read "jsonPayload.msg:LLM AND severity>=WARNING" \
  --project YOUR_TENANT_PROJECT \
  --limit 20

# Common errors:
# - "invalid_api_key": Key wrong or revoked
# - "rate_limit_exceeded": Wait and retry
# - "context_length_exceeded": Reduce input size
# - "Invalid schema for function 'X': ... array schema missing items"
#   → See "Tool Schema Validation Failures" below
```

---

### Tool Schema Validation Failures

**Symptoms**: `Agent task execution failed` with error like
```
400 Invalid schema for function 'google-sheets__create_spreadsheet':
In context=('properties', 'sheets'), array schema missing items.
```

**Root cause**: a connector tool schema served by the Connector Service
(`liftoff-connector-service`) is missing `items` on a `type: 'array'`
property, or has some other JSON Schema invalidity that the LLM provider
rejects. (For standard / research tools in tenant-runtime — `STANDARD_TOOLS`
/ `RESEARCH_TOOLS` in `src/tools/` — the same class of bug can also occur.)

**This should be impossible in production** because the Connector Service's
startup validator refuses to start on a malformed schema and Cloud Run keeps
the previous good revision serving. If you're seeing this error in prod, it
means either:

1. The validator is bypassed somehow in `liftoff-connector-service` (check
   its `start()` entry point for the registry validation call).
2. The error is actually coming from a tenant's external-agent MCP server —
   see the Platform Backend's `MCPClient.discover()` validator.
3. The tenant-runtime's `tool-schema-cache` is holding a stale response
   from before the fix deployed. The cache TTL is 5 min; waiting or
   hitting `/internal/tool-schema-cache/refresh` (if exposed) clears it.

**How to verify the Connector Service validator caught it**:
```bash
# On the Connector Service startup, this log line confirms the registry validated
gcloud logging read 'resource.type=cloud_run_revision \
  AND resource.labels.service_name="connector-service" \
  AND jsonPayload.message="Tool schema registry validated"' \
  --project YOUR_CONTROL_PROJECT_STAGING --limit 1
```

**How to fix a real schema bug**:
1. Find the offending function in `liftoff-connector-service`'s connector-tools registry
2. Add `items` to the offending `type: 'array'` property
3. Run `npm test` in that repo — the schema validation tests will now pass
4. Commit and push. The next tenant-runtime `ListTools` cache refresh
   (≤5 min) picks up the corrected schema.

**Five-layer defense** documented in the README's "Tool Schema Source
of Truth" section.

---

### Database Inspection / Repair (Break-Glass)

**Symptoms**: You need to inspect or repair tenant data directly — debug
a stuck agent, fix a corrupt row, run a one-off SELECT — and the data
isn't accessible via the API.

**Why this is hard**: Cloud SQL is on a private IP inside the tenant
VPC and isn't reachable from operator laptops by design. There's no
SSH, no public IP, no port forward.

**Two break-glass paths** (documented in
`Liftoff-Infrastructure-GCP/docs/BREAK_GLASS_DB_ACCESS.md`):

**Option A — Cloud SQL Studio (browser, casual)**
GCP Console → SQL → instance `tenant-<tenant>-pg-<env>` → Cloud SQL Studio.
Database `tenant_runtime`, user `tenant_app`, password from
`gcloud secrets versions access latest --secret=tenant-db-password
--project=tenant-<tenant>-<env>`. Best for ad-hoc SELECTs.

**Option B — `tenant-runtime-psql` Cloud Run job (scriptable)**
```bash
gcloud run jobs execute tenant-runtime-psql \
  --project=tenant-<tenant>-<env> \
  --region=us-west1 \
  --update-env-vars 'QUERY=SELECT COUNT(*) FROM connectors;' \
  --wait
```
Output is in Cloud Logging:
```bash
gcloud logging read 'resource.labels.job_name="tenant-runtime-psql"' \
  --project=tenant-<tenant>-<env> --limit=10
```
For queries with commas/quotes use the `^@^` alternate delimiter:
```bash
gcloud run jobs execute tenant-runtime-psql \
  --project=... --region=us-west1 \
  --update-env-vars=^@^"QUERY=SELECT id, name FROM connectors WHERE type = 'google_sheets';" \
  --wait
```

**WARNING**: `tenant-runtime-psql` runs as the default compute SA with
full DB access. Anything you can express in SQL — including `DROP TABLE`
— will execute. Treat like ssh-to-prod. SELECT first, UPDATE second.

---

## Workspace Isolation Issues

### Workspace Path Isolation Errors (`OUTSIDE_WORKSPACE`)

**Symptoms**: An SDK tool call (Read, Write, Edit, Glob, Grep) inside a chat turn is blocked with an error containing the code `OUTSIDE_WORKSPACE` or a message like `path resolves outside workspace boundary`.

**Root cause**: The `PreToolUse` hook in `src/workspace/path-isolation.ts` rejected the path. This happens when:
1. A relative path with `..` components would escape the thread's workspace directory.
2. A symlink inside the workspace points to a location outside the workspace boundary (intermediate-component symlink TOCTOU — the hook walks every component with `O_NOFOLLOW`).
3. The agent was given an absolute path by untrusted content in the conversation.

**This is a security enforcement, not a bug.** If the agent legitimately needs to access a path outside its workspace, that path should be provided via the system prompt or a trusted tool, not derived from user/tool output.

**Diagnosis**:
```bash
# Look for OUTSIDE_WORKSPACE events in logs
gcloud logging read 'resource.type=cloud_run_revision AND jsonPayload.event="path_isolation_block"' \
  --project YOUR_TENANT_PROJECT --limit 10 \
  --format="table(timestamp,jsonPayload.path,jsonPayload.reason)"
```

**Resolution**: If the rejection is a false positive (e.g. a legitimate symlink within the workspace pointing to another workspace location), file a bug against `src/workspace/path-isolation.ts` with the exact path and symlink chain. Do not disable the hook.

---

## Tool Gateway Issues

### Tool Execution Timeout

**Symptoms**: Tool call takes too long, times out

**Solutions**:
```bash
# Check external API status
# e.g., for Salesforce: https://status.salesforce.com

# Check connector health
curl -H "X-Tenant-ID: YOUR_TENANT" \
  http://localhost:4000/api/connectors/CONNECTOR_ID/status
```

### Conflict Detection False Positive

**Symptoms**: Tool fails with conflict but no actual conflict

**Solutions**:
```sql
-- Check recent tool gateway actions
SELECT id, connector_type, action_name, resolution_mode, conflict_detected, created_at
FROM tool_gateway_actions
WHERE tenant_id = 'YOUR_TENANT'
ORDER BY created_at DESC
LIMIT 20;

-- If using compare-and-set mode, resource may have been modified
-- Switch to fresh-read-before-write for this operation type
```

### Credential Refresh Fails

**Symptoms**: Tool calls fail with "unauthorized" after working

**Solutions**:
```bash
# Check credential in Secret Manager
gcloud secrets versions list connector-CONNECTOR_ID-TENANT_ID \
  --project YOUR_TENANT_PROJECT

# Check token expiry
gcloud secrets versions access latest --secret=connector-CONNECTOR_ID-TENANT_ID \
  --project YOUR_TENANT_PROJECT | jq '.expires_at'

# If refresh token revoked, user needs to re-authorize
```

---

## Sandbox Executor Issues

The `sandbox-executor` Cloud Run service owns per-sandbox provisioning, the `InstanceAliveTicker`, the KMS JWT envelope, and the sidecar callback proxy. Sandbox tool calls flow `agent-service → tool-gateway-service → sandbox-executor /v2/execute → per-sandbox Cloud Run`. When something breaks, the failure can be in any of those hops.

### Diagnose which hop failed

```bash
EXEC_URL=$(gcloud run services describe sandbox-executor \
  --project=tenant-<id>-<env> --region=us-west1 --format='value(status.url)')

# tool-gateway side — did it wire the client at boot?
gcloud logging read "resource.type=cloud_run_revision \
  AND resource.labels.service_name=\"tool-gateway-service\" \
  AND jsonPayload.msg:\"Sandbox executor client wired\"" \
  --project=tenant-<id>-<env> --limit=1

# sandbox-executor side — did the subsystem wire at boot?
gcloud logging read "resource.type=cloud_run_revision \
  AND resource.labels.service_name=\"sandbox-executor\" \
  AND jsonPayload.msg:\"Sandbox subsystem wired\"" \
  --project=tenant-<id>-<env> --limit=1

# /v2/execute errors over the last 10 min
gcloud logging read "resource.type=cloud_run_revision \
  AND resource.labels.service_name=\"sandbox-executor\" \
  AND jsonPayload.path=\"/v2/execute\" \
  AND severity>=ERROR" \
  --project=tenant-<id>-<env> --limit=10
```

If `Sandbox executor client wired` is missing on tool-gateway, the `SANDBOX_EXECUTOR_URL` env var didn't resolve at deploy time (see `resolve-peer-urls` step in `cloudbuild.yaml`). If `Sandbox subsystem wired` is missing on sandbox-executor, the bootstrap IIFE in `src/index.ts` threw before reaching `aliveTicker.start()` — check the executor's startup error log.

### `/v2/execute` returns 403

Cloud Run rejected the OIDC token at the frontend. Causes:
- Caller SA isn't in the allow-list. The executor accepts `tenant-<id>-runtime`, `sandbox-executor@…`, and `tenant-<id>-scheduler`. Inspect the `Authorization: Bearer <token>` against `https://www.googleapis.com/oauth2/v3/tokeninfo` to confirm the `email` claim.
- Cloud Run service-level invoker binding is missing. `tenant-<id>-runtime` SA needs `roles/run.invoker` on the `sandbox-executor` service (declared by `google_cloud_run_v2_service_iam_member.sandbox_executor_invokable_by_runtime` in the tenant-runtime-template module). Verify with `gcloud run services get-iam-policy sandbox-executor --region=us-west1 --project=tenant-<id>-<env>`.

### `/v2/execute` returns 401

Wrong OIDC audience or invalid issuer. `SandboxExecutorClient` mints the token with `audience = SANDBOX_EXECUTOR_URL`. If the cloudbuild placeholder `placeholder://awaiting-cloudbuild-patch` is still set, the first request after a brand-new deploy will 401 — the `patch-split-service-urls` step in cloudbuild rewrites the URL after both services come up. Subsequent revisions deploy with the real URL via `resolve-peer-urls`.

### Sandbox creation fails with `artifactregistry.repositories.downloadArtifacts denied`

Cloud Run can't pull `us-west1-docker.pkg.dev/YOUR_GCP_PROJECT<env>/sandbox-images/aio-sandbox:latest` cross-project. The pull is done by the consuming project's Cloud Run robot agent, not the per-sandbox SA. Check:

```bash
# Does the repo exist on the control project?
gcloud artifacts repositories describe sandbox-images \
  --location=us-west1 --project=YOUR_GCP_PROJECT<env>

# Does the tenant's Cloud Run robot agent have reader access?
TENANT_PROJ_NUM=$(gcloud projects describe tenant-<id>-<env> --format='value(projectNumber)')
gcloud artifacts repositories get-iam-policy sandbox-images \
  --location=us-west1 --project=YOUR_GCP_PROJECT<env> \
  | grep "service-${TENANT_PROJ_NUM}@serverless-robot-prod"
```

If missing, the per-tenant binding is declared by `google_artifact_registry_repository_iam_member.sandbox_images_pull` in the tenant-runtime-template module (uses the `google.platform_control` aliased provider).

### Sandbox stuck `Provisioning revision instances to receive traffic`, never reaches ready

The per-sandbox container's startup probe is timing out. `/health` is composite — the sidecar returns 503 (`degraded`) if any subsystem reports unhealthy.

```bash
SBX=$(gcloud run services list --project=tenant-<id>-<env> --region=us-west1 \
  --filter='metadata.name:sandbox-' --format='value(metadata.name)' | head -1)
gcloud logging read "resource.type=cloud_run_revision \
  AND resource.labels.service_name=\"$SBX\" \
  AND (textPayload:\"degraded\" OR textPayload:\"STARTUP HTTP probe\" OR textPayload:\"emerg\")" \
  --project=tenant-<id>-<env> --limit=20
```

Common subsystem failures:
- `nginx healthy:false` with latency > 0 — nginx's listen succeeded but the `/nginx-up` no-auth route isn't responding. Should never happen on a fresh image; if you see it, the sidecar build is stale (rebuild via `sandbox-sidecar-<env>` Cloud Build trigger).
- `chromium healthy:false` — `xvfb` race; container needs another tick.

The startup probe is sized to tolerate a ~5-minute cold-start (`failureThreshold: 60 × periodSeconds: 5 = 300 s`). If you bump the image size, re-check `cloud-run-sandbox-provider.ts` to ensure the probe window still fits.

### Alive ticker not billing — `cost_micro_credits_total` stays 0

The `InstanceAliveTicker` runs `setInterval` every 30 s. Two failure modes:

1. **CPU throttling.** The sandbox-executor service must deploy with `--no-cpu-throttling` or the timer pauses between requests. Verify on the live revision:
   ```bash
   gcloud run revisions describe sandbox-executor-<rev> \
     --project=tenant-<id>-<env> --region=us-west1 --format=yaml \
     | grep "cpu-throttling"
   # Expected: run.googleapis.com/cpu-throttling: 'false'
   ```

2. **CAS precision mismatch.** Postgres TIMESTAMPTZ stores microseconds, but node-pg's `Date` round-trip is millisecond-only. If the CAS uses raw `last_billed_at = $3`, every comparison misses by the dropped microseconds and `rowCount=0` every tick — silently. The current code wraps both sides in `date_trunc('milliseconds', …)`. If you change the SQL, keep that wrapper.

Quick check: walk `sandbox_state` and confirm `last_billed_at > created_at` for any sandbox that's been alive more than a minute:

```bash
psql -h <db_host> -U tenant_app -d tenant_runtime -c "
  SELECT sandbox_id, created_at, last_billed_at,
         EXTRACT(EPOCH FROM (last_billed_at - created_at))::int AS alive_secs,
         cost_micro_credits_total
  FROM sandbox_state
  WHERE status='ready'
  ORDER BY created_at DESC LIMIT 10;"
```

If `alive_secs = 0` for sandboxes older than 30 s, the ticker isn't firing.

### `usage_events` sum doesn't match `sandbox_usage_log` sum

The OU bucket drains via `usage_events` (spend-subscriber inline). `sandbox_usage_log` is the per-sandbox cost report. For accurate billing, every phase write must hit both sinks — provision, execute, instance_alive, teardown. If one phase only writes to `sandbox_usage_log`, the bucket under-bills silently and the tenant gets free compute.

```bash
# For a known invocation_id
psql -h <db_host> -U tenant_app -d tenant_runtime -c "
  SELECT 'sandbox_usage_log' AS sink,
         COALESCE(SUM(credits_consumed),0) AS total
    FROM sandbox_usage_log WHERE invocation_id = '<uuid>'
  UNION ALL
  SELECT 'usage_events',
         COALESCE(SUM(credits),0)
    FROM usage_events
   WHERE metadata->>'sandboxId' = '<sandbox_id>';"
```

If the two totals diverge, find which phase is short by comparing per-phase: `sandbox_usage_log.phase` vs `usage_events.event_type` (one of `sandbox_provision`, `sandbox_exec`, `sandbox_instance_alive`, `sandbox_teardown`).

### `usage_events` insert fails with `invalid input syntax for type uuid`

`usage_events.action_id` is typed UUID. Every `usageLedger.recordUsage()` caller must pass `uuid()` for `actionId` — never a stringy handle like `sandbox:<id>:exec:<key>`. The stringy tracing handle belongs in `metadata.actionRef`. If you see this error, grep for `actionId:` in `src/execution-environments/*.ts` and confirm every site uses `uuid()`.

### `audit_logs` insert fails with `INSERT with ON CONFLICT clause cannot be used with table that has INSERT or UPDATE rules`

`audit_logs` enforces append-only via BEFORE UPDATE/DELETE triggers (migration 283). If you see this error, the legacy `CREATE RULE ... DO INSTEAD NOTHING` is still present — re-apply migration 283. The trigger-based guard preserves immutability without blocking `ON CONFLICT DO NOTHING` (Postgres rejects ON CONFLICT against any table with INSERT/UPDATE rules, even when the action is `DO NOTHING`).

### `sandbox_usage_log` insert fails with `sandbox_usage_log_template_check`

The original migration 083 CHECK only allowed `('general-shell', 'code-development', 'data-analysis')`. The aio-sandbox provider writes `template='aio-sandbox'` for the provision row. Migration 282 widens the CHECK to include `'aio-sandbox'` and `'sandbox-sidecar'`. If you see this error post-2026-06, re-apply migration 282.

### Sidecar callbacks 404 with `runtime <url> unreachable at boot`

Per-sandbox sidecars bake `RUNTIME_BASE_URL` into Cloud Run env at create time. It must point at the `sandbox-executor` service URL (where `/internal/sandbox/*` is mounted), not at `agent-service` or `tool-gateway`. Provider source of truth: `cloud-run-sandbox-provider.ts:runtimeBaseUrl` reads `SANDBOX_EXECUTOR_URL` first, falling back to `TENANT_RUNTIME_INTERNAL_URL` (monolith). If you see the warning on a non-monolith deploy, check `SANDBOX_EXECUTOR_URL` is set on sandbox-executor itself.

---

## Agent ID Issues

### "This agent id doesn't exist" / a query returns zero rows for an agent that clearly exists

**Symptoms**: A uuid from a log line, a Cloud Scheduler job name, an `invocations` row or a
dashboard URL returns nothing from `agents` (or from `internal_agents` on the platform-backend
side). Endpoints return empty lists — "No learned context yet" — with no error. You cannot
correlate invocations back to an agent name.

**Cause**: There are **two disjoint agent id spaces** and you are using one against the other.
`agents.id` here is a `uuidv4` minted at provisioning; platform-backend addresses the same
agent by `internal_agents.id`. They never overlap, so the wrong one matches zero rows **with
no error** — an empty result, not an exception. See INV-TR-010 and ADR-039.

**Solution**: resolve the id — it takes one call and accepts either space.

```bash
curl -s "$RUNTIME_URL/internal/agents/resolve?tenantId=$TENANT&id=$UUID" | jq
# -> { matchedOn, internalAgentId, runtimeAgentId, name, lifecycle, schedulerJobName }
```

Full procedure, direct SQL for both directions, the per-table id-space census, and the
health-check queries: **runbooks/resolve-agent-id.md**.

**Do not** conclude the record is missing or that the counts should match — platform-backend's
agent count includes soft-deleted and never-provisioned rows, so the two totals differ normally.

### Translation is failing silently in code

**Symptoms**: an endpoint returns empty for every agent, or writes appear to vanish.

**Solution**: every failed translation now logs. Neither event should appear in steady state:

```
jsonPayload.event = "agent_id_mapping_miss"           # PB id -> runtime id failed
jsonPayload.event = "agent_id_reverse_mapping_miss"   # runtime id -> PB id failed
```

`caller` names the code path. `fellBack: true` means a read path returned the untranslated id
(expect a silently-empty result); `false` means a write path refused with
`409 agent_not_provisioned`, which is correct behaviour during the provisioning race.

## Memory Issues

### Memory Search Returns No Results

**Symptoms**: Agent can't find relevant memories

**Possible Causes**:
1. Embeddings not generated
2. Wrong memory scope
3. Search threshold too high

**Solutions**:
```sql
-- Check if memories exist
SELECT id, content_preview, scope, embedding IS NOT NULL as has_embedding
FROM memories
WHERE tenant_id = 'YOUR_TENANT'
ORDER BY created_at DESC
LIMIT 20;

-- If embeddings are null, check embedding service
```

### Memory Decryption Fails

**Symptoms**: Memory content returns garbled or error

**Solutions**:
```bash
# Check KMS key access
gcloud kms keys list --keyring=tenant-encryption \
  --location=us-west1 \
  --project YOUR_TENANT_PROJECT

# Verify service account has decrypter role
gcloud kms keys get-iam-policy memory-content \
  --keyring=tenant-encryption \
  --location=us-west1 \
  --project YOUR_TENANT_PROJECT
```

---

## Event Subscription Issues

### Not Receiving Control Plane Events

**Symptoms**: Configuration changes not reflected in runtime

**Solutions**:
```bash
# Check subscription exists and is healthy
gcloud pubsub subscriptions describe control-plane-events-tenant-runtime-<env> \
  --project YOUR_TENANT_PROJECT

# Check for unacked messages
gcloud pubsub subscriptions pull control-plane-events-tenant-runtime-<env> \
  --project YOUR_TENANT_PROJECT \
  --limit 5

# Check dead letter queue
gcloud pubsub subscriptions pull control-plane-events-dlq \
  --project YOUR_TENANT_PROJECT \
  --auto-ack \
  --limit 5
```

### Stale Configuration

**Symptoms**: Old agent config being used after update

**Solutions**:
```sql
-- Check entity versions
SELECT entity_type, entity_id, entity_version, updated_at
FROM entity_versions
WHERE tenant_id = 'YOUR_TENANT'
ORDER BY updated_at DESC;

-- Force refresh from Control Plane (if endpoint exists)
curl -X POST -H "X-Tenant-ID: YOUR_TENANT" \
  http://localhost:4000/api/internal/refresh-config
```

### Agent Activation Fails Partway Through

**Symptoms**: Agent stuck in transitional state, activation event redelivered repeatedly

**Root Cause**: Activation is a 5-step process (validate, compile instructions, configure scheduler, update status, notify). If any step fails, Pub/Sub redelivers the event. Before EventProcessor, this caused duplicate instruction compilations and scheduler misconfiguration.

**Solutions**:
```sql
-- Check event processing ledger for the activation event
SELECT message_id, event_type, current_step, status, error_message, created_at
FROM event_processing_ledger
WHERE event_type = 'tenant.deployment.approved'
ORDER BY created_at DESC
LIMIT 10;

-- If stuck, check which step failed
-- Common failures:
--   Step 2 (compile): LLM API key missing or rate limited
--   Step 3 (scheduler): Cloud Scheduler IAM issue
--   Step 4 (status update): Database constraint violation
```

```bash
# Check DLQ for permanently failed events
curl -H "Authorization: Bearer SERVICE_TOKEN" \
  http://localhost:4000/api/dlq

# Replay after fixing root cause
curl -X POST -H "Authorization: Bearer SERVICE_TOKEN" \
  http://localhost:4000/api/dlq/DLQ_ENTRY_ID/replay
```

### framer-secret Not Loaded at Startup

**Symptoms**: Chat turns fail immediately with an error like `framer-secret not loaded` or `UntrustedContentFramer: SERVER_FRAMER_SECRET is null`. Autonomous agent execution is unaffected.

**Root cause**: `UntrustedContentFramer` requires the server-side framer secret to be loaded before any chat turn runs. The secret is fetched at startup from Secret Manager using the path in `FRAMER_SECRET_NAME` (defaults to `projects/${GCP_PROJECT}/secrets/framer-secret/versions/latest`).

**Diagnosis**:
```bash
# Confirm FRAMER_SECRET_NAME is set on the Cloud Run service
gcloud run services describe tenant-runtime \
  --project YOUR_TENANT_PROJECT --region us-west1 \
  --format="yaml(spec.template.spec.containers[0].env)" | grep FRAMER_SECRET_NAME

# Confirm the secret exists and has at least one version
gcloud secrets versions list framer-secret --project YOUR_TENANT_PROJECT

# Check startup logs for "framer secret loaded" or error messages
gcloud logging read 'resource.type=cloud_run_revision AND jsonPayload.event="framer_secret_loaded"' \
  --project YOUR_TENANT_PROJECT --limit 5
```

**Resolution**:
1. If `FRAMER_SECRET_NAME` is missing from the service env, add it to the Cloud Build substitution variables and redeploy.
2. If the secret doesn't exist, create it: `gcloud secrets create framer-secret --project YOUR_TENANT_PROJECT` then add a version with at least 32 random bytes. The `tools/framer-rotate/` Cloud Run Job handles subsequent rotation automatically (Cloud Scheduler triggers every 90 days).
3. Ensure the runtime service account has `roles/secretmanager.secretAccessor` on `framer-secret`.

### Credential Refresh Failures After Secrets Wiring Change

**Symptoms**: Connectors that previously worked now fail with "secret not found" or "permission denied"

**Root Cause**: Tenant runtime services need `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `OPENAI_API_KEY` secrets wired via Cloud Build `--set-secrets`. If a new deployment omits these, token refresh and LLM calls fail.

**Solutions**:
```bash
# Verify secrets are mounted on Cloud Run service
gcloud run services describe tenant-runtime \
  --project YOUR_TENANT_PROJECT \
  --region us-west1 \
  --format="yaml(spec.template.spec.containers[0].env)"

# Check if secrets exist in tenant project
gcloud secrets list --project YOUR_TENANT_PROJECT \
  --filter="name:google-client OR name:openai-api-key"

# If secrets are missing, they should be populated during provisioning
# via populateTenantSecrets() in the Platform Backend.
# Re-run tenant provisioning or manually create the secrets:
gcloud secrets create google-oauth-client-id --project YOUR_TENANT_PROJECT
echo -n "CLIENT_ID_VALUE" | gcloud secrets versions add google-oauth-client-id \
  --project YOUR_TENANT_PROJECT --data-file=-
```

---

## Workflow Coordinator Issues

### Workflow Stuck in PENDING

**Symptoms**: Workflow doesn't progress past pending state

**Solutions**:
```sql
-- Check workflow status
SELECT id, status, created_at, error_message
FROM workflows
WHERE tenant_id = 'YOUR_TENANT'
ORDER BY created_at DESC
LIMIT 10;

-- Check for blocked tasks
SELECT id, workflow_id, status, dependencies, lease_expires_at
FROM workflow_tasks
WHERE workflow_id = 'WORKFLOW_ID';
```

### Task Lease Expired

**Symptoms**: Task fails with "lease expired"

**Solutions**:
```sql
-- Check task lease
SELECT id, status, lease_holder, lease_expires_at, retry_count
FROM workflow_tasks
WHERE id = 'TASK_ID';

-- Task may have taken too long
-- Increase timeout or break into smaller tasks
```

---

## Database Issues

### Connection Pool Exhausted

**Symptoms**: "too many connections" errors, requests hanging

**Root Cause**: Typically caused by long-running event handlers or LLM calls holding connections. The EventProcessor's step-based approach helps by releasing connections between steps.

**Solutions**:
```bash
# Check connection count
gcloud sql connect YOUR_TENANT_PROJECT \
  --project YOUR_TENANT_PROJECT \
  -c "SELECT count(*) FROM pg_stat_activity;"

# Check which queries are holding connections
gcloud sql connect YOUR_TENANT_PROJECT \
  --project YOUR_TENANT_PROJECT \
  -c "SELECT pid, state, query, query_start FROM pg_stat_activity WHERE state != 'idle' ORDER BY query_start;"

# Kill idle connections
gcloud sql connect YOUR_TENANT_PROJECT \
  --project YOUR_TENANT_PROJECT \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle' AND query_start < now() - interval '5 minutes';"
```

**Prevention**: Pool isolation ensures event processing, agent execution, and API requests use separate connection pools so one workload cannot starve another.

### Query Performance

**Symptoms**: Slow responses, high latency

**Solutions**:
```sql
-- Find slow queries
SELECT query, calls, mean_time, total_time
FROM pg_stat_statements
ORDER BY mean_time DESC
LIMIT 10;

-- Check for missing indexes
SELECT schemaname, tablename, indexname, idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0;
```

---

## Kill Switch Issues

### Tenant Suspended

**Symptoms**: All requests return 403 with "tenant suspended"

**Solutions**:
```bash
# Check tenant status in Control Plane
curl -H "Authorization: Bearer ADMIN_TOKEN" \
  https://api.example.com/api/tenants/TENANT_ID

# If billing issue, resolve in Stripe
# If abuse, contact security team

# To reactivate (admin only)
curl -X POST -H "Authorization: Bearer ADMIN_TOKEN" \
  https://api.example.com/api/tenants/TENANT_ID/reactivate
```

---

## Debugging Tips

### Enable Debug Logging

```bash
# Set LOG_LEVEL=debug in environment
gcloud run services update tenant-runtime \
  --region us-west1 \
  --project YOUR_TENANT_PROJECT \
  --set-env-vars LOG_LEVEL=debug

# Remember to set back to info after debugging
```

### Trace a Request

```bash
# Look for trace ID in logs
gcloud logging read "trace:YOUR_TRACE_ID" \
  --project YOUR_TENANT_PROJECT

# Or use Cloud Trace
# Console → Trace → Enter trace ID
```

### Test Locally

```bash
# Run locally with tunnel to prod DB (be careful!)
export DATABASE_URL="postgresql://..."
export CONTROL_PLANE_API_URL="https://api.example.com"
npm run dev
```

---

## Getting Help

## Indexed-context / `search` Issues

### `search` returns no `indexed_context` results, or coverage is 0

The index holds only content previously fetched THROUGH THE TOOL GATEWAY. An
empty result is often correct. Work down this list before assuming a defect.

```bash
# 1. Is the writer even on? It must be true on BOTH services.
for S in agent-service tool-gateway-service; do
  echo -n "$S: "
  gcloud run services describe $S --project=tenant-<id>-<env> --region=us-west1 --format=json \
    | python3 -c "import json,sys;e=json.load(sys.stdin)['spec']['template']['spec']['containers'][0].get('env',[]);print({x['name']:x.get('value') for x in e}.get('CONNECTOR_CONTENT_INDEXING_ENABLED','(absent)'))"
done

# 2. What is the indexer actually saying? A drop is never silent.
gcloud logging read 'resource.type=cloud_run_revision AND
  (jsonPayload.metric="connector_content.indexed" OR jsonPayload.metric="connector_content.not_indexed")' \
  --project=tenant-<id>-<env> --limit=20 --freshness=1h
```

`connector_content.not_indexed` carries `reason`, `extractedChars` and a `shape`
hint (top-level key names). Read it before anything else — it usually answers the
question outright.

| What you see | What it means |
|---|---|
| No metrics at all | No read action reached the indexer. Either the flag is off on the service that handled the dispatch, or the tool was a WRITE, or the connector is vendor-MCP (below). |
| `reason: no_text_extracted`, `shape: {items,nextPageToken}` | The payload genuinely has no prose — e.g. a mail `list_messages` returns only ids. Fetch the thing itself (`read_thread`), not the list. |
| `reason: no_text_extracted`, `shape: {id,threadId,payload}` | The text is ENCODED. Mail bodies arrive base64 at `payload.body.data`; extraction refuses base64 by design. |
| `reason: below_min_length` | Real text, under the 150-char floor. |
| `connector_content.indexed` present, search still empty | Check the FILTER — see the next entry. |

### A connector-scoped search finds nothing while an unfiltered one works

`connector_content.connector_type` holds a resolved connector TYPE
(`google_mail`), not an alias (`google-mail-0105297e`) or a connector UUID.
`search` filters on the type it resolves from the aliases a model names.

Rows written before that resolution existed carry the raw identifier and will
never match a type filter. They age out on the 30-day TTL; there is no backfill.
Confirm what a row actually holds:

```sql
SET app.tenant_id = '<tenant-uuid>';
SELECT connector_type, entity_type, count(*) FROM connector_content GROUP BY 1,2;
```

### GitHub / Notion / Stripe content is never indexed

Working as designed, and it will not change without a separate decision. Those
are **vendor-hosted MCP servers**: the Claude SDK connects to them directly with
a Bearer token, so they never pass through `ToolGatewayService.execute()`, which
is where the indexer hangs. Only REST connectors dispatched through the gateway
are indexable. See ADR-009.

### `42704 unrecognized configuration parameter "app.tenant_id"`

Working as designed. `connector_content` is FORCE RLS with the **fail-loud**
policy form, so a query off a tenant scope RAISES instead of returning zero rows.
The silent variant would report "nothing indexed" for a workspace with plenty
indexed, which is the exact falsehood this surface exists to avoid.

Fix the caller: wrap the query in `withTenantScope(tenantId, …)`. For a one-off
psql session, `SELECT set_config('app.tenant_id','<uuid>',false);` first.

Note that a fleet-wide sweep of this table is impossible by construction — the
embedding backfill sweeps it one tenant at a time, and refuses a fleet-wide pass
with a clear error rather than dying on a 42704 mid-batch.

---

If you can't resolve the issue:

1. **Collect logs**: Last 100 lines around the error
2. **Collect context**: Tenant ID, agent ID, workflow ID if applicable
3. **Check Control Plane**: Is the issue in Control Plane or Tenant Runtime?
4. **Post in #platform-support**: Include all context
