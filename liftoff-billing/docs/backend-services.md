# Backend services

> Reference map of the LiftoffOS microservices this repo sits among. The system-wide
> architecture source of truth is `liftoff-platform-backend/docs/ARCHITECTURE.md`.

| Repository | Role |
|---|---|
| `liftoff-platform-backend` | Control plane — auth, accounts, tenants, agent config |
| `liftoff-tenant-runtime` | Execution plane — agent execution, coordinator, tool-gateway, memory, reflection |
| `liftoff-connector-service` | Connector plane — OAuth + credentials + connector clients + MCP sidecars |
| `liftoff-governance-engine` | HITL approvals, admission/kill switches, action + usage + audit ledgers |
| **`liftoff-billing`** | **This repo — Stripe webhooks, invoices, payment methods, credit balance, meter events, daily reconciliation** |
| `liftoff-developer-proxy` | Developer proxy for Claude Code — API keys, transparent Anthropic proxy, usage metering |
| `liftoff-workforce-service` | Workforce plans/CAIO, HRBP provisioning, team-plan chat, capability tokens |
| `liftoff-harvest-service` | Background memory pipeline — classifies connector events, writes typed memories (operator opt-in) |
| `liftoff-proto` | Shared proto contracts (Connect-RPC) |
| `liftoff-infrastructure-gcp` | Terraform for all GCP resources; Cloud Build triggers |
| `liftoff-react` | Frontend |
