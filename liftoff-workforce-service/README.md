# liftoff-workforce-service

Everything runs in your own cloud project, on your own credentials, and every
hostname is something you configure. The code throws rather than falling back
to a default, because a default here would point at infrastructure that is not
yours.

Licensed under [Apache-2.0](LICENSE). The licence grants no trademark rights:
the Liftoff name and logo are not licensed for use as the name of what you ship.

Workforce planning service — extracted from `liftoff-platform-backend` as part of the platform-backend decomposition. Owns all CAIO (Chief AI Officer) workforce planning, HRBP provisioning, team-plan chat, and capability token management.

Platform-backend forwards `/api/workforce-plans/*` and `/api/team-plan/*` here unconditionally.

## What it owns

- **Workforce plans** — plan lifecycle state machine (draft → pending_approval → provisioning → completed / failed)
- **CAIO tools** — 9 LLM tools: draft plan, commit plan, approve plan, org structure, list connectors, memory save/retrieve, agent-templates list/get
- **Team plan chat** — SSE-streaming chat threads with the CAIO agent; includes context-budget allocator and conversation summarization
- **HRBP provisioning** — batch agent provisioning from a committed plan (distill + create with `si-template` injection)
- **CAIO memory** — persistent cross-session memory for the CAIO agent (`caio_memory` table)
- **Capability tokens** — tracks which capabilities have been granted for pending integrations
- **Outbox** — transactional outbox for publishing billing meter events

## Architecture

```
platform-backend
 /api/workforce-plans/* ────────────────────────────▶ liftoff-workforce-service
 /api/team-plan/*       ────────────────────────────▶
                                                       │
                    ┌──────────────────────────────────┘
                    │
      ┌─────────────▼──────────────────────────────────────────┐
      │               liftoff-workforce-service                │
      │                                                        │
      │  ┌──────────────┐  ┌─────────────────┐               │
      │  │ REST routes  │  │ events/         │               │
      │  │ (Fastify)    │  │ (kill-switch    │               │
      │  │              │  │  subscriber)    │               │
      │  └──────┬───────┘  └─────────────────┘               │
      │         │                                              │
      │         ▼                                              │
      │  ┌───────────────────────────────────────────┐       │
      │  │       workforce-pg (Cloud SQL)            │       │
      │  │  workforce_plans, team_plan_threads,      │       │
      │  │  team_plan_messages, caio_memory,         │       │
      │  │  capability_tokens, outbox_events, ...    │       │
      │  └───────────────────────────────────────────┘       │
      │                      │                               │
      │                      ▼                               │
      │           outbox_events → Pub/Sub                    │
      │           billing meter events → liftoff-billing     │
      └────────────────────────────────────────────────────────┘
                 ▲
                 │ kill-switch events
      governance-events-{env} (Pub/Sub)
```

## Source layout

```
src/
├── workforce-plans/    # Plan data model, CAIO tools, plan chat handler, HRBP task handler
├── platform-agent/     # Shared runPlatformAgent loop used by both CAIO (chat) and HRBP
│                       # (Cloud Tasks fan-out). Owns system-agent UUIDs, audit-log
│                       # writes, and the seed-prompt renderer.
├── platform-agent/hrbp/ # HRBP per-spec tool registry + dispatcher
├── branding/           # Liftoff brand registry — local copy of the
│                       # @liftoffos/shared-types canonical registry
├── events/             # Pub/Sub subscriber for governance kill-switch events
├── llm/                # LLM client (multi-provider, same pattern as platform-backend)
└── infrastructure/     # DB, secrets, config, Cloud Tasks helper, outbox worker
```

### HRBP provisioning architecture

Plan approval does not run HRBP in-process. It
fans out one Cloud Task per spec to the `workforce-hrbp-fanout-{env}` queue;
each task delivers OIDC-signed to `POST /api/tasks/hrbp-provision-spec` on
this same Cloud Run service. The handler verifies the OIDC token and runs
`runPlatformAgent` with the HRBP tool set. Cloud Tasks owns retries via the
queue's `retry_config`. The approve handler opens one row in
`hrbp_provisioning_runs` before fan-out so each task has an FK target for
`hrbp_provisioning_events` / `hrbp_compensation_log`. `stuck-plan-resumer.ts`
re-enqueues specs from any run that has been in `running` state for more
than 10 minutes.

#### Terminal-status invariant — the platform is authoritative

Every HRBP run for a spec must end with one of `completed` / `failed` /
`skipped` / `blocked` recorded on `workforce_plans.agents[].provisioningStatus`,
or CAIO cannot tell whether the work shipped. The system prompt instructs
the LLM to call `provisioning__update_spec_status` at the end of a
successful run, but `hrbp-task-handler.ts` does not depend on that —
after the agent loop ends it always writes the terminal status itself
based on the loop outcome:

| Loop outcome                                          | Written status |
|-------------------------------------------------------|----------------|
| `terminator='normal'` AND `createdInternalAgentId` set| `completed`    |
| `terminator='tool_blocker'`                           | skip (the `provisioning__transition_to_blocker` tool already wrote `blocked`) |
| Anything else (`error` / `max_iterations` / `token_budget` / `normal` without an agent) | `failed` (with `errorMessage` when available) |

`handleProvisioningUpdateSpecStatus` is idempotent (`jsonb_set` with the
same payload is a no-op overwrite), so when the LLM does call the tool
the handler's later write just re-confirms its decision.

Both `provisioning__update_spec_status` and
`provisioning__transition_to_blocker` mutate the RLS-protected
`workforce_plans` table — they run under `withTenantContext()` so the
policy's `current_setting('app.current_tenant_id', true)::uuid` cast
sees a real UUID rather than the empty string default. Any new tool
that touches an RLS-protected table must go through `withTenantContext`
for the same reason.

