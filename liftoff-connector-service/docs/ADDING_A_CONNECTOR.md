# Adding a Connector — Canonical Guide

This is the **end-to-end** guide for adding a new connector to LiftoffOS. It is the
source of truth; the older focused docs (CONNECTOR_OAUTH_SETUP.md,
CONNECTOR_EVENT_TOPIC_ONBOARDING.md,
CONNECTOR_SOURCE_FLIP.md) drill into individual steps.

A connector is more than a catalog entry. Depending on its type it can touch **four
repos**: `liftoff-connector-service` (the catalog + auth + clients + polling), `liftoff-tenant-runtime`
(tool dispatch + billing reporting), `liftoff-platform-backend` (billing allow-list + HITL
classification + capability/template binding + static cache), and `liftoff-react` (the
connector picker). This guide covers all of it.

> **Golden rule:** `src/catalog/connectors.ts` is the single source of truth. Almost everything
> else — `MCP_SERVER_REGISTRY`, `CONNECTOR_DISPLAY_NAMES`, `CONNECTOR_TYPES_LIST`,
> `FUNCTIONAL_CONNECTOR_TYPES`, the capability map, `docs/CONNECTORS.md`, and the platform-backend
> static fallback cache — is a **projection** of that file. Never hand-edit a projection.

---

## 0. TL;DR decision tree — pick the connector type FIRST

Ask, in order:

1. **Does the vendor publish a first-party MCP server?** (ALWAYS web-search "`<vendor>` MCP server" —
   do not assume.) → **`vendor_hosted`**. Zero per-call cost, vendor maintains the tools. *Preferred.*
   Examples: Sentry, Stripe, HubSpot, GitHub, Notion, Linear, Intuit/QuickBooks, Xero.
2. **No vendor MCP, but Composio has the toolkit?** → **`composio_managed`**. Per-call OU cost
   (~$0.0003, pass-through revenue) buys instant, maintained tools with no build. Right for the long
   tail. Examples: Gmail/Drive/Calendar, Slack, Jira/Confluence, Airtable, Reddit, Apollo, Intercom.
3. **Neither, and you need deep/custom control or custom credential custody?** → build a **`sidecar`**
   (REST client + hand-authored MCP tool schemas in the MCP-sidecar service). Most work.
4. **The vendor has no API but the customer runs their own MCP?** → **`customer_hosted`** (the Custom
   MCP Server / tunnel flow).
5. **You want hand-authored tools executed by a REST client you control (no MCP at all)?** →
   **native REST** (function-registry entry + a `buildClient` REST client). Legacy-style; prefer MCP.

Current mix (so you can find a recent precedent to copy): `composio_managed` ≈ 57, `sidecar` ≈ 25,
`vendor_hosted` ≈ 19, `customer_hosted` = 1, plus a handful of native-REST connectors with no `mcp`.

**Tool count ≠ value.** Composio's `meta.tools_count` is not the callable list, and the "extra" tools
over a native MCP are often admin/CRUD you do *not* want agents calling. Compare the actual tool lists.

---

## 1. How a connector actually works at runtime

Three independent runtime paths. A connector opts into whichever it needs:

| Path | What it does | Where it's wired |
|------|--------------|------------------|
| **Tool dispatch** | Agent calls a tool (e.g. "send email") | `mcp` field → the MCP server (Composio/vendor/sidecar/customer) OR, for native-REST, the `connector-functions-registry` + a `buildClient` REST client. |
| **Reactive polling** | Scheduler emits events (e.g. `email.received`) | `polling[]` + `buildClient` returns a client whose `list()` fetches records + a registered **normalizer**. Orthogonal to tool dispatch. |
| **History reads** | "Read a thread/conversation" tools | `historyReads[]` (§5.4) — auto-generated read-a-thread tools. |

How tools are **sourced** is what really distinguishes the types:

- `composio_managed` / `vendor_hosted` / `customer_hosted` → tools are discovered **live from the MCP
  server** at runtime. No `connector-functions-registry` entry needed.
- `sidecar` → tools are hand-authored schemas served by the Liftoff sidecar MCP.
- native REST → tools are hand-authored `ConnectorFunction[]` in `connector-functions-registry.ts`,
  executed by a `buildClient` REST client.

---

## 2. The `ConnectorDef` shape (every field)

Defined in `@liftoffos/connector-types` (`packages/connector-types/src/catalog.ts`), authored in
`src/catalog/connectors.ts`.

