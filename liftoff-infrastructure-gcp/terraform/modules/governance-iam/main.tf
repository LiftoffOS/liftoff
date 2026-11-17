# governance-iam: Phase 3 per-tenant IAM for the Governance Engine.
#
# What this module does:
#   1. Grants the tenant-runtime SA roles/run.invoker on the Governance
#      Engine Cloud Run service, so the runtime can call preflight /
#      authorize / record without a project-wide invoker role.
#   2. Grants the tenant-runtime SA access to the governance-engine-token
#      secret (shared bearer for X-Service-Auth verifyServiceAuth middleware).
#
# Governance does NOT read per-tenant secrets from the tenant project — the
# action ledger, kill switches, and policy cache all live in the Governance
# Engine's own Cloud SQL DB (`governance-pg`). That's the key behavioural
# difference from connector-iam: no project-level secretAccessor binding for
# the governance-engine SA against the tenant's Secret Manager.
#
# Prerequisites (fill in before applying):
#   - var.governance_engine_sa_email must be the real Governance Engine SA.
#   - var.tenant_runtime_sa_email must be the real per-tenant runtime SA.
#   - var.governance_engine_project_id must be where Cloud Run is deployed.
#   - The Governance Engine Cloud Run service must already exist before this
#     module is applied (Cloud Run IAM bindings require the service to exist,
#     so module.governance_engine.enabled must be true in the parent config).
#
# TODO before production:
#   - Consider adding resource-level secret bindings for
#     governance-preflight-verification-key so tenant-runtime can verify
#     signed preflight tokens without calling out to the governance engine
#     for every authorize (offline verification). Add once the token format
#     is finalized.

# ─── Tenant-runtime SA → Cloud Run invoker on Governance Engine ───────────────
# Allows the tenant-runtime SA to invoke the Governance Engine Cloud Run
# endpoints (preflight, authorize, record). Scoped to the specific Cloud Run
# service — not a project-wide invoker grant.

resource "google_cloud_run_v2_service_iam_member" "tenant_runtime_invoker" {
  project  = var.governance_engine_project_id
  location = var.region
  name     = var.governance_engine_cloud_run_service_name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.tenant_runtime_sa_email}"
}

# ─── Tenant-runtime SA → governance-engine-token secret ───────────────────────
# Allows the tenant-runtime to load the GOVERNANCE_SERVICE_TOKEN bearer token
# (env-var name per Phase 3 plan convention) from the shared secret
# `governance-engine-token` — the Secret Manager resource keeps its legacy
# name but the env var exposed in the container follows the plan.
# from the platform-control project at startup, so it can authenticate to the
# governance-engine's verifyServiceAuth middleware.

resource "google_secret_manager_secret_iam_member" "tenant_runtime_governance_engine_token" {
  project   = var.governance_engine_project_id
  secret_id = "governance-engine-token"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.tenant_runtime_sa_email}"
}
