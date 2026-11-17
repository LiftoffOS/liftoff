# connector-service-security

Terraform module for Phase 4 security hardening of the Connector Service.

## What it does

Creates a VPC Service Controls (VPC-SC) service perimeter around the GCP project
that hosts the Connector Service. The perimeter:

- Restricts `secretmanager.googleapis.com`, `run.googleapis.com`, and
  `cloudfunctions.googleapis.com` so they cannot be accessed from outside
  the perimeter without an explicit ingress/egress policy.
- Grants an ingress policy to authorized tenant-runtime project service accounts
  so they can invoke the Connector Service Cloud Run endpoint.
- Grants an egress policy to the Connector Service SA so it can read connector
  credentials from Secret Manager.

## Before applying

1. **Access Context Manager policy** — Set `access_policy_name` to the short name
   of your existing org-level ACM policy. List policies with:
   ```
   gcloud access-context-manager policies list --organization=<org_id>
   ```

2. **Connector Service SA email** — Set `connector_service_sa_email` to the
   service account the Connector Service Cloud Run service runs as.

3. **Allowed caller projects** — Set `allowed_caller_projects` to the list of
   GCP project *numbers* (not IDs) for each tenant-runtime project. These are
   the projects whose service accounts are allowed to call the Connector Service.

4. **Identity narrowing (TODO)** — The current ingress policy uses
   `identity_type = "ANY_SERVICE_ACCOUNT"` for the caller projects. Before
   production, narrow this to explicit SA emails once the per-tenant connector-iam
   module is in place. See the `TODO` comment in `main.tf`.

5. **WIF STS binding (TODO)** — The `sts_binding_reference` output is a
   placeholder. Once a Workload Identity Federation pool is provisioned for the
   Connector Service, replace the placeholder with the actual pool resource.

6. **DRY_RUN mode** — The perimeter is marked for `ENFORCE` but the comment
   suggests starting in dry-run to audit before locking. Toggle
   `perimeter_type` or use a separate `google_access_context_manager_service_perimeter_dry_run_status`
   resource to validate first.

## Usage

```hcl
module "connector_service_security" {
  source = "../../modules/connector-service-security"

  project_id                 = "YOUR_CONNECTOR_PROJECT"
  org_id                     = "123456789012"
  access_policy_name         = "<numeric-policy-id>"
  connector_service_sa_email = "YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com"
  allowed_caller_projects    = ["111111111111", "222222222222"]
  environment                = "prod"
}
```

## Enabling/disabling

By default the module is only active when `environment = "prod"`. Pass
`enabled = true` to force-enable in dev/staging for testing, or
`enabled = false` to disable in prod temporarily.

## Outputs

| Name | Description |
|------|-------------|
| `perimeter_name` | Full VPC-SC perimeter resource name |
| `perimeter_enabled` | Whether the perimeter was created |
| `connector_sa_access_level_name` | Access level granted to the Connector Service SA |
| `sts_binding_reference` | Placeholder for WIF STS binding (TODO) |
