# Ops — Cloud Logging filters for liftoff-tunnel-service

Common filters to triage tunnel issues. Run from the GCP Console (Logs
Explorer, project `YOUR_GCP_PROJECT`) or `gcloud logging read`.

## All terminator logs

```
resource.type = "cloud_run_revision"
resource.labels.service_name = "tunnel-service"
```

## Single tenant — all events

```
resource.type = "cloud_run_revision"
resource.labels.service_name = "tunnel-service"
jsonPayload.tenantId = "<TENANT_UUID>"
```

## Single deployment — connection lifecycle

```
resource.type = "cloud_run_revision"
resource.labels.service_name = "tunnel-service"
jsonPayload.deploymentId = "<DEPLOYMENT_UUID>"
jsonPayload.event =~ "session\."
```

## Failed auth handshakes (likely bad / expired token)

```
resource.type = "cloud_run_revision"
resource.labels.service_name = "tunnel-service"
textPayload =~ "auth (rejected|failed)"
```

## Tunnel routes refresh (Pub/Sub path)

```
resource.type = "cloud_run_revision"
resource.labels.service_name = "tunnel-service"
httpRequest.requestUrl =~ "/_tunnel/pubsub/routes-changed"
```

If you see no entries here for >2 minutes during a known route change, the
push subscription is stuck. Check the topic in `YOUR_GCP_PROJECT`
and the subscription's `numUndeliveredMessages` metric.

## Failed pubsub-driven refresh

```
resource.type = "cloud_run_revision"
resource.labels.service_name = "tunnel-service"
textPayload =~ "pubsub-driven route refresh"
```

## 502s from data plane (tunnel client dropped mid-call)

```
resource.type = "cloud_run_revision"
resource.labels.service_name = "tunnel-service"
httpRequest.status = 502
```

## Cost-attribution emission failures

```
resource.type = "cloud_run_revision"
resource.labels.service_name = "tunnel-service"
textPayload =~ "usage emitter flush failed"
```

## Backend GCLB requests by Host (cross-instance affinity check)

```
resource.type = "http_load_balancer"
jsonPayload.statusDetails != ""
httpRequest.requestUrl =~ "tunnels\\.example\\.com"
```

If requests for the same Host are landing on different Cloud Run revisions
within a short window, session affinity has broken — investigate the GCLB
backend service config.
