# Backend services

> The hard rules are docs/invariants.md. This file holds the detail.

## Project Overview
Platform Backend - Control plane API service for LiftoffOS.

## Backend Architecture

The backend is split into services, each a top-level folder of this repository with its own README.md:

### Core services

| Repository | Description |
|------------|-------------|
| `liftoff-platform-backend` | Control plane API (this repo) — accounts, tenants, plans/subscriptions/meters, entitlements, agent config, insights; proxies `/api/billing/*`, `/api/workforce-plans/*`, `/proxy/*`, `/api/claude-code/*`, `/api/connectors/*`, `/api/governance/*` to dedicated services |
| `liftoff-tenant-runtime` | Agent execution plane — deploys per-tenant as `agent-service`, `coordinator-service`, `tool-gateway-service`, `reflection-service`, plus a monolith |
| `liftoff-connector-service` | OAuth/DCR flows, credential vault, vendor SDKs, MCP sidecars, 50+ connector types |
| `liftoff-governance-engine` | HITL approvals, admission/kill switches, action + usage + audit ledgers |
| `liftoff-billing` | Stripe webhooks, invoices, payment methods, credit balance, meter events, daily reconciliation |
| `liftoff-developer-proxy` | BYOK developer proxy for Claude Code (Anthropic) + Codex (OpenAI) — vendor-neutral API key management, transparent proxy, per-credential rate limiting, usage metering |
| `liftoff-workforce-service` | Workforce plans/CAIO, HRBP provisioning, team-plan chat, capability tokens |
| `liftoff-harvest-service` | Background memory pipeline — classifies connector events via LLM and writes typed memories into tenant-runtime; operator opt-in per tenant, invisible to end users |
| `liftoff-tunnel-service` | Multi-tenant terminator for the private MCP reverse-tunnel. Customers run a single `docker run` of `liftoffos/tunnel-client` in their network; the terminator (Cloud Run + GCLB with a wildcard cert for `*.tunnels.example.com`) forwards HTTPS requests through the chisel-multiplexed session to the upstream URL configured in `mcp_tunnel_routes`. Powers the "Use a tunnel" affordance in the Custom MCP Server and External Collaborator flows. |

### Shared infrastructure

| Repository | Description |
|------------|-------------|
| `liftoff-proto` | Connect-RPC contracts shared across backend services; published as `@liftoffos/proto-gen` |
| `liftoff-infrastructure-gcp` | Terraform for all GCP resources; Cloud Build triggers for CI/CD |
| `liftoff-react` | Frontend |