```ts
<type>: {
  type: '<type>',                       // canonical id, snake_case. MUST equal the map key.
  displayName: 'Vendor Name',           // shown in the UI
  category: '<ConnectorCategory>',      // existing enum only (crm_sales, productivity_comms, ...)
  objectsCovered: ['Obj1', 'Obj2'],     // UI copy — the nouns the connector touches
  status: 'available',                  // 'available' | 'coming_soon'
  auth: { ... },                        // see §3
  mcp: { ... },                         // OPTIONAL — omit for native-REST connectors. see §3
  capabilities: [                       // OPTIONAL — projects into the capability picker (§5.2)
    { capability: '<existing_cap>', requiredScopes: [] },
  ],
  historyReads: [ ... ],                // OPTIONAL — auto-generated "read a thread" tools (§5.5)
  polling: [                            // OPTIONAL — reactive events (§5.3)
    { entityType: 'Email', eventTopics: ['email.received'], listImplemented: true },
  ],
  multiInstance: true,                  // OPTIONAL — allow multiple connections of this type
  urlResolverKey: '...',                // OPTIONAL — per-workspace MCP URL (Snowflake/Databricks)
}
```

`type` MUST equal its map key, MUST be in the `ConnectorType` union in `src/types.ts` (hand-maintained),
and `displayName`/`CONNECTOR_TYPES_LIST` derive from this map automatically.

---

## 3. `auth` and `mcp` by type

### `auth` (three kinds)

```ts
// API key / token the user pastes (also Composio API_KEY connectors):
auth: { kind: 'api_key' }

// OAuth the platform runs (and the Composio-OAuth placeholder):
auth: { kind: 'static_oauth', clientIdEnvVar: 'VENDOR_CLIENT_ID', clientSecretEnvVar: 'VENDOR_CLIENT_SECRET',
        authUrl: '...', tokenUrl: '...', scopes: [...], scopeDelimiter: ' ' }

// Composio-managed OAuth uses the placeholder form (Composio holds the app):
auth: { kind: 'static_oauth', clientIdEnvVar: 'COMPOSIO_MANAGED', clientSecretEnvVar: 'COMPOSIO_MANAGED',
        authUrl: 'https://composio.dev', tokenUrl: 'https://composio.dev', scopes: [], scopeDelimiter: ' ' }

// DCR (dynamic client registration) — the modern MCP-OAuth path. NO pre-registered
// client app: dcr.ts fetches the vendor's OAuth metadata and registers a client on
// the fly. You supply ONLY the discovery base; endpoints are discovered at connect time.
auth: { kind: 'dcr_oauth', discoveryBaseUrl: 'https://mcp.vendor.com',
        clientIdEnvVar: 'VENDOR_CLIENT_ID', clientSecretEnvVar: 'VENDOR_CLIENT_SECRET',
        scopes: [], scopeDelimiter: ' ' }
```

For real `static_oauth` (platform-run OAuth), you also add a provider under
`src/credentials/oauth-providers/` (token refresh + identity fetch) and register it in that dir's
`index.ts`. See the existing `google.ts`, `salesforce.ts`, `atlassian.ts`, `dcr.ts` (dynamic client
registration). Composio-OAuth connectors do **not** need a provider (Composio refreshes tokens).

> **`dcr_oauth` — the SSRF discovery allowlist is a REQUIRED, easily-missed step.** The DCR flow
> is guarded by `ALLOWED_DISCOVERY_DOMAINS` (`src/oauth/discovery.ts`) — a distinct, hand-maintained
> safety list from the two MCP-egress allowlists in §4B. On "Connect", `resolveAuthServerUrl()` calls
> `isAllowedDiscoveryUrl()` on the FIRST discovery URL and throws `ssrf_blocked` **before any network
> call** if the host is not listed → the user sees a generic **"failed to connect"** toast, with
> nothing wrong in the catalog and a fully green build. **You must add every host the vendor's live
> discovery documents reference — not just the MCP host.** The OAuth dance routinely spans several
> hosts (auth server ≠ MCP host): protected-resource, authorization-server metadata,
> `authorization_endpoint`, `token_endpoint`, AND `registration_endpoint` are each re-checked against
> the allowlist. Read them yourself before shipping:
> ```bash
> B=https://mcp.vendor.com   # the discoveryBaseUrl
> curl -s "$B/.well-known/oauth-protected-resource" | jq .authorization_servers   # → real auth server(s)
> AS=$(curl -s "$B/.well-known/oauth-protected-resource" | jq -r '.authorization_servers[0]')
> curl -s "$AS/.well-known/oauth-authorization-server" \
>   | jq '{issuer, authorization_endpoint, token_endpoint, registration_endpoint}'
> ```
> Allowlist the host of every URL that returns (apex domain is fine — matching is exact-or-subdomain).
> No `registration_endpoint` in the doc → the vendor does **not** support DCR; use `static_oauth`
> instead. A worked example — `okta-login.zoominfo.com` (token) and `app.ahrefs.com` (authorize) both
> had to be listed even though the MCP host was `mcp.zoominfo.com` / `api.ahrefs.com`.

