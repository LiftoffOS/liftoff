# liftoff-proto

Everything runs in your own cloud project, on your own credentials, and every
hostname is something you configure. The code throws rather than falling back
to a default, because a default here would point at infrastructure that is not
yours.

Licensed under [Apache-2.0](LICENSE). The licence grants no trademark rights:
the Liftoff name and logo are not licensed for use as the name of what you ship.

Canonical protobuf service contracts across the Liftoff platform. Every service
(connector-service, governance-engine, tenant-runtime, platform-backend) depends
on generated stubs from this repo. No service defines its own wire format.

## Layout

```
liftoff/
  event/v1/          Common shapes: TenantContext, Pagination, Error,
                     LiftoffEvent envelope, EventType enum (no service)
  billing/v1/        BillingService RPCs + billing domain types
  connector/v1/      ConnectorService RPCs + connector domain types
  developer_proxy/v1 DeveloperProxyService RPCs (API-key proxy)
  governance/v1/     GovernanceService RPCs + HITL/admission/ledger types
  platform/v1/       TenantRuntimeService (platform-backend → tenant-runtime)
                     and BrowserSessionsService RPCs + tenant/agent types
  workforce/v1/      WorkforceService RPCs (workforce plans / CAIO)
```

Eight domain packages, each with its own service (except `event/v1`, which holds
shared shapes and the event envelope). `platform/v1` carries two services:
`TenantRuntimeService` and `BrowserSessionsService` (21 RPCs for agent-driven
browser sessions: list/get/create/ensure/end sessions, pause/resume, stream
events, goto, get page state, run a browser task, list takeover activity,
list browser activity, snapshot the page, act on it, ask the person to take
over, point at a control, set the viewport, list the session's downloads and
fetch a file out of it).

## Non-proto modules

In addition to the generated Connect-RPC stubs, this package publishes a small
set of hand-written modules that are shared across services.

### `@liftoffos/proto-gen/dist/redaction`

Source: `gen/ts/redaction.ts`. Canonical PII pattern set shared by harvest
pre-LLM scrubbing, governance audit-log sanitization, and platform-backend
export anonymization. Best-effort, pattern-based defense-in-depth — NOT a
re-identification-bounded de-identification boundary.

```ts
import {
  redactPii,
  redactPiiWithCounters,
  redactPiiDeep,
  REDACTION_VERSION,
} from '@liftoffos/proto-gen/dist/redaction';
```

| Pattern | Token |
|---|---|
| JWT | `[REDACTED_JWT]` |
| `Bearer <token>` | `Bearer [REDACTED_TOKEN]` |
| AWS access key (`AKIA…`) | `[REDACTED_AWS_KEY]` |
| SSN (formatted `123-45-6789`) | `[REDACTED_SSN]` |
| 9-digit run (non-digit-bounded) | `[REDACTED_SSN]` or `[REDACTED_ROUTING]` (ABA-checksum-validated) |
| Credit card 13–19 digit | `[REDACTED_CC]` (Luhn-validated; failed Luhn passes through) |
| IBAN | `[REDACTED_IBAN]` |
| Email | `[REDACTED_EMAIL]` |
| Phone (separator-required) | `[REDACTED_PHONE]` |

API surface:

| Function | Use case |
|---|---|
| `redactPii(text)` | Single string scrub. Returns the redacted string. |
| `redactPiiWithCounters(text)` | Same as `redactPii` but also returns per-pattern hit counts (for audit metadata). |
| `redactPiiDeep(value)` | Recursive walk of any JSON-shaped value; non-mutating. |
| `REDACTION_VERSION` | Semver string. Recorded in audit rows / export blob metadata so downstream consumers can detect pattern-set drift. |

**Bump policy**: PATCH — narrowing/widening an existing pattern; MINOR — new
pattern added; MAJOR — pattern removed or replacement token renamed.

**Note on the import path**: consumers use `@liftoffos/proto-gen/dist/redaction`
(explicit dist path) rather than the cleaner `/redaction` subpath because
several downstream services still use classic node `moduleResolution`, which
does not honor the package's `exports` map.

### `@liftoffos/proto-gen/event-schemas`

Source: `event-schemas/index.js` + `index.d.ts`. Hand-written JSON Schema
constants (Draft 2020-12) for every Pub/Sub event type the platform publishes.
Plain CommonJS — no tsc step — so the schemas are usable directly by both
publishers and subscribers without depending on `dist/` output.

```ts
import { RuntimeConfigUpdatedPayloadSchema } from '@liftoffos/proto-gen/event-schemas';
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(RuntimeConfigUpdatedPayloadSchema);
```

**Current schemas**:

| Event type | Schema constant | Required fields |
|------------|-----------------|-----------------|
| `tenant.internal_agent.runtime_config_updated` | `RuntimeConfigUpdatedPayloadSchema` | `agentType` (enum: 'agent'\|'workflow'), `hitlLevel` (integer 1..5), `modelConfig`, `execConfig`, `memoryScope` |

**Contract tests**: every event type has paired publisher + subscriber contract
tests:
- Publisher: `liftoff-platform-backend/src/internal-agents/__tests__/runtime-config-updated.contract.test.ts`
- Subscriber: `liftoff-tenant-runtime/src/events/__tests__/runtime-config-updated.contract.test.ts`

