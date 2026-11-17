# liftoff-developer-proxy

Everything runs in your own cloud project, on your own credentials, and every
hostname is something you configure. The code throws rather than falling back
to a default, because a default here would point at infrastructure that is not
yours.

Licensed under [Apache-2.0](LICENSE). The licence grants no trademark rights:
the Liftoff name and logo are not licensed for use as the name of what you ship.

Developer Proxy — vendor-agnostic API key management and transparent HTTP proxy for
developer coding tools. Owns all BYOK proxy traffic, API key management, rate limiting,
and per-key usage metering for **Claude Code (Anthropic)** and **OpenAI Codex**. Extracted
from `liftoff-platform-backend` as part of the platform-backend decomposition.

Platform-backend forwards `/proxy/*` (raw body) and `/api/claude-code/*` (management) here
unconditionally.

## Supported vendors

| Vendor | Client | Auth header the client sends | Liftoff namespace |
|---|---|---|---|
| **Anthropic** | Claude Code (CLI / Desktop / VS Code) | `x-api-key: liftoff_sk_*` | `/v1/messages`, `/claude-code/v1/messages` (+ `/count_tokens`), `GET /v1/models` (model discovery, never metered) |
| **OpenAI** | Codex CLI | `Authorization: Bearer liftoff_sk_*` | `/codex/v1/responses`, `/codex/v1/responses/compact`, `/codex/v1/models` |

A credential is bound to exactly one vendor (`anthropic` \| `openai`); the proxy enforces
`route vendor == credential vendor == adapter` on every request (a mismatch is a stable 403).
The `liftoff_sk_*` proxy key is accepted from **either** `x-api-key` or `Authorization: Bearer`
so each vendor's native SDK works unmodified.

### Model discovery and liveness (gateway-protocol routes)

Beyond the messages endpoints, two routes back the Claude Code gateway protocol (what the CLI
sends against a custom `ANTHROPIC_BASE_URL`):

- **`GET /v1/models`** — verbatim model-discovery passthrough. Claude Code issues it **only**
  when its CLI env var `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` is set, so it is opt-in on
  the *client*; the route itself is always mounted (the env var is a Claude Code flag, not a
  proxy-side toggle). The handler (`handleVendorGetPassthrough`) resolves the vendor key,
  forwards the `GET` unchanged, and returns the upstream body unchanged through the response
  header allowlist. It is **never metered** — a model listing consumes no tokens, so it writes
  no usage row and emits no billing event (the read-only carve-out to INV-DP-005). It still
  runs inside the auth + per-credential rate-limit sub-app, so it is not an open proxy / DDoS
  vector. Only the plain `/v1/models` path is served; the `/claude-code/`-prefixed variant is
  deliberately **not** added (it would forward that prefix upstream). Codex model discovery is
  the separate `/codex/v1/models` route.
- **`HEAD /`** — an unauthenticated connectivity probe answered with `200` and no body. Claude
  Code sends it against its base URL at startup; answering keeps it from logging a spurious
  failure. It is a root-level liveness route (registered in `server.ts`), outside every vendor
  namespace, and carries no request body.

## What it owns

- **API key management** — developer proxy key CRUD, PKCE setup-token exchange, self-revoke,
  Secret Manager storage. Vendor-neutral: `{ vendor, apiKey }`.
- **Transparent proxy** — forwards requests to the vendor and tees token usage from the
  response. Anthropic bodies pass through byte-for-byte; OpenAI bodies are re-serialized
  through a strict field allowlist in the adapter (see INV-DP-001).
- **Rate limiting** — per-credential request/token rate limits (`{credentialId}:{vendor}`
  bucket), enforced before proxying.
- **Usage metering** — logs every request to `developer_proxy_usage_log`; emits a
  `billing.meter.usage_recorded` outbox event that `liftoff-billing` drains into the single
  `operating_unit_consumed` OU meter.
