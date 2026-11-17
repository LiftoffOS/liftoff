# liftoff-connector-service — Architecture

The connector service owns every byte that crosses the boundary between the Liftoff platform and a third-party SaaS API. OAuth flows, Dynamic Client Registration, credential storage, vendor SDK execution, MCP routing, and the tool registry all live here. No other service embeds a vendor SDK — callers invoke `ConnectorService.Execute` and the answer comes back.

One important exception to "nothing else touches tokens": for `vendor_hosted` MCP connectors, and for `code_session`'s git clone, this service issues a token to the caller through `GetCredentials` and the caller talks to the vendor itself. The token leaves the service by design in those two flows, and the request never comes back through `Execute`. See "How connector tools are reached" below, because it decides whether this service can see, gate or rewrite a given tool call at all.

## Scope boundary

```
┌──────────────────┐   RPC: Execute, ListTools, GetCapabilities,
│  tenant-runtime  │ ──▶ GetFunctionalTypes, Warm, GetCredentials
│  (tool-gateway)  │
└──────────────────┘
                        ┌────────────────────────────────────┐
                        │     liftoff-connector-service      │
┌──────────────────┐    │                                    │
│ platform-backend │ ──▶│  RPC router  ←→  Credential vault  │
│  /api/connectors │    │       │                            │
│   /* (proxy)     │    │       ▼                            │
└──────────────────┘    │  OAuth engine  Vendor SDK pool     │
                        │   (static +     (50+ integrations) │
                        │   DCR + api     MCP sidecar hosts  │
                        │   key + inst)   Webhook normalizers│
                        └──────────┬─────────────────────────┘
                                   │
                                   ▼
                        ┌────────────────────────┐
                        │  connector-pg          │
                        │  (Cloud SQL)           │
                        │                        │
                        │  connectors            │
                        │  tenant_connectors     │
                        │  tool_schemas          │
                        │  oauth_states          │
                        │  dcr_registrations     │
                        └────────────────────────┘
```

Callers never see vendor-specific anything. A tool call that reaches `Execute` with a `google_calendar.createEvent` identifier gets routed internally to the Google Calendar SDK; the caller gets back a structured response that matches the proto schema.

## Auth models

Connectors split into four authentication patterns. The model is **fixed per connector type** and cannot be changed at runtime.

| Model | Example vendors | How it works |
|-------|----------------|--------------|
| **Static OAuth** | Google, Slack, GitHub, GitLab, HubSpot | Pre-registered client credentials in Secret Manager; user clicks Connect, is redirected to vendor's consent screen, callback exchanges code for token. |
| **DCR** (Dynamic Client Registration, RFC 7591) | MCP-native servers, Sentry | Server advertises OAuth metadata at a well-known URL; we register a client on the fly per tenant and cache the registration. |
| **API key / key pair** | Anthropic, OpenAI, Stripe (partial) | User pastes the credential into the UI; stored in Secret Manager; no OAuth round-trip. |
| **Instant-connect** | Web search, public RSS | No credentials, no OAuth, always available. |

Credential material is written to the **tenant's own Secret Manager** (cross-project), not to the connector-service project. Read access is scoped to the connector service account only; the tenant runtime has no IAM binding to read these secrets.

## RPC surface

Defined in [liftoff-proto](../liftoff-proto) as `ConnectorService`. Implementations under `src/rpc/`.

| RPC | Purpose | Typical caller |
|-----|---------|----------------|
| `Execute` | Invoke a specific tool on a specific connector for a specific tenant. Resolves credentials, dispatches to the vendor SDK or MCP sidecar, returns structured output. | tenant-runtime tool-gateway |
| `ExecuteBatch` | Same as `Execute`, for parallel same-connector calls (e.g. batch Slack sends). | tenant-runtime tool-gateway |
| `Warm` | Pre-warm credential cache + MCP sidecar for a connector before the first real call. | tenant-runtime during agent startup |
| `GetCredentials` | Short-lived credential fetch (used by webhook normalizers that need to sign outbound callbacks). | internal only |
| `GetCapabilities` | Return the allowlisted operations + auth info for a connector. | platform-backend during distill / template authoring |
| `GetFunctionalTypes` | Map abstract "functional types" (e.g. `messaging`, `calendar`) to concrete connector types. | platform-backend workforce-plans |
| `ListTools` | Full tool schema catalog for a tenant. 5-min in-process cache at callers with unchanged-hash short-circuit. | tenant-runtime on schema resolve |
| `ListTenantConnectors` | Per-tenant list of configured connectors with health status. | platform-backend Connections page |