### `mcp` (four kinds, or omit)

```ts
// 1. Composio-managed — Composio hosts the per-tenant MCP server.
mcp: { kind: 'composio_managed', toolkitSlug: '<slug>',
       authConfigIds: { dev: 'ac_...', prod: 'ac_...' },
       mcpServerIds:  { dev: '...',   prod: '...' },
       transport: 'streamable-http' }

// 2. Vendor-hosted — the vendor's own first-party MCP.
mcp: { kind: 'vendor_hosted', mcpUrl: 'https://mcp.vendor.com', transport: 'sse' | 'streamable-http' }

// 3. Sidecar — a Liftoff-built MCP sidecar (REST client + hand-authored schemas).
mcp: { kind: 'sidecar', sidecarPath: '/vendor', allowedEgressDomain: '*.vendor.com' }

// 4. Customer-hosted — URL resolved per tenant from custom_mcp_servers / tunnel routes.
mcp: { kind: 'customer_hosted', transport: 'streamable-http' }

// (omit `mcp` entirely for native-REST connectors)
```

`MCP_SERVER_REGISTRY` and the `ALLOWED_MCP_DOMAINS` / `VENDOR_HOSTED_ALLOWED_HOSTNAMES` allow-lists are
projections of this — but the allow-lists are also static safety lists: a `vendor_hosted` URL must be on
`VENDOR_HOSTED_ALLOWED_HOSTNAMES` (mcp-registry-conformance.ts) or the conformance test fails.

---

## 4. Recipes by type

Every recipe ends with §5 (cross-cutting wiring) and §6–8 (gates, deploy, verify).

### A. Composio-managed (the most common path)

1. **Provision Composio resources** (writes `config/composio-resources.json` — generated, never
   hand-edit):
   ```bash
   export COMPOSIO_API_KEY_DEV="$(gcloud secrets versions access latest --secret=composio-api-key --project=YOUR_CONTROL_PROJECT_STAGING)"
   export COMPOSIO_API_KEY_PROD="$(gcloud secrets versions access latest --secret=composio-api-key --project=YOUR_CONTROL_PROJECT)"
   npm run composio:bootstrap-toolkit -- --slug=<composio_slug>           # OAuth2 managed (default)
   npm run composio:bootstrap-toolkit -- --slug=<composio_slug> --auth-scheme=API_KEY   # API key
   ```
   Pass the keys via env (ADC reauth often fails). **The bootstrap's MCP-server create is NOT
   re-run-idempotent** (duplicate-name 400 on re-run); if you lose `composio-resources.json`,
   hand-write the record from the recorded ids + fetch scopes from `GET /auth_configs/{id}`.
   Check `composio_managed_auth_schemes` on the toolkit: non-empty → managed OAuth; empty + API_KEY →
   user supplies the key.
2. **Catalog entry** (`connectors.ts`): `mcp.kind: 'composio_managed'` with the real ids; `auth` =
   `api_key` (key connectors) or the `COMPOSIO_MANAGED` `static_oauth` placeholder (OAuth connectors).
3. **API_KEY connectors only**: add a connect-form entry to `API_KEY_CONNECTOR_CONFIGS` in
   `src/oauth/apikey-router.ts` (§5.1). OAuth connectors need nothing here.
4. **Billing allow-lists** (§5.6) — REQUIRED or you leak OU cost.
5. **HITL classification** (§5.7), **capabilities** (§5.2), **frontend** (§5.8) as needed.

6. **Composio overlay (REQUIRED)** — post-cutover, a `composio_managed` connector's tools come from
   **`@liftoffos/composio-overlays`** (a `schemas/<slug>.ts` + `overlays/<slug>.ts` pair), **not** from
   the live MCP server. Without an overlay the connector authenticates but exposes **zero tools**
   (connects-but-toolless). The package lives in `liftoff-platform-backend/packages/composio-overlays`;
   author the overlay with its generator, which copies each tool's REAL Composio input schema and
   refuses to emit a fabricated slug:
   ```bash
   # in liftoff-platform-backend/packages/composio-overlays
   COMPOSIO_API_KEY=... npm run scaffold:connector -- --slug=<composio_slug> --tools <curated.json>
   npm run validate:slugs    # every schema slug must exist in live Composio (publish gate)
   npm run validate:schemas  # every schema must be LLM-tool-API valid, else tool-gateway won't boot (publish gate)
   ```
   Then bump the package version, publish, and bump the `^x.y.z` dep in connector-service + tenant-runtime.

