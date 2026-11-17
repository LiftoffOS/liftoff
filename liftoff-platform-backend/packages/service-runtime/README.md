# @liftoffos/service-runtime

Graceful-shutdown + readiness helpers for Liftoff Cloud Run services.

## Installing the SIGTERM handler

```ts
import { installSigtermHandler, createReadinessRoutes } from '@liftoffos/service-runtime';

const outboxPublisher = new OutboxPublisher(pool, pubsub, {...});
outboxPublisher.start();

const runtime = installSigtermHandler({
  gracePeriodMs: 30_000,
  inflightCountFn: () => app.server.getConnections
    ? app.server.connections   // or whatever in-flight counter your HTTP server exposes
    : 0,
  drainFns: [
    () => outboxPublisher.stop(),
    () => pool.end(),
  ],
});

const routes = createReadinessRoutes(runtime);
app.get('/health', routes.health);
app.get('/ready', routes.ready);
```

## Cloud Run configuration

Set `terminationGracePeriodSeconds: 35` on the Cloud Run service so the
container has the full internal 30 s grace period plus a 5 s buffer
for process exit and platform bookkeeping. Example Terraform:

```hcl
resource "google_cloud_run_v2_service" "svc" {
  template {
    timeout                             = "300s"
    termination_grace_period_seconds    = 35
  }
}
```

## What the handler does

1. On SIGTERM (and SIGINT), flips the readiness flag to `false`. `/ready`
   starts returning `503 Service Unavailable`; `/health` stays `200 OK`.
2. Cloud Run stops routing new requests to the container within ~1 s.
3. Polls the injected `inflightCountFn` until it hits zero, up to
   `gracePeriodMs`.
4. Runs each `drainFns[]` in order (flush outbox, close DB pool, etc.).
5. Calls `process.exit(0)`.

If the grace period expires before in-flight work completes, the process
still exits — the signal from Cloud Run will become SIGKILL 5 s later,
and we prefer an orderly exit over an abrupt one.
