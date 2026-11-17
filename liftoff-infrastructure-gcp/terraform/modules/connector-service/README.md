# connector-service

Terraform module for the Connector Service Cloud Run deployment. Provisions
the service account, Cloud SQL instance (`connector-pg`), and Cloud Run service
that make up the Connector Service in the control plane.

## Architecture

The Connector Service is a single Cloud Run service in `YOUR_GCP_PROJECT`
that handles all connector execution — for both shared and dedicated tenants.
Tenant isolation is enforced at the application layer (signed JWT claims +
per-request credential fetch via STS) and at the infrastructure layer via the
`connector-iam` and `connector-service-security` sibling modules.

## What it does

1. **Service account** — Always created. Needed by `connector-iam` for per-tenant
   invoker grants and by `connector-service-security` for VPC-SC access level
   bindings, even before the Cloud Run service is deployed.

2. **Secret Manager access** — Grants the Connector Service SA
   `roles/secretmanager.secretAccessor` scoped via IAM condition to
   `connector-*` secrets in its own project.

3. **Cloud SQL `connector-pg`** — Postgres instance for connector credential
   metadata, rate-limit state, and per-tenant vendor account references.
   Conditional on `var.enabled`.

4. **Cloud Run service** — The `liftoff-connector-service-{env}` Cloud Run
   deployment with health probes, Cloud SQL socket mount, and GEN2 execution
   environment. Conditional on `var.enabled`.

5. **Platform Backend invoker** — Grants the Platform Backend SA
   `roles/run.invoker` on the Connector Service so it can call
   `/api/connectors/warm` and batch execution endpoints. Conditional on
   `var.enabled`.

## Enabling

Set `enabled = true` once the Connector Service container image is published
to Artifact Registry. The service account and SA-level IAM bindings are
created regardless so downstream modules can reference them.

## Usage

```hcl
module "connector_service" {
  source = "../../modules/connector-service"

  project_id                = "YOUR_CONTROL_PROJECT_STAGING"
  region                    = "us-west1"
  environment               = "dev"
  platform_backend_sa_email = "YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com"

  # Flip to true once the container image is published
  enabled = false
}

# Wire the SA email into per-tenant IAM
module "connector_iam_acme" {
  source = "../../modules/connector-iam"

  tenant_id                              = "acme"
  connector_service_project_id           = module.connector_service.project_id
  connector_service_url                  = module.connector_service.service_url
  connector_service_sa_email             = module.connector_service.service_account_email
  tenant_runtime_sa_email                = "YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com"
  secret_manager_project_id              = "tenant-acme-dev"
  connector_service_cloud_run_service_name = module.connector_service.service_name
}
```

## Outputs

| Name | Description |
|------|-------------|
| `service_account_email` | Connector Service SA email — always populated |
| `service_account_name` | Full SA resource name |
| `service_url` | Cloud Run service URL (empty if `enabled = false`) |
| `service_name` | Cloud Run service name (empty if `enabled = false`) |
| `database_connection_name` | Cloud SQL connection name for Cloud Run volumes (empty if `enabled = false`) |
| `database_instance_name` | Cloud SQL instance name (empty if `enabled = false`) |
| `enabled` | Whether Cloud Run + Cloud SQL were created |

## Related modules

| Module | Purpose |
|--------|---------|
| `connector-iam` | Per-tenant invoker + secret-accessor IAM bindings |
| `connector-service-security` | VPC-SC perimeter around the Connector Service project |
