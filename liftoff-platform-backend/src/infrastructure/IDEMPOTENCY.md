# Idempotency-Key middleware (Phase 0t)

The middleware at `src/infrastructure/idempotency-middleware.ts` is the
HRBP-facing idempotency surface. HRBP (in liftoff-workforce-service)
generates `Idempotency-Key = hmac(plan_id || step_id)` and includes it
on every mutating call so that a provisioning-run resume after crash
never double-creates a resource.

## Semantics

| Scenario                                   | Behavior                                                  |
|--------------------------------------------|-----------------------------------------------------------|
| No `Idempotency-Key` header                | Pass through; no persistence                              |
| New key                                    | Run handler; cache status + body + headers (24 h TTL)     |
| Duplicate key + same body hash             | Replay byte-identically; `X-Liftoff-Idempotent-Replay: true` |
| Duplicate key + different body hash        | `422 idempotency_key_conflict`                            |
| 5xx response                               | NOT cached — transient; next retry runs handler           |

## Mounting

```ts
import { withIdempotencyMiddleware } from '../infrastructure/idempotency-middleware'

router.post(
  '/',
  withIdempotencyMiddleware({ endpoint: 'POST /api/internal-agents' }),
  createInternalAgentHandler,
)
router.put(
  '/:internalAgentId',
  withIdempotencyMiddleware({ endpoint: 'PUT /api/internal-agents/:internalAgentId' }),
  updateInternalAgentHandler,
)
```

### Endpoints to wire (Phase 3 prerequisite)

- `POST/PUT/PATCH/DELETE /api/internal-agents`
- `POST /api/agents/from-template`
- `POST/PATCH/DELETE /api/workforce-plans` + `:submit`, `:approve`, `:reject`, `:reopen`
- `PUT /api/entitlements/tenant/:tenantId` + snapshot POSTs
- `PUT /api/person-assignments/:accountId`

The `endpoint` string is `{METHOD} {pathTemplate}` so the cache key is
stable across param variation.

## Storage

`idempotency_keys` table (migration `032` + additive `128` extension):

```
id                 UUID PK
key                TEXT
tenant_id          UUID
endpoint           TEXT
request_hash       TEXT (sha256 of JSON body)
user_id            TEXT NULL   (added in 128)
response_status    INTEGER
response_body      JSONB
response_headers   JSONB NULL  (added in 128)
created_at / expires_at (24h TTL default)
UNIQUE(tenant_id, key, endpoint)
```

The existing `withIdempotency()` helper in `idempotency.ts` is
preserved for the legacy callers (`internal-agents` POST,
`from-template`) that pre-date the middleware. Both paths converge on
the same table and the same 422-on-mismatch semantics.

## TTL cleanup

`cleanup_expired_idempotency_keys()` was provisioned in migration 032.
A Cloud Scheduler job that invokes it daily lives in terraform (see
`Liftoff-Infrastructure-GCP/terraform/projects/platform-control/`).
