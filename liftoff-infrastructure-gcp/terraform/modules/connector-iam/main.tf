# connector-iam: Phase 4 Security Hardening
# Per-tenant IAM bindings for the Connector Service.
#
# What this module does:
#   1. Grants the Connector Service SA a Secret Manager secretAccessor role
#      scoped via IAM condition to connector-{tenantId}-* secrets only,
#      so the Connector Service can only read credentials for this tenant.
#   2. Grants the tenant-runtime SA Cloud Run invoker permission on the
#      Connector Service, so the runtime can call the Connector Service
#      without a broad project-level invoker role.
#
# IAM condition scoping:
#   The secretAccessor binding uses a CEL IAM condition that restricts the
#   grant to secrets whose resource name matches the pattern
#   "connector-{tenant_id}-*". This ensures the Connector Service cannot
#   read credentials belonging to a different tenant even if its SA is
#   compromised.
#
# Prerequisites (fill in before applying):
#   - var.connector_service_sa_email must be the real Connector Service SA.
#   - var.tenant_runtime_sa_email must be the real per-tenant runtime SA.
#   - var.secret_manager_project_id must be the project where secrets live.
#   - var.connector_service_project_id must be where Cloud Run is deployed.
#   - The Connector Service Cloud Run service must already exist before this
#     module is applied (Cloud Run IAM bindings require the service to exist).
#
# TODO before production:
#   - Validate the CEL condition expression against the actual secret name
#     format used by the platform backend when it creates connector credentials.
#     Current assumption: secret name starts with "connector-{tenant_id}-".
#   - Confirm whether the project-level secretAccessor with IAM condition is
#     preferred over individual resource-level bindings. Resource-level bindings
#     on each secret are more precise but require Terraform to know every secret
#     name at apply time. The condition approach is more maintainable as secrets
#     are added dynamically.
#   - Add a google_project_iam_audit_config resource here once the audit logging
#     strategy for connector credential reads is finalized.

# ─── Connector Service SA → Secret Manager (scoped to this tenant) ────────────
# Allows the Connector Service to read secrets named "connector-{tenant_id}-*"
# in the tenant's Secret Manager project.

resource "google_project_iam_member" "connector_service_secret_accessor" {
  project = var.secret_manager_project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${var.connector_service_sa_email}"

  condition {
    title       = "connector-secrets-${var.tenant_id}-only"
    description = "Restrict Connector Service secret access to connector-${var.tenant_id}-* secrets"
    expression  = "resource.name.startsWith(\"projects/${var.secret_manager_project_id}/secrets/connector-${var.tenant_id}-\")"
  }
}

# ─── Connector Service SA → legacy-named secrets (pre-Phase-2b migration) ─────
# Before Phase 2b the platform-backend OAuth callback stored shared-tenant
# secrets as "tenant-{tenant_id}-connector-{connector_id}" in the tenant
# runtime project (not "connector-{tenant_id}-{connector_id}"). The
# connector-service backfill migration reads those secrets and re-files them
# at the canonical path. Without this binding the backfill gets
# PERMISSION_DENIED on every legacy secret and silently logs secretsMissing.
#
# After the one-time backfill runs successfully, no secrets exist at legacy
# paths and this binding is a no-op. It can be removed once all environments
# have been fully migrated and the backfill step is retired from CI.
resource "google_project_iam_member" "connector_service_legacy_secret_accessor" {
  project = var.secret_manager_project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${var.connector_service_sa_email}"

  condition {
    title       = "connector-legacy-secrets-${var.tenant_id}"
    description = "Pre-Phase-2b platform-backend naming: tenant-{tenant_id}-connector-* in tenant project"
    expression  = "resource.name.startsWith(\"projects/${var.secret_manager_project_id}/secrets/tenant-${var.tenant_id}-connector-\")"
  }
}

# ─── Tenant-runtime SA → Cloud Run invoker on Connector Service ───────────────
# Allows the tenant-runtime SA to invoke the Connector Service Cloud Run endpoint.
# Scoped to the specific Cloud Run service — not a project-wide invoker grant.

resource "google_cloud_run_v2_service_iam_member" "tenant_runtime_invoker" {
  project  = var.connector_service_project_id
  location = var.region
  name     = var.connector_service_cloud_run_service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.tenant_runtime_sa_email}"
}

# ─── Tenant-runtime SA → connector-service-token secret ───────────────────────
# Allows the tenant-runtime to load the CONNECTOR_SERVICE_TOKEN bearer token
# from the platform-control project at startup, so it can authenticate to the
# connector-service's verifyServiceAuth middleware.
resource "google_secret_manager_secret_iam_member" "tenant_runtime_connector_service_token" {
  project   = var.connector_service_project_id
  secret_id = "connector-service-token"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.tenant_runtime_sa_email}"
}