Do **not** hand-author slugs, and do **not** add a `connector-functions-registry` entry — that registry
is for native/sidecar tool schemas, not Composio. Use a recent overlay (e.g. `reddit`, `gong`) as the
template. `historyReads` require a matching overlay history mapping (§5.4) or connector-service boot
hard-fails.

### B. Vendor-hosted MCP (preferred when it exists)

1. Catalog entry with `mcp.kind: 'vendor_hosted'`, `mcpUrl`, `transport`.
2. **MCP-egress allowlists (tool-call time).** Add the `mcpUrl` host to `VENDOR_HOSTED_ALLOWED_HOSTNAMES`
   (mcp-registry-conformance.ts) **and** `ALLOWED_MCP_DOMAINS` (mcp-server-registry.ts).
3. `auth`: `api_key` (user pastes a vendor token → apikey-router config, §5.1), `static_oauth`
   (platform OAuth → an oauth-provider, §3), or `dcr_oauth` (dynamic client registration via `dcr.ts` — §3).
4. **DCR discovery allowlist (connect time) — `dcr_oauth` ONLY, and DON'T skip it.** Add every host the
   vendor's live discovery docs reference to `ALLOWED_DISCOVERY_DOMAINS` (`src/oauth/discovery.ts`). This
   is a THIRD allowlist, separate from step 2 — the two in step 2 gate runtime tool calls; this one gates
   the OAuth handshake. Miss it and every "Connect" throws `ssrf_blocked` → "failed to connect" toast,
   green build and all. See the boxed `dcr_oauth` note in §3 for the exact hosts to read and why the MCP
   host alone is not enough. The `connectors.test` discovery-host guard (§6) catches a missing *base* host,
   but downstream auth-server hosts still need manual listing.
5. No billing allow-list (zero per-call cost). Capabilities/polling/HITL as needed.

### C. Sidecar (most work — only when volume/credential-custody justifies it)

1. Build the REST client + hand-authored MCP tool schemas in the MCP-sidecar service
   (`sidecarPath` is the path segment the tool-gateway routes to).
2. Catalog entry with `mcp.kind: 'sidecar'`, `sidecarPath`, `allowedEgressDomain` (sandbox egress).
3. `auth` + oauth-provider as needed; capabilities/polling/HITL as needed.

### D. Native REST (no MCP)

1. Write a `buildClient` REST client (`src/clients/<vendor>.ts`) and hand-author `ConnectorFunction[]`
   in `connector-functions-registry.ts` (`<type>: <VENDOR>_FUNCTIONS`).
2. Add the client to the `buildClient` switch in `src/polling/scheduler.ts` (also used by tool dispatch).
3. Catalog entry **without** an `mcp` field; `auth: static_oauth` + an oauth-provider.

### E. Customer-hosted

`mcp.kind: 'customer_hosted'` — the URL is resolved per tenant at runtime from the tenant's
`custom_mcp_servers` row / tunnel route. See the Custom MCP Server flow. Single existing example.

---

## 5. Cross-cutting wiring (which pieces apply — the matrix)

| Piece | Composio | Vendor MCP | Sidecar | Native REST |
|-------|:--------:|:----------:|:-------:|:-----------:|
| 5.1 Connect form / OAuth provider | api_key→apikey-router | api_key→apikey-router, oauth→provider | oauth→provider | oauth→provider |
| 5.2 Capabilities | optional | optional | optional | optional |
| 5.3 Polling (events) | via composio client/proxy | via REST/MCP client | via sidecar/REST client | via REST client |
| 5.4 historyReads | overlay-gated | yes | yes | yes |
| 5.5 Billing allow-lists | **REQUIRED** | no | no | no |
| 5.6 HITL classification | yes | yes | yes | yes |
| 5.7 Frontend (union + icon) | yes | yes | yes | yes |

### 5.1 Connect form (`apikey-router.ts`) / OAuth providers

For `api_key`/`basic` connectors add a per-connector entry to `API_KEY_CONNECTOR_CONFIGS`. Each field
maps to a Composio auth-scheme field via `composioField` (`generic_api_key`, `generic_id`, `region`,
`subdomain`, `bearer_token`, …):

```ts
<type>: {
  displayName: 'Vendor',
  fields: [
    // host-templated vendors only (Freshdesk/Shopify/Pipedrive/Datadog…):
    { name: 'subdomain', label: 'Account Subdomain', type: 'text', required: true,
      placeholder: 'yourco', composioField: 'subdomain', composioNormalize: 'subdomain' },
    { name: 'apiKey', label: 'API Key', type: 'password', required: true,
      placeholder: 'Your Vendor API key', composioField: 'generic_api_key' },
  ],
},
```
- `composioNormalize: 'subdomain'` strips `https://…/path` → first DNS label (prevents
  `acme.vendor.com.vendor.com` host-doubling).
