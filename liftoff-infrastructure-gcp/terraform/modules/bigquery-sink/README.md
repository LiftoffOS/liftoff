# bigquery-sink

BigQuery datasets + Pub/Sub subscriptions feeding Dataflow streaming inserts
(plan 0m).

## What it provisions

- `developer_proxy_usage_${env}` dataset + `developer_proxy_usage_events` table
  (partitioned by day on `occurred_at`; clustered on `tenant_id, user_id, vendor`).
- `developer-proxy-usage-${env}-to-bq` Pub/Sub subscription consumed by the
  Dataflow streaming job. The Dataflow job itself is stood up out-of-module with
  the same service account (Dataflow job terraform resources are bespoke enough
  that they don't belong in the shared sink module).
- Optional `governance_audit_${env}` mirror dataset
  with a matching Pub/Sub subscription, gated behind flags (plan 0m says
  those are optional; not required for launch).

## Inputs

| Name | Description |
|------|-------------|
| `developer_proxy_usage_topic` | Pub/Sub topic name for developer-proxy usage events |
| `dataflow_service_account` | SA used by the Dataflow streaming job |
| `kms_key_id` | Optional CMEK for the datasets |
| `enable_governance_audit_mirror` | Default `false` |