#### Platform-agent system prompt loading

`loadPlatformAgentConfig` (`src/platform-agent/config.ts`) fetches the
CAIO and HRBP `system_prompt`/`modelConfig` from platform-backend's
`GET /api/internal-agents/system/:id` (service-auth, system-only). The
result is cached in-process with a **60-second TTL** so that when a
platform-backend migration updates a seeded prompt (e.g. migration 199
for HRBP), a workforce-service revision that started up before the
migration applied picks the change up within a minute — without the
TTL it would cache the pre-migration prompt for its entire lifetime.

#### LLM relay retries

`callPBEndpoint` (`src/llm/client.ts`) retries on `429`/`502`/`503`/
`504`/`529` and on upstream `overloaded_error` bodies, with exponential
backoff and jitter (up to 4 attempts, capped at 8s per wait), so a single
upstream 529 does not terminate an HRBP run mid-loop and leave the spec
un-provisioned.

## Kill-switch integration

The service subscribes to `governance-events-{env}` Pub/Sub and evicts its cached preflight token on kill-switch change events. This ensures the CAIO agent respects governance decisions within 5 seconds of a kill-switch flip, consistent with the tenant-runtime's propagation SLO.

## Migrations

| Migration | Purpose |
|---|---|
| `001_workforce_plans.sql` | `workforce_plans` table with lifecycle state machine |
| `002_team_plan_threads.sql` | `team_plan_threads`, `team_plan_messages` |
| `003_workforce_plans_reprovisioning.sql` | Reprovisioning state and retry tracking |
| `004_workforce_plans_instructions_md.sql` | `instructions_md` column for CLAUDE.md injection |
| `005_caio_memory.sql` | Initial CAIO memory schema |
| `006_capability_tokens.sql` | Capability token grant tracking |
| `007_hrbp_provisioning.sql` | HRBP batch provisioning state |
| `008_plan_pending_integrations.sql` | Pending connector integration tracking |
| `009_caio_memory_table.sql` | Persistent CAIO memory (full table, replaces 005 schema) |
| `010_workforce_audit_log.sql` | Tamper-evident audit log for plan state transitions |
| `011_outbox_events.sql` | Transactional outbox for Pub/Sub publishing |
| `012_rls_policies.sql` | Row-level security (per-tenant isolation) |
| `013_grant_outbox_permissions.sql` | Grant outbox table permissions to `workforce_app` |

## Scripts

| Script | Purpose |
|---|---|
| `npm run build` | `tsc` → `dist/` |
| `npm start` | Run the server (`dist/index.js`) |
| `npm run dev` | Watch-mode local dev |
| `npm run migrate` | Run pending `node-pg-migrate` migrations |
| `npm test` | Jest unit tests |
| `npm run test:integration` | Jest integration tests (live DB) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

## Deployment

Cloud Build triggers auto-deploy on push to `main` (dev) and `release` (prod) — the branch comes from `deploy_branch_pattern` in `liftoff-infrastructure-gcp/terraform/projects/platform-ci`, which is `^main$` for dev and `^release$` for prod. The pipeline builds runtime + migrate images with SHA-only tags, signs with binauthz attestor (SLSA-3), runs migrations, then deploys.

Cloud Run service accepts traffic only from platform-backend's service account (IAM-restricted). Returns 404 to unauthorized callers.

Terraform module: `liftoff-infrastructure-gcp/terraform/modules/workforce-service/`.

## Local development

```bash
export ARTIFACT_REGISTRY_TOKEN=$(gcloud auth print-access-token)
npm install
# The runtime connects to Postgres over the Cloud SQL connector via
# DB_INSTANCE_CONNECTION_NAME (not a DATABASE_URL string), and resolves the
# Anthropic key from Secret Manager via ANTHROPIC_API_KEY_SECRET. See
# src/infrastructure/config.ts for the full schema.
export GCP_PROJECT_ID=YOUR_CONTROL_PROJECT_STAGING
export DB_INSTANCE_CONNECTION_NAME=YOUR_CONTROL_PROJECT_STAGING:us-west1:workforce-pg-dev
export ANTHROPIC_API_KEY_SECRET=workforce-anthropic-key   # Secret Manager secret name
export GOVERNANCE_EVENTS_SUBSCRIPTION=...  # or omit to skip kill-switch subscriber

# Cross-service auth + HRBP fan-out (required for end-to-end HRBP runs)
export PLATFORM_BACKEND_URL=http://localhost:3000
export WORKFORCE_SERVICE_TOKEN=...                            # X-Service-Auth shared with PB; same value as PB's WORKFORCE_SERVICE_TOKEN
export WORKFORCE_SERVICE_URL=http://localhost:8080            # OIDC audience for tasks
export WORKFORCE_SERVICE_ACCOUNT_EMAIL=workforce-dev@...gserviceaccount.com

# Pub/Sub outbox publishing — must match the topic provisioned by terraform
# (pubsub-events module appends -${env}). Cloud Run sets this via
# cloudbuild.yaml; locally you'll usually leave it pointed at the dev topic.
export WORKFORCE_EVENTS_TOPIC=workforce-events-dev

npm run migrate
npm run dev
```

## Related

- Platform-backend (caller): `src/workforce-plans/workforce-proxy.ts`
- Governance kill-switch events: [liftoff-governance-engine](../liftoff-governance-engine)
- Billing meter events: [liftoff-billing](../liftoff-billing)
- Terraform: [Liftoff-Infrastructure-GCP](../liftoff-infrastructure-gcp) — `terraform/modules/workforce-service/`