All RPCs carry `X-Service-Auth` (shared bearer) + an OIDC token. Cloud Run `run.invoker` IAM enforces the network layer; the middleware in `src/security/` validates the shared secret.

### Capabilities and version-control identity

`GetCapabilities` returns the capability → connector-type registry
(`src/catalog/connector-capabilities.ts`), derived at module init from the
`capabilities` field on each catalog entry. The `version_control` capability is
shared by `github` (required scope `repo`) and `gitlab` (required scope `api`):
platform-backend's SWE role templates require the capability rather than a named
connector, so either host satisfies a role.

At connect time both version-control providers also record two non-secret
identity fields into `connectors.config` — `bot_login` (for self-event exclusion:
a role must not react to a PR/MR it authored) and the granted `scopes` (for
required-scope validation). Platform-backend reads these back through this
service's `POST /api/connectors/_resolve` binding-contract lookup, resolving a
bound connector against this DB (the source of truth for OAuth connections)
rather than its own tables. See the README for the full contract.

## Tool schema source of truth

Tool schemas are defined in code alongside each connector's SDK wrapper and flow through `ListTools`. They never leave the image — the old pattern of baking schemas into a `connector_manifests.functions` JSONB column caused stale-per-tenant drift and was removed. Callers hold only a time-bounded in-process cache; a redeploy of this service propagates schema changes to every tenant on the next cache miss.

`getConnectorFunctions(connectorType)` in `src/catalog/connector-functions-registry.ts` is the single entry point for a connector's full tool surface. It merges two sources:

1. **`CONNECTOR_FUNCTIONS[type]`** — manually defined tools (create, update, delete, search, send, etc.)
2. **`buildHistoryTools(type)`** — auto-generated history-reading tools derived from the `historyReads` field on the connector's `LocalConnectorDef` in `connectors.ts`

Each `historyReads` entry produces a `read_<entityType>` tool (e.g. `read_thread`, `read_comments`, `read_activity`) that agents call to fetch full conversation or record history. The generated tool routes to `client.read(entityType, id)` on the connector client — so adding history reading to any connector requires only: (1) add a `historyReads` entry in `connectors.ts`, (2) implement the matching `case` in the client's `read()` method. No registry edits needed.

## How connector tools are reached

A catalog entry's `mcp.kind` decides how a connector's tools are reached, and the three kinds behave very differently. Which one a connector uses is the single most useful thing to know about it, because it determines whether this service is in the data path at all.

**`vendor_hosted`** — the caller connects straight to the vendor's own MCP endpoint. This service resolves the URL and mints the bearer token via `GetMcpServerConfig` / `GetCredentials`, then steps out of the way; it never sees the tool call or its arguments. GitHub (`https://api.githubcopilot.com/mcp/`), HubSpot and Outreach are all this kind. Anything that needs to inspect or rewrite a tool call cannot be built here for these connectors.

**`sidecar`** — `getMCPServerConfig()` rewrites the URL to `${MCP_SIDECAR_URL}${sidecarPath}`, a **remote** HTTP endpoint authenticated with the shared-secret header in `src/mcp/sidecar-secret.ts`. Despite the name, nothing is spawned as a subprocess: `src/mcp/` holds client, credential, circuit-breaker and token plumbing only. 24 catalog entries declare this kind (Salesforce, Salesloft and others).

> **`MCP_SIDECAR_URL` is not set by this service's `cloudbuild.yaml` or the infrastructure Terraform.** `getMCPServerConfig()` returns `null` when it is missing, so every `sidecar` connector resolves to "no MCP config" and falls through to the native-REST path below. Set the variable to point at your sidecar deployment to enable the sidecar kind.

