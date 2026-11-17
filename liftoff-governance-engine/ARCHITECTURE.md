# liftoff-governance-engine — Architecture

The governance engine is the policy enforcement point for the entire Liftoff platform. Every tool call originated by an agent runs through this service twice — once before execution (`Preflight` + `Authorize`) and once after (`Record`). Every operator action that affects agent behavior (approving a HITL gate, flipping a kill switch, adjusting a credit budget) is an RPC here. Every audit-trail entry the dashboard shows came from this service's ledgers.

## Responsibility boundary

```
Agent tool-call path                       Operator path
───────────────────────────                ─────────────────────────

tenant-runtime                             platform-backend
(agent-service,                            /api/governance/* proxy
 tool-gateway-service)                                │
        │                                             ▼
        │  Preflight (start of invocation)    ┌─────────────────┐
        │  Authorize (per tool call)          │                 │
        │  Record    (after tool call)        │  ListApprovals  │
        ▼                                     │  (dashboard)    │
┌──────────────────────────────────────────┐  └────────┬────────┘
│          liftoff-governance-engine       │           │
│                                          │           │
│  ┌────────────────────────────────────┐  │           │
│  │ rpc/router.ts (Connect-RPC)        │◀─┼───────────┘
│  └────────────────────────────────────┘  │
│            │          │         │        │
│            ▼          ▼         ▼        │
│      admission    hitl-enforce  action-  │
│      (credits,    (levels,      ledger   │
│       rate lim,   allowlists)            │
│       kill sw)                 usage-    │
│                                ledger    │
│                                          │
│                                audit/    │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ events/ (Pub/Sub publisher)        │──┼──▶ governance-events-${env}
│  └────────────────────────────────────┘  │      (tenant runtimes
│                                          │       subscribe & invalidate
└──────────────────┬───────────────────────┘       cached preflight)
                   ▼
          ┌─────────────────────┐
          │   governance-pg     │
          │   (Cloud SQL)       │
          │                     │
          │ hitl_approval_*     │
          │ actions             │
          │ usage_events        │
          │ audit_logs          │
          │ action_allowlists   │
          │ kill_switches       │
          │ cached_entitlements │
          │ rate_limit_configs  │
          └─────────────────────┘
```

## Request lifecycle

### Preflight (once per agent invocation)

Triggered by `agent-service` at the start of every agent invocation.

1. Resolve the tenant's effective HITL level, kill-switch snapshot, allowlists, and admission rules.
2. Produce a short-lived HMAC-signed **preflight token** that binds all four to this specific invocation. The caller caches the result for 30 s.
3. Return admission status (`ok`, `blocked`, `rate_limited`, etc.) and the token.

Callers treat the preflight result as immutable for the invocation window. Mid-invocation policy changes propagate via a Pub/Sub push that evicts caller caches; the next tool call re-preflights.

### Authorize (per tool call, target p99 < 10 ms)

Triggered by `tool-gateway-service` immediately before every tool dispatch.

1. Verify the preflight token HMAC and expiry. Reject if either fails.
2. Check the action-ledger for an idempotent duplicate of this tool call; if found, return the earlier decision.
3. Walk the admission → HITL → conflict rule chain:
   - Admission (credits, rate limits, kill switches) — BLOCK if any fail.
   - HITL — a **risk-class-aware** gate keyed on the action *name* (this RPC has no tool definitions), not a flat level check. Three classes:
     - **Consequential** (merge / land ops across GitHub and GitLab — `merge_pull_request`, `accept_merge_request`, … — plus every super-destructive operation) require a human at **every** autonomy level (1–5).
     - **Reversible collaboration writes** (open a PR/MR, post a review comment) proceed once autonomy reaches `balanced` (level ≥ 3); they still gate at the restrictive levels 1–2.
     - **Every other write** keeps the original levels-1–3 gate.

     A tenant allowlist entry short-circuits the gate; otherwise HITL_REQUIRED if approval is needed. The consequential class closes a prior gap where levels 4–5 skipped the per-action gate entirely, letting a fully-autonomous agent's merge-to-main land unreviewed. The taxonomy lives in `src/hitl-enforcement/risk-classes.ts` and is shared with the batch `checkHitlGate()` so the operator dashboard preview matches the runtime decision.
   - Conflict detection (overlapping pending actions) — CONFLICT if collision.