- **Vendor routing** — `vendor/` adapters (Anthropic, OpenAI) resolved by route + credential.
- **Credentials** — stores the per-key vendor API key (`sk-ant-*` / `sk-*`) encrypted in
  Secret Manager, one secret per proxy key.

## Tracking granularity (limitation, shared by both vendors)

Usage is attributed at the **credential / user** level, plus vendor-supplied **session /
thread / turn** correlation ids captured as Liftoff attributes (`x-claude-code-session-id`
for Claude Code; `session_id` / `thread_id` / `turn_id` / `client_metadata` for Codex).

It is **not** attributed to a specific Liftoff agent or task: the coding-tool CLIs are
transparent clients and do not send the `x-agent-id` / `x-invocation-id` / `x-action-id`
headers that platform-internal callers use, so `agent_id` is null for BYOK proxy rows. This
is a property of the CLI transport, not a per-vendor gap — Codex is exactly as granular as
Claude Code, no more, no less. Per-member/per-credential cost breakdown likewise depends on a
per-credential endpoint from this service (see `getClaudeCodeProxyCosts` in platform-backend).

## Billable terminal states

Every proxied request is written to `developer_proxy_usage_log` with a `lifecycle_status`,
but only the terminal states the **vendor actually bills** are served by the cost-attribution
ingestion feed (`src/usage/`, polled by platform-backend) and therefore charged as Operating
Units. "Logs every request" is not "charges every request".

| `lifecycle_status` | Charged? | Why |
|---|---|---|
| `completed` | Yes | Normal completion (includes an Anthropic `max_tokens` stop, which is itself a completion). |
| `incomplete` | Yes | Hit the token cap (e.g. OpenAI `max_output_tokens`) — full usage was still captured. |
| `aborted_by_client` | Yes | Client aborted mid-stream — the vendor bills the tokens generated before teardown. |
| `timed_out` | Yes | Same as an abort — charged for whatever streamed through. |
| `failed` | No | Provider 4xx/5xx or a rejection — the vendor did not bill it. |
| `transport_error` | No | Never reached the vendor — nothing to charge. |

Cap-hit (`incomplete`) and aborted (`aborted_by_client` / `timed_out`) output **is charged**,
because both OpenAI and Anthropic bill for the output the model produced before the response
stopped. The proxy charges whatever streamed through — accurate input, best-effort partial
output, and a $0 no-op when nothing was captured — and excludes the genuinely non-billed
failures (`failed`, `transport_error`). The set is the `WHERE lifecycle_status IN (...)`
allowlist in `src/usage/routes.ts`. Widening it is **forward-only**: rows are selected by
monotonic `id`, so a change never back-charges rows already behind the ingester cursor. See
INV-DP-008.

## Architecture

```
Claude Code (x-api-key)          Codex CLI (Authorization: Bearer)
        │                                 │
        │   npx @liftoffos/cli setup  /  codex setup  (PKCE setup-token exchange)
        │                                 │
        └───────────────┬─────────────────┘
                        ▼
platform-backend  ──  /proxy/*           ──────────────▶ liftoff-developer-proxy
                  ──  /api/claude-code/* ──────────────▶   (IAM: OIDC on X-Serverless-
                                                            Authorization; client key on
                        ┌───────────────────────────────┐   Authorization/x-api-key)
                        │                                │
          ┌─────────────▼─────────────────────────────────────────┐
          │                liftoff-developer-proxy                │
          │                                                       │
          │  ┌──────────────┐  ┌────────────┐  ┌─────────────┐   │
          │  │  proxy/      │  │rate-limit/ │  │ credentials/│   │
          │  │  + vendor/   │  │(per-cred   │  │(Secret Mgr  │   │
          │  │  (adapters,  │  │ enforcement│  │ key vault,  │   │
          │  │  usage tee)  │  │            │  │ setup tokens)   │
          │  └──────┬───────┘  └──────┬─────┘  └──────┬──────┘   │
          │         └────────────────┬┴───────────────┘          │
          │                          ▼                           │
          │      developer-proxy-pg (Cloud SQL, private IP)      │
          │        developer_proxy_credentials                   │
          │        developer_proxy_usage_log                     │
          │        developer_proxy_vendor_config (per vendor)    │
          │        developer_proxy_setup_tokens                  │
          │                          │                           │
          │                          ▼                           │
          │        outbox_events → Pub/Sub → liftoff-billing     │
          └───────────────────────────────────────────────────────┘
                                     │
                                     ▼ vendor/
                   Anthropic API / Vertex AI   |   OpenAI API (Responses)
```