- `composioValueMap` maps a fixed set of user inputs → Composio values (e.g. Datadog region
  full-host → region code).
For real OAuth, add `src/credentials/oauth-providers/<vendor>.ts` (refresh + identity) and register it.

**Check the Composio auth MODE, not just the field names** — these two bite silently and pass every
build (they only fail at connect time):
- **BASIC vs API_KEY.** Some toolkits authenticate with HTTP Basic (username + API-key-as-password).
  Look up the toolkit's mode: `GET https://backend.composio.dev/api/v3/toolkits/<slug>` →
  `auth_config_details[].mode`. If it's `BASIC`, you MUST set `composioAuthScheme: 'BASIC'` on the
  config (see `mixpanel`/`clicksend`) — otherwise the connect submits `AuthScheme.APIKey` instead of
  `AuthScheme.Basic` and the connection fails. Having `username`+`password` fields is NOT enough.
- **Enum/region casing.** Fields like `region` are case-sensitive — Composio's New Relic field wants
  `'US'`/`'EU'` (uppercase). Read the field's `description` from the same toolkit endpoint and either
  prompt for the exact casing or add a `composioValueMap: { us: 'US', US: 'US', eu: 'EU', EU: 'EU' }`
  to normalize. A lowercase value silently 4xx's at connect.

### 5.2 Capabilities (a PROJECTION — just tag the connector)

Add `capabilities: [{ capability: '<existing_cap>', requiredScopes: [...] }]`. The capability picker,
the `data_table`/`crm`/etc. groups, and template binding are all derived from this. Use **existing**
capability keys (see `connector-capabilities.ts` / proto). A connector can satisfy many capabilities.
A capability key declared by a functional connector must exist in the proto `ConnectorCapability`
enum (`src/catalog/__tests__/capability-proto-parity.test.ts` fails otherwise): `getCapabilityGroups`
silently drops a key with no enum value, so the tile would resolve to nothing. To add a new key,
add the enum value in liftoff-proto (`liftoff/connector/v1/types.proto`), publish `@liftoffos/proto-gen`,
and bump the dependency here before tagging the connector.

**Don't leave a connector untagged when an existing capability fits.** A missing tag is invisible to
the build but means the connector never surfaces under its capability tile and never auto-binds to
templates that require it (the "swap any app" model breaks for that group). Before shipping, check
whether an analog already exists: a scraper → `web_scraping`, an Airtable-like → `data_table`, a
to-do app → `project_management`, a commerce platform → `e_commerce`, a chat/messaging app →
`messaging`/`team_chat`. Genuinely niche tools with no analog are correctly left untagged.

### 5.3 Polling / reactive events (orthogonal to tool dispatch)

Two reactive mechanisms, both declared on the catalog `polling[]` entry.

**A. Polling** (`email.received`, `candidate.created`, …) — the ~60s scheduler calls `list()`:

1. `polling: [{ entityType, eventTopics, listImplemented: true }]` in the catalog.
2. **`composio_managed` connectors → the generic poll framework (preferred, ~10 lines).** Add one
   data-driven `ComposioPollSpec` entry to [`src/polling/composio-poll-spec.ts`](../src/polling/composio-poll-spec.ts):
   the Composio `action` (or HTTP `proxy`), `recordsPath`, `idField`, a `since` spec
   (`server | sortDesc | none`), a `pagination` spec (`page | offset | cursor | afterId | none`), and a
   `fields` map. A single `ComposioGenericPollClient` + `ComposioGenericNormalizer` interpret it — **no
   bespoke client or normalizer.** `getPollSpec()` (the `buildClient` default branch) and the
   `normalizers/index.ts` loop wire it automatically; the entity schema is derived from `fields`.
   **Every field MUST be doc-verified** — Composio docs → the vendor's API reference → the vendor's
   official GitHub client, in that order — never guessed. If a shape can't be established from any
   source, leave `listImplemented:false`. `scripts/probe-poll-spec.ts` drafts a spec from the Composio
   input schema and WARNs on anything unresolved (e.g. header-only cursors).
3. **Non-composio or multi-surface connectors → a bespoke client** whose `list(entityType,
   {since, pageToken})` fetches records, wired in the `buildClient` switch in `src/polling/scheduler.ts`,
   plus a registered normalizer. `close`/`pipedrive` (one-off payload shapes) and `intercom`/`gong`/`jira`
   (which also serve on-demand `read()`/browse) stay bespoke.
