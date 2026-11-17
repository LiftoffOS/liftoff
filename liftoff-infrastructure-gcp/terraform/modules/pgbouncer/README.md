# pgbouncer

Shared transaction-mode PgBouncer pool in front of `control-plane-pg`.

## Why a shared instance (not a Cloud Run sidecar)

Plan 0d notes that the sidecar-vs-shared question is to be decided in 0d
implementation. We pick **shared**:

1. Transaction-mode pooling collapses N client connections into a smaller
   pool of PG backends. A sidecar per Cloud Run instance opens its own
   backends, defeating the pool budget — seven services × N replicas would
   blow past control-plane-pg's `max_connections` immediately.
2. Plan 0d fixes per-service quotas (60 / 30 / 30 / 20 / 20 / 20 / 20 = 200).
   Enforcing those in a single `pgbouncer.ini` is trivial; replicating them
   across sidecars with no shared ceiling is not.
3. Single scrape target for Cloud Monitoring (pgbouncer `SHOW STATS`).
4. Cost: one regional MIG of `e2-standard-2` vs. N sidecar containers.

## Inputs

- `control_plane_sql_private_ip` — private IP of the primary instance.
- `service_quotas` — `map(number)` of per-service quotas. The sum MUST
  equal `control_plane_sql_max_connections` (plan 0d). A precondition in
  the instance template fails apply on drift.
- `kms_key_id` — CMEK for the boot disk.
- `pgbouncer_sa_email` — SA the MIG runs as.
- `notification_channels` — attached to the per-service >80% quota alerts.

## Alerts

Cloud Monitoring alert per service when `client_active` exceeds 80% of its
pool quota for 5 minutes (plan 0d).