## Source layout

```
src/
├── proxy/          # Raw-body transparent proxy, SSE usage tee, auth, self-revoke
├── vendor/         # adapter.ts (interface) + anthropic.ts + openai.ts + registry.ts
├── credentials/    # Vendor key storage/retrieval, PKCE setup-token store (DB-backed)
├── rate-limit/     # Per-credential rate limiting (requests/min, tokens/min)
├── billing/        # Meter-event hand-off to liftoff-billing
├── usage/          # Usage-log ingestion feed (platform-backend cost-attribution poller)
├── outbox/         # Outbox publisher/reporter worker
└── infrastructure/ # DB + RLS wrappers, secrets, config, firebase, service-token
```

The vendor layer is the extension point: a new vendor implements `VendorAdapter`
(`classifyOperation`, `buildUpstreamUrl`, `buildAuthHeader`, header allowlists,
`extractCorrelation`, `normalizeRequestBody`, SSE parse/accumulate) and registers in
`registry.ts`. Enablement + allowed models + pricing live per-vendor in
`developer_proxy_vendor_config`.

## Key types

| Type | Description |
|---|---|
| **Personal** | One per user per vendor. Created via PKCE setup-token exchange in the CLI (`setup` / `codex setup`). |
| **Org** | Shared key for a tenant. Admins create; members use. |

Both types store the vendor API key encrypted in Secret Manager (one secret per proxy key,
path `devproxy---{tenantId}---{userId}---{vendor}---{credentialId}`). The proxy fetches and
caches the key on first use.

## Setup-token handoff

Creating a credential mints a one-time setup token stored in `developer_proxy_setup_tokens`
(migration 016 — durable Postgres, not in-memory, so it survives deploys and works across
Cloud Run instances). The CLI-auth page retrieves it (`pending-setup-token`), optionally binds
a PKCE `code_challenge`, and the CLI exchanges it for the `liftoff_sk_*` key + the
environment-specific proxy base URL. Tokens are single-use (consumed via `DELETE … RETURNING`)
with a 30-minute TTL.

## Migrations

`node-pg-migrate`, plain numbered SQL files under `migrations/`, applied by the
`developer-proxy-migrate` Cloud Run job (role `developer_proxy_migrate`, DB `developer_proxy`).

| Migration | Purpose |
|---|---|
| `001`–`006` | Core schema, RLS (per-tenant + per-user), grants, rate-limit + revocation-cache + outbox tables |
| `009` | Rename `byok_*` → `developer_proxy_*` |
| `012` | Reversible `paused` credential state (self-service pause/resume) |
| `014` | Model catalog + usage-log partitions |
| `015` | Seed the OpenAI vendor config (models + pricing) — seeded **disabled**; OpenAI/Codex stays dark until a later migration flips `enabled` |
| `016` | `developer_proxy_setup_tokens` — durable, cross-instance setup-token store |
| `017` | Refresh the OpenAI/Codex model set and **enable the `openai` vendor** — OpenAI/Codex goes live (gpt-5.6 sol/terra/luna trio + gpt-5.4 line) |
| `018` | Restore `gpt-5.3-codex` and expand to the **full Codex family** (gpt-5.3/5.2-codex, gpt-5.1-codex-max / -codex / -codex-mini, gpt-5-codex, codex-mini-latest) alongside the gpt-5.6 trio + gpt-5.4 line |

## Scripts