4. **Invariant (enforced by `normalizers/__tests__/registration.test.ts`): `listImplemented:true`
   requires a registered entity schema for the *polled* entityType.** The generic normalizer keys its
   schema by `entityType` automatically; a bespoke normalizer must register under the same `entityType`
   the catalog polls (Outlook's normalizers emit `Message`/`Event` but the catalog polls
   `Email`/`CalendarEvent`, so `normalizers/index.ts` aliases the schema under the polled key). Missing
   schema → the scheduler skips + distill can't reference the entity.
- **`listImplemented:false`** = topics documented, no poller runs (scheduler skips). Don't set `true`
  without a spec/client + a normalizer/schema, or the scheduler logs "no client" / "no normalizer".

**Generic-spec quirks:** since-formats `iso | dateOnly | unixSec | unixMs | pipedriveDateTime`; a
header-only cursor (Composio strips response headers) → single page + a documented note; `pollIntervalMs`
throttles low-velocity entities (e.g. candidates at 5 min) to cut Composio call volume; `versionField`
versions a record on a different field than the since filter (PagerDuty filters `created_at` but a status
change bumps `updated_at`); `fromTag` extracts a scalar from a `key:value` string array (Datadog tags).
**Not every composio_managed connector is poll-addressable:** those whose only list action needs a
per-resource scope the poller can't supply (bitbucket needs a repo, facebook a page_id, figma a
project_id, reddit a subreddit) stay `listImplemented:false` with a documented reason.

**B. Event triggers** (Composio push/poll triggers — `CLICKUP_TASK_CREATED`, …) — **the catalog is the
single source of truth.** Add `eventTrigger: { slug, triggerConfig? }` to the `polling[]` entry. That ONE
declaration drives BOTH connector-service's arming registry (`deriveTriggersFromCatalog` →
`composio.triggers.create` on webhook enable) AND tenant-runtime's slug→`(source, entityType)` dispatch
(derived from the fetched catalog at startup). The two tables can no longer drift. An entity can be
event-only (`listImplemented:false` + `eventTrigger`); the polled `entityType` chosen here is what TR
dispatches to, so match it to the routing intent.

### 5.4 historyReads

`historyReads: [{ entityType, idDescription, description }]` auto-generates "read a thread/conversation"
tools. **For `composio_managed` connectors this HARD-FAILS unless the toolkit has an overlay in
`@liftoffos/composio-overlays`** (connector-functions-registry enforces overlay coverage). If there's
no overlay, omit `historyReads` — the live MCP's `GET_*` tool covers it.

### 5.5 Billing allow-lists (composio_managed ONLY — REQUIRED)

A `composio_managed` connector incurs per-call OU cost. Add `'<type>'` to **both** (and update both pin
tests — they assert an exact sorted set):
- `liftoff-tenant-runtime` → `COMPOSIO_MANAGED_TYPES` in `src/billing/composio-call-reporter.ts`
  (+ `__tests__/composio-call-reporter.test.ts`).
- `liftoff-platform-backend` → `COMPOSIO_MANAGED_CONNECTOR_TYPES` in
  `src/internal-api/platform-tools-router.ts` (+ `__tests__/composio-managed-types.test.ts`).
**Miss this and the OU cost is silently dropped** (PB 400-rejects unknown types; the TR reporter is
fire-and-forget). Vendor/sidecar/native connectors do **not** go in these sets.

### 5.6 HITL classification (platform-backend)

Tools default fail-secure (write + sensitive + destructive → HITL on every call) until classified.
The seed is written BEFORE the connector ships, from the vendor's public tool inventory, with
Liftoff holding no vendor account, key or token:
```bash
# 1. Harvest the vendor's tool inventory into src/catalog/vendor-mcp-inventory/<type>.json
npm run harvest:vendor-mcp -- --connector <type> --source live            # unauthenticated tools/list
npm run harvest:vendor-mcp -- --connector <type> --source docs --url <docs page>
npm run harvest:vendor-mcp -- --connector <type> --source docs --read-only-scopes --url <docs page>   # *:read scopes only → every tool is a read
npm run harvest:vendor-mcp -- --connector <type> --source oss --repo <owner/name> --commit <sha> --placeholder-env TOKEN=x
npm run harvest:vendor-mcp -- --connector <type> --source api-reference --url <llms.txt>   # MCP mirrors the public API, no tool list published
# 2. Classify from the inventory (annotations / HTTP method / scope proof decide first; the LLM
#    relay decides the rest) and emit the SQL + a review sheet
npm run classify:tools -- --connector <type> --from-inventory src/catalog/vendor-mcp-inventory/<type>.json
# composio_managed: the overlay is the registry
npm run classify:tools -- --connector <type> --from-registry
```
Paste the SQL into a new `liftoff-platform-backend/migrations/NNN_<type>_tool_classification.sql` and
commit the review sheet the script writes under `docs/vendor-mcp-classification-review/<type>.md`
after a human pass. The sheet names the evidence that decided each tool; a row with a review note
is one where the vendor states read-only and the name rule refused it, which a manual override
settles. `src/catalog/__tests__/vendor-mcp-inventory-age.test.ts` fails when an inventory is older
than 120 days, so re-harvest and re-seed on that cadence. `--token <connector-service-token>` remains for refreshing an inventory from a
connection a person owns; it is not the way a new connector gets its seed. Only a connector that is
`coming_soon` goes in `COMING_SOON_OR_NOT_REQUIRED` in
`liftoff-platform-backend/src/__tests__/smoke/classification-coverage.test.ts`; `CLASSIFICATION_PENDING`
is frozen debt for the types that predate the harvester, not a place for a new type.

