# Technical Design: liftoff-proto

## Purpose

This repository is the single source of truth for all protobuf service contracts
across the Liftoff platform. Every backend service (platform-backend,
tenant-runtime, connector-service, governance-engine, billing,
workforce-service, developer-proxy, harvest-service) depends on generated stubs
from this repo. No service defines its own wire format — all inter-service
communication is defined here.

Changing a proto here regenerates the TypeScript stubs and publishes the
`@liftoffos/proto-gen` package to the GCP Artifact Registry npm repository.
Downstream repos pin a version and are notified via the consumer-fanout workflow
(see below).

The package README (`../README.md`) is the canonical reference for the current
service/RPC surface and the published non-proto modules; this document covers the
build, codegen, and release design.

---

## Proto Package Hierarchy

Eight domain packages live under `liftoff/`. Each package is versioned `v1` and
contains a `types.proto` (domain messages) plus, where it exposes RPCs, a
`*_service.proto`. `event/v1` is the only package with no service — it holds the
shared event envelope and common shapes.

```
liftoff/
  event/v1/
    common.proto              # TenantContext, Pagination, Error, timestamp shapes
    event.proto               # LiftoffEvent envelope, EventType enum

  billing/v1/
    billing_service.proto     # BillingService
    types.proto

  connector/v1/
    connector_service.proto   # ConnectorService (14 RPCs)
    types.proto               # ToolDefinition and connector domain types

  developer_proxy/v1/
    developer_proxy_service.proto  # DeveloperProxyService (API-key proxy)
    types.proto

  governance/v1/
    governance_service.proto  # GovernanceService: Preflight, Authorize, Record, ListApprovals
    types.proto               # HITL / admission / ledger types

  platform/v1/
    tenant_runtime.proto      # TenantRuntimeService (platform-backend → tenant-runtime)
    browser_sessions.proto    # BrowserSessionsService (13 RPCs, agent-driven browser sessions)
    workflow.proto            # Workflow step / hybrid-reasoning messages
    types.proto

  workforce/v1/
    workforce_service.proto   # WorkforceService (workforce plans / CAIO)
    types.proto
```

### Services

| Package | Service | Notes |
|---------|---------|-------|
| `billing/v1` | `BillingService` | |
| `connector/v1` | `ConnectorService` | 14 RPCs; the connector/credential/tool-listing surface |
| `developer_proxy/v1` | `DeveloperProxyService` | API-key management + proxy |
| `governance/v1` | `GovernanceService` | `Preflight`, `Authorize`, `Record`, `ListApprovals` |
| `platform/v1` | `TenantRuntimeService` | Platform-backend → tenant-runtime control RPCs |
| `platform/v1` | `BrowserSessionsService` | 13 RPCs: list/get/create/ensure/end sessions, pause/resume, stream events, goto, get page state, run a browser task, list takeover activity, list browser activity |
| `workforce/v1` | `WorkforceService` | Workforce plans / CAIO |

---

## Code Generation

Codegen is driven by [buf](https://buf.build) v2. The repo emits **TypeScript
only** — there are no Python or Go targets.

### buf.yaml

```yaml
version: v2
modules:
  - path: .
    name: buf.build/liftoffos/liftoff-proto
    excludes:
      - gen       # generated TS stubs, not protos
lint:
  use:
    - STANDARD
  except:
    - PACKAGE_VERSION_SUFFIX   # packages are `liftoff.<domain>.v1`
breaking:
  use:
    - FILE
```

### buf.gen.yaml

A single plugin: `buf.build/bufbuild/es` (protobuf-es v2), emitting into
`gen/ts`. protobuf-es v2 emits messages **and** Connect-RPC-v2-compatible service
descriptors (`GenService<{...}>`) directly into the `*_pb.ts` files, so no
separate `connectrpc/es` plugin is needed.

```yaml
version: v2
plugins:
  - remote: buf.build/bufbuild/es
    out: gen/ts
    opt:
      - target=ts
      - import_extension=js
```

### Non-proto modules

Alongside the generated stubs, `gen/ts` ships a small set of hand-written modules
that are shared across services (e.g. `redaction.ts`, the canonical PII pattern
set, and event-schema helpers). See `../README.md` for the authoritative list and
import paths.

---

## Release Pipeline

The package is published to **GCP Artifact Registry**
(`https://us-west1-npm.pkg.dev/YOUR_CONTROL_PROJECT_STAGING/npm-packages-dev/`),
not the public npm registry. The package name is `@liftoffos/proto-gen`.

GitHub Actions workflows (`.github/workflows/`):

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `ci.yml` | push / PR to `main` | `buf lint` + `buf breaking` (against history); `buf generate` then assert `gen/` has no uncommitted drift; `npm run build` (tsc). |
| `publish.yml` | push to `main` touching `gen/**` or `buf.gen.yaml` | Regenerate, assert no drift, build, then `npm publish --access restricted` to Artifact Registry **only if `package.json` version is newer than the published one** (idempotent — re-runs skip). |
| `consumer-fanout.yml` | after a successful publish | Sends a `repository_dispatch` to each consumer repo with the new version and blocks (via required status) if any consumer's contract check fails. |
| `rolling-compat.yml` | push / PR | Generates stubs for HEAD and the previous published tag and runs N↔N-1 serialize/deserialize round-trips to catch wire-compat regressions `buf breaking` cannot see. |

### Versioning

Version is the `version` field in `package.json` (currently `0.10.0`); `publish.yml`
compares it to the registry and only publishes when it advances.

- **Patch** — new fields on existing messages, new enum values.
- **Minor** — new proto files, new services, new RPC methods.
- **Major** — reserved for a stability guarantee; post-1.0 breaking changes go to
  a new package version (`v1` → `v2`).

---

## Breaking Change Policy

1. `buf breaking` runs on every PR; a failure blocks the PR.
2. Breaking changes include: removing fields, changing field numbers or types,
   renaming packages, and removing RPC methods.
3. When a breaking change is genuinely required:
   - Create a new package version (e.g. `liftoff/governance/v2/`).
   - Leave the `v1` protos unchanged so existing consumers are unaffected.
   - Migrate downstream services one at a time, then deprecate `v1`.
4. Use `reserved` for any removed field numbers to prevent accidental reuse.

---

## Downstream Consumption

Downstream repos consume the stubs from Artifact Registry. They scope the
`@liftoffos` registry in `.npmrc`:

```
@liftoffos:registry=https://us-west1-npm.pkg.dev/YOUR_CONTROL_PROJECT_STAGING/npm-packages-dev/
```

```json
// package.json
{ "dependencies": { "@liftoffos/proto-gen": "^0.10.0" } }
```

```typescript
import { LiftoffEvent, EventType } from '@liftoffos/proto-gen';
import { GovernanceService } from '@liftoffos/proto-gen';
```

After a publish, `consumer-fanout.yml` dispatches to each consumer so its
contract tests run against the new version before the change is considered safe.

---

## Design Decisions

1. **buf over raw protoc** — linting, breaking-change detection, and a module
   system catch mistakes before code generation.
2. **Single repo for all protos** — sharing cross-service shapes (e.g.
   `TenantContext`) is trivial when all protos live together, and avoids the
   circular-dependency risk of splitting them across repos.
3. **TypeScript-only codegen** — every consuming service is Node.js/TypeScript,
   so a single protobuf-es v2 target keeps the toolchain simple.
4. **Artifact Registry over public npm** — the stubs are internal; the private
   `@liftoffos` registry integrates with the existing GCP IAM and CI tokens.
