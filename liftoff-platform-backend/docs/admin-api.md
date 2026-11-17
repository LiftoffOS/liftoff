# Admin API reference

Canonical, hand-written reference for `/api/admin/*` on `liftoff-platform-backend`. This is the source of truth for operator-facing endpoints; runbooks link here for shape, not the other way around.

If you change an endpoint's shape, URL, or audit-action name, update this file in the same PR.

## Auth

All endpoints (except the **Public state** group) require:

1. A Firebase ID-token Bearer header (`Authorization: Bearer eyJ...`).
2. The authenticated account must have `accounts.is_platform_admin = TRUE`.

Authentication failure returns `401 {error: "Unauthorized", ...}`; authorization failure returns `403 {error: "Forbidden", ...}`. Both are emitted by `adminAuthMiddleware` ([`src/admin/middleware.ts`](../src/admin/middleware.ts)).

The **Public state** endpoints (`GET /platform/state`, `GET /connectors`, `GET /connectors/:type/state`, `GET /workflow-types`, `GET /workflow-types/:type/state`) bypass admin auth — they are read-only and intended for service-to-service callers without a Firebase identity. The bypass is implemented by `isPublicStateEndpoint` in [`src/admin/router.ts:46`](../src/admin/router.ts).

## Response envelope

### Success

```json
{
  "data": { ... },
  "audit": {
    "actionId": "<uuid>",
    "action": "<domain>.<resource>.<verb>",
    "actor": { "accountId": "<uuid|null>", "email": "<email|null>" },
    "timestamp": "<ISO-8601>"
  },
  "healthCheck": { "ok": true, "issues": [] }
}
```

- `data` — resource-specific payload.
- `audit` — echoes the `admin_action_audit` row written by `logAdminAction` so curl users see the audit trail in the response without a follow-up query. Public read endpoints omit `audit` entirely (no admin identity exists).
- `healthCheck` — present only on state-returning endpoints (`GET /accounts/:accountId/state`, and post-mutation responses on `POST /accounts/:accountId/enterprise-setup`). `ok = true` means no curated inconsistencies were detected; `issues[]` lists any that were. Not present on the other endpoints below.

### Error

```json
{ "error": "<code>", "detail": "<message>", "field": "<name>" }
```

- `error` — short snake_case identifier. Stable; consumers may key on it.
- `detail` — optional human-readable message.
- `field` — optional path to the offending field for Zod shape-validation errors (e.g. `user.email`).

## Audit-action grammar

