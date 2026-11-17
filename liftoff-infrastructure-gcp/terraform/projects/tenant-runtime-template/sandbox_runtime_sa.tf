# Per-sandbox RUNTIME service account (P0.1 of the sandbox privilege-escalation
# remediation). This is the identity the per-sandbox Cloud Run container RUNS AS
# — distinct from the sandbox-executor ORCHESTRATOR SA, which keeps run.admin /
# cloudsql.client / secretmanager / cloudkms / iam.serviceAccountUser.
#
# It holds ZERO project roles on purpose. Agent code in the sandbox can mint this
# SA's OAuth token via the Cloud Run metadata server (link-local 169.254.169.254,
# which VPC egress firewalls cannot block), so the token must
# be useless: an identity that can do nothing.
#
# Why it needs nothing:
#  - Image pull is done by the Cloud Run service agent (serverless-robot), not the
#    run-as SA (see sandbox_aio.tf sandbox_images_pull).
#  - Sandbox->runtime callbacks are HS256 per-sandbox JWTs, not IAM/OIDC.
#  - KMS encrypt/decrypt of the JWT secret is orchestrator-side.
#  - The per-sandbox service is a single container (no Envoy egress-audit sidecar),
#    so it publishes nothing.
resource "google_service_account" "sandbox_runtime" {
  project      = google_project.tenant_runtime.project_id
  account_id   = "sandbox-runtime"
  display_name = "Sandbox Runtime (agent code) SA"
  description  = "SA the per-sandbox container RUNS AS. ZERO project roles — a metadata token stolen by agent code is useless (can mint an OAuth token for an identity that can do nothing)."
}

# The ONLY binding needed: the orchestrator must actAs this SA to set it on the
# per-sandbox service it creates. No project-level roles on sandbox_runtime itself.
resource "google_service_account_iam_member" "executor_actas_sandbox_runtime" {
  service_account_id = google_service_account.sandbox_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.sandbox_executor.email}"
}