4. Return the decision with evidence (rule that matched, HITL request id if created).

Fail-closed: unreachable engine or any internal error → callers BLOCK the tool call. No silent pass-through. Additionally, `resolveHitlLevel()` catches DB/cache errors and explicitly returns `1` — governance never silently defaults to a permissive level under partial infrastructure failure. This is a deliberate safety invariant, not an accidental behavior.

**OTel span attributes.** After resolving `hitlLevel` and `oversight`, the Preflight handler attaches the following OpenTelemetry span attributes: `governance.hitl_level`, `governance.autonomy`, `governance.escalation`, `governance.tenant_id`. These flow into Cloud Trace → BigQuery, enabling analysis of governance decision patterns over time.

### Record (after every tool call)

Fan-out write to three ledgers via `Promise.allSettled` (lenient: one leg failing doesn't roll back the others):

1. **action-ledger** — `{ tool, params_hash, result_hash, ts, agent_id, invocation_id }`. Immutable, partitioned by month, retained 7 years.
2. **usage-ledger** — `{ cost_credits, vendor, tool, ts }`. Feeds billing reconciliation.
3. **audit-log** — `{ event, actor, target, evidence_blob, ts }`. Used by the compliance dashboard.

Returns `202 Accepted` immediately. Clients do not wait on ledger durability.

### ListApprovals

Paginated read of `hitl_approval_requests` filtered by tenant + status. Powers the HITL dashboard and the mobile approval queue. Approval decisions (approve / reject / escalate) arrive back via the platform-backend `/api/governance/*` proxy as mutation RPCs.

### Debug endpoints (`src/debug/router.ts`)

A REST module mounted at `/api/governance`, protected by `X-Service-Auth`. Provides two endpoints for diagnostics and integration testing:

- `GET /api/governance/tenant/:tenantId/health` — reads cache freshness, effective HITL level, pending approvals, rate limit, and last audit entry without triggering any enforcement logic.
- `POST /api/governance/tenant/:tenantId/simulate` — dry-runs a gate decision for a given set of tool calls. Accepts an optional `oversightOverride` that merges on top of the live cache, enabling testing of specific configurations without touching production state. Internally calls `checkHitlGate()` with `{ dryRun: true }`, which suppresses the `insertAuditLog()` calls that would normally fire at levels 4 and 5 (auto-elevation audit entries).

Neither endpoint writes to the ledgers or emits Pub/Sub events.

## Kill-switch propagation

When an operator flips a kill switch:

1. HTTP mutation hits the engine via platform-backend proxy.
2. Engine updates `kill_switches` table inside a transaction.
3. On commit, publishes a `GovernanceEvent { type: KILL_SWITCH_CHANGED, scope, tenant_id }` to the `governance-events-${env}` Pub/Sub topic.
4. Tenant runtimes subscribe to the topic; their subscriber evicts the cached preflight token for the affected scope.
5. Next tool call in that scope re-Preflights against the new state.

End-to-end propagation is typically under five seconds. This is the reason Preflight caches are short-lived — a stale cache is bounded by the eviction path plus the 30-s TTL floor.

## Caller rollout flag

Callers consult `GOVERNANCE_SERVICE_ENABLED` to choose a mode independently:

| Mode | Behavior |
|------|----------|
| `off` | Local in-process rules; engine not called. |
| `shadow` | Both paths run. Local result is served; engine result is logged. Mismatches surface as Cloud Monitoring alerts. |
| `on` | Engine is authoritative. Unreachable engine = BLOCK. |

Shadow mode exists so each tenant runtime can validate parity before cutting traffic over. Once `on`, there is no local fallback.

## Data model

`governance-pg` is a dedicated Cloud SQL Postgres instance in the platform-control project (one per environment). The connection uses private IP via the platform-control VPC connector.

### Core tables

| Table | Purpose | Retention |
|-------|---------|-----------|
| `hitl_approval_requests` | Pending + resolved HITL approvals with decision, approver, evidence. | Forever |
| `actions` | Every tool-call decision record (the action ledger). Partitioned by month. | 7 years |
| `usage_events` | Credit consumption per tool call (the usage ledger); feeds Stripe meter reconciliation. Partitioned by month. | 7 years |
| `audit_logs` | Event stream of all governance actions (approvals, kill-switch flips, rule edits). | 7 years |
| `action_allowlists` | Per-tenant tool/category allowlists. | Forever |
| `kill_switches` | Active kill switches (tenant-wide, agent-scoped, tool-scoped). | Forever |
| `cached_entitlements` | Per-tenant credit budgets, operational status, and admission columns. | Forever |
| `rate_limit_configs` / `rate_limit_buckets` | Per-tenant rate-limit policy and live token buckets. | Forever |
| `credit_cost_model` | Per-tool/category credit pricing used in admission and usage costing. | Forever |

There is no single `admission_config` table; admission inputs are spread across `cached_entitlements`, `rate_limit_configs`, `kill_switches`, and `credit_cost_model`.

Partitioned tables use monthly partitions created by `src/partitions/` — the provisioner job runs daily and pre-creates six months ahead.

### Immutability

`actions`, `usage_events`, and `audit_logs` are append-only. Database triggers (`*_immutable`) reject UPDATE and DELETE on non-superuser roles. Historical corrections are made by inserting compensating records, never by mutation. A dedicated migration role with `BYPASSRLS + BYPASSTRIGGER` exists for backfills but is granted only during migration jobs.

## Authentication

Callers present two credentials on every request:

1. `X-Service-Auth: <shared-token>` — the `GOVERNANCE_SERVICE_TOKEN` secret, loaded from Secret Manager at caller startup. Scoped per-environment.
2. `Authorization: Bearer <oidc>` — a Google OIDC token, audience = engine's Cloud Run URL. Validated at the Cloud Run layer via `run.invoker` IAM.

Both layers must pass. The middleware in `src/auth/` rejects requests missing either.

Cross-project callers (tenant runtimes) mint the OIDC token from their own service account and fetch the shared secret from their own Secret Manager (cross-project grant issued by the governance-engine terraform module).

## Performance targets

- **Authorize p99 < 10 ms** under normal load. The hot path avoids database round-trips for cached preflight tokens; only token verification + action-ledger idempotency check touch pg (both index-driven, <2 ms).
- **HTTP/2 keep-alive** — Connect-RPC pools one connection per caller SA, amortizing TLS handshake cost.
- **Record writes** — fire-and-forget via `Promise.allSettled`. Ledger durability is not on the critical path.

Benchmarks under `src/__benchmark__/` run in CI on every push. They validate budgets on Cloud Build's shared runner (noisy) and do not replace the Cloud Monitoring SLO dashboard on deployed Cloud Run.

## Deployment

Single Cloud Run service (`governance-engine`) in `YOUR_GCP_PROJECT`. Uses `--no-allow-unauthenticated`, private Cloud SQL (via VPC connector), `--vpc-egress private-ranges-only`. Cross-project callers reach it at the Cloud Run URL with OIDC tokens.

Migrations run as a Cloud Run Job (`governance-engine-migrate`) before each deploy. Schema lives under `migrations/`; the provisioner jobs for partitions live under `src/partitions/` and run on Cloud Scheduler.

## Related

- Proto definitions: [liftoff-proto](../liftoff-proto) (`liftoff/governance/v1/governance_service.proto`)
- Terraform: [Liftoff-Infrastructure-GCP](../liftoff-infrastructure-gcp) — `terraform/modules/governance-engine/`
- Callers: [liftoff-tenant-runtime](../liftoff-tenant-runtime) (every tool call), [liftoff-platform-backend](../liftoff-platform-backend) (`/api/governance/*` proxy)
