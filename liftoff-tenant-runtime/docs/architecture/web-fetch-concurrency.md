# Web-Fetch Concurrency & Rate Limiting

Status: Implemented (Tier A + Tier B of the web-fetch concurrency plan).

## Why this exists

Seven vendor fetch / search / browser backends — WebClaw, Firecrawl, Perplexity,
Anchor, Browserbase, Tavily, Exa — each with vendor-imposed caps on concurrent
in-flight requests and requests-per-hour we may consume. Perplexity leads the
static-fetch chain on tool-invocation cost (fetch_url tool: $0.0005 per call;
Agent API LLM tokens are added on top — the exact billed amount is read from
`usage.cost.total_cost` on every response, never approximated, so the OU
ledger stays accurate per call). Search API is a flat $0.005 per call.
Tavily sits second in the no-JS fetch chain and the research chain — paygo
at $0.008/credit (basic /search = 1 credit, basic /extract = 0.2 credits/URL),
with `usage.credits` read off every response so per-call cost is authoritative.
Firecrawl and webclaw are the cheap-tier HTML/markdown fallbacks; Anchor and
Browserbase are the full-browser tier reserved for true interactive automation.
Perplexity also adds three new agent tools — `web_people_search`,
`web_finance_search`, and `web_deep_research` — none of which exist on the
other vendors. Tavily implements `fetch` + `research` only; it has no
schema-guided extraction primitive and is omitted from the extract chain
(same posture as Perplexity).
Going past either ceiling returns a vendor-side 429 that hurts the requesting
tenant AND the next tenant whose request lands in the same minute.

Liftoff itself does NOT impose any per-tenant or per-agent cap on web-tool
usage — usage is revenue. The admission layer exists ONLY to stay under the
vendor-side limits and, when the vendor pool is the binding constraint, to
share that capacity fairly across tenants.

## Exact-cost capture (OU billing invariant)

Every billable web-tool call records the **authoritative billed amount** to
`usage_events.metadata.cost_micros` — never a placeholder, never an estimate.
The platform-backend cost-attribution pipeline reads that field unchanged and
debits the tenant's operating-unit ledger from it, so any approximation here
would compound directly into customer-facing OU billing drift.

| Vendor | Tool | Source of `cost_micros` |
|---|---|---|
| Perplexity | `fetch` (`/v1/agent` + `fetch_url`) | `usage.cost.total_cost` from the Agent API response — captures LLM tokens + tool cost together |
| Perplexity | `research` (`/search`) | Flat $0.005 — published contract price; the Search API returns no cost field because pricing is flat-rate |
| Perplexity | `peopleSearch` / `financeSearch` | `usage.cost.total_cost` |
| Perplexity | `deepResearch` (async chat completions) | `completion.usage.cost.total_cost` from the COMPLETED async response |
| Anchor | `identityCreate` / `createProfileFromSession` | `GET /v1/billing.credits_used` delta × $0.10/credit. Process-local mutex serializes before/after snapshots so concurrent identity/profile ops within a replica don't interleave their billing windows |
| Anchor | `fetch` (stateless Web Unlocker, session-based) / `extract` / `task` | `$0.01` (per-browser, when new) + (actual elapsed wall-clock ms / 3.6M) × `$0.05` (per-browser-hour, pro-rated). The ephemeral or session browser's lifetime equals the measured elapsed window |
| Webclaw / Firecrawl / Browserbase | (existing) | Vendor-published per-call constants — unchanged |
| Tavily | `fetch` (`/extract`) / `research` (`/search`) | `usage.credits` × `USD_PER_CREDIT` (paygo $0.008). Always present in the response when `include_usage: true` is set — and we always set it. Quota poller alerts at 80% of the 1,000-credit/mo Researcher free allotment so operators see paid usage starting before the spend monitor catches the $ side |
| Exa | `fetch` (`/contents`) / `research` (`/answer`) | `costDollars.total` from response — exact billed amount (Perplexity precedent). Captured directly into `costMicros = round(total * 1_000_000)`. Exa publishes no usage endpoint, so vendor MTD spend is tracked end-to-end via PB `vendor-spend-monitor` consuming `cost_attribution_events` |