| Script | Purpose |
|---|---|
| `npm run build` | `tsc` → `dist/` |
| `npm start` | Run the server (`dist/index.js`) |
| `npm run dev` | Watch-mode local dev |
| `npm run migrate` | Run pending `node-pg-migrate` migrations |
| `npm test` | Jest unit tests |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |

## Deployment

Cloud Build auto-deploys on push to `main` (dev) and `release` (prod). The pipeline builds
runtime + migrate images with SHA-only tags, signs with the binauthz attestor (SLSA-3), runs
the migrate job, then deploys the `developer-proxy` Cloud Run service.

The service is deployed `--no-allow-unauthenticated`: management routes are reachable only via
platform-backend's service account (Cloud Run IAM). Platform-backend attaches the OIDC token
on `X-Serverless-Authorization` so the client's `Authorization`/`x-api-key` proxy key survives
the IAM hop. `/proxy/*` is exposed to clients only through platform-backend.

Terraform module: `Liftoff-Infrastructure-GCP/terraform/modules/developer-proxy/`.

### Credential-route authentication (two layers, two trusted callers)

The credential-management routes (`registerCredentialRoutes`) sit behind **two distinct auth
layers**, which are easy to conflate:

1. **Transport — Cloud Run IAM.** The service is `--no-allow-unauthenticated`, so every request
   must carry a valid OIDC token for platform-backend's service account. Platform-backend sends
   it on `X-Serverless-Authorization` so the client's proxy key on `Authorization`/`x-api-key`
   survives the hop. This gate is what makes the routes reachable **only** through
   platform-backend.
2. **Application — who is the acting user.** Inside the service, the credential sub-plugin
   resolves the user via one of two paths, checked in this order (both still require
   `x-tenant-id`):
   - **Service-to-service** — platform-backend sends the shared `X-Service-Token` (resolved from
     `DEVELOPER_PROXY_SERVICE_TOKEN_SECRET`) plus `x-user-id` naming the acting user. On a token
     match the route trusts `x-user-id` and **skips Firebase**.
   - **Browser Firebase JWT** — a direct `Authorization: Bearer <firebase-jwt>`, kept for
     local/legacy use, with a defense-in-depth check that any `tenant_id` claim matches
     `x-tenant-id`.

   The `setup-exchange` route is exempt from both application paths (its one-time setup token is
   the secret).

Before this split the routes accepted **only** the browser Firebase JWT, which made them
effectively unreachable: the transport gate admits only platform-backend's service-to-service
calls, and those carry no browser JWT, so every BYOK key create failed before validation.
Trusting `x-user-id` on the service path is safe **only** behind the IAM gate — this coupling is
captured as INV-DP-009 (bound to INV-DP-007's `--no-allow-unauthenticated`). The `X-Service-Token`
resolver `src/infrastructure/service-token.ts` is shared with the usage ingestion feed
(`src/usage/`).

**Cross-repo:** platform-backend must attach both `X-Service-Token` and `x-user-id` on its
credential-management calls (`src/claude-code-proxy/developer-proxy-client.ts`).

## Local development

```bash
export ARTIFACT_REGISTRY_TOKEN=$(gcloud auth print-access-token)
npm install
export DB_INSTANCE_CONNECTION_NAME=YOUR_CONTROL_PROJECT_STAGING:us-west1:control-plane-pg-dev
export GCP_PROJECT_ID=YOUR_CONTROL_PROJECT_STAGING
npm run migrate
npm run dev
```

## Related

- Platform-backend (caller): `src/claude-code-proxy/developer-proxy-client.ts`,
  `src/claude-code-proxy/proxy-forward-router.ts`, `src/claude-code-proxy/router.ts`
- CLI: `@liftoffos/cli` (`setup` for Claude Code, `codex setup` for Codex)
- Terraform: [Liftoff-Infrastructure-GCP](../liftoff-infrastructure-gcp) — `terraform/modules/developer-proxy/`
- Billing meter events: [liftoff-billing](../liftoff-billing)