A PR that publishes a payload with `hitlLevel:0` fails the publisher test;
a PR that adds a payload field without updating the schema fails too. This
closes the `|| null` falsy-coercion class, which silently dead-letters
messages. See `liftoff-platform-backend/docs/adr/024-no-stubs-reliability.md`.

**Bump policy**: PATCH — narrowing an existing schema; MINOR — new schema
added; MAJOR — required field removed or renamed.

## ConnectorService

As of the BYOK web-tools rollout, `ConnectorService` exposes **14 RPCs**
(`liftoff/connector/v1/connector_service.proto`). All traffic from
`liftoff-platform-backend` and `liftoff-tenant-runtime` that touches a
connector goes through one of these.

| RPC | Purpose | Hot path? | Caller-side cache |
|-----|---------|-----------|-------------------|
| `Execute` | Single connector tool call. | yes | no |
| `ExecuteBatch` | N independent operations in one HTTP round trip. | yes | no |
| `Warm` | Pre-fetch OAuth tokens / warm sidecar sessions at invocation start. | yes (startup) | no |
| `GetCredentials` | Fetch live OAuth credentials for one connector (used by platform-backend MCP session bootstrap). | no | no |
| `GetFunctionalTypes` | Set of connector types with working OAuth + MCP impls. | no | 5-min TTL |
| `GetCapabilities` | Capability → connector types + required OAuth scopes registry. | no | 5-min TTL |
| `ListTools` | Tool schemas for every function a connector type exposes. Callers feed this into Claude's tool-use catalog. | no | 5-min TTL + unchanged-hash short-circuit |
| `ListTenantConnectors` | The tenant's connector instances (rows from the `connectors` table). | no | 5-min TTL |
| `GetMcpServerConfig` | Resolve the MCP server URL + transport for one connector instance. | yes (MCP session bootstrap) | no |
| `PrefetchThread` | Read + format a conversational thread (Slack/Jira/Zendesk/…) for pre-flight context injection. | no | no |
| `LookupTenantConnector` | Per-(tenant, type) connector lookup — cheaper than `ListTenantConnectors` for the BYOK credential resolver. Picks the highest-priority row by status-rank CASE. Returns `{connector_id, status, error_code, present}`. | yes (resolver) | 60s in tenant-runtime credential cache |
| `MarkConnectorError` | Flip a connector to `status='error'` with `error_code` ∈ `{byok_insufficient_funds, byok_invalid_key}` (validated against the migration-014 CHECK constraint). Called when a BYOK web-tool client classifies a vendor response as `insufficient_funds` / `invalid_key`. | no | no |
| `ClearConnectorError` | Restore a connector to `status='active'` and NULL `error_code` after a balance probe reports the vendor account is healthy. Called by the tenant-runtime byok-reprobe worker. | no | no |
| `ListErroredConnectors` | Cross-tenant admin scan of connectors with a given `(type, error_code)`. Uses `withAdminScope` because RLS would block cross-tenant SELECT. Drives the BYOK 15-min recovery loop. | no | no |

Caching conventions for the four cold-path RPCs: in-process cache at the
caller, 5-minute TTL, unchanged-hash short-circuit where the service
returns a content hash and callers skip the decode if it matches the
last response. Fail-open on refresh error (serve stale rather than
erroring the agent turn). Hot-path RPCs are never cached.

Example Connect-RPC client:

```ts
import { createPromiseClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { ConnectorService } from '@liftoffos/proto-gen/liftoff/connector/v1/connector_service_connect.js';

const transport = createConnectTransport({
  baseUrl: process.env.CONNECTOR_SERVICE_URL!,
  httpVersion: '2',
  interceptors: [serviceAuthInterceptor(), oidcAuthInterceptor()],
});
const client = createPromiseClient(ConnectorService, transport);

const res = await client.execute({
  tenantContext: { tenantId, traceId },
  connectorId,
  functionName: 'slack__send_message',
  input: { channel: '#ops', text: 'hello' },
  idempotencyKey,
});
```

## Toolchain

- [`buf`](https://buf.build) — lint, breaking-change detection, code generation
- Connect-RPC (not gRPC) for TS clients — works with standard HTTP/2 on Cloud
  Run, no gRPC-specific proxy config needed
- Generated stubs published as `@liftoffos/proto-gen` to Artifact Registry

## Local workflow

```bash
# Lint
buf lint

# Check for breaking changes against main
buf breaking --against 'https://github.com/acme/liftoff.git#branch=main,subdir=liftoff-proto'

# Generate TypeScript stubs into gen/ts
buf generate
```

## Conventions

- **Package naming**: `liftoff.{domain}.v1` (e.g. `liftoff.governance.v1`)
- **Directory structure mirrors packages**: `liftoff/governance/v1/types.proto`
- **Enum zero values**: always `_UNSPECIFIED` (e.g. `ADMISSION_STATUS_UNSPECIFIED = 0`)
- **Document every field** — each field, enum value, and RPC gets a comment
- **Reserve removed fields** — never reuse a field number
- **Never modify existing field numbers** — add new fields with new numbers

## CI

On every PR and push to `main`:

1. `buf lint` — enforces style
2. `buf breaking` — blocks breaking changes
3. `buf generate` — regenerates stubs and verifies the committed `gen/ts/` is
   up to date with the `.proto` files