Two fail-loud safeguards prevent silent under-billing:

- **`PerplexityError(422)`** when an Agent API or chat-completions response
  is missing `usage.cost.total_cost`, has non-numeric / negative `total_cost`,
  or reports non-USD currency. Throws into the handler so operators see the
  contract break immediately. Router treats 422 as healthy non-transient so
  vendor health doesn't trip on a billing-shape regression.
- **`AnchorError(422)`** when `GET /v1/billing` is missing `credits_used` or
  the period rolls over mid-snapshot (negative delta clamped to 0). Same
  router treatment.
- **`ExaError(422)`** when an Exa response is missing `costDollars.total`,
  has a non-numeric `total`, or reports a negative `total`. Same router
  treatment — billing-shape regression surfaces in agent logs without
  marking Exa unhealthy for 60s.

## What the design IS NOT

- It is NOT a quota system. Tenants are never told they hit a limit.
- It is NOT a hard rejection path. Saturated pools cause a brief cooperative
  wait, then a soft `transient: true` signal that the agent runner auto-
  retries once before the LLM ever sees a failure.
- It does NOT escalate the chain on busy. Vendor escalation only happens on
  vendor *health* failures (5xx, timeout) — capacity contention stays
  pinned to the originally-chosen vendor.

## The five components

| File | Role |
|------|------|
| `concurrency-limits.ts` | Admission. `acquireInflightSlot(vendor, tenant, agent, tool)` inserts a row in `web_inflight_requests` under per-vendor `pg_advisory_xact_lock`, runs a fair-share tiebreak, and returns a `release()` handle. Throws `VendorPoolBusy` only after a 5s cooperative wait. |
| `notifier.ts` | Wake. One dedicated `pg.Client` per replica multiplexed across LISTEN channels. Today only `web_fetch_release` is subscribed; future subsystems add channels via `subscribeToPgChannel(name, handler)` and share the same connection. Every `release()` runs `pg_notify('web_fetch_release', vendor)`; waiters wake in milliseconds via an in-memory `EventEmitter`. Auto-reconnect on disconnect; re-LISTENs every channel on reconnect. |
| `token-bucket.ts` | Rate. `consumeToken(tenant, vendor, tool)` is a single atomic UPSERT that refills based on `last_refilled_at` and only commits if ≥1 token remains. Per-tenant-per-vendor-per-tool key in `token_buckets`. |
| `router.ts` | Single chokepoint. `runChain` performs admission → token → invoke → release-in-finally. `admitSingleVendor` is the equivalent for tools that don't escalate. |
| `janitor.ts` | Sweep. Every 60s: delete expired inflight (with `pg_notify` so waiters wake), delete expired waiters, close expired sessions, drop 24h-stale token buckets. |
| `limits-config.ts` | Tuning. Reads numeric overrides from the sentinel-row feature-flag JSONB at `<key>_value` suffix. 10s in-memory cache, invalidated immediately by `events/subscriber.ts` after every sentinel write — operator PUTs take effect at event-delivery latency (sub-second), not the cache TTL. |

## Tables

| Table | Purpose | Lifecycle |
|-------|---------|-----------|
| `web_inflight_requests` | One row per slot currently held. `(vendor, tenant_id, agent_id, tool_name, expires_at)`. | Inserted by `acquireInflightSlot`, deleted by `release()` or janitor. |
| `web_waiters` | One row per request currently waiting for a slot. Used in the fair-share tiebreak so other replicas see the queue. | Inserted on wait, deleted on admission or timeout; expires after wait-budget + 30s as a crash-safety net. |
| `token_buckets` | Per `(tenant:vendor:tool)` token bucket state. | Lazily inserted on first call, refilled per UPSERT, dropped by janitor after 24h idle. |

Schema lives in migrations 217 (`web_inflight_requests` + `web_waiters`) and
218 (`token_buckets`). Migration 219 tightens the `web_sessions.expires_at`
default from 1h to 10min and back-tightens open sessions.

## Fair-share tiebreak

