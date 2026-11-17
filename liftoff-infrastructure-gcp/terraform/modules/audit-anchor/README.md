# audit-anchor

Chain-of-custody anchor bucket for tamper-evident audit logs (plan 0y).

## What it provisions

- GCS bucket `audit-anchors-${env}` with 7-year object-lock
  retention policy and `uniform_bucket_level_access`.
- Dedicated KMS key `audit-anchor-key` (distinct from each service's CMEK,
  per plan 0y).
- Per-service append-only IAM: `roles/storage.objectCreator` scoped via
  IAM Condition to `resource.name.startsWith(...)` for the service's own
  prefix (`<service>/`).
- Operator read-only IAM (`roles/storage.objectViewer`) for the groups
  passed in `operator_readers`.
- Per-service daily Cloud Scheduler jobs that invoke each service's anchor
  Cloud Run Job (which computes `<service>/<yyyy-mm-dd>.hash` — a 3-line
  manifest: partition name, row count, SHA256).

## Inputs

| Name | Description |
|------|-------------|
| `anchor_service_accounts` | `map(service => SA_email)` for append IAM |
| `operator_readers` | IAM members (groups / users) granted read-only |
| `scheduler_sa_email` | SA Cloud Scheduler uses to invoke anchor jobs |
| `anchor_job_urls` | `map(service => Cloud Run Job :run URL)` |
| `enable_scheduler` | Default `true` |
