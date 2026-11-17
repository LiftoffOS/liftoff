# Operations — liftoff-harvest-service

Deploy, GCP resources, the place of this service among the backend,.
The invisibility
rule and the other hard rules live in invariants.md.

## What this service is

Liftoff's **background memory pipeline**. It consumes connector events, classifies them via
an LLM, and writes typed memories into the tenant runtime. It is **operator opt-in per
tenant** and **completely invisible to end users** — never disclosed on connect/disconnect,
no tenant-facing controls or labels (INV-HARV-001).

## Backend architecture

### Core services

| Repository | Role |
|---|---|
| `liftoff-platform-backend` | Control plane — auth, accounts, tenants, agent config; internal LLM gateway + tenant feature flags this service depends on |
| `liftoff-tenant-runtime` | Execution plane — agent execution, coordinator, tool-gateway, memory, reflection (the memory-write target) |
| `liftoff-connector-service` | Connector plane — OAuth + credentials + connector clients + MCP sidecars (source of `connector-events`) |
| `liftoff-governance-engine` | HITL approvals, admission/kill switches, action + usage + audit ledgers |
| `liftoff-billing` | Stripe webhooks, invoices, payment methods, credit balance, meter events, daily reconciliation |
| `liftoff-developer-proxy` | Developer proxy for Claude Code — API key management, transparent Anthropic proxy, usage metering |
| `liftoff-workforce-service` | Workforce plans/CAIO, HRBP provisioning, team-plan chat, capability tokens |
| **`liftoff-harvest-service`** | **This repo — background memory pipeline; classifies connector events via LLM and writes typed memories into tenant-runtime; operator opt-in per tenant, invisible to end users** |

### Shared infrastructure

| Repository | Role |
|---|---|
| `liftoff-proto` | Shared proto contracts (Connect-RPC); also ships the PII redaction module used here |
| `liftoff-infrastructure-gcp` | Terraform for all GCP resources; Cloud Build triggers for CI/CD |
| `liftoff-react` | Frontend |

The canonical system-wide architecture doc lives in
`../liftoff-platform-backend/docs/ARCHITECTURE.md`.

## CRITICAL: Deployment (INV-HARV-007)

**NEVER run `gcloud builds submit` manually.**

Both the dev trigger (`YOUR_CI_PROJECT_STAGING`) and the prod trigger
(`YOUR_CI_PROJECT`) auto-deploy on push to `main`. To deploy: commit, push to
`main`, done — the trigger handles build, test, migration, and deploy.

## GCP resources

| Resource | Location |
|---|---|
| Cloud Run service | `harvest-service` in `YOUR_GCP_PROJECT<env>` |
| Cloud Run migrate job | `harvest-service-migrate` in `YOUR_GCP_PROJECT<env>` |
| Cloud SQL instance | `control-plane-pg-<env>` in `YOUR_GCP_PROJECT<env>` (harvest DB: `harvest`, user `harvest_app`) |
| Docker images | `us-west1-docker.pkg.dev/YOUR_GCP_PROJECT<env>/YOUR_GCP_PROJECT<env>/harvest-service` |
| Pub/Sub subscriptions | `connector-events-<env>-harvest-sub`, `control-plane-events-<env>-harvest-sub` |

## Commit discipline

Same rules as every other Liftoff repo:

- Run `npm run lint && npm run typecheck && npm test` locally before committing.
- Pushes to `main` must result in a healthy Cloud Run revision (`/ready` green); monitor
  Cloud Build to completion.
- Never force-push `main`.

## Runbooks

- runbooks/HARVEST_TENANT_REAPPLY.md — re-apply /
  backfill harvest for a tenant.
- runbooks/REPLAY.md — replay events after a schema / prompt change.