When two tenants T1 (holding N inflight) and T2 (holding M inflight) both
have requests waiting, the next slot to free goes to whichever waiter's
tenant currently holds **fewer** inflight rows for that vendor. With one
waiter it's a no-op; with N waiters it strictly alternates by load. This
runs inside the per-vendor advisory lock so two replicas can't both admit
the same slot. There is no per-tenant cap — a tenant alone can hold the
entire vendor pool.

## What busy looks like to the agent

1. `acquireInflightSlot` waits up to 5s. If a slot opens, the tenant with
   the lowest inflight count wins under the lock.
2. If 5s elapses with no opening, `VendorPoolBusy` (a soft signal) is thrown.
3. The handler translates this to `{ success: false, transient: true,
   retryAfterMs }` — NOT a `success: false` with quota prose.
4. `runToolWithTransientRetry` in the agent runner (`mcp-server.ts` and
   `agent-execution/service.ts`) sleeps `min(retryAfterMs, 3000)ms` then
   invokes the tool once more.
5. If the second attempt also fails transiently, the result returns to the
   LLM with `transient` stripped — the model sees a normal failure, not a
   retry prompt it might misinterpret.

Every retry decision emits a structured `web_fetch_transient_retry` log
line tagged with `tool_name` and `phase`. Operators can build a Cloud
Logging metric on retry rate; a sustained spike in
`phase="second_attempt_failed"` is the early procurement signal — more
vendor capacity is needed before structural saturation surfaces to users.

The LLM therefore only sees "busy" prose when TWO sequential 5s-bounded waits
both timed out — i.e. ~10s of structurally over-saturated vendor capacity,
which is a procurement signal (more vendor capacity), not a runtime signal
(retry harder).

## Tuning without redeploy

The PB `feature_flags.value_num` column flows through the outbox to the TR
`cached_feature_flags` sentinel row as `<key>_value`. To raise an Anchor
global cap from 25 to 40 in dev:

```bash
curl -X PUT "https://api-dev.example.com/api/internal/feature-flags/key/web_fetch_anchor_max_concurrent_global" \
  -H "x-service-auth: $TOKEN" -H 'content-type: application/json' \
  -d '{"value_num":40}'
```

(For numeric-only tunables, `enabled` defaults to `true` per ADR-018 — no
need to send it explicitly. First-time creates still need `name` and
`description`.)

The runtime subscriber invalidates `limits-config.ts`' in-memory cache
immediately after writing the sentinel row, so every replica picks up the
new cap at event-delivery latency (sub-second under healthy Pub/Sub), not
the 10s cache TTL. The TTL exists as a fallback for the missed-event case.

The same mechanism tunes rate buckets via
`web_fetch_<vendor>_rate_per_hour_<tool>_value`.

## Why LISTEN/NOTIFY instead of polling

A polling design at 4Hz over N waiters costs N×4 SELECTs per second
regardless of release activity. LISTEN/NOTIFY costs ≈ release rate (single-
digit per second at vendor cap). A 1s fallback tick guards the rare
notifier-disconnect window so a waiter still attempts `tryAdmit` at least
once per second under failure. This was the gap-#8 closure during planning.

## Session lifecycle

