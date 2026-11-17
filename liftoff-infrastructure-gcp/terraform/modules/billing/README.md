# billing

Terraform module for the `liftoff-billing` Cloud Run deployment.

## What it provisions

- **Service account** (`billing-${env}`) — always created; needed by other
  modules before the Cloud Run service exists.
- **Database `billing` on `control-plane-pg`** — no new Cloud SQL instance;
  the shared primary is reused per plan 0d.
- **Role triad** (`billing_migrate`, `billing_app`, `billing_readonly`) per
  plan 0g. Lockdown SQL lives in `sql/00_roles.sql`.
- **Per-service KMS key** `billing-key` in `keyring-${env}` per plan 0l.
- **Secret Manager IAM** scoped via IAM Condition to `billing-*` secrets only
  per plan 0d (no project-level `secretAccessor`).
- **Cloud Run service `billing`** — `ingress=internal`,
  `--no-allow-unauthenticated`, `min-instances=0`, `terminationGracePeriodSeconds=35`.
- **Cloud Run service `billing-stripe-webhook`** — public HTTPS; the only
  exception to the internal-only rule (plan 1c).
- **Cloud Build trigger** for the `liftoff-billing` repo.
- **Cloud Monitoring dashboard + SLOs + burn-rate alerts** per plan 0v/0n/0x.
- **Binary Authorization attestor** per plan 0e.
- **Labels** `service=billing env=<env> managed_by=terraform` per plan 0e.

## Inputs

| Name | Description | Default |
|------|-------------|---------|
| `project_id` | Host project (`YOUR_GCP_PROJECT`) | required |
| `environment` | `dev` / `prod` | required |
| `region` | GCP region (`us-west1`) | `us-west1` |
| `billing_account` | GCP billing account (used for labels) | required |
| `control_plane_sql_instance` | Name of `control-plane-pg-${env}` | required |
| `control_plane_sql_connection_name` | Cloud SQL connection name | required |
| `kms_key_ring_id` | `keyring-${env}` full ID | required |
| `network_id` | VPC network ID | required |
| `vpc_connector_id` | Serverless VPC Access connector ID | required |
| `platform_backend_sa_email` | Granted `roles/run.invoker` on private service | required |
| `image_sha` | SHA-only image tag | `placeholder` (TODO on first build) |
| `enabled` | Create Cloud Run + invoker IAM | `false` |
| `min_instances` / `max_instances` | Autoscaling | `0` / `10` |
| `db_app_password` / `db_migrate_password` / `db_readonly_password` | Role triad passwords | required, sensitive |
| `notification_channels` | Burn-rate alert notification channels | `[]` |
| `binary_authorization_enabled` | Create per-service attestor | `true` |

## Outputs

| Name | Description |
|------|-------------|
| `service_account_email` | Billing SA (always populated) |
| `service_url` | Private billing Cloud Run URL |
| `stripe_webhook_url` | Public Stripe webhook URL |
| `db_name` | `billing` |
| `kms_key_id` | Fully-qualified `billing-key` resource ID |

## SQL bootstrap

The `sql/` directory contains role lockdown, RLS enablement, and pg_partman
provisioning SQL to be applied by the `billing-migrate` Cloud Run Job before
the service comes online:

- `sql/00_roles.sql` — role triad + lockdown per plan 0g.
- `sql/01_rls.sql` — RLS on tenant-scoped tables per plan 0h.
- `sql/02_partitions.sql` — pg_partman provisioning +18 months per plan 0i.
