# LiftoffOS Platform Architecture

**A comprehensive guide to the LiftoffOS AI Agent Platform architecture.**

This document provides a unified view of how the LiftoffOS repositories work together to deliver a production-grade AI agent platform with human-in-the-loop oversight.

---

## System Overview

LiftoffOS is a multi-tenant SaaS platform that enables organizations to deploy and manage autonomous AI agents. The architecture is split across nine backend services:

- **Control Plane** (`liftoff-platform-backend`) — accounts, tenants, subscriptions/plans/meters, entitlements, agent configuration. Every user-facing REST call lands here first; it unconditionally proxies six domains to dedicated services.
- **Execution Plane** (`Liftoff-Tenant-Runtime`) — agent runtime, tool execution, memory. Deploys as four specialized Cloud Run services per tenant: `agent-service`, `coordinator-service`, `tool-gateway-service`, `reflection-service`. The monolith has been decommissioned. Receives control-plane Pub/Sub events via **push** delivery on coordinator-service (`POST /internal/pubsub/:topic`, OIDC-authenticated by a dedicated cross-project push SA) so coordinator can stay at `--min-instances=0` without backlogs.
- **Connector Service** (`liftoff-connector-service`) — OAuth / DCR flows, credential vault, vendor SDK execution, MCP sidecar orchestration. Shared across all tenants. Every `Execute`/`ExecuteBatch` result is echo-scrubbed at `runConnectorExecution` (value + format layers) before it returns, so a vendor that reflects a credential can't leak it into the agent context, trajectory, or audit trail; a value hit (our own credential echoed) is an error-level anomaly, opt-in fail-closed via `CONNECTOR_CREDENTIAL_ECHO_FAIL_CLOSED` [credential leak].
- **Governance Engine** (`liftoff-governance-engine`) — HITL **approval row persistence** (`hitl_approval_requests`, `hitl_approval_policies` tables); admission decisions (Preflight + Authorize RPCs — kill switches, credit drain checks); action + usage + audit ledgers. **NOT the runtime gate evaluator** — see the policy-enforcement split below. Also hosts a dry-run gate simulator at `POST /api/governance/tenant/:id/simulate` that mirrors the runtime evaluator for the operator dashboard's "what would happen if I enable this?" preview.
- **Billing** (`liftoff-billing`) — Stripe webhooks, invoices, payment methods, OU meter events (Stripe-native `billing.meterEvents` — event `operating_unit_consumed`), subscription lifecycle, outbox-based reconciliation. Platform-backend proxies `/api/billing/*` here.
- **Developer Proxy** (`liftoff-developer-proxy`) — BYOK proxy for developer coding tools, **Claude Code (Anthropic)** and **OpenAI Codex**: vendor-neutral API key management, per-credential rate limiting, usage metering. A credential is bound to one vendor; the client presents its `liftoff_sk_*` key via `x-api-key` (Claude Code) or `Authorization: Bearer` (Codex). Platform-backend delegates to this service when `DEVELOPER_PROXY_SERVICE_ENABLED=new`; until that flag is set, `src/claude-code-proxy/` handles the proxy logic locally.
- **Workforce Service** (`liftoff-workforce-service`) — Workforce plans, CAIO chat, HRBP provisioning, capability tokens. CAIO and HRBP both run through a shared `runPlatformAgent` tool-use loop; HRBP fan-out is one Cloud Task per spec (queue `workforce-hrbp-fanout-{env}`), delivered OIDC-signed to `/api/tasks/hrbp-provision-spec`. Platform-backend proxies `/api/workforce-plans/*` and `/api/team-plan/*` here, and serves `GET /api/internal-agents/system/:id` (service-auth) so workforce-service can load the CAIO and HRBP seed prompts from the `internal_agents` table (`is_system=TRUE`, `tenant_id=NULL` per migrations 193–194; migration 199 refines the HRBP prompt). The HRBP task handler is authoritative for spec terminal status: after the agent loop ends it always writes `completed`/`failed`/`skipped` to `workforce_plans.agents[].provisioningStatus` based on the loop outcome, independent of whether the LLM called `provisioning__update_spec_status`. Workforce-service caches system-agent configs (prompt + tier) for 60s so platform-backend prompt migrations propagate within a minute of deploy.
- **Harvest Service** (`liftoff-harvest-service`) — Passive memory pipeline. Subscribes to `connector-events-{env}` Pub/Sub, classifies connector records via LLM, and writes institutional memories to tenant-runtime with TTL. Implements change detection (skips unchanged content), dual-path connector-disconnect cleanup (provenance graph erasure + harvest_entities fallback), and a monthly re-harvest Cloud Run Job.
- **MCP OAuth front door** (platform-backend `src/oauth/`, ADR-032) — external coding tools (Claude Code, Codex) link to a workspace by pasting `https://api.example.com/mcp`: the 401 challenge points at RFC 9728 discovery → DCR → browser `/oauth/authorize` → frontend `/oauth/consent` (workspace picker, explicit approve) → PKCE token exchange. The grant anchors on a credential-less `mcp_tokens` row (`auth_kind='oauth'`) so the existing collaboration identity model is unchanged. Chat with workspace agents flows through durable `mcp_chat_runs` + a same-project Cloud Tasks worker that executes the standard agent-chat turn (TR interactive-chat SSE) — threads are `channel='mcp'` and appear read-only in the dashboard. Task delegation dispatches via TR's `enqueue-standalone`/`execute-standalone` pair (TR self-enqueues on its own queue; no cross-project IAM; the endpoint translates PB internal agent ids to runtime ids via `resolveRuntimeAgentId`). Onboarding is agent-executed: the dashboard shows one copyable prompt (`Set up <site>/SKILL.md`; the site nginx proxies it to the API host so the published URL stays the site's) and the backend serves the Liftoff skill (`/SKILL.md`, alias `/agent-setup.md`, flag-gated, env-generated, `src/oauth/skill-document.ts`): an Agent Skill whose frontmatter description is the trigger every tool loads at session start, with a choice between the standard loopback flow and the device flow before the per-client MCP registration sections for Claude Code, Codex, OpenCode, Gemini CLI, Grok Build, Windsurf, and Cursor/Copilot, the instruction to install itself into `~/.agents/skills/liftoff/` and `~/.claude/skills/liftoff/` and refresh when its content-digest version differs, when-to-use and troubleshooting sections. Public MCP/OAuth surfaces enforce the canonical host: requests on a raw `*.run.app` host get GET→301 / other→404 (`src/oauth/canonical-host.ts`); internal Google-signed deliveries are exempt. The MCP 2026-07-28 hardening (ADR-034) adds the RFC 9207 `iss` parameter on the authorization response, `application_type` on DCR, and Client ID Metadata Documents (CIMD) — a URL-form `client_id` resolved on demand via an SSRF-guarded fetch of the client's metadata document and upserted into `oauth_clients` (`src/oauth/cimd.ts`), coexisting with DCR for backward compat. A tool that cannot reach a browser on its own machine (a container, a remote host, an agent driven from a phone) uses the RFC 8628 device flow instead of the loopback redirect: it registers for the device grant with no redirect URI, asks `POST /oauth/device_authorization` for a device code and a user code (`oauth_device_codes`, migration 485), shows the person the user code and `<site>/activate`, and polls the token endpoint's device grant until the person has approved there; the `/activate` page renders the same consent as `/oauth/consent` and both approval paths build the grant through one branch machine (`src/oauth/grant-lifecycle.ts`). `resource` defaults to the one MCP server when omitted. A connection ends the way it began, from the client's side: `POST /oauth/revoke` marks the presented token and, when the grant is left with no live refresh token, retires the grant family so the row leaves the Teams page; and a DCR client can deprovision its own registration with RFC 7592 `DELETE` on the `registration_client_uri` its registration answer carried, authenticated by the `registration_access_token` from the same answer, which ends every connection made through that registration (`oauth_clients.deleted_at`). Every path that writes a grant or anything it owns is one function in `src/oauth/transactions.ts`, following one lock discipline (client → pending rows → grant, ascending; grant-owned rows never locked on their own; request paths lock and write only live rows; the sweep deletes only rows dead for an hour or more), so revocation, issuance and the sweep cannot cycle. The `/mcp` server itself is stateless and liberal: it advertises `2026-07-28`, reads the version/capabilities from request `_meta`, implements `server/discover`, and never 400s an unknown/newer protocol version.
- **Conversation recall** — an agent can look up its own past conversations with the current user across web/Slack/Teams/MCP. Every chat turn persists an `agent_chat_turns` row (id = the PB turnId; responder agent; `sender_account_id` = the user's accounts.id or NULL for unresolved guests) and stamps its user + assistant messages with `turn_id` (migration 294). The TR gateway tool `recall_conversations` (flag `RECALL_CONVERSATIONS_ENABLED` on agent-service) calls `POST /api/internal/platform-tools/agent-conversations`, scoped by tenant + agent + sender account so a user recalls only their own turn windows — never thread titles or rolling summaries; guests recall nothing. Retrieval is keyword-first with semantic fill: an ILIKE substring pass always runs and its hits are never displaced, and when it under-fills the requested limit a semantic pass (flag `RECALL_SEMANTIC_READ_ENABLED`) fills the remaining slots by cosine similarity over per-turn `content_embedding vector(768)`, restricted to the same embedding space that produced the query vector (`content_embedding_provider`/`content_embedding_model`; migration 295 — spaces are never cross-compared, the m238 pattern). No vector index: the `(tenant, agent, sender)` filter via `idx_turns_recall` leaves a small exact-sortable set, where a global approximate (HNSW) index would post-filter and could empty out selective results. Turn embeddings are written both inline at assistant-append (best-effort) and by the hourly `embed-sweep-chat-turns` Cloud Run Job (durable; also re-embeds provider/model-drifted vectors), gated by `RECALL_EMBED_WRITE_ENABLED` (job env is separate from service env — both flags live in the infra repo Terraform). Cost lands in `llm_usage_log`: background turn embeds as platform overhead (`conversation_recall`), query embeds customer-attributed (`conversation_recall_query`, charged only when the semantic pass actually runs). Pre-existing history was attributed by a one-shot backfill (TR audit-log exporter + PB matcher, HMAC-of-sanitized-objective matching); residual gaps are guests, ambiguous/duplicate matches, and turns whose stored embedding space no longer matches the current default until the next sweep. Ops: runbooks/embed-sweep-chat-turns.md.
- **Chat share links** (platform-backend `src/chat-shares/`) — workspace-scoped `/share/<uuid>` deep links to agent chat threads. `POST /api/chat-shares` finds-or-creates one canonical share UUID per `(tenant, thread)` (the `UNIQUE (tenant_id, thread_id)` upsert arbiter, migration 293; `agent_id` denormalized for URL reconstruction and validated against thread participants); `GET /api/chat-shares/:id` resolves it to `{tenantId, agentId, threadId, threadKind}` and is leak-proof — unknown/non-UUID id, non-member caller, and soft-deleted thread all return a byte-identical 404. `chat_share_links` is FORCE-RLS: writes under `withTenantScope`, the pre-tenant-context by-PK resolve under `withAdminScope` with the router enforcing membership on the row's tenant. Migration 326 made the table serve both chat surfaces: `thread_kind` is `agent` (default) or `team_plan`, and the thread FK was dropped because team-plan threads live in the `workforce` database — their existence is checked over HTTP against workforce-service on create and resolve, so a soft-deleted CAIO thread still 404s. The frontend routes on `threadKind`: `agent` opens the agent chat, `team_plan` opens `/dashboard/agents/plan`.
- **Tunnel Service** (`liftoff-tunnel-service`) — Multi-tenant terminator for the private MCP reverse-tunnel, built on **stock jpillora/chisel** (no fork). Customers run a single `docker run` of `liftoffos/tunnel-client` in their network; the terminator (Cloud Run + GCLB with a Certificate Manager wildcard cert) forwards HTTPS to the upstream URL configured in `mcp_tunnel_routes`. Base domain is env-specific: prod = `tunnels.example.com`, dev = `tunnels-dev.example.com` (shared Cloudflare zone, distinct hostnames so envs don't collide). The single-port Cloud Run constraint is handled via **per-tenant in-container loopback ports**: PB allocates a unique port in 20000-29999 per deployment (migration 229); the customer's chisel client opens `R:<port>:<upstreamHost>:<upstreamPort>` so chisel server-side binds that loopback inside the container; the HTTP dispatcher dials `127.0.0.1:<loopbackPort>` per route to forward HTTP requests. The chisel WS endpoint at `/_tunnel/ws` is reverse-proxied through the dispatcher mux to the loopback chisel server (Go's `httputil.ReverseProxy` handles the upgrade dance natively since 1.20). Two data planes: HTTP reverse proxy (active in MVP) and SNI passthrough (stubbed behind `mcp_tunnel_deployments.inner_tls_enabled` for future customer-CA inner mTLS). Powers the "Use A Tunnel" affordance in the MCP Server and External Collaborator flows on a 1:1 basis — one tunnel = one customer Docker container = one routed private service. Subdomains are server-generated opaque hex tokens; clients never pick them. Route table refreshed via Pub/Sub push (`mcp-tunnel-routes-changed-{env}`) + 30s poll fallback. Chisel tunnel-client auth tokens live in Secret Manager (`mcp-tunnel-token-{tenant_prefix}`) with versioned rotation + 5-minute grace window.

Platform-backend does not own connector, governance, billing, or workforce logic — it proxies those to the dedicated services. Claude Code proxy logic runs either locally in `src/claude-code-proxy/` or in `liftoff-developer-proxy`, selected by `DEVELOPER_PROXY_SERVICE_ENABLED`. The tenant runtime calls Connector Service for every tool invocation and Governance Engine for **admission decisions + approval persistence + ledger writes** — but NOT for the runtime gate evaluation itself, which lives in tenant-runtime (see below).

### Policy enforcement is split — read this before changing any HITL/gate code

| Concern | Where it lives | Why |
|---|---|---|
| **Runtime gate evaluation** (does this tool call need human approval?) | `liftoff-tenant-runtime/src/hitl-enforcement/service.ts:checkHitlGate()` + `src/agent-execution/service.ts:runAdapterHitlGate()` + the catalog wrap at `src/tool-gateway/mcp-server.ts:373` | Runs inline on the tool-dispatch critical path; cross-service latency would dominate. Plus the catalog wrap needs `oversight.communication`/`oversight.sensitiveWork` at MCP catalog *build* time, which is per-invocation. |
| **Admission control** (kill switches, credit drain, suspension) | `liftoff-governance-engine` Preflight + Authorize RPCs, called from `liftoff-tenant-runtime/src/tool-gateway/service.ts` | Tenant-wide state that's authoritative at the engine. TR caches the Preflight token per invocation. |
| **Approval row persistence** (`hitl_approval_requests`) | **tenant-runtime's own database.** `hitl-enforcement/service.ts:createApprovalRequest()` is a direct INSERT (TR migration 013), read back locally at eight sites; PB reaches it over TR's HTTP surface | The row must be readable synchronously on the resume path, and TR is one deployment per tenant with its own Cloud SQL, so a local row already survives restarts. governance-engine carries the same table (its migrations 001/006/007) but nothing writes it live — `src/jobs/backfill/backfill-from-tenant.ts` is a one-shot Phase-3d copy tool, and the governance client exposes no approval-creation RPC. Centralisation is designed and unbuilt; treat gov-engine's copy as a backfill artifact, not a source of truth. |
| **Standing-approval policies** (`hitl_approval_policies`) | governance-engine; TR's `checkHitlGate()` calls `getGovernanceApprovalPolicy()` inline before firing the gate | Multi-tenant + multi-agent visibility; ops set policies via the dashboard. |
| **Action / usage / audit ledger writes** | governance-engine Record RPC; TR's `tool-gateway/service.ts` posts after every execution | Append-only ledgers belong at the engine. `audit_logs` is DB-enforced append-only via a `BEFORE UPDATE/DELETE/TRUNCATE` trigger, with a 2-year retention purge (governance migration 019); `actions` remains a mutable state ledger. |
| **Dry-run gate simulator** (operator dashboard preview) | governance-engine's `src/hitl-enforcement/service.ts` (also called `checkHitlGate` — naming collision with TR's runtime gate) at `POST /api/governance/tenant/:id/simulate` | Mirrors TR's evaluator for the "what would happen if I enable this?" UI without touching prod state. |
| **Gate decision types** (`SensitivityCategory`, `GateReason`, `MERGE_TO_MAIN_TOOL_NAMES`, `OversightSettings.sensitiveWork` shape) | `@liftoffos/governance-types` shared npm package (`packages/governance-types` in this repo) | Single source of truth — TR's runtime gate and gov-engine's simulator both import from it so the two can't drift. |
| **Approval-decision authorization** (may THIS person approve THIS approval?) | platform-backend `src/internal-agent-oversight/router.ts:authorizeHitlDecision()` | TR carries no end-user identity — its HITL router documents that PB authenticates the user and TR trusts `decidedBy`/`decidedByRole` from the body. PB is therefore the ONLY place the level-1-needs-admin rule can be applied; a check in TR would re-validate a claim TR cannot verify. Runs unconditionally, and an approval it cannot read authorizes against level 1 (see ADR-003). |
| **Announcement of a pending approval** (was a human actually told?) | TR `src/agent-execution/hitl-side-effects.ts` fan-out → PB `/api/internal/agent-{slack,teams}/post-review-*`; outcome recorded by TR `hitl-notification-outcome.ts` onto `hitl_approval_requests` (TR migration 366) | The gate is fail-closed but the announcement is fire-and-forget, so its failure has to be written down or it is indistinguishable from a person ignoring the request. NOT answerable from `dm_delivery_attempts`, which tracks TARGET health, not per-approval delivery. |

**Rule of thumb when adding new gate logic**: if it needs to make a decision at tool-dispatch time, it goes in TR's `checkHitlGate()` (or `runAdapterHitlGate()` for the adapter path). If it's a persisted policy/ledger row that another service reads later, it goes in gov-engine. Both sides import the gate decision's input shape from `@liftoffos/governance-types`.

**Two traps this split sets** (detail in ADR-003):
a gate that matches tool calls **by name** must normalize the dispatch prefix —
the catalog stores `<alias>__<fn>` and the SDK calls `mcp__<server>__<alias>__<fn>`,
so a raw comparison silently disables the gate for every connector and vendor-MCP
tool, and tests that pass the catalog's own name form will not notice. And
authorization on the DECISION side must never be nested behind a read of the
approval: `getApproval()` returns null both for a real 404 and as the circuit
breaker's fallback, so a guard inside `if (approval)` disappears precisely when the
runtime is degraded.

**Risk-aware Authorize gate.** The per-tool-call `Authorize` RPC (`POST /api/governance/authorize`, once per tool call, synchronous — wire shape in `packages/governance-types/src/preflight.ts`) now decides by the **risk class of the action**, not just the workspace autonomy level. Irreversible/high-blast-radius operations — merges to protected branches (name-gated via `MERGE_TO_MAIN_TOOL_NAMES` in `packages/governance-types/src/hitl.ts`) and destructive/super-destructive ops — gate at **every** autonomy level, so even a fully-autonomous team stops for a merge or a delete. Reversible collaboration writes (opening/updating a PR or MR, posting a review comment) gate only at the lower autonomy levels (1–3) and **proceed at `balanced`**, so a review team can open and iterate on a PR without a human in the loop while merge stays gated. The decision itself lives in **`liftoff-governance-engine`**'s Authorize implementation (with the tool-name set + `GateReason` union shared via `@liftoffos/governance-types` so TR's runtime gate and the dry-run simulator can't drift); PB proxies to it and surfaces results to the dashboard. This is what makes the SWE team (§3f) safe to run: open-PR-and-review flows are autonomous at `balanced`, merges and destructive actions always gate.

**Read "once per tool call" as the design, not as what runs.** `client.authorize` has a single call site, inside `executeInner`, below the branches that return early for external-agent, agent-Slack, agent-Teams, custom-MCP and sandbox dispatch — and `executeBatch` does not call it at all. The batch path carries most tool calls, so most tool calls **never reach Authorize**. That is not an open gate: the gate that runs is tenant-runtime's in-process `checkHitlGate`, which raises `HitlGateError` before the connector is ever dispatched, and it is the one covered by tests and invariants. Authorize is a second, parallel gate that the paths in use do not consult. Before citing it as an enforcement control, confirm it is reached on the path in question.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              USER INTERFACE                                      │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                        Liftoff-React                                     │   │
│  │                                                                          │   │
│  │  Sign-in & OAuth         Dashboard v2           Settings & Billing      │   │
│  │  /login, /oauth/*,      /dashboard/*            /dashboard/settings     │   │
│  │  /invitation/*          Teams, Oversight,       Profile, Members,       │   │
│  │                         Review Queue            Workspace, API Keys     │   │
│  └──────────────────────────────────┬──────────────────────────────────────┘   │
│                                     │                                           │
│                          Firebase Auth + REST API                               │
│                                     │                                           │
└─────────────────────────────────────┼───────────────────────────────────────────┘
                                      │
┌─────────────────────────────────────┼───────────────────────────────────────────┐
│                            CONTROL PLANE                                         │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                    liftoff-platform-backend                              │   │
│  │                                                                          │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │   │
│  │  │ Accounts │ │ Tenants  │ │ agents │ │Connectors│ │ External │      │   │
│  │  │ Passkeys │ │ Members  │ │ Oversight│ │ OAuth    │ │  Agents  │      │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘      │   │
│  │                                                                          │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │   │
│  │  │Entitle-  │ │  Model   │ │  Prompt  │ │ Feature  │ │ Deploy-  │      │   │
│  │  │  ments   │ │ Registry │ │ Registry │ │  Flags   │ │  ments   │      │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘      │   │
│  │                                                                          │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │   │
│  │  │ Billing  │ │Connector │ │Workforce │ │ DevPxy   │ │Governance│      │   │
│  │  │ (proxy → │ │(proxy →  │ │(proxy →  │ │(proxy →  │ │(proxy →  │      │   │
│  │  │ billing) │ │connector)│ │workforce)│ │devprxy)  │ │  govnce) │      │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘      │   │
│  └──────────────────────────────────┬──────────────────────────────────────┘   │
│                                     │                                           │
│                    Pub/Sub Events + Direct Secret Manager Write                 │
│                                     │                                           │
└─────────────────────────────────────┼───────────────────────────────────────────┘
                                      │
┌─────────────────────────────────────┼───────────────────────────────────────────┐
│                           EXECUTION PLANE                                        │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                    Liftoff-Tenant-Runtime                                │   │
│  │                                                                          │   │
│  │                                                                          │   │
│  │  agent-service │ coordinator-service │ tool-gateway-service │ reflection│   │
│  │                                                                          │   │
│  │  Per-service routing via SERVICE_TYPE; monolith tenant-runtime also runs │   │
│  │  Per-tenant PostgreSQL (pgvector) · Cloud Tasks · Cloud Storage · Pub/Sub│   │
│  │                                                                          │   │
│  │  Calls Connector Service for every tool invocation (Execute, ListTools)  │   │
│  │  Runs the HITL gate evaluator INLINE (checkHitlGate / runAdapterHitlGate)│   │
│  │  Calls Governance Engine for admission (Preflight + Authorize) + approval│   │
│  │  row persistence + ledger writes (Record). NOT for gate evaluation.     │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
                                      │
┌─────────────────────────────────────┼───────────────────────────────────────────┐
│                       SHARED SERVICES (platform-control)                         │
│                                                                                  │
│  ┌───────────────────────────────┐   ┌────────────────────────────────────┐    │
│  │  liftoff-connector-service    │   │  liftoff-governance-engine         │    │
│  │                               │   │                                    │    │
│  │  OAuth / DCR flows            │   │  HITL approvals                    │    │
│  │  Credential vault             │   │  Admission (credits, rate limits,  │    │
│  │  Vendor SDK execution         │   │    kill switches, allowlists)      │    │
│  │  MCP sidecars                 │   │  Action / usage / audit ledgers    │    │
│  │  Tool registries              │   │  Kill-switch Pub/Sub publisher     │    │
│  │                               │   │                                    │    │
│  │  Data: connector-pg           │   │  Data: governance-pg               │    │
│  └───────────────────────────────┘   └────────────────────────────────────┘    │
│                                                                                  │
│  ┌───────────────────────────────┐   ┌────────────────────────────────────┐    │
│  │  liftoff-billing              │   │  liftoff-developer-proxy           │    │
│  │                               │   │                                    │    │
│  │  Stripe webhooks              │   │  BYOK key mgmt (CC + Codex)        │    │
│  │  Invoices, payment methods    │   │  Transparent Claude/OpenAI proxy   │    │
│  │  Credit balance               │   │  Per-key rate limiting             │    │
│  │  Meter events (idempotent)    │   │  Usage metering → billing          │    │
│  │  Stripe-native OU ingest (RT) │   │                                    │    │
│  │                               │   │                                    │    │
│  │  Data: billing-pg             │   │  Data: developer-proxy-pg          │    │
│  └───────────────────────────────┘   └────────────────────────────────────┘    │
│                                                                                │
│  ┌───────────────────────────────┐                                             │
│  │  liftoff-workforce-service    │                                             │
│  │                               │                                             │
│  │  Workforce plans (CAIO)       │                                             │
│  │  HRBP provisioning            │                                             │
│  │  Team-plan chat (SSE)         │                                             │
│  │  CAIO memory, cap. tokens     │                                             │
│  │                               │                                             │
│  │  Data: workforce-pg           │                                             │
│  └───────────────────────────────┘                                             │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
                                      │
┌─────────────────────────────────────┼───────────────────────────────────────────┐
│                           INFRASTRUCTURE                                         │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐   │
│  │                   Liftoff-Infrastructure-GCP                             │   │
│  │                                                                          │   │
│  │  Terraform modules for: Cloud Run, Cloud SQL, Pub/Sub, Cloud Tasks,     │   │
│  │  Secret Manager, Cloud KMS, IAM, VPC Service Controls, Binary Auth,     │   │
│  │  Workload Identity Federation, Logging, Tracing, Audit, Restore Drills  │   │
│  │                                                                          │   │
│  │  Shared RPC contracts: liftoff-proto (@liftoffos/proto-gen)              │   │
│  └─────────────────────────────────────────────────────────────────────────┘   │
│                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## Repository Structure

| Repository | Purpose | Tech Stack |
|------------|---------|------------|
| **Liftoff-React** | Customer-facing web application | React 19, Vite 7, TanStack Query, Tailwind CSS 4 |
| **liftoff-platform-backend** | Control Plane API service; proxies billing, workforce, developer proxy, connector, and governance traffic to dedicated services | Node.js 20, Express, PostgreSQL |
| **Liftoff-Tenant-Runtime** | Execution Plane; deploys as agent / coordinator / tool-gateway / reflection Cloud Run services per tenant | Node.js 20, Fastify, PostgreSQL, pgvector |
| **liftoff-connector-service** | OAuth / DCR flows, credential vault, vendor SDK execution, MCP sidecars | Node.js 20, Fastify, PostgreSQL, Connect-RPC |
| **liftoff-governance-engine** | HITL approval row persistence (`hitl_approval_requests`, `hitl_approval_policies`); admission / kill switches via Preflight + Authorize RPCs; action + usage + audit ledgers. Dry-run gate simulator at `/api/governance/tenant/:id/simulate`. **NOT the runtime gate evaluator — that lives in tenant-runtime.** See the policy-enforcement split table in §System Overview. | Node.js 20, Fastify, PostgreSQL, Connect-RPC |
| **liftoff-billing** | Stripe webhooks, invoices, payment methods, OU meter events (Stripe-native `billing.meterEvents`), subscription lifecycle, outbox pattern for retry | Node.js 20, Fastify, PostgreSQL, Connect-RPC |
| **liftoff-developer-proxy** | BYOK developer proxy for Claude Code (Anthropic) + Codex (OpenAI), API key management, rate limiting, usage metering | Node.js 20, Fastify, PostgreSQL |
| **liftoff-workforce-service** | Workforce plans (CAIO), HRBP provisioning, team-plan chat, capability tokens | Node.js 20, Fastify, PostgreSQL |
| **liftoff-harvest-service** | Passive memory pipeline — classifies connector records, writes institutional memories to tenant-runtime with TTL; change detection + dual-path connector-disconnect cleanup (provenance graph CTE + harvest_entities fallback) + monthly re-harvest job | Node.js 20, Express, PostgreSQL |
| **liftoff-proto** | Canonical Connect-RPC contracts between services; published as `@liftoffos/proto-gen` | Protobuf, buf, TypeScript |
| **Liftoff-Infrastructure-GCP** | Infrastructure as Code | Terraform, GCP |

---

## Security Model

### Authentication

- **Users**: Firebase Authentication (email/password, OAuth, WebAuthn passkeys)
- **Services**: Service account identity via GCP IAM
- **API Keys**: Tenant-specific API keys for programmatic access

### Authorization

- **Role-based access**: owner > admin > member > viewer
- **Tenant isolation**: X-Tenant-ID header enforced on all API calls
- **Entitlements**: Quota enforcement based on subscription plan
- **Domain-based access gate**: `accessGateMiddleware` enforces that only users with whitelisted email domains (via `allowed_domains` DB table) or accepted tenant invitations can access protected API endpoints. Access decision is computed as `accessGranted` (boolean) and `accessReason` (`'domain'` | `'invitation'` | `null`) on every account response. The frontend's `ProtectedRoute` reads `accessGranted` and redirects non-granted users to `/request-invite`. Email changes are also restricted to whitelisted domains.

### Data Protection

- **Encryption at rest**: Cloud SQL encryption, Secret Manager, Cloud KMS (per-service KMS keys: `billing-key`, `workforce-key`, etc.)
- **Encryption in transit**: TLS everywhere
- **Memory encryption**: PII in agent memory encrypted with tenant-specific keys
- **Credential isolation**: OAuth tokens in tenant's Secret Manager, never in logs/messages
- **Secret path validation**: `getConnectorCredential()` in connector-service calls `assertSafeSecretSegment()` on both `tenantId` and `connectorId` before composing the Secret Manager path. Segments must match `[a-zA-Z0-9_-]+` — any disallowed character throws before the path is constructed, preventing path traversal. Secret names additionally must match `connector-{segment}-{segment}` via `SECRET_NAME_RE`.
- **VPC Service Controls** (prod): A VPC-SC perimeter wraps `YOUR_CONTROL_PROJECT`, restricting access to Secret Manager and Cloud Run APIs. All service accounts (platform-backend, billing, developer-proxy, workforce, connector-service, governance-engine, tenant-runtime) are in the access level so they can read cross-project secrets at startup.

### Safety Controls

- **HITL enforcement**: 5-level system with tamper detection
- **Rate limiting**: 1000 autonomous ops/hour for Level 5
- **Super-destructive guard**: Always gates database drops, mass deletes, etc.
- **Kill switch**: Immediate tenant suspension capability

### PII Redaction & Defense-in-Depth

The platform applies pattern-based PII redaction as defense-in-depth at three boundaries inside the per-tenant trust boundary. None of these constitute a re-identification-bounded de-identification pipeline; that gate is documented in ADR-017.

| Layer | Where | What |
|---|---|---|
| Pre-LLM scrub | `liftoff-harvest-service/src/redact.ts` | Every `rawContent` is run through `redactPii` before being sent to the LLM gateway for classification. Memory is for *learnings*, not source-of-truth lookups — agents that need raw PII to act on call HRIS / connector tools, not `memory_retrieve`. |
| Audit-log sanitization | `liftoff-governance-engine/src/audit/service.ts` | Recursive `sanitizeArgs` walks every snapshot field (`inputArgs`, `outputSummary`, `preActionSnapshot`, `postActionSnapshot`, `externalResponse`) before INSERT into `audit_logs` AND before publishing to the `audit-events-{env}` Pub/Sub topic. Layer 1 kills credential-shaped keys wholesale; Layer 2 pattern-scrubs every remaining string leaf. |
| Anonymized export | `liftoff-platform-backend/src/data-management/export-service.ts` | Three-layer export-time scrub when `filters.anonymize = true`: (1) PII_COLUMNS kill-list nulls structured columns, (2) recursive pattern scrub of every remaining string leaf (including JSONB blobs like `connector_records.data`), (3) env-gate `EXPORT_ANONYMIZE_ENABLED` runtime guard. Schema-drift in PII_COLUMNS causes a loud failure that marks the job `failed`. Each anonymized export emits a `compliance.export_anonymized` audit row with `redactionVersion` and per-pattern hit counters. |

All three layers consume the **shared canonical pattern set** at `@liftoffos/proto-gen/dist/redaction` (`liftoff-proto` repo, `gen/ts/redaction.ts`):

| Pattern | Detection |
|---|---|
| JWT | `eyJ`-prefixed three-segment base64url |
| Bearer token | `Bearer <token>` literal |
| AWS access key | `AKIA[0-9A-Z]{16}` |
| SSN (formatted) | `\d{3}-\d{2}-\d{4}` |
| SSN (unformatted 9-digit) | `\d{9}` with non-digit boundaries (after ABA-checksum-first classification) |
| ABA routing number | 9-digit ABA checksum-validated |
| Credit card | 13-19 digit run, Luhn-validated |
| IBAN | `[A-Z]{2}\d{2}[A-Z0-9]{11,30}` |
| Email | RFC-shaped |
| Phone | International / area-coded with mandatory separator (avoids bare-digit false positives) |

**Acknowledged gaps:** names, addresses, narrative health/financial content, and custom-format IDs are NOT caught and pass through. Audit-log access control (operator-only, tenant-scoped via RLS) is the primary defense; redaction is defense-in-depth.

**Versioning:** `REDACTION_VERSION` (semver) is exported from the shared module. Bumped on PATCH (pattern narrowing/widening), MINOR (new pattern), MAJOR (pattern removal or replacement token rename). Anonymized export audit rows and output blob metadata both record this version for downstream traceability.

---

## Event System

### Pub/Sub Topics (Control Plane → Execution Plane)

| Event | Trigger | Payload |
|-------|---------|---------|
| `tenant.created` | New tenant provisioned | Tenant ID, tier, config |
| `tenant.suspended` | Billing issue, abuse | Tenant ID |
| `tenant.reactivated` | Issue resolved | Tenant ID |
| `tenant.entitlement.updated` | Plan change | Tenant ID, credit balance, operational status, feature flags |
| `tenant.deployment.approved` | agent config change | Tenant ID, team config |
| `tenant.model_config.updated` | LLM settings change | Tenant ID, model config |
| `tenant.feature_flag.created` | Global feature flag row added via `/api/feature-flags` or `/api/internal/feature-flags` | `payload: { key, enabled, value_num? }` — `value_num` present only when the flag carries a tunable numeric threshold (e.g. concurrency caps); runtime merges it into the sentinel-row JSONB at `<key>_value` |
| `tenant.feature_flag.updated` | Global feature flag row mutated | `payload: { key, enabled, value_num? }` — same shape as `.created`. Runtime applies an atomic JSONB `||` merge so concurrent updates for different keys never lose writes |
| `tenant.feature_flag.deleted` | Global feature flag row removed | `payload: { key }` — runtime drops `key` AND the sibling `<key>_value` from the sentinel-row JSONB. PB's `delete()` looks up the row pre-delete to fill `payload.key`; runtime tolerates a missing key (back-compat for pre-2026-06 events) by returning silently |
| `connector.credentials_stored` | OAuth completed | Tenant ID, connector type (NO tokens) |
| `external_agent.created` | External agent saved | Tenant ID, agent config, tool classifications |
| `external_agent.updated` | Agent config changed | Tenant ID, updated config |
| `external_agent.deleted` | Agent removed | Tenant ID, agent ID |
| `external_agent.rediscovered` | Tools refreshed | Tenant ID, new tool list |
| `external_agent.credentials_stored` | Credentials updated | Tenant ID, secret reference (NO credentials) |
| `external_agent.health_failed` | Periodic health check failed | Tenant ID, agent ID, failure reason |
| `tenant.internal_agent.skills_updated` | Skill feedback service applied a skill mutation (refined description or new pitfall skill) | Tenant ID, agent ID, updated skill list |
| `workflow.run.started` | Workflow run created and first step dispatched | Run ID, definition ID, tenant ID |
| `workflow.run.completed` | All steps completed, no pending branches | Run ID, tenant ID |
| `workflow.run.failed` | Run failed after max retries exhausted | Run ID, node ID, error, tenant ID |
| `workflow.step.dispatched` | Step sent to Tenant Runtime | Run ID, node ID, step ID, agent ID |
| `workflow.step.completed` | Tenant Runtime confirmed step completion | Run ID, node ID, step ID |
| `workflow.step.failed` | Tenant Runtime reported step failure | Run ID, node ID, step ID, error |

#### Model-config dual delivery (outbox trigger + periodic reconciler)

`tenant.model_config.updated` has stricter durability than the rest of the `tenant.*` events because TR caches `model_configs` row-for-row in `cached_model_configs` and serves every LLM call from that cache. A missed event silently pins TR to the last-synced shape — a tenant can stay stuck resolving a role to an old model long after PB has migrated the row.

Two safety nets sit underneath the normal publish path:

1. **PB-side outbox trigger** (migration 263). An `AFTER INSERT/UPDATE/DELETE` trigger on `model_configs` inserts a `tenant.model_config.updated` envelope into `control_plane_outbox` regardless of code path. Catches direct-SQL migrations (the usual drift cause) and any future code path that mutates the row without an explicit `publishEvent` call. The trigger's `EXCEPTION WHEN OTHERS` block degrades to a `RAISE NOTICE` so the write itself never fails on outbox issues.
2. **TR-side periodic reconciler**. Hourly Cloud Scheduler job (`model-config-reconciler`, per tenant-runtime project) → `POST /api/internal/model-config-reconciler`. Walks every distinct `tenant_id` in `cached_model_configs`, calls PB's service-auth endpoint `GET /api/model-registry/tenant/:id/configs` (mounted on `modelRegistryServiceRouter` *before* `authMiddleware`), and synthesizes a normal `tenant.model_config.updated` handler invocation per tenant. Drains drift even when the outbox trigger and Pub/Sub both miss.

Neither safety net replaces the normal event flow — they assume occasional gaps and converge against the authoritative `model_configs` table. Existing tenants whose caches drifted before either layer shipped recover on the next reconciler tick.

### Event Versioning

All events include `entity_version` to handle out-of-order delivery:
- Tenant Runtime stores latest version per entity
- Stale events (lower version) are discarded
- Prevents race conditions during rapid updates

### Event Processing Ledger (Idempotent Event Handling)

Pub/Sub guarantees at-least-once delivery, which means event handlers must be idempotent. The Tenant Runtime uses an **event processing ledger** (`event_processing_ledger` table) with step-level tracking to ensure multi-step event handlers can safely resume after failures or redeliveries.

```
Pub/Sub delivers event
            │
            ▼
    EventProcessor.claim(messageId)
    ├── Already completed? → ACK immediately
    └── New or incomplete? → Resume from last completed step
            │
            ▼
    Execute steps sequentially
    (each step recorded in ledger)
            │
            ├── Step succeeds → Record completion, continue
            └── Step fails → Record failure
                    │
                    ├── Retryable? → NACK for redelivery
                    └── Permanent? → Route to DLQ
```

**Key properties**:
- **Claim/resume**: `EventProcessor.claim()` returns the last completed step, allowing handlers to skip already-executed work on redelivery
- **Step tracking**: Each step in a multi-step handler (e.g., activation has 5 steps: validate, compile instructions, configure scheduler, update status, notify) is recorded individually
- **DLQ routing**: Events that fail permanently are routed to a dead-letter queue with full context for manual replay via `scripts/replay-dlq.ts`
- **Circuit breaker removed**: The previous circuit breaker pattern was replaced by this ledger-based approach, which provides finer-grained recovery without blocking all events when one type fails
- **EntityBusyError**: When a different event for the same entity arrives while a prior event is still in-flight, the handler throws `EntityBusyError` and the Pub/Sub message is nacked for redelivery. This prevents concurrent mutations to the same entity (e.g., two rapid config updates to the same agent) without blocking events for other entities

See: ADR-006: Idempotent Event Processing

### Bulletproof Event Delivery (Publisher↔subscriber acknowledgment + DLQ + healthchecks)

ADR-006 covers redelivery correctness assuming a message arrives. Four
additional safeguards ensure messages can't be silently
lost between the outbox-marked-completed publisher side and the runtime
ledger:

1. **Outbox acknowledgment reconciler** — A Cloud Run Job
   `outbox-ack-reconciler-${env}` (every 5 min, in `YOUR_GCP_PROJECT`)
   walks every row in `internal_agent_outbox` + `control_plane_outbox` with
   `status='completed' AND completed_at BETWEEN NOW() - 24h AND NOW() - 15min`
   whose `reconciler_checked_at` is older than 5 min. For each row it calls
   the tenant runtime's `GET /api/internal/event-status/:event_id?tenant_id=<uuid>`
   endpoint (queries `event_processing_ledger`'s `(tenant_id, event_id)` PK).
   Rows the subscriber reports as `unknown` or `failed` are republished via
   `publishEventWithExplicitId` (idempotent on the subscriber side); rows
   stuck > 24h emit a metric and log at error level.

2. **Push-endpoint healthcheck** — A Cloud Run Job
   `push-endpoint-healthcheck-${env}` (per-deploy, in
   `tenant-${tenant}-${env}`) is invoked from cloudbuild as a
   `verify-push-endpoints` step immediately after `patch-push-sub-endpoints`.
   It refuses to ship the deploy if any control-plane push subscription
   still points at `placeholder.invalid`, has a mismatched OIDC audience,
   or fails an OIDC-bearing GET on `/healthz`. The cloudbuild becomes a
   regression-test for the placeholder-endpoint failure mode.

3. **DLQ drainer** — One Cloud Run Job per control-plane DLQ
   (`pubsub-dlq-drainer-<topic>-${env}`, every 10 min). The control-plane
   DLQ subscriptions historically had no consumer; messages aged out at the
   7-day retention boundary. The drainer pulls up to 100 messages, inserts
   each into a new `failed_events` table (operator-only forensic record),
   republishes parseable payloads to the live topic with attributes
   `manual_retry='true'` / `republished_from_dlq='true'`, and acks only
   after both insert + republish succeed. Forensic rows persist
   indefinitely so the 7-day Pub/Sub retention is no longer a loss
   boundary.

4. **Push-handler error classification** — `coordinator-service`'s push
   handler classifies unhandled errors before deciding HTTP status:
   - `EntityBusyError`, ECONNRESET/ETIMEDOUT/EAI_AGAIN, default → 500
     transient, Pub/Sub redelivers.
   - Foreign-key / check-constraint / invalid-input-syntax /
     null-value-in-column → 204 + write to `dlq_messages` with prefix
     `[permanent]`. No point retrying schema mismatches.
   - `deliveryAttempt >= 8` (`POISON_DELIVERY_ATTEMPT_CAP`) → 204 +
     `[over-attempt]` DLQ row. Proactive cap two attempts before Pub/Sub's
     `maxDeliveryAttempts=10` to avoid retry waste.

Cross-cutting:

- **`validate-tenant-runtime-urls-${env}`** Cloud Run Job (every 15 min)
  verifies `tenants.runtime_url` matches the live agent-service URL in
  `tenant.gcp_project_id`. A stale runtime_url silently fails the drift
  reconciler's `fetchSyncState`; this catches it within 15 min via metric
  `custom.googleapis.com/liftoff/tenants/runtime_url_invalid`.
- `runReconciliation` now emits
  `custom.googleapis.com/liftoff/internal_agents/reconciler_errors` so
  silent `summary.errors` accumulation triggers alert I.
- `/healthz` is now an alias for `/health` on tenant-runtime as a stable
  probe target.

Telemetry/migration deltas:

- `internal_agent_outbox` + `control_plane_outbox` gain
  `reconciler_checked_at TIMESTAMPTZ` and `reconciler_subscriber_status TEXT`
  with partial indexes on `(completed_at) WHERE status='completed'`
  (migration 250).
- Tenant runtime gains `failed_events` table (migration 216), keyed by
  Pub/Sub `messageId` with `ON CONFLICT (dlq_message_id) DO NOTHING`.

New alerts (Terraform):

| ID | Metric | Threshold | Project |
|---|---|---|---|
| C-1 | `pubsub.googleapis.com/subscription/num_undelivered_messages` on `*-dlq-sub` | > 0 for 10 min | tenant-${tenant}-${env} |
| C-2 | `run.googleapis.com/request_count` 5xx on `coordinator-service` | > 0.1/s for 5 min | tenant-${tenant}-${env} |
| C-3 | `pubsub.googleapis.com/subscription/oldest_unacked_message_age` on `*-coordinator-push` | > 300s for 5 min | tenant-${tenant}-${env} |
| C-4 | `custom.googleapis.com/liftoff/outbox/stuck_24h_count` (scope=global) | > 0 for 5 min | YOUR_GCP_PROJECT |
| C-5 | `custom.googleapis.com/liftoff/tenants/runtime_url_invalid` | > 0 for 5 min | YOUR_GCP_PROJECT |
| I | `custom.googleapis.com/liftoff/internal_agents/reconciler_errors` | > 0 for 15 min | YOUR_GCP_PROJECT |

See: ADR-018: Bulletproof Pub/Sub Event Delivery,
Runbook: PUBSUB_EVENT_RECOVERY.

---

## Infrastructure Mapping

### GCP Projects

There are two parallel environments (dev and prod), each with a CI project and a control-plane project, plus per-tenant runtime projects.

| Project | Purpose | Key resources |
|---------|---------|---------------|
| `YOUR_WEB_PROJECT` | Frontend hosting | Firebase Hosting, Firebase Auth |
| `YOUR_CI_PROJECT_STAGING` | Dev CI/CD | Cloud Build triggers for all service repos, Workload Identity |
| `YOUR_CI_PROJECT` | Prod CI/CD | Cloud Build triggers for all service repos, Workload Identity |
| `YOUR_CONTROL_PROJECT_STAGING` | Dev control plane | Cloud Run services, Cloud SQL, Pub/Sub, Secret Manager, KMS, Artifact Registry |
| `YOUR_CONTROL_PROJECT` | Prod control plane | Cloud Run services, Cloud SQL, Pub/Sub, Secret Manager, KMS, Artifact Registry, VPC-SC perimeter |
| `YOUR_TENANT_PROJECT` | Dev shared-tier runtime | Cloud Run split services, Cloud SQL, Cloud Tasks |
| `YOUR_TENANT_PROJECT` | Prod shared-tier runtime | Cloud Run split services, Cloud SQL, Cloud Tasks |
| `tenant-{id}-prod` | Enterprise tenant (prod-only) | Dedicated Cloud Run, Cloud SQL — customers have no dev/staging counterpart |

### Control-Plane Services (YOUR_GCP_PROJECT)

All services run as Cloud Run services (internal ingress, `--no-allow-unauthenticated`), share a single Cloud SQL instance (`control-plane-pg-{env}`), and connect via the Cloud SQL Auth Proxy. Each service has its own database and dedicated `*_app` / `*_migrate` DB users.

| Service | Cloud Run name | Database | Owns |
|---------|---------------|----------|------|
| Platform Backend | `platform-backend` | `platform_backend` | Accounts, tenants, subscriptions, agent config, all proxy routes |
| Connector Service | `connector-service` | — | OAuth/DCR flows, credential vault, MCP sidecars |
| Governance Engine | `governance-engine` | — | HITL approvals, admission, action + audit ledgers |
| Billing | `billing` | `billing` | Stripe invoices, payment methods, meter events, reconciliation |
| Billing Stripe Webhook | `billing-stripe-webhook` | (shared billing db) | Public HTTPS endpoint for inbound Stripe webhooks |
| Developer Proxy | `developer-proxy` | `developer_proxy` | BYOK developer proxy for Claude Code + Codex, API key management, per-key rate limiting |
| Workforce | `workforce` | — | Workforce plans, CAIO memory, HRBP provisioning |

### Tenant Runtime Services (YOUR_TENANT_PROJECT)

The monolith was split (Phase 4) into four Cloud Run services per tenant project:

| Service | Cloud Run name | Role |
|---------|---------------|------|
| Agent Service | `agent-service` | Public ingress; all routes platform-backend calls |
| Coordinator Service | `coordinator-service` | Multi-agent orchestration |
| Tool Gateway Service | `tool-gateway-service` | Routes tool calls, enforces HITL |
| Reflection Service | `reflection-service` | Evaluation and reflection loop |

### CI/CD per Service

Each service repo has its own Cloud Build trigger in the CI project. Triggers fire on push to `main`. The pipeline for decomposed services (billing, developer-proxy, workforce, connector-service, governance-engine) follows the same pattern: build image + migrate image → push to Artifact Registry → deploy migrate Cloud Run Job (waits for completion) → `gcloud run deploy` with explicit env vars.

| Repo | Dev trigger | Prod trigger |
|------|-------------|--------------|
| liftoff-platform-backend | `platform-backend-dev` | `platform-backend-prod` |
| liftoff-tenant-runtime | `YOUR_TENANT_PROJECT` | `YOUR_TENANT_PROJECT` |
| liftoff-connector-service | `connector-service-dev` | `connector-service-prod` |
| liftoff-governance-engine | `governance-engine-dev` | `governance-engine-prod` |
| liftoff-billing | `billing-dev` | `billing-prod` |
| liftoff-developer-proxy | `developer-proxy-dev` | `developer-proxy-prod` |
| liftoff-workforce-service | `workforce-service-dev` | `workforce-service-prod` |

### Tenant Tiering

| Tier | Database | Secrets | Provisioning | Isolation |
|------|----------|---------|-------------|-----------|
| Standard | Shared instance + RLS | Shared project, tenant-prefixed | Instant | RLS + naming |
| Enterprise | Dedicated instance | Own project | Minutes (Cloud Build) | Full GCP project |

### Cost Attribution

LLM usage is tracked per-request in `llm_usage_log` (platform-backend's own calls: insights chat, distill, internal-agent distill). Per-credential BYOK usage for **Claude Code and Codex** is tracked by `liftoff-developer-proxy` in `developer_proxy_usage_log` and published as meter events to `liftoff-billing`. BYOK usage is attributed per credential/user (not per agent/task — the coding-tool CLIs don't propagate agent identity).

The `src/cost-attribution/` pipeline ingests from 6 sources into `cost_attribution_events` (partitioned by month). Ingesters run inside `POST /api/internal/jobs/cost-attribution-ingest` together with the auto-reload sweep and the snapshot. The pass is armed as a Cloud Task by every spend signal (one per 10-minute bucket, scoped to the feeds that signal's spend lands in, so this service's own model calls never poll the tenant runtimes) and run in full daily by the housekeeping pass, so the prepaid balance reacts to LLM and sandbox spend ~10 minutes after it and nothing runs when nothing was spent; two nightly reconcilers cross-check Anthropic and OpenAI invoices against internal records. See §8 for the full pipeline description.

LLM calls are routed to 4 purpose-group keys per provider (`agent-execution`, `reflective-services`, `platform-analytics`, `background-services`) so reconcilers can attribute invoice spend by group.

Shared-tier tenants share infrastructure. Proportional cost allocation (Cloud SQL, Secret Manager) was previously handled by `src/billing/cost-attribution.ts` — that module was removed in Phase 4 when `liftoff-billing` took over the billing domain. The current metering boundary is: LLM tokens tracked in `llm_usage_log` and `cost_attribution_events`, all billing transactions in `liftoff-billing`.

**Dedicated-tier**: No shared-infra metering needed — GCP billing export provides per-project costs natively (ingested by `gcp-billing-ingester.ts`).

---

## API Contracts

### Platform Backend → Tenant Runtime

The Tenant Runtime periodically fetches from Platform Backend:

```
GET /api/entitlements/:tenantId    # Credit balance, operational status, feature flags
GET /api/model-config/:tenantId    # LLM provider settings
GET /api/prompt-templates/:tenantId # Prompt templates
GET /api/feature-flags/:tenantId   # Feature toggles
```

Platform Backend reaches the Tenant Runtime via Connect-RPC services:

| Service (proto) | Used for |
|-----------------|----------|
| `TenantRuntimeService` | HITL approvals/clarifications, usage dashboard, invocation stats, action costs, connector health, tool catalog |
| `BrowserSessionsService` | Virtual-browser sessions for chat threads (list / create / pause / resume / streaming change events) — see [Virtual Browser Sessions](#virtual-browser-sessions) |

### Anchor Browser webhook

**Public ingress (dedicated Cloud Run service).** Anchor's webhook deliveries land on a small purpose-built Cloud Run service `anchor-webhook-receiver` (deployed from `liftoff-tenant-runtime`, `SERVICE_TYPE=anchor-webhook-receiver`, entry `src/anchor-webhook-receiver-entry.ts`) at `https://anchor-webhooks.example.com/webhooks/anchor`. This service has zero internal state and one job: accept the unauthenticated POST and forward it to the main `agent-service` Connect-RPC ingress with a Google-issued OIDC bearer (audience = upstream URL from `ANCHOR_WEBHOOK_UPSTREAM_URL`). The verbatim raw body plus `Anchor-Signature` and `Anchor-Timestamp` headers are forwarded — no re-signing — so HMAC verification happens against bytes Anchor actually signed.

**Per-tenant signing secret.** Each tenant who connects an Anchor Browser connector gets their own webhook automatically registered on their Anchor account via `attachAnchorWebhookToCredential` (`liftoff-connector-service/src/oauth/anchor-webhook-registration.ts`, invoked from `oauth/apikey-router.ts` immediately after `storeCredentials`). Anchor returns `{id, secret}` and we merge `{webhook_secret, webhook_id}` into the credential blob's `extraFields`. There is **no env-wide `ANCHOR_WEBHOOK_SECRET`** — that earlier design was reverted in `liftoff-infrastructure-gcp@e1de0b1` ("drop env-wide anchor-webhook-secret resources").

**HMAC verification (per-envelope tenant resolution).** `agent-service`'s `anchorWebhookRouter` does NOT pre-know the secret. It:
1. Parses the envelope JSON without verifying.
2. Pulls `data.session_id` and looks up `web_sessions WHERE vendor_session_id = $1 LIMIT 1` to map to a tenant (`anchor-webhook-secret-resolver.ts`).
3. Calls `getWebToolCredential(tenantId, 'anchor_browser')` and reads `cred.extra.webhook_secret`.
4. Computes HMAC-SHA256 over `v0:<timestamp>:<rawBody>`, compares against the `v1=<hex>` value in `Anchor-Signature` using `crypto.timingSafeEqual`. Mismatched-length / missing-session / missing-secret all return 401.

**Dedupe + dispatch.** Verified envelopes INSERT into `anchor_webhook_events` (PK on envelope `id`); a duplicate envelope id collides and the handler returns 204 without further work. Envelopes are ACK'd with HTTP 204 within Anchor's 10s timeout; payload dispatch runs asynchronously after the response.

**Webhook envelope shape.** Anchor's `data.*` fields are **snake_case** (verified by capturing a real delivery): `intervention.requested` carries `{ session_id, request_id, message, input_type, fields, live_view_url }`. **Do not assume camelCase** — Anchor's SDK shape suggests `requestId`/`inputType`, but the over-the-wire webhook envelope uses snake_case.

**Supported event types:** `intervention.requested` → routed through `insertClarificationRow` with `source: 'anchor_intervention'`, `vendor_request_id` set from `data.request_id`, `question` set from `data.message`; posts as an assistant message + `/review` queue card. `intervention.resolved` → inline UPDATE `agent_scheduled_invocations SET status='fired' WHERE vendor_request_id = $1 AND status IN ('pending','resume_inflight')` (idempotent safety net for envelopes that arrive after we drove resolution ourselves via `respond-to-human-intervention`). `session.completed` / `session.failed` → `markClosed` + `SESSION_CLOSED` emit on the in-process events bus. `identity.*`, `task.*`, `session.recording.ready` are recorded in `anchor_webhook_events` for audit but not otherwise consumed.

**Disconnect cleanup.** When the tenant disconnects the connector, `crud/router.ts` calls `unregisterAnchorWebhook(apiKey, webhookId)` to remove the webhook from Anchor's side.

### Cross-Service Authentication

- Tenant Runtime authenticates to Platform Backend using `TENANT_RUNTIME_SERVICE_TOKEN` (set via Cloud Build `gcloud run services update` step)
- Platform Backend validates the token on incoming requests from Tenant Runtime
- Platform Backend service account authenticates to tenant Secret Managers via cross-project IAM

### Secrets Provisioning Flow

**Dedicated tier** (enterprise): When provisioned, `populateTenantSecrets()` copies shared secrets to the tenant's own Secret Manager project:

```
Tenant provisioned (enterprise)
            │
            ▼
    populateTenantSecrets()
    ├── GOOGLE_CLIENT_ID
    ├── GOOGLE_CLIENT_SECRET
    ├── OPENAI_API_KEY
    └── (other shared secrets)
            │
            ▼
    Written to tenant's own Secret Manager
```

**Shared tier** (standard): Secrets are stored in the shared runtime project with tenant-prefixed names:

```
Connector OAuth callback (shared tier)
            │
            ▼
    getSecretProject(tenant) -> SHARED_RUNTIME_PROJECT
    getSecretName(tenantId, connectorId, 'shared') -> tenant-{id}-connector-{connectorId}
            │
            ▼
    Written to shared project's Secret Manager
    (getTenantSecret enforces naming prefix)
```

Note: The platform backend loads its own operational secrets via in-process `loadSecretsToEnv()` at startup (no `--set-secrets` Cloud Run bindings). Tenant connector credentials are managed separately via the functions above.

---

## Observability

### Logging

- **Application logs**: Structured JSON to Cloud Logging
- **Audit logs**: Immutable records in tenant database + Cloud Logging
- **Error aggregation**: Cloud Error Reporting

### Audit Log Dual-Write

The Tenant Runtime's `insertAuditLog` mirrors every audit entry to the Platform Backend's `agent_audit_logs` table via `POST /api/agent-audit-logs` (fire-and-forget, service-auth). This makes external agent calls and per-tool-call rows visible on the /activity page in the dashboard without requiring cross-service queries at read time. The platform copy is the source of truth for the Insights report's `audit-logs-provider`.

### Unified Workspace Audit Log

`/dashboard/settings/workspace` → Audit Logs surfaces a single chronological feed of every human-initiated action in the workspace — needed for SOC 2 / ISO 27001 / HIPAA evidence. The implementation lives at `src/audit-log/` and the table below is the canonical map of which producer writes which workspace event into which physical table.

| Source table | Time column | Producer pattern | Workspace events |
|---|---|---|---|
| `tenant_member_audit` | `created_at` | Direct INSERT from `tenant-members/repository.ts` `createAuditEntry()` (legacy table, kept for invite/role/membership churn) | `member.*`, `invitation.*`, role changes |
| `audit_log` (`user_id IS NOT NULL`, `deleted_at IS NULL`) | `timestamp` | `logAudit(action, ctx, details)` buffered batch insert (`infrastructure/logging.ts`). EVERY handler that fires `logAudit` must build `ctx` via `auditCtx(req)` from `infrastructure/audit-context.ts` — the firebase UID on `req.ctx.userId` is NOT a valid UUID and the buffered flush's `validateUuid()` would NULL it out | `account.*`, `tenant.*`, `subscription.*`, `compliance.*`, `passkey.*`, `knowledge.*`, `mcp_server.*`, `external_agent.*`, `tunnel.*`, `internal_agent.*`, `webhook.*`, `agent.slack_install_*`, `audit.*`, plus Phase 3 `account.password_changed`/`mfa_*` and `activity.*` |
| `internal_agent_audit` (`actor_id IS NOT NULL`) | `created_at` | Direct INSERT from `internal-agents/service.ts` on agent CRUD. Doubly-written alongside `audit_log` `internal_agent.*` events — the unified read deduplicates pairs at the same second, preferring the richer `audit_log` row | `agent.created`/`updated`/`deleted`/`status_changed` |
| `agent_chat_messages` (`role='user'`) | `created_at` | Chat persistence path | `chat.message_sent` (synthesized; `new_state` carries thread + first 500 chars of content) |
| `agent_audit_logs` (`triggered_by LIKE 'human:%'`) | `created_at` | `/review` page approve/reject/correction triggers; SUBSTRING extracts the accountId from `human:<uuid>` | correction request / approve / reject |
| `event_deliveries` | `received_at` | Inbound-webhook pipeline (`event-sources/inbound-router.ts`) | `webhook.delivery_<status>` (synthesized; actor_id always NULL — actor is the external system, identified via `new_state.sourceName` / `new_state.sourceId`) |

**Endpoint** — `GET /api/audit/:tenantId/events?startDate=&endDate=&cursor=&limit=`. Owner/admin only via `tenantAuthMiddleware('viewAuditLogs')`. Date range hard-capped at 90 days; `endDate > now` is clamped silently (not rejected — the legacy endpoint threw a 400 here). Per-page work is bounded at `6 × (limit + 1)` row reads via per-source `LIMIT` then a final UNION + outer LIMIT.

**Pagination correctness** — outer ORDER is `(occurred_at DESC, source ASC, row_id DESC)`. The cursor predicate per source is **three-way**:
- matching source: tuple `(timeCol, idCol::text) < (cursorTs, cursorRowId)` — strict.
- source alphabetically AFTER cursor source: `timeCol <= cursorTs` — inclusive (those rows weren't shown on the prior page).
- source alphabetically BEFORE cursor source: `timeCol < cursorTs` — strict (those rows were shown on the prior page).

This three-way scheme prevents the duplicate-row class of bugs at timestamp collisions across sources. Service-layer `hasMore` reads the repository's `rawCount` (pre-dedup row count) not `rows.length`, so the dedup of `internal_agent.*` pairs never masks real pagination state.

**CSV export** — the React UI fetches every page, builds the CSV, then POSTs `/api/audit/:tenantId/events/export-completed` with `{ startDate, endDate, totalRows }`. The endpoint emits an `audit.csv_downloaded` row so the *next* download includes the prior export in the audit trail. Read and export have separate rate limiters (`auditReadLimiter` 10/min vs `auditExportLimiter` 30/min per tenant).

**Cross-service producers** — `liftoff-connector-service` (connector connect/reauth/apikey/keypair flows) and the platform-backend `billing-proxy.ts` (user-initiated billing mutations on a fixed allowlist of paths derived from `liftoff-billing/src/billing-accounts-router.ts`) publish `audit.platform_event` envelopes on the shared `control-plane-events-{env}` topic. The shared `handleAuditPlatformEvent` helper in `src/events/subscriber.ts` unwraps them and writes directly into `audit_log` via `insertAuditLogDirect`. Subscriber drops messages with no `userId` (system/cron paths cannot be attributed). The bridge envelope shape is the `AuditPlatformEventPayload` interface in `src/events/types.ts`.

**Phase 3 client-asserted events** — `POST /api/audit/security-events` (password change, MFA enroll/disable, etc.) and `POST /api/audit/activity-events` (filter / search / details_viewed on /activity) accept Firebase-authenticated user assertions. Both accept optional `tenantId` in the body (verified via `verifyAccountInTenant`) so multi-tenant users get correct attribution; without it the audit is attributed to the user's primary (oldest-joined) tenant.

**Why `auditCtx` matters** — `authMiddleware` sets `req.ctx.userId = decodedToken.uid` (the firebase UID — 28-char alphanumeric, NOT a UUID). The buffered audit flush runs `validateUuid` on `user_id` before INSERT and NULL-s firebase UIDs. The unified read's `WHERE user_id IS NOT NULL` filter then HIDES those rows from the workspace feed. The `auditCtx(req)` helper substitutes `(req as any).actorAccountId` (set by `tenantAuthMiddleware`) — a real account UUID — so the row survives validation and surfaces in the feed. Routes that can't sit behind `tenantAuthMiddleware` (Phase 3 routers, slack OAuth callback, data-management, billing proxy) use the async `resolveAuditActor(req)` helper which does the firebase UID → accountId lookup via `AccountService.getByFirebaseUid`.

### Tracing

- **Distributed tracing**: OpenTelemetry → Cloud Trace
- **Trace context propagation**: W3C Trace Context headers across services
- **Governance span attributes**: The governance-engine Preflight handler attaches structured span attributes to every call — `governance.hitl_level`, `governance.autonomy`, `governance.escalation`, `governance.tenant_id` — enabling Cloud Trace → BigQuery analysis of governance decision patterns across tenants and HITL levels.

### Monitoring

- **Dashboards**: Cloud Monitoring dashboards per service
- **Alerts**: Error rate, latency, credit exhaustion, Cloud SQL connection utilization
- **Health checks**: `/health` and `/ready` endpoints

### Frontend Product Analytics (PostHog + GA4)

liftoff-react ships GA4 (page-view funnel) and PostHog (product-event funnel) side-by-side. Both libraries are loaded only on `example.com` (or with `?ga=1` / `?ph=1` smoke-test overrides) and only when their respective env vars are present at build time — pre-launch Cloud Run traffic and developer localhost never reach the production analytics properties. Implementation lives in `liftoff-react/src/lib/analytics.ts`.

**Identity contract with platform-backend.** PostHog's `distinct_id` is set to the **backend `account.id`** (UUID), not the Firebase UID. This is the only stable identifier shared across the backend audit log, billing rows, and PostHog — a Firebase UID rotates on account-recovery flows and is not a UUID, so anchoring product analytics to it would fragment user histories on recovery and break joins against backend tables. `AuthContext` calls `identifyUser({ accountId })` immediately after `setAccount(...)` (after the `/api/accounts/me` GET resolves) and `resetAnalytics()` on `signOut` so an anonymous PostHog session starts fresh on the next sign-in.

**Tenant context as super-properties (no `posthog.group()`).** Multi-tenancy is attached via `posthog.register({ tenant_id, tenant_role })` from `AuthContext.updateTenantContext` — fired after the workspace list resolves and after every `switchTenant` / `refreshTenants`. This keeps the PostHog free tier viable (Groups is a paid feature) while still giving every event a per-tenant slice for funnels. Backend events that need cross-correlation with PostHog should join on `account_id` (= PostHog `distinct_id`) and `tenant_id` (= PostHog `tenant_id` super-property).

**Typed event registry.** Event names + payload shapes live in `liftoff-react/src/lib/analytics-events.ts` as a discriminated union. The `track<E>(name, props)` helper is strongly typed against this registry so an unknown event name or wrong-shape payload is a compile-time error. The registry is the single source of truth for what PostHog will receive — there is intentionally no schema enforcement on PostHog's side. Pageviews are forwarded manually from `ScrollToTop` (`capture_pageview: false` in the PostHog config) so SPA route changes capture exactly once across both GA4 and PostHog.

**Session recording is disabled** (`disable_session_recording: true`). The product surfaces too much PII (SSN/EIN/health) to safely record without redaction work that has not been done — re-enable only after a screen-text classifier and an explicit per-tenant opt-in are wired.

---

## Disaster Recovery

### Backup Strategy

- **Database**: Automated daily backups with 7-day retention, point-in-time recovery
- **Secrets**: Secret Manager versioning
- **Configuration**: Terraform state in GCS with versioning

### Restore Procedures

- **Tenant database restore**: Per-tenant granularity
- **Platform database restore**: Full platform recovery
- **Quarterly restore drills**: Automated testing via `restore-drill` module

See: Disaster Recovery Runbook

---