### 5.7 Frontend (`liftoff-react`)

- Add `'<type>'` to the `ConnectorType` union in `src/services/connections.ts`.
- Add the brand icon to `src/components/icons/IntegrationIcons.tsx` keyed by type. Grab the official
  logo from `https://logos.composio.dev/api/<slug>`, convert to a TSX component (camelCase
  `fill-opacity`/`stop-color`/`stop-opacity`, drop fixed width/height). `getIntegrationIcon()` falls
  back to a generic icon, so a missing icon won't break — but add a real one.
- The grid is catalog-driven; no other React change. Note `localhost:5173` uses MSW mocks by default —
  test real connections on **deployed dev**.

---

## 6. The CI gates that WILL block you

| Gate (Cloud Build step / test) | Trigger | Fix |
|--------------------------------|---------|-----|
| `check-connector-docs-drift` | added/changed a catalog entry | `npm run gen:connector-docs` and commit `docs/CONNECTORS.md` |
| `composio-resources-parity.test` | composio_managed entry | catalog ids must equal `composio-resources.json` (bootstrap writes it) |
| `connectors.test` placeholder check | composio_managed with `<from-phase-0>` ids | paste real ids (placeholder ids = non-functional / `coming_soon`) |
| billing pin tests (TR + PB) | composio_managed | add to BOTH sets + update both sorted expected arrays |
| `classification-coverage.test` (PB) | new functional type | seed migration OR add to `CLASSIFICATION_PENDING` |
| `connectors.test` union check | any new type | add to `ConnectorType` union in `src/types.ts` |
| `connectors.test` DCR discovery-host check | `dcr_oauth` entry | add the `discoveryBaseUrl` host to `ALLOWED_DISCOVERY_DOMAINS` (discovery.ts) — §4B step 4. (Guards the base host only; downstream auth-server hosts are not offline-checkable.) |
| capability-map test | tagged capability | only functional connectors appear; placeholder-id entries are filtered |

---

## 7. Build, deploy, promote

**Local CI (per touched repo), in order:** `npm run lint && npm run typecheck && npm test && npm run build`.

**Deploy ordering matters:**
1. Push `liftoff-connector-service` to `main` → dev build/deploy. It is the source of truth, so it goes first.
2. **After** connector-service is deployed, run `npm run sync:connectors` in `liftoff-platform-backend`
   (it reads the **deployed** catalog over HTTP → regenerates the static fallback cache). Commit the result.
3. Push `liftoff-tenant-runtime` + `liftoff-platform-backend` to `main` → dev.
4. Push `liftoff-react` (deploys from `main` via GitHub Actions).