`<domain>.<resource>.<verb>`. Examples: `tenant.kill_switch.disable`, `account.enterprise_provisioning.create`, `account.cascade_delete`. Rows written under the legacy action names (see [Legacy route and action names](#legacy-route-and-action-names)) keep them by design.

## Request validation

Request shape is validated by Zod schemas via the `validateRequest` middleware ([`src/admin/validate-request.ts`](../src/admin/validate-request.ts)). Schemas live next to each handler or in [`src/admin/zod-helpers.ts`](../src/admin/zod-helpers.ts) (shared fragments). On failure the middleware returns `400 {error: "invalid_request", detail, field}` and emits an `admin.api.validation_failed` log event.

Handlers retain *business-invariant* checks (e.g. "this account has no Stripe customer" → `409 account_has_no_stripe_customer`). Pure shape-validation lives in the middleware, not in handlers.

## 404 catch-all

Any path under `/api/admin/*` that doesn't match a registered route returns `404 {error: "not_found"}` and emits an `admin.api.404_legacy_url` log event ([`src/admin/router.ts:833`](../src/admin/router.ts)). The `admin_api_legacy_url_404` Cloud Logging alert (`liftoff-infrastructure-gcp/terraform/projects/platform-control/main.tf`) keys on this — a spike means a stale runbook is circulating.

---

## Kill switches

Deliberately namespaced under `kill-switch/` for visibility. Idempotent.

### POST `/api/admin/kill-switch/tenant/:tenantId/disable`

Disable a tenant globally (suspends agent execution).

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: [`src/admin/router.ts:65`](../src/admin/router.ts) — `tenantKillSwitchSchema = { params: tenantIdParam }`. `tenantIdParam` at [`src/admin/zod-helpers.ts:12`](../src/admin/zod-helpers.ts) requires `tenantId` to be a UUID.
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  {
    "data": { "status": "disabled", "tenantId": "11111111-1111-1111-1111-111111111111" },
    "audit": {
      "actionId": "audit_abc",
      "action": "tenant.kill_switch.disable",
      "actor": { "accountId": "acct_xyz", "email": "admin@example.com" },
      "timestamp": "2026-05-17T12:34:56.789Z"
    }
  }
  ```
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `invalid_request` | `tenantId` not a UUID |
  | 401 | `Unauthorized` | No Firebase token |
  | 403 | `Forbidden` | Authenticated but not platform admin |
- **Audit action**: `tenant.kill_switch.disable`.

### POST `/api/admin/kill-switch/tenant/:tenantId/enable`

Re-enable a previously disabled tenant.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: [`src/admin/router.ts:65`](../src/admin/router.ts) — `tenantKillSwitchSchema`.
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  {
    "data": { "status": "enabled", "tenantId": "11111111-1111-1111-1111-111111111111" },
    "audit": { "actionId": "...", "action": "tenant.kill_switch.enable", "actor": { ... }, "timestamp": "..." }
  }
  ```
- **Error codes**: 400 `invalid_request`, 401 `Unauthorized`, 403 `Forbidden`.
- **Audit action**: `tenant.kill_switch.enable`.

### POST `/api/admin/kill-switch/connector/:connectorType/disable`

Disable a connector type across all tenants.

This is also the operator's switch for a **platform-provided vendor** (`apify`, `tikhub`, `strale`, `nasdaq`, `gloria`, …): while the row exists, capability search does not offer the vendor, the distiller's prior art does not present its automations as runnable, and the vendor executor refuses a handle minted earlier ([`src/capability-discovery/vendor-gate.ts`](../src/capability-discovery/vendor-gate.ts), read through a 30 s cache). Use it when a vendor account cannot pay — a fixed credit running out, a wallet not yet funded — instead of removing the key; the key stays, and `enable` below puts the vendor back.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: [`src/admin/router.ts:125`](../src/admin/router.ts) — `connectorKillSwitchSchema = { params: connectorTypeParam }`. `connectorTypeParam` at [`src/admin/zod-helpers.ts:18`](../src/admin/zod-helpers.ts) requires `connectorType` length 1–64.
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  {
    "data": {
      "status": "disabled",
      "connector": { "id": "dc_1", "connectorType": "salesforce", "disabledAt": "...", "disabledBy": "admin" }
    },
    "audit": { "action": "connector.kill_switch.disable", ... }
  }
  ```
- **Error codes**: 400 `invalid_request`, 401, 403.
- **Audit action**: `connector.kill_switch.disable`.

### POST `/api/admin/kill-switch/connector/:connectorType/enable`

Re-enable a connector type.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: [`src/admin/router.ts:125`](../src/admin/router.ts) — `connectorKillSwitchSchema`.
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  {
    "data": { "status": "enabled", "connectorType": "salesforce" },
    "audit": { "action": "connector.kill_switch.enable", ... }
  }
  ```
- **Error codes**: 400, 401, 403.
- **Audit action**: `connector.kill_switch.enable`.

### POST `/api/admin/kill-switch/workflow-type/:workflowType/disable`

Disable a workflow type across all tenants.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: [`src/admin/router.ts:185`](../src/admin/router.ts) — `workflowKillSwitchSchema = { params: workflowTypeParam }`. `workflowTypeParam` at [`src/admin/zod-helpers.ts:22`](../src/admin/zod-helpers.ts) requires `workflowType` length 1–64.
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  {
    "data": {
      "status": "disabled",
      "workflowType": { "id": "dwt_1", "workflowType": "data_sync", "disabledAt": "...", "disabledBy": "admin" }
    },
    "audit": { "action": "workflow_type.kill_switch.disable", ... }
  }
  ```
- **Error codes**: 400, 401, 403.
- **Audit action**: `workflow_type.kill_switch.disable`.

### POST `/api/admin/kill-switch/workflow-type/:workflowType/enable`

Re-enable a workflow type.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: [`src/admin/router.ts:185`](../src/admin/router.ts) — `workflowKillSwitchSchema`.
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  {
    "data": { "status": "enabled", "workflowType": "data_sync" },
    "audit": { "action": "workflow_type.kill_switch.enable", ... }
  }
  ```
- **Error codes**: 400, 401, 403.
- **Audit action**: `workflow_type.kill_switch.enable`.

### POST `/api/admin/kill-switch/global/freeze-writes`

Globally freeze all writes (tenant-runtime middleware reads `platform_status.global_writes_frozen`).

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: no body, no params.
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  {
    "data": { "status": "frozen", "platformStatus": { "id": "global", "globalWritesFrozen": true, "updatedAt": "..." } },
    "audit": { "action": "platform.kill_switch.freeze_writes", ... }
  }
  ```
- **Error codes**: 401, 403.
- **Audit action**: `platform.kill_switch.freeze_writes`.

### POST `/api/admin/kill-switch/global/unfreeze-writes`

Globally unfreeze writes.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: no body, no params.
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  {
    "data": { "status": "unfrozen", "platformStatus": { "id": "global", "globalWritesFrozen": false, "updatedAt": "..." } },
    "audit": { "action": "platform.kill_switch.unfreeze_writes", ... }
  }
  ```
- **Error codes**: 401, 403.
- **Audit action**: `platform.kill_switch.unfreeze_writes`.

---

## Public state (read-only, no admin auth)

These bypass `adminAuthMiddleware` (see `isPublicStateEndpoint` at [`src/admin/router.ts:46`](../src/admin/router.ts)) so service-to-service callers without Firebase auth can read platform state. They do not write to `admin_action_audit` and therefore omit the `audit` field from the response envelope.

### GET `/api/admin/platform/state`

Merged replacement for the retired `GET /status` and `GET /check/global-writes-frozen`.

- **Auth**: none (public).
- **Schema**: no body, no params, no query.
- **Success response** (HTTP 200):
  ```json
  {
    "data": {
      "platform": { "id": "global", "globalWritesFrozen": false, "updatedAt": "2026-05-17T..." },
      "globalWritesFrozen": false
    }
  }
  ```
- **Error codes**: 500 on infrastructure failure (DB unavailable).
- **Audit action**: none (no admin identity).

### GET `/api/admin/connectors?state=disabled`

List disabled connectors (replaces `GET /disabled-connectors`).

- **Auth**: none (public).
- **Schema**: [`src/admin/router.ts:312`](../src/admin/router.ts) — `connectorsQuerySchema = { query: z.object({ state: z.enum(['disabled']).optional() }) }`. Only `state=disabled` is accepted today; without filter the same list is returned (the URL signals intent).
- **Success response** (HTTP 200):
  ```json
  {
    "data": {
      "connectors": [
        { "id": "dc_1", "connectorType": "salesforce", "disabledAt": "...", "disabledBy": "admin" }
      ]
    }
  }
  ```
- **Error codes**: 400 `invalid_request` if `state` is provided with a value other than `disabled`.
- **Audit action**: none.

### GET `/api/admin/connectors/:connectorType/state`

State of a single connector (replaces `GET /check/connector/:connectorType`).

- **Auth**: none (public).
- **Schema**: [`src/admin/router.ts:333`](../src/admin/router.ts) — `{ params: connectorTypeParam }` (length 1–64).
- **Success response** (HTTP 200):
  ```json
  { "data": { "connectorType": "salesforce", "disabled": true } }
  ```
- **Error codes**: 400 `invalid_request` for an empty or oversized `connectorType`.
- **Audit action**: none.

### GET `/api/admin/workflow-types?state=disabled`

List disabled workflow types (replaces `GET /disabled-workflow-types`).

- **Auth**: none (public).
- **Schema**: [`src/admin/router.ts:345`](../src/admin/router.ts) — `workflowTypesQuerySchema = { query: z.object({ state: z.enum(['disabled']).optional() }) }`.
- **Success response** (HTTP 200):
  ```json
  {
    "data": {
      "workflowTypes": [
        { "id": "dwt_1", "workflowType": "data_sync", "disabledAt": "...", "disabledBy": "admin" }
      ]
    }
  }
  ```
- **Error codes**: 400 `invalid_request` if `state` value is not `disabled`.
- **Audit action**: none.

### GET `/api/admin/workflow-types/:workflowType/state`

State of a single workflow type (replaces `GET /check/workflow-type/:workflowType`).

- **Auth**: none (public).
- **Schema**: [`src/admin/router.ts:364`](../src/admin/router.ts) — `{ params: workflowTypeParam }` (length 1–64).
- **Success response** (HTTP 200):
  ```json
  { "data": { "workflowType": "data_sync", "disabled": false } }
  ```
- **Error codes**: 400.
- **Audit action**: none.

## Vendor credential cooldowns (read-only, admin auth)

### GET `/api/admin/vendor-cooldowns`

The credentials the capability path is currently NOT using: a platform vendor key (`internal:<type>`) or a workspace's own connector that answered 401 (classified `auth_expired`) or an explicit payment-required response within the last ten minutes, parked by `src/capability-discovery/vendor-execution.ts` in `vendor_cooldowns` (migration 479) and read by `src/capability-discovery/vendor-gate.ts`. A park lapses on its own expiry; an operator who wants a vendor off for longer uses the connector kill switch above. Distinct from the kill switch: a parked credential is a short, self-clearing memory of a failure, not an operator decision.

- **Auth**: admin (Firebase). Deliberately **not** in `isPublicStateEndpoint`: the response names credential failure states.
- **Schema**: no body, no params, no query.
- **Success response** (HTTP 200): platform-key parks individually; workspaces' own connectors as counts by vendor, reason and time to lapse (bucketed to the minute), never as tenant or connector ids.
  ```json
  {
    "data": {
      "platform": [
        { "connectorType": "tikhub", "scope": "platform", "reason": "payment", "expiresAt": "2026-09-18T10:09:00.000Z" }
      ],
      "workspace": [
        { "connectorType": "apify", "scope": "workspace", "reason": "auth", "expiresWithinMinutes": 5, "count": 2 }
      ]
    }
  }
  ```
- **Error codes**: 401 without admin auth; 500 on infrastructure failure (DB unavailable).
- **Audit action**: none (a read).

---

## Platform vendor levers (admin auth)

Which vendor powers **Liftoff's own** LLM work, by area. NOT the Workspace AI dropdown: that
answers what a customer's AI teams run on, and the two must never be the same setting — a
workspace switching to Qwen should not move the Chief AI Officer with it. Backed by
`platform_vendor_policy` (migration 553), seeded to `'default'` for every area so the feature
ships inert; see ADR-054 for why four areas and
`src/model-registry/platform-vendor-policy.ts` for which purposes land in which.

| Area | Covers |
|---|---|
| `assistants` | What a person reads: Liftoff, the Chief AI Officer, the Insights Manager, the HRBP |
| `team_shaping` | Distillation and the capability/template analysis behind it |
| `quiet_work` | Titles, compaction, recall, reflection, consolidation, extraction — and every unregistered purpose |
| `safety` | Injection screening, untrusted content, DLP, the sensitivity classifications |

### GET `/api/admin/platform-vendors`

- **Auth**: admin (Firebase).
- **Schema**: no body, no params, no query.
- **Success response** (HTTP 200): `resolves` is what the setting takes effect as RIGHT NOW,
  and `null` there is how the screen tells "set to default" from "set to something that does
  not work". `availableProviders` is what this environment holds a client for, which is why a
  vendor can be absent from `selectableVendors`.
  ```json
  {
    "areas": [
      { "area": "assistants", "description": "What a person reads: …", "vendor": "default", "resolves": null }
    ],
    "selectableVendors": ["default", "anthropic", "openai", "google", "glm", "qwen", "deepseek", "kimi", "minimax", "xiaomi"],
    "availableProviders": ["anthropic", "openai", "google", "openrouter"]
  }
  ```

### PUT `/api/admin/platform-vendors`

- **Auth**: admin (Firebase).
- **Schema**: `{ areas: Record<area, vendor> }`, at least one area. Unknown area or a
  non-string vendor → `400 invalid_body`.
- **Refusal, not silent acceptance**: a vendor this plane cannot route to returns
  `400 vendor_not_routable` with `rejected: [{area, vendor}]` and writes nothing. Two causes,
  the same refusal: no transport (Grok left the gateway for api.x.ai and neither plane holds
  an xAI client) or no client configured here (a gateway vendor with no OpenRouter key). A
  lever that reads as configured and routes nowhere is worse than a rejected edit.
- **Success response** (HTTP 200): `{ applied: <areas read back>, policy: { … } }`. The write
  installs the change in this process at once, so the admin's own next request sees it, and
  publishes `platform.vendor_policy.updated` (tenantless) so the tenant runtime refreshes on
  arrival rather than waiting out its 60s poll.
- **Error codes**: 400 as above; 401 without admin auth; 500 on write failure (nothing is
  published when the write fails).
- **Audit action**: `platform_vendor_policy.updated`, one row per area, carrying `from` and
  `to`. A runtime-mutable routing decision with no actor is a change nobody can account for.

### GET `/api/admin/platform-vendors/resolve/:purpose`

Operator diagnostic: "the assistants are still on Anthropic" should be a curl, not a reading
of `areaForPurpose`.

- **Success response** (HTTP 200): `{ purpose, area, vendor, resolves }`. Answers for an
  unregistered purpose too — it lands in `quiet_work`, deliberately, so the default is visible.

```bash
curl -s https://api.example.com/api/admin/platform-vendors/resolve/history-compaction \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)"
```

---

## Account operations

### GET `/api/admin/accounts/:accountId/state`

Consolidated read of all state relevant to an enterprise account: `accounts`, `tenants` (with per-tenant role from `tenant_members`), `entitlements`, `billing_controls`, the active `enterprise_contracts` row, the local `subscriptions` mirror (active + last 5 canceled), plus the canonical Stripe-side active subscription and any orphan Stripe subscriptions (subs tagged with this account's primary `tenant_id` on a different customer).

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: params [`accountIdParam`](../src/admin/zod-helpers.ts) (UUID).
- **Success response** (HTTP 200):
  ```json
  {
    "data": {
      "account": { "id": "...", "email": "...", "stripeCustomerId": "cus_...", "isPlatformAdmin": false },
      "tenants": [
        { "id": "...", "name": "...", "status": "active", "gcpProjectId": null, "databaseName": null, "role": "owner", "createdAt": "..." }
      ],
      "entitlements": [
        { "tenantId": "...", "tenantOperationalStatus": "active", "agentExecutionAllowed": true, "remainingIncludedCredits": 0, "overageAllowed": true }
      ],
      "billingControls": {
        "accountId": "...", "billingTier": "enterprise", "stripeCustomerId": "cus_...",
        "stripeSubscriptionId": "sub_...", "suspended": false, "suspendedReason": null,
        "currentPeriodSpendUsd": "0.00", "prepaidBalanceUsd": "0.00", "updatedAt": "..."
      },
      "contract": {
        "accountId": "...", "includedOus": "10000000", "precommitExtraOus": "0",
        "includedRateUsdPerOu": "0.02", "precommitRateUsdPerOu": "0.02", "reloadRateUsdPerOu": "0.02",
        "stripeBilled": false, "isAnnualPlan": false, "annualTotalUsdCents": null,
        "effectiveFrom": "...", "effectiveTo": null, "contractReference": "MSA-..."
      },
      "subscriptions": [
        { "id": "...", "planId": "enterprise", "stripeSubscriptionId": "sub_...", "status": "active",
          "currentPeriodStart": "...", "currentPeriodEnd": "...", "updatedAt": "..." }
      ],
      "stripe": {
        "activeSubscription": { "id": "sub_...", "status": "active", "customer": "cus_...", "metadata": { "tenant_id": "..." } },
        "allSubscriptions": [
          { "id": "sub_...", "status": "active", "customer": "cus_...", "metadata": { "tenant_id": "..." } }
        ],
        "orphanSubscriptions": [],
        "searchAvailable": true
      }
    },
    "audit": { "actionId": "...", "action": "account.state.read", "actor": { "accountId": "...", "email": "..." }, "timestamp": "..." },
    "healthCheck": { "ok": true, "issues": [] }
  }
  ```
- **`stripe.allSubscriptions`**: the full status='all' result of `subscriptions.list` for the canonical Stripe customer. Used by `inferHealthIssues` to distinguish "sub exists in Stripe but is canceled" from "sub deleted entirely (resource_missing)". Operators can also use this for sub-history triage.
- **healthCheck scope**: `inferHealthIssues` is a **curated** list of inconsistencies that have caused real provisioning incidents. It is **not** a comprehensive linter. `ok: true` means none of the curated checks fired — it does **not** mean "everything is perfect." The checks are:
  - `stripe_active_sub_customer_mismatch` — Stripe's active sub for this customer is on a different `customer` than `billing_controls.stripe_customer_id`.
  - `local_active_sub_diverged_from_stripe` — local `subscriptions` row is `status='active'` but the corresponding Stripe sub is canceled or missing.
  - `billing_controls_subscription_missing_from_stripe` — `billing_controls.stripe_subscription_id` is non-null but Stripe has no record of that sub.
  - `contract_present_but_tier_not_enterprise` — an `enterprise_contracts` row exists but `billing_controls.billing_tier !== 'enterprise'`.
  - `stripe_orphan_subscriptions_present` — Stripe returned active subs tagged with this tenant's id on a **different** customer.
  - `billing_controls_suspended_but_stripe_active` — local `suspended = true` while Stripe still bills.
  - `stripe_search_unavailable` — the Stripe orphan-subscription search hit a rate limit (or otherwise failed); orphan-sub detection is degraded for this snapshot.
- **Stripe degradation**: when the orphan-subscription search rate-limits, `stripe.searchAvailable` is `false` and `healthCheck.issues` includes `stripe_search_unavailable`. The rest of the snapshot is unaffected.
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `invalid_request` | `accountId` not a UUID |
  | 401 | `Unauthorized` | No Firebase token |
  | 403 | `Forbidden` | Not platform admin |
  | 404 | `account_not_found` | No `accounts` row for the given id |
- **Audit action**: `account.state.read`.

### POST `/api/admin/accounts/:accountId/enterprise-setup`

Consolidated end-to-end enterprise-account setup. A single call runs the whole sequence:

1. **Pre** — pre-mutation snapshot via `readAccountState` (404 if account missing).
2. **Step A** — Cancel existing Stripe sub on the canonical customer (opt-in default; toggle via `cancelExistingSubscription`). Polls the local mirror up to 10s for the canceled state; falls back to a direct DB flip + warning log if the webhook lags.
3. **Step B** — Upsert `enterprise_contracts` row (shared helper).
4. **Step C** — Sync rates onto `billing_controls` and Stripe metadata + price (shared helper; the canceled-subscription guard applies).
5. **Step D** — Provision via liftoff-billing `/api/internal/provision-enterprise` with `cleanOrphanState: true`.
6. **Step E** — Post-mutation snapshot via `readAccountState`; envelope wraps it with `audit.status` (`success` | `partial_failure`) and `healthCheck.issues[]`.

Each mutation step (A–D) catches its own failure and records `failedStep` + `failureError`; subsequent steps short-circuit but Step E still runs so the operator always sees current state. Pre-snapshot failures (account not found) are the only path that returns a non-200.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: params [`accountIdParam`](../src/admin/zod-helpers.ts); body [`enterpriseSetupBodySchema`](../src/admin/enterprise-setup-handler.ts) — the enterprise-contract body plus `cancelExistingSubscription?: boolean` (defaults to `true` per Q6).
- **Request body example**:
  ```json
  {
    "includedOus": 10000000,
    "precommitExtraOus": 0,
    "includedRateUsdPerOu": 0.02,
    "precommitRateUsdPerOu": 0.02,
    "reloadRateUsdPerOu": 0.02,
    "stripeBilled": true,
    "isAnnualPlan": false,
    "annualTotalUsdCents": null,
    "contractReference": "MSA-2026-...",
    "cancelExistingSubscription": true
  }
  ```
- **Success response** (HTTP 200): `data` is the post-mutation `AccountStateSnapshot` (same shape as `GET /accounts/:accountId/state`); `audit.status = 'success'`; `healthCheck.ok = true` when no curated inconsistencies remain.
- **Partial-failure response** (HTTP 200): same envelope shape; `audit.status = 'partial_failure'`; `audit.failedStep` ∈ `'cancel_existing' | 'upsert_contract' | 'sync_rates' | 'provision_enterprise'`; `healthCheck.ok = false` with `healthCheck.issues[]` including the curated inferred issues PLUS a `step:<name> failed: <message>` entry.
- **Q6 behavior**: re-running this endpoint on an account that already has a matching enterprise sub still cancels + re-provisions. Intentional "known-clean" override path.
- **Long-running**: total response time may be **10–30s** under normal load (Stripe ops dominate). Acceptable for curl-based ops use; a UI consumer should adopt 202 + polling instead.
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `invalid_request` | body fields missing/wrong type; `accountId` not a UUID |
  | 401 | `Unauthorized` | No Firebase token |
  | 403 | `Forbidden` | Not platform admin |
  | 404 | `account_not_found` | No `accounts` row for the given id (pre-mutation snapshot) |
  | 500 | (uncaught) | Post-snapshot read failed after mutations ran — manual reconciliation needed |
- **Audit action**: `billing.enterprise.setup`. The audit row's `details` include `failedStep` + `failureError` on partial-failure paths.

### PUT `/api/admin/accounts/:accountId/enterprise-contract`

Upsert the active enterprise contract for an account; live-synchronises rates onto `billing_controls` and (if a Stripe sub exists) updates Stripe metadata + recurring price.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: params [`accountIdParam`](../src/admin/zod-helpers.ts) (UUID); body [`enterpriseContractBodySchema`](../src/admin/enterprise-contract-handler.ts) at line 36.
- **Request body example**:
  ```json
  {
    "includedOus": 10000000,
    "precommitExtraOus": 0,
    "includedRateUsdPerOu": 0.02,
    "precommitRateUsdPerOu": 0.02,
    "reloadRateUsdPerOu": 0.02,
    "stripeBilled": false,
    "isAnnualPlan": false,
    "annualTotalUsdCents": null,
    "contractReference": "MSA-2026-internal-001",
    "notes": "Internal test account"
  }
  ```
- **Success response** (HTTP 200):
  ```json
  {
    "data": { "ok": true },
    "audit": { "action": "account.enterprise_contract.upsert", "actor": { ... }, ... }
  }
  ```
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `invalid_request` | Body fields missing/wrong type; `accountId` not UUID |
  | 401 | `Unauthorized` | No Firebase token |
  | 403 | `Forbidden` | Not platform admin |
  | 409 | `interval_change_requires_replace` | Toggling `isAnnualPlan` on an account that already has a Stripe sub |
- **Audit action**: `account.enterprise_contract.upsert`.

### GET `/api/admin/accounts/:accountId/enterprise-contract`

List historical enterprise contracts for an account (active + superseded).

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: params [`accountIdParam`](../src/admin/zod-helpers.ts).
- **Success response** (HTTP 200):
  ```json
  {
    "data": {
      "contracts": [
        {
          "account_id": "...",
          "included_ous": "10000000",
          "precommit_extra_ous": "0",
          "included_rate_usd_per_ou": "0.02",
          "precommit_rate_usd_per_ou": "0.02",
          "reload_rate_usd_per_ou": "0.02",
          "stripe_billed": false,
          "is_annual_plan": false,
          "annual_total_usd_cents": null,
          "effective_from": "2026-05-17T...",
          "effective_to": null,
          "contract_reference": "MSA-...",
          "notes": "...",
          "updated_at": "..."
        }
      ]
    }
  }
  ```
  No `audit` field — read endpoints write no row to `admin_action_audit` (the audit-action table covers only the PUT). Admin auth is still required, but the response omits the audit echo.
- **Error codes**: 400, 401, 403.
- **Audit action**: (none — see note above).

### POST `/api/admin/accounts/:accountId/enterprise-provisioning`

Renamed from `POST /api/admin/billing/accounts/:accountId/provision-enterprise`. Provisions the account as an enterprise pre-pay customer — sets `billing_tier='enterprise'`, loads wallet, creates the $0 (or stripe-billed) Stripe sub via liftoff-billing.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: params [`accountIdParam`](../src/admin/zod-helpers.ts); empty body.
- **Pre-condition**: an active row in `enterprise_contracts` for the account (PUT the contract first).
- **Success response** (HTTP 200):
  ```json
  {
    "data": {
      "accountId": "...",
      "includedOus": 10000000,
      "precommitExtraOus": 0,
      "stripeBilled": false
    },
    "audit": { "action": "account.enterprise_provisioning.create", ... }
  }
  ```
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `invalid_request` | `accountId` not UUID |
  | 401 / 403 | Auth | |
  | 404 | `account_not_found` | No row in `accounts` for `accountId` |
  | 404 | `tenant_not_found` | Account has no tenants |
  | 409 | `account_has_no_stripe_customer` | `accounts.stripe_customer_id` is NULL |
  | 422 | `no_enterprise_contract_on_file` | No active row in `enterprise_contracts` for the account |
- **Audit action**: `account.enterprise_provisioning.create`.

### POST `/api/admin/accounts/:accountId/fraud-hold/clear`

Lift the hold an early fraud warning placed on an account. Stripe reports the issuer's fraud claim on `radar.early_fraud_warning.created`; liftoff-billing calls `POST /api/internal/billing/controls/:cus/fraud-hold`, which sets `billing_controls.fraud_hold_at` and stops every workspace under the account. No payment clears it — a top-up clears `suspended` and raises the balance, and a stolen card's own next top-up would otherwise release the workspace it just got held. This route is the only way back.

Clearing the column is all it does. An account that is also out of credit or suspended stays refused on those terms, decided by the same predicate ([`billingStoppedSql`](../src/billing/prepaid-floor.ts)) that refused it for the hold. The wallet is never touched by either direction: credit leaves only when money leaves (`charge.refunded` / `charge.dispute.created`).

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: params [`accountIdParam`](../src/admin/zod-helpers.ts); empty body.
- **Side effect**: `publishBillingSuspensionChange(accountId, 'unsuspended', 'fraud_hold_cleared')` republishes every tenant's entitlement snapshot, so the runtime stops refusing within seconds rather than on its next TTL refresh.
- **Success response** (HTTP 200):
  ```json
  {
    "data": { "accountId": "...", "cleared": true },
    "audit": { "action": "billing.fraud_hold.clear", ... }
  }
  ```
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `invalid_request` | `accountId` not UUID |
  | 401 / 403 | Auth | |
  | 404 | `no_fraud_hold` | The account has no `billing_controls` row, or is not on a hold |
- **Audit action**: `billing.fraud_hold.clear`, with the dismissed warning's `issfr_…` reference.

### POST `/api/admin/accounts/:id/reprovision`

Heal an account orphaned by the pre-fix provisioning chain — creates a Stripe customer if missing, runs the synchronous activation chain per tenant. Same code path new signups use.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: params [`idParam`](../src/admin/zod-helpers.ts) (UUID).
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  {
    "data": {
      "accountId": "...",
      "stripeCustomerCreated": true,
      "tenantsReactivated": ["tenant-1", "tenant-2"]
    },
    "audit": { "action": "account.reprovision", ... }
  }
  ```
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `invalid_request` | `id` not UUID |
  | 401 / 403 | Auth | |
  | 404 | `account_not_found` | `AccountNotFoundError` thrown |
- **Audit action**: `account.reprovision`.

### DELETE `/api/admin/accounts/:id?cascade=true[&dryRun=true]`

Hard-delete an account + all owned tenants + cross-tenant memberships. Cascades to Stripe (delete customer) and Firebase (delete auth user). `cascade=true` is required as a safety; `dryRun=true` runs the same path inside a ROLLBACK so the operator can eyeball counts. Both flags are case-insensitive booleans.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: params [`idParam`](../src/admin/zod-helpers.ts); query [`src/admin/router.ts:770`](../src/admin/router.ts) — `z.object({ cascade: z.string().optional(), dryRun: z.string().optional() })` (raw strings; handler does case-insensitive compare to "true").
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  {
    "data": {
      "accountId": "...",
      "tenantsAffected": 2,
      "memberRowsAcrossOtherTenants": 0,
      "stripeCustomerDeleted": true,
      "firebaseUserDeleted": true,
      "accountRowDeleted": true
    },
    "audit": { "action": "account.cascade_delete", ... }
  }
  ```
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `invalid_request` | `id` not UUID |
  | 400 | `cascade_required` | `cascade=true` not present |
  | 401 / 403 | Auth | |
  | 404 | `account_not_found` | `AccountNotFoundError` thrown |
- **Audit action**: `account.cascade_delete`.

---

### POST `/api/admin/accounts/:accountId/ou-credit`

Credit Operating Units to the account's current billing period, as the remedy
for work that failed or an outage that burned an allowance.

Compute rather than cash: it costs COGS instead of revenue, lands immediately,
and needs no Stripe call. The grant travels as a negative-cost event through the
ordinary consumption boundary, so it walks `ous_consumed_this_period` back down
by exactly the units granted and leaves one negative row in
`cost_attribution_events` with `source = 'operator_credit'`.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: [`src/admin/ou-credit-router.ts`](../src/admin/ou-credit-router.ts). `operatingUnits` is a positive number at most `MAX_OPERATOR_CREDIT_OUS` (50,000); `reason` is 1-500 characters and required; `idempotencyKey` is optional.
- **Units, not dollars.** Operating Units are the customer-facing quantity and the only one billing surfaces expose.
- **The ceiling is a typo guard, not a spending cap.** 50,000 units is roughly $500 of raw compute and well above a Scale plan's whole monthly allowance, so it refuses an extra digit without refusing a real remedy. A larger grant is two grants, both audited.
- **Idempotent on `idempotencyKey`.** A replay reports `credited: false` rather than crediting twice. Omit the key and the audit record's id is used, which makes each call its own grant.
- **Request body**:
  ```json
  { "operatingUnits": 800, "reason": "run produced nothing usable", "idempotencyKey": "incident-42" }
  ```
- **Success response** (HTTP 200):
  ```json
  {
    "data": {
      "accountId": "22222222-2222-2222-2222-222222222222",
      "tenantId": "11111111-1111-1111-1111-111111111111",
      "operatingUnits": 800,
      "credited": true,
      "idempotencyKey": "incident-42"
    },
    "audit": {
      "actionId": "audit_abc",
      "action": "billing.ou_credit.grant",
      "actor": { "accountId": "acct_xyz", "email": "admin@example.com" },
      "timestamp": "2026-09-11T12:34:56.789Z"
    }
  }
  ```
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `invalid_account_id` | `accountId` not a UUID |
  | 400 | `invalid_grant` | Non-positive units, units above the ceiling, or a missing reason |
  | 401 | `Unauthorized` | No Firebase token |
  | 403 | `Forbidden` | Authenticated but not platform admin |
  | 404 | `tenant_not_found` | The account has no workspace |
  | 502 | `ou_credit_failed` | The credit could not be applied |
- **Audit action**: `billing.ou_credit.grant`. Written BEFORE the credit, so an operator's intent is recorded even if the grant then fails.

### POST `/api/admin/accounts/:accountId/refund-quote`

What could be refunded on one invoice, and why not when the answer is nothing.
Moves no money and writes no audit row — asking is not an act.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Request body**: `{ "stripeInvoiceId": "in_123" }`
- **Success response** (HTTP 200): `data` carries `refundableCents`, `refusal` (null when refundable), `monthsStarted` and `monthlyListCents` (annual only, so the working is visible), and `amountPaidCents`. No `audit` key.
- **Refusal reasons** (returned in `refusal`, not as an error): `not_a_subscription_invoice`, `nothing_left_to_refund`, `outside_refund_window`, `allowance_already_consumed`, `term_fully_consumed`.
- **Error codes**: 400 `invalid_account_id` / `invalid_request`; 404 `tenant_not_found`; 502 `refund_quote_failed`.

### POST `/api/admin/accounts/:accountId/refunds`

Issues a refund against a subscription invoice as a **Stripe credit note**, and
cancels the subscription.

A credit note rather than a charge refund because a charge refund never touches
the invoice, which is how the local mirror and Stripe drifted apart. The
cancellation is not tidiness: on an annual plan the monthly allowance reset would
otherwise keep granting units for months that were just refunded.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **The ceiling is enforced by liftoff-billing**, which computes eligibility from the invoice's own term and the tenant's consumption. Discretion lives in "do we refund at all", never in "can we beat the formula"; a genuine exception goes through the Stripe dashboard, where it is visible as one.
- **Only `subscription_cycle` invoices.** A `prepaid_reload` invoice bought usage credits, which are non-refundable — the exact mirror of the prepaid clawback, so between them every invoice type has one owner.
- **Annual proration**: `amount_paid − (months_started × monthly_list)`, floored at zero, reaching zero at month ten because annual is ten months' price. Whether an invoice is annual is read off its own period length, so a later interval change cannot reprice an older invoice.
- **Idempotent** on `idempotencyKey`, which is forwarded to Stripe: a replay returns the original credit note.
- **Request body**:
  ```json
  { "stripeInvoiceId": "in_123", "amountCents": 120000, "reason": "annual cancelled at month four", "idempotencyKey": "refund-42" }
  ```
- **Success response** (HTTP 200): `data` carries `creditNoteId`, `refundedCents`, `cancelledSubscriptionId`; `audit` echoes the row.
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `invalid_account_id` \| `invalid_refund` | Bad account id, non-positive amount, or a missing reason / idempotency key |
  | 404 | `tenant_not_found` | The account has no workspace |
  | 409 | `refund_refused` | Policy says no; `detail` carries the reason, including `amount_exceeds_refundable` |
  | 502 | `refund_failed` | Stripe or billing could not complete it |
- **Audit action**: `billing.refund.issue`, written BEFORE the money moves so intent survives a failure.

## Signup access

Two families that answer the same question at different times. **Signup approvals** decide on someone who has already signed up and is sitting on `/request-invite`; the account row exists, so the decision writes `accounts.access_status` directly. **Signup pre-approvals** record the decision *before* the person signs up, when there is no account row to write to — `AccountService.create` spends the entry and the account is born approved.

`computeAccess` ([`src/accounts/service.ts`](../src/accounts/service.ts)) grants on a whitelisted email domain, then `access_status='approved'`, then non-owner tenant membership. Both families below drive the middle one; neither can revoke access granted by the other two.

> **`pending` is not a queue.** It means no per-person decision was ever needed — the permanent value for anyone granted by domain or invitation, paying customers included, because those users short-circuit before the column is read and no path writes it. Adding a domain to the allow-list deliberately does not stamp `approved`: the list is live and revocable, the column is permanent, and writing it would mean removing the domain no longer revokes anyone. So `WHERE access_status = 'pending'` is **not** "awaiting a decision" — it is mostly granted users. Use `computeAccess(...).accessGranted === false` instead, which is what `GET /api/admin/signup-approvals/:token` and the accounts admin list already return as `accessGranted`. Full rationale is on the column (migration 376).

### GET `/api/admin/signup-approvals/:token`

Metadata for the authenticated `/signup-approval` page. The signed HMAC token (7-day TTL, `SIGNUP_APPROVAL_SECRET`) identifies **which** signup and carries no action — the admin session authenticates who is deciding.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: params `z.object({ token: z.string().min(1) })` ([`src/admin/router.ts`](../src/admin/router.ts)).
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  {
    "data": {
      "firstName": "Jane",
      "lastName": "Doe",
      "email": "jane@acme.com",
      "accessGranted": false
    }
  }
  ```
  No `audit` key — a read decides nothing.
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `token_invalid` | Bad signature, malformed payload, or `SIGNUP_APPROVAL_SECRET` unset |
  | 401 / 403 | Auth | |
  | 404 | `account_not_found` | Token valid, account since deleted |
  | 410 | `token_expired` | Past the 7-day TTL — distinguished from invalid so the page can say so |
- **Audit action**: none.

### POST `/api/admin/signup-approvals/approve`

Grant access (`access_status='approved'`) and welcome the user.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: body `z.object({ token: z.string().min(1) })`.
- **Request body**: `{ "token": "<signed-token>" }`.
- **Success response** (HTTP 200):
  ```json
  {
    "data": { "approved": true, "alreadyApproved": false },
    "audit": { "action": "account.signup_approval.approve", ... }
  }
  ```
  Idempotent: an already-approved account skips the status write **and** the audit row (`alreadyApproved: true`, no `audit` key) but still re-sends the welcome, so a retry after a failed send delivers it rather than dropping it.
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `token_invalid` | |
  | 401 / 403 | Auth | |
  | 404 | `account_not_found` | |
  | 410 | `token_expired` | |
  | 500 | — | Welcome-email send failed. The grant has already committed; retry re-sends only. |
- **Audit action**: `account.signup_approval.approve`.

### POST `/api/admin/signup-approvals/waitlist`

Record a `waitlisted` decision. Changes no access — the gate already denies a `pending` account.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: body `z.object({ token: z.string().min(1) })`.
- **Request body**: `{ "token": "<signed-token>" }`.
- **Success response** (HTTP 200):
  ```json
  {
    "data": { "waitlisted": true },
    "audit": { "action": "account.signup_approval.waitlist", ... }
  }
  ```
  Never revokes: against an already-`approved` account this is a no-op returning `{ "waitlisted": false, "alreadyApproved": true }` with no `audit` key, because writing `waitlisted` there would take access away from someone who has it.
- **Error codes**: same table as `…/approve`, minus the 500 (no email is sent).
- **Audit action**: `account.signup_approval.waitlist`.

### POST `/api/admin/signup-preapprovals`

Put an email on the guest list before it signs up. Entries live in `signup_preapprovals` (migration 341) and are spent by `AccountService.create`, which INSERTs the matching account already `access_status='approved'` with `access_decided_by` set to the admin who cleared it.

Matching is exact on the lowercased address — no plus-address or gmail-dot unwrapping, because a whitelist that grants more than it literally says fails invisibly.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: body `z.object({ email: z.string().trim().email(), note: z.string().max(500).optional() })`.
- **Request body**: `{ "email": "someone@example.com", "note": "prospect from the Acme call" }`.
- **Success responses** — three outcomes, distinguished by `data.mode`:

  `preapproved` (HTTP 201 new, HTTP 200 when a live entry already existed) — nobody has signed up with this address:
  ```json
  {
    "data": {
      "mode": "preapproved",
      "created": true,
      "entry": {
        "id": "<uuid>", "email": "someone@example.com", "note": "...",
        "addedBy": "<admin-uuid|null>", "createdAt": "<ISO-8601>",
        "consumedAt": null, "consumedAccountId": null
      }
    },
    "audit": { "action": "account.signup_preapproval.add", ... }
  }
  ```
  Adding the same address twice returns `created: false` with the **original** entry and no second audit row, so a double-click cannot re-attribute the first decision.

  `approved_existing` (HTTP 200) — that address already has a blocked account, so it is approved outright rather than storing a row that is only ever read at account-creation time and would sit unspent while an operator believed they had let someone in. Sends the welcome email:
  ```json
  {
    "data": { "mode": "approved_existing", "email": "...", "accountId": "<uuid>" },
    "audit": { "action": "account.signup_preapproval.approve_existing", ... }
  }
  ```

  `already_granted` (HTTP 200) — the account exists and is already in, via domain, an earlier approval, or an invitation. No-op, no `audit` key:
  ```json
  { "data": { "mode": "already_granted", "email": "...", "accountId": "<uuid>", "accessReason": "domain" } }
  ```
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `invalid_request` | `email` not an email, or `note` over 500 chars |
  | 401 / 403 | Auth | |
  | 500 | — | Welcome-email send failed on the `approved_existing` path (grant already committed; retry re-sends) |
- **Audit action**: `account.signup_preapproval.add` or `account.signup_preapproval.approve_existing`.

### GET `/api/admin/signup-preapprovals`

The whole guest list, live entries first, then by recency. Consumed entries are retained deliberately: the spent row records who cleared whom and which account it admitted, and "expected, not yet arrived" is only distinguishable from "arrived" if both are visible.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: none.
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  { "data": { "entries": [ { "id": "...", "email": "...", "consumedAt": null, "consumedAccountId": null, "...": "..." } ] } }
  ```
  No `audit` key.
- **Error codes**: 401 / 403 only.
- **Audit action**: none.

### DELETE `/api/admin/signup-preapprovals/:id`

Take a **live** entry back off the list. A consumed entry is history and cannot be revoked here — the person has an account by then, so the thing to change is that account's `access_status`. Note that no endpoint currently does that for an already-approved account: `…/signup-approvals/waitlist` deliberately refuses to downgrade one, so revoking a granted user today means a direct write.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: params `z.object({ id: z.string().uuid() })`.
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  {
    "data": { "revoked": true, "email": "someone@example.com" },
    "audit": { "action": "account.signup_preapproval.revoke", ... }
  }
  ```
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `invalid_request` | `id` not UUID |
  | 401 / 403 | Auth | |
  | 404 | `preapproval_not_found` | No entry with that id, **or** it has already been spent |
- **Audit action**: `account.signup_preapproval.revoke`.

---

## Tenant operations

### POST `/api/admin/tenants/:id/upgrade-to-dedicated`

Upgrade a shared-hosting tenant to its own GCP project. The FOR UPDATE row lock is held across the (slow) GCP provisioning call so a second concurrent caller blocks and then short-circuits with `409 tenant_already_dedicated`.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: params [`idParam`](../src/admin/zod-helpers.ts).
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  {
    "data": {
      "tenantId": "...",
      "buildId": "build-abc-123",
      "gcpProjectId": "tenant-...-prod"
    },
    "audit": { "action": "tenant.upgrade_to_dedicated", ... }
  }
  ```
- **Error codes**:
  | Status | Code | When |
  |---|---|---|
  | 400 | `invalid_request` | `id` not UUID |
  | 401 / 403 | Auth | |
  | 404 | `tenant_not_found` | No row in `tenants` |
  | 409 | `tenant_already_dedicated` | `hosting_mode='dedicated'`; `detail` includes the existing `gcpProjectId` |
  | 500 | `provisioning_failed` | GCP provisioning returned non-success; `detail` carries the underlying error |
- **Audit action**: `tenant.upgrade_to_dedicated`.

---

## Debug

### GET `/api/admin/debug/agents?tenantId=<UUID>`

Inspect agents + audit summary for a tenant.

- **Auth**: Firebase Bearer + `is_platform_admin = TRUE`.
- **Schema**: [`src/admin/router.ts:511`](../src/admin/router.ts) — `{ query: z.object({ tenantId: z.string().uuid() }) }`.
- **Request body**: empty.
- **Success response** (HTTP 200):
  ```json
  {
    "data": {
      "internalAgents": [{ "id": "...", "role": "...", "agentType": "...", "engineConfig": {...}, "status": "active" }],
      "externalAgents": [{ "id": "...", "name": "...", "status": "..." }],
      "proxyKeys": [{ "id": "...", "name": "..." }],
      "auditSummary": {
        "total": 1234,
        "byEngineType": { "anthropic": 800, "openai": 434 },
        "last24h": 56
      }
    }
  }
  ```
  No `audit` field — read endpoints write no row to `admin_action_audit` (the audit-action table covers only mutating routes). Admin auth is still required, but the response omits the audit echo.
- **Error codes**: 400 `invalid_request` (no `tenantId`, or not UUID); 401, 403.
- **Audit action**: (none — see note above).

---

## Legacy route and action names

These earlier routes now return 404; use the replacements:

| Old (404) | New |
|---|---|
| `POST /admin/billing/accounts/:id/provision-enterprise` | `POST /admin/accounts/:id/enterprise-provisioning` |
| `PUT /admin/enterprise-contracts/:accountId` | `PUT /admin/accounts/:accountId/enterprise-contract` |
| `GET /admin/enterprise-contracts/:accountId` | `GET /admin/accounts/:accountId/enterprise-contract` |
| `GET /admin/check/connector/:type` | `GET /admin/connectors/:type/state` |
| `GET /admin/check/workflow-type/:type` | `GET /admin/workflow-types/:type/state` |
| `GET /admin/check/global-writes-frozen` + `GET /admin/status` | `GET /admin/platform/state` (merged) |
| `GET /admin/disabled-connectors` | `GET /admin/connectors?state=disabled` |
| `GET /admin/disabled-workflow-types` | `GET /admin/workflow-types?state=disabled` |

The audit-action name normalisation (e.g. `tenant.disable` → `tenant.kill_switch.disable`) is captured in [`src/admin/router.ts`](../src/admin/router.ts) per route. Historical `admin_action_audit` rows retain their old names — query for both names if you need a longitudinal view.

### Audit-action rename map

| Legacy (`admin_action_audit.action`) | Current |
|---|---|
| `tenant.disable` | `tenant.kill_switch.disable` |
| `tenant.enable` | `tenant.kill_switch.enable` |
| `connector.disable` | `connector.kill_switch.disable` |
| `connector.enable` | `connector.kill_switch.enable` |
| `workflow_type.disable` | `workflow_type.kill_switch.disable` |
| `workflow_type.enable` | `workflow_type.kill_switch.enable` |
| `global.freeze_writes` | `platform.kill_switch.freeze_writes` |
| `global.unfreeze_writes` | `platform.kill_switch.unfreeze_writes` |
| `admin.enterprise_contract.upsert` | `account.enterprise_contract.upsert` |
| `billing.enterprise_provisioned` (implicit) | `account.enterprise_provisioning.create` |
| `tenant.upgrade_to_dedicated` | (unchanged) |
| `account.reprovision` | (unchanged) |
| `account.cascade_delete` | (unchanged) |

Read endpoints intentionally write no `admin_action_audit` row, with one exception: `GET /accounts/:accountId/state` records `account.state.read`.

Public state endpoints (`/platform/state`, `/connectors`, `/connectors/:type/state`, `/workflow-types`, `/workflow-types/:type/state`) write no audit row.
