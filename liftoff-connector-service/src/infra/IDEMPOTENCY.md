# Idempotency-Key (Phase 0t)

HRBP (liftoff-workforce-service) passes `Idempotency-Key` on every
mutating RPC so that a provisioning-run resume after crash never
double-provisions. Header name matches the Stripe convention.

## Surfaces

| Surface                    | Entry point                                                    | Wiring                                          |
|----------------------------|----------------------------------------------------------------|-------------------------------------------------|
| `Execute` (Connect-RPC)    | `idempotency_key` proto field                                   | `idempotencyInterceptor` on the Connect router  |
| `ExecuteBatch` (Connect-RPC) | `idempotency_key` proto field                                  | `idempotencyInterceptor` on the Connect router  |
| `InitiateOAuth` (REST)     | `POST /api/connectors/oauth/:connectorType/start`              | `withIdempotencyRest` on `oauth/router.ts`      |

## Interceptor wiring (src/server.ts)

```ts
import { idempotencyInterceptor } from './infra/idempotency-interceptor.js';
import { routes } from './rpc/router.js';

const connectMiddleware = expressConnectMiddleware({
  routes,
  interceptors: [
    idempotencyInterceptor({
      extractTenant: (ctx) => {
        // HandlerContext exposes request headers + values set by prior interceptors.
        const tenantId = (ctx as any).values.get(tenantKvKey);
        const userId = (ctx as any).values.get(userKvKey);
        return { tenantId: tenantId ?? null, userId: userId ?? null };
      },
    }),
  ],
});
app.use(connectMiddleware);
```

## REST wiring (src/oauth/router.ts)

```ts
import { withIdempotencyRest } from '../infra/idempotency-rest-middleware.js';

oauthRouter.post(
  '/:connectorType/start',
  withIdempotencyRest({ endpoint: 'POST /api/connectors/oauth/:connectorType/start' }),
  async (req, res) => { /* existing start handler */ },
);
```

## Response semantics

- New key: handler runs, response cached for 24 h, `Idempotency-Key`
  stored with `tenant_id, rpc_name, request_hash`.
- Duplicate key + same hash: cached response returned byte-for-byte
  with `X-Liftoff-Idempotent-Replay: true` (REST only; Connect-RPC
  replays the message without modifying trailers).
- Duplicate key + different hash:
  - REST → `422 idempotency_key_conflict`
  - Connect-RPC → `ConnectError(InvalidArgument, "idempotency_key_conflict")`
- 5xx responses are NOT cached — transient; next retry re-runs the handler.

## Cleanup

`cleanup_expired_idempotency_keys()` (migration 005) is invoked daily
by a Cloud Scheduler job (see
`Liftoff-Infrastructure-GCP/terraform/modules/connector-service/`).