**No `mcp` field** — tool dispatch falls to a native executor in `src/clients/`, driving the vendor REST API from inside this service. `gitlab` is the canonical example: its merge-request tools run over the GitLab v4 REST API via `GitLabClient`, because GitLab's vendor MCP requires a token scope mutually exclusive with the `api` scope the rest of the connector needs (see the README, "Version-control connectors (GitHub + GitLab)"). The absent-`mcp` `null` is also the contract the tenant-runtime tool-gateway keys on to wrap these functions in its in-house SDK MCP server (the same path Jira and Linear take), so native-REST tool calls still run the full governance / HITL pipeline that a vendor-MCP-direct connector would bypass.

Note that a connector can be `vendor_hosted` for agent tool calls and still have a client in `src/clients/`: `github-mcp.ts` exists for reactive polling only and says so at the top, because agent CRUD on GitHub goes through the vendor MCP path instead.

## Event ingestion: webhooks and polling

Reactive connectors reach the platform two ways, and the split is fixed per connector.

**Webhooks** — `src/normalizers/` contains per-vendor payload mappers that translate incoming webhook bodies into a canonical event shape, for the push-capable sources that support them (Google Drive/Gmail, Microsoft OneDrive/SharePoint, Box, Meta, Slack). The raw payload lives briefly in a payload-archive bucket (Cloud Storage, lifecycle policy: 30 days), then the normalizer fans out the canonical event through Pub/Sub to whichever runtime services subscribe. Webhook ingest endpoints verify each caller (HMAC signature or per-connector bearer token).

**Polling** — the background scheduler (~60s loop) drives everything else, including **both version-control connectors**. GitHub and GitLab reactivity is polling over the stored OAuth token: there are no VCS webhook receivers — an earlier webhook path was built and then retired in favor of polling — no webhook secrets, and no GitHub App install. Both hosts publish under the uniform `PullRequest` / `Issue` entity types onto `connector-events-${env}` (a GitLab merge request is published as `PullRequest`), so one software-delivery-team subscription reacts to either host. See the README, "Version-control connectors (GitHub + GitLab)".

## Data

`connector-pg` is a Cloud SQL Postgres instance in `YOUR_GCP_PROJECT`. Schema managed under `migrations/` and applied by the `connector-service-migrate` Cloud Run Job on every deploy.

| Table | Purpose |
|-------|---------|
| `connectors` | Catalog of connector types (static config + schema). |
| `tenant_connectors` | Per-tenant instance of a connector: auth model, credential pointer, health status. |
| `tool_schemas` | Rendered tool schemas exposed via `ListTools`; recomputed on deploy. |
| `oauth_states` | Short-lived state tokens for OAuth callbacks (15-min TTL). |
| `dcr_registrations` | Cached per-tenant DCR client credentials for servers that advertise them. |

Credentials themselves are **not** in `connector-pg` — only pointers. The actual OAuth tokens and API keys live in the tenant's Secret Manager.

## Security perimeter

The service runs inside a VPC Service Controls perimeter (defined in `terraform/modules/connector-service-security/` in Liftoff-Infrastructure-GCP). Outbound egress is restricted to explicit vendor domains per connector; the rest is blackholed. This blocks data exfiltration via an LLM-emitted tool call that tries to talk to an unexpected host.

## Deployment

Single Cloud Run service (`connector-service`) in `YOUR_GCP_PROJECT`. `--no-allow-unauthenticated`, `--vpc-connector serverless-connector`, `--vpc-egress private-ranges-only`. Cross-project callers (tenant runtimes) reach it at its Cloud Run URL with OIDC tokens minted from their service accounts.

## Related

- Proto definitions: [liftoff-proto](../liftoff-proto)
- Terraform: [Liftoff-Infrastructure-GCP](../liftoff-infrastructure-gcp) — `terraform/modules/connector-service/` + `terraform/modules/connector-service-security/`
- Callers: [liftoff-tenant-runtime](../liftoff-tenant-runtime) (every tool call), [liftoff-platform-backend](../liftoff-platform-backend) (`/api/connectors/*` proxy)