**Prod** is gated on the `release` branch for PB / TR / connector-service (the `*-prod` triggers fire
on `^release$`). Promote each repo with `git merge main --no-ff` onto `release` and push. (connector-service's
prod build includes a `rpc-hop` latency benchmark that is **flaky** — if it fails on latency, re-run the
trigger, don't "fix" it.) Follow each push through to a healthy deploy.

---

## 8. E2E verification (required — unit tests are not enough)

Connect the connector on **deployed dev** (`/connections`), run an agent tool call, and confirm a
`cost_attribution_events` row with `source='composio_mcp'` (for composio_managed — proves dispatch +
billing). For Composio execution checks: `composio.tools.execute(slug, { userId: TENANT_ID,
connectedAccountId, arguments, dangerouslySkipVersionCheck: true })` — `userId` MUST be the
connected-account owner (`GET /api/v3/connected_accounts/{id}.user_id`) or you get
`ConnectedAccountEntityIdMismatch`. **Validate polling/normalizers against REAL connected-account data,
not synthetic** (see §9).

---

## 9. Hard-won gotchas

- **Composio structured actions can be broken — fall back to the proxy.** Some Composio *actions*
  (`tools.execute`) fail server-side pydantic validation on legit vendor `null` fields (e.g. Intercom
  `INTERCOM_LIST_CONVERSATIONS` chokes on `source:null`). The **proxy** (`composioProxyRequest` /
  `tools.proxyExecute` → raw vendor REST) returns the response untouched. Don't conclude "the connector
  can't do X" from one failed action.
- **Validate normalizers against real data.** A brand-new "empty" account can still have records, and
  the real REST shape differs from webhook shapes: Intercom returns `null` for absent fields (Zod
  `.optional()` rejects `null`, not just `undefined` → coalesce), and `tags` as a `{type:'tag.list',
  tags:[]}` object, not an array. Probe live via a throwaway jest test (ts-jest resolves the repo's
  `.js` imports; standalone ts-node does not).
- **Switching an existing NATIVE connector → composio_managed is a real migration, not a tag.** It must
  re-point any native code paths to Composio, drop `historyReads` (overlay hard-fail), relax cred guards
  to accept `composioConnectedAccountId`, and add billing allow-lists. See the Intercom switch.
- **Capabilities/types/cache are projections** — never hand-edit `CONNECTORS.md`, the static cache, or
  the display-name/types lists; regenerate them.
- **getConnectorFunctions = 0 is a red herring** for composio/vendor MCP connectors — tools surface
  from the MCP at runtime, not the function registry.
- **Auth bugs pass every build — verify the auth shape from docs, no demo account needed.** A green
  CI does not mean a connector can connect. Cross-check each api_key/basic config against the toolkit's
  *declared* Composio auth (`GET /api/v3/toolkits/<slug>` → mode + field specs) and the vendor's auth
  docs. This catches the silent connect-time failures field-name checks miss: wrong auth **mode**
  (BASIC submitted as APIKey — see §5.1), case-sensitive enum/region values, and missing host fields.
  A live connect only proves one token; doc verification covers the whole batch.
- **A `vendor_hosted` + `dcr_oauth` connector needs THREE allowlists, not two — and it "connects" nowhere
  until the third is set.** The two MCP-egress lists (`VENDOR_HOSTED_ALLOWED_HOSTNAMES` +
  `ALLOWED_MCP_DOMAINS`, §4B step 2) gate runtime tool calls; `ALLOWED_DISCOVERY_DOMAINS` (discovery.ts,
  §4B step 4) gates the OAuth handshake. Wiring the first two but not the third leaves a connector dead:
  catalog and MCP lists correct, every build green, and yet every connect "failed to connect" because
  `resolveAuthServerUrl` threw `ssrf_blocked` on the first discovery URL. Compounding it: the OAuth dance spans multiple hosts —
  the token endpoint (`okta-login.zoominfo.com`), authorize endpoint (`app.ahrefs.com`), and auth server
  (`mcp-auth.similarweb.com`, `login.commonroom.io`) are all DIFFERENT hosts from the MCP endpoint, and
  each is re-checked. Read the vendor's live discovery docs and allowlist every host (§3 boxed note). The
  `connectors.test` guard now fails a missing base host, but downstream auth hosts are still on you.
- **A new NATIVE (first-party client) connector needs drift coverage, not just request tests.** For
  native HRIS/REST clients (not composio_managed), add it to `src/catalog/native-hris-types.ts` and
  ensure at least one read tool carries a `responseSchema` (codegen emits it for a fetchable spec;
  hand-author the top-level container otherwise) — else `native-hris-drift-coverage.test.ts` fails
  unless you add it to the explicit `AWAITING_DRIFT_SCHEMA` backlog. Offline request-conformance,
  auth-handshake, and fixture-contract coverage live in `src/contract-tests/` +
  `src/clients/__tests__/native-hris-auth.test.ts`. See the README "Native HRIS client verification".

---

## See also
- README → "Native HRIS client verification" — the offline-conformance + drift + capture layers
- `docs/INTEGRATION_TESTS.md` — the response-capture integration test + harness limitations
- Platform-backend side: `liftoff-platform-backend/docs/runbooks/ADDING_A_CONNECTOR_BACKEND.md`
- `docs/CONNECTOR_OAUTH_SETUP.md` — OAuth app setup specifics
- `docs/CONNECTOR_EVENT_TOPIC_ONBOARDING.md` — polling topics + distillation
- `docs/CONNECTOR_SOURCE_FLIP.md` — flipping a connector's source (native ↔ composio)
- `docs/ARCHITECTURE.md` (canonical, in platform-backend) — system-wide data flows
