# governance-engine

Terraform module for the Governance Engine Cloud Run deployment. Provisions
the service account, Cloud SQL instance (`governance-pg`), and Cloud Run
service that make up the Governance Engine in the control plane.

Admission, HITL, kill-switch and the action ledger live here as a shared
control-plane service rather than inside each tenant runtime.

## What it does

1. **Service account** — Always created. Needed by `governance-iam` for per-
   tenant invoker grants, even before the Cloud Run service is deployed.
2. **Secret Manager access** — `roles/secretmanager.secretAccessor` scoped via
   IAM Condition to `governance-*` secrets in its own project.
3. **Cloud SQL `governance-pg`** — Postgres instance for the action ledger,
   kill-switch state, policy cache, preflight token revocation list. Always
   created (cloudbuild migration job needs the DB before `enabled=true`).
4. **Cloud Run service** — The `governance-engine` deployment with health
   probes, Cloud SQL socket mount, min-instances=1. Conditional on `enabled`.
5. **Platform Backend invoker** — `roles/run.invoker` on the Cloud Run service.

## Inputs

| Name | Description | Default |
|------|-------------|---------|
| `project_id` | Host project (YOUR_GCP_PROJECT) | required |
| `environment` | dev / staging / prod | required |
| `region` | GCP region | `us-west1` |
| `image` | Container image URL | dev image in Artifact Registry |
| `enabled` | Create Cloud Run + invoker IAM | `false` |
| `min_instances` / `max_instances` | Autoscaling bounds | 1 / 10 |
| `platform_backend_sa_email` | SA granted invoker | required |
| `network_id` | VPC for Cloud SQL private IP | default |
| `db_tier` / `db_max_connections` | Cloud SQL sizing | `db-custom-2-4096` / 200 |
| `db_app_password` | Password for `governance_app` SQL user | required, sensitive |
| `env_vars` / `secrets` | Passed through to Cloud Run | `{}` / `[]` |

## Outputs

| Name | Description |
|------|-------------|
| `project_id` | Host project (pass-through) |
| `service_account_email` | Governance Engine SA email — always populated |
| `service_url` | Cloud Run URL (empty until `enabled = true`) |
| `service_name` | Cloud Run service name (empty until `enabled`) |
| `cloud_sql_connection_name` | Cloud SQL connection name (always populated) |
| `cloud_sql_instance_name` | Cloud SQL instance name (always populated) |
| `enabled` | Pass-through of `var.enabled` |

## Related modules

| Module | Purpose |
|--------|---------|
| `governance-iam` | Per-tenant invoker bindings (tenant-runtime → governance-engine) |