Sessions are stateful on Anchor (Browserbase too, partially). The default
idle TTL is 10 minutes (migration 219, plan gap-closure for "open sessions
counted as concurrency"); the janitor closes anything past `expires_at`.

`web_session_close` lets an agent release a session early. It does NOT
admit a slot (closing must never wait). `web_task` auto-closes sessions it
created itself — `anchor.task()` returns `createdSessionLocally: true` when
its `ensureSession` produced a new row, and the handler's `finally` block
calls `handleWebSessionClose`.

Sessions the caller passed in (the agent's lifecycle) are never auto-closed
— it's the agent's responsibility to call `web_session_close` when done.

## Deep-research durability

`web_deep_research` is the only web tool with a multi-minute upstream call
(Perplexity's `/async/chat/completions` typically resolves in 20–40 min,
hard-bounded by the 60-min client ceiling). A naive emit-on-completion model
under-bills the customer in three failure modes documented at planning time:
408 ceiling hit + Perplexity finishes after, hook-publish exhaustion, and
process crash mid-poll. Sub-minute freshness in every failure mode is the
correctness requirement.

The durability stack (ADR-021
in liftoff-platform-backend; migration `233_deep_research_registry_and_outbox.sql`
in this repo) is three layers:

1. **Registry** (`deep_research_submissions`) — source-of-truth row written
   immediately after the Perplexity submit succeeds, before the pre-charge
   hook fires. Captures `tenant_id`, `agent_id`, `submission_id`,
   `reasoning_effort`, `estimate_cost_micros`, plus the lifecycle columns
   (`final_status`, `final_cost_micros`, `finalized_at`). Hooks are still
   the optimistic fast path: when COMPLETED arrives, the hook publishes the
   delta event AND calls `finalizeSubmission` so the reconciler skips the
   row on the next pass.

2. **Outbox drainer** (`deep-research-outbox.ts`, 10s cadence) — when
   `publishWebToolEvent` returns false (Pub/Sub down, transient PB outage),
   the payload lands in `deep_research_outbox` keyed by
   `UNIQUE (deep_research_id, kind)`. The drainer retries publish with
   exponential backoff (10s → 20s → 40s … capped at 1h, up to 20 attempts
   ≈ 57h before logging `deep_research_outbox_giving_up` for manual replay).
   Overlap-guarded so a slow drain pass doesn't double-fire.

3. **Reconciler** (`deep-research-reconciler.ts`, 60s cadence with adaptive
   poll spacing — 60s/120s/300s/1h by submission age) — polls Perplexity
   for any registry row without a `final_status` and emits BOTH a
   pre-charge AND a delta event with the same idempotency keys the hook
   uses (`${deep_research_id}` and `${deep_research_id}/delta`). PB
   ingester dedupes by `metadata.idempotency_key`, so hook-then-reconciler
   races collapse to one row per (deep_research_id, kind). After 24h still
   IN_PROGRESS the reconciler marks the row `abandoned` and emits a full
   refund.

A `hook_active_until` heartbeat column lets the reconciler defer to a
healthy hook — refreshed by `markHookActive(deepResearchId, 30)` on every
5s Perplexity poll inside `perplexity-client.ts:deepResearch()`. Rows with
`hook_active_until > NOW()` are skipped by the reconciler's selection
predicate. When the hook stops (process crash, 408 ceiling, graceful exit),
the column goes stale within 30s and the reconciler picks up the row at
the next 60s cycle.

Multi-replica behaviour: no `SELECT FOR UPDATE SKIP LOCKED`. Holding a row
lock across the per-row Perplexity poll (~5s) + Pub/Sub publish (~1s)
would (a) deadlock with the registry's pool-based helpers and (b) hold
the outer tx open across a network call. Instead, two replicas may pick
the same row and do duplicate work in parallel — Perplexity polls are
free (3000–6000 RPM cap, we use <2 RPS), registry writes are idempotent
(`ON CONFLICT` / `WHERE final_status IS NULL`), and publishes dedupe at
the PB ingester layer. The `hook_active_until` skip predicate further
bounds the cost — in steady state, most rows have an active hook.

Boot wiring lives in `src/index.ts`: both loops start inside the
`ownsAgentRoutes` block (so agent-service / monolith run them;
tool-gateway-service / coordinator-service do not) and `.unref()` so they
don't keep the process alive during shutdown. The existing SIGTERM
handler awaits `stopOutboxDrainer()` + `stopReconciler()` (5s bounded
each) before closing the HTTP server, so in-flight publishes complete
inside Cloud Run's 10s grace window.

Env-disable kill switches (used during rollback per the runbook in
liftoff-platform-backend):
- `DEEP_RESEARCH_RECONCILER_DISABLED=true` — disables the reconciler
- `DEEP_RESEARCH_OUTBOX_DRAINER_DISABLED=true` — disables the drainer

Both are no-ops when set; existing rows in the registry/outbox remain
durable until the loops are re-enabled.
