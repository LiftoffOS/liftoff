# Integration Tests

End-to-end integration tests exercise the connector-service against a real
Postgres database brought up via docker-compose. They live in
`src/__integration__/*.integration.test.ts` and use a dedicated
`jest.integration.config.js` so the default `npm test` stays hermetic
(no docker required).

## Prerequisites

- Docker / Docker Desktop
- Port `55432` free on `127.0.0.1` (the harness Postgres bind)

## Run

```bash
# 1. Start the harness (first run pulls postgres:15 ~ 150 MB)
docker-compose -f docker-compose.integration.yml up -d

# 2. Wait for the container to become healthy (a few seconds)
docker-compose -f docker-compose.integration.yml ps

# 3. Run integration tests (jest auto-waits for PG readiness and verifies the
#    schema the tests exercise has loaded — see REQUIRED_TABLES in integration-setup.ts)
npm run test:integration

# 4. Stop the harness and remove the data volume when done
docker-compose -f docker-compose.integration.yml down -v
```

## What's verified

`rpc-end-to-end.integration.test.ts` spins up the real Express app on an
ephemeral port, points a Connect-RPC client at it, and exercises:

- `GetCredentials` over HTTP → DB row → stubbed Secret Manager → proto
  response with the correct `AuthFlowKind`.
- `Warm` over HTTP → DB query by connector type → partial-failure shape
  (types with zero active connectors show up in `failures`).
- **RLS isolation**: a row seeded under tenant A is invisible to a
  session scoped to tenant B, both at the SQL layer (via
  `withTenantScope`) and at the RPC layer.

Secret Manager is **stubbed at the test layer** (via
`__setSecretManagerClient`) — these tests never touch GCP.

`response-capture.integration.test.ts` exercises the Phase-4 native-HRIS
response capture (`src/observability/response-capture.ts`) against the real
`connector_response_samples` table (migration 018) — behaviour the mocked-pool
unit test can't prove:

- one redacted, envelope-unwrapped sample per `(connector_type, function_name)`;
- **first-write-wins** (`ON CONFLICT DO NOTHING` — a later, larger payload never
  overwrites the first);
- reads only (a write/mutating function records nothing);
- the per-process short-circuit skips the second DB round-trip for the same action.

## Known limitations

The harness Postgres runs everything as `connector_app`, which is the
container's `POSTGRES_USER` and therefore a **superuser + `BYPASSRLS` + table
owner**. Row-level security is *enabled but not forced* on the tables, so this
role bypasses RLS entirely. As a result the RLS-dependent assertions in
`rpc-end-to-end` (tenant-B-can't-see-tenant-A, and the `Warm` visibility case)
**do not pass under the current single-role harness** — exercising them
correctly needs the app pool to connect as a non-owner role that lacks
`BYPASSRLS` (e.g. `connector_user`), which the compose file does not yet
provision. `response-capture.integration.test.ts` is unaffected:
`connector_response_samples` is a cross-tenant, PII-redacted table with no RLS.

## Schema & seeding

Migrations `migrations/*.sql` are mounted into the postgres container as
`/docker-entrypoint-initdb.d`, so **every** `*.sql` runs in lexical order on
first container start (the on-disk migration ordering). `integration-setup.ts`
then asserts the tables the tests need are present (`REQUIRED_TABLES`).

Each test clears its own rows in `beforeEach` by running tenant-scoped
`DELETE`s, so tests do not leak into each other. If the schema ever
drifts, tear down the data volume (`down -v`) and re-run.

## Env the harness uses

The setup script (`src/test-utils/integration-setup.ts`) forces:

| Env | Value |
| --- | --- |
| `DB_HOST` | `127.0.0.1` |
| `DB_PORT` | `55432` |
| `DB_USER` | `connector_app` |
| `DB_ADMIN_USER` | `connector_app` (the admin pool the capture path uses; see limitation above) |
| `DB_ADMIN_PASSWORD` | `connector_app_test` |
| `DB_NAME` | `connector_service` |
| `DB_PASSWORD` | `connector_app_test` (override via `DB_PASSWORD` env) |
| `CONNECTOR_SERVICE_TOKEN` | `integration-test-token` |

## Troubleshooting

- **"integration postgres not ready"** — container isn't up; run
  `docker-compose -f docker-compose.integration.yml up -d` and wait.
- **"integration postgres missing tables"** — the volume has a stale
  schema. Tear it down and recreate: `down -v && up -d`.
- **Port 55432 in use** — another local Postgres is bound. Stop it or
  edit the port mapping in `docker-compose.integration.yml`.
