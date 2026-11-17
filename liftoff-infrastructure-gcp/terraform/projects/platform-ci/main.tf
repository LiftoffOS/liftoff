# Platform CI Project
# Owns: Cloud Build, deployment pipelines, GitHub integration
# Per Section 2: GCP Layout

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }
}

variable "org_id" {
  type = string
}

variable "billing_account" {
  type = string
}

variable "environment" {
  type = string
}

variable "region" {
  type = string
}

variable "platform_control_project_id" {
  type        = string
  description = "Platform control project ID for cross-project deployments"
}

variable "artifact_registry" {
  type        = string
  description = "Artifact registry URL from platform-control"
}

variable "github_repos_connected" {
  type        = bool
  default     = false
  description = "Set to true after GitHub repos are connected in Cloud Build console"
}

variable "connector_service_repo_connected" {
  type        = bool
  default     = false
  description = <<-EOT
    Set to true after the liftoff-connector-service GitHub repo has been
    connected to Cloud Build in this project's console. Gates creation of
    the connector-service-{env} trigger separately from the main
    github_repos_connected flag so apply doesn't fail on a brand-new repo
    that has not yet been hooked up.
  EOT
}

variable "governance_engine_repo_connected" {
  type        = bool
  default     = false
  description = <<-EOT
    Set to true after the liftoff-governance-engine GitHub repo has been
    connected to Cloud Build in this project's console. Gates creation of
    the governance-engine-{env} trigger separately from the main
    github_repos_connected flag so apply doesn't fail on a brand-new repo
    that has not yet been hooked up.
  EOT
}

variable "tunnel_service_repo_connected" {
  type        = bool
  default     = false
  description = <<-EOT
    Set to true after the liftoff-tunnel-service GitHub repo has been
    connected via the Cloud Build GitHub App console; gates creation of
    the tunnel-service-{env} trigger.
  EOT
}

variable "harvest_service_repo_connected" {
  type        = bool
  default     = false
  description = <<-EOT
    Set to true after the liftoff-harvest-service GitHub repo has been
    connected to Cloud Build in this project's console. Gates creation of
    the harvest-service-{env} trigger.
  EOT
}

variable "workforce_service_repo_connected" {
  type        = bool
  default     = false
  description = <<-EOT
    Set to true after the liftoff-workforce-service GitHub repo has been
    connected to Cloud Build in this project's console. Gates creation of
    the workforce-service-{env} trigger. Trigger fires on pushes to main
    (trunk-based, consistent with all other decomposed services).
  EOT
}

variable "billing_repo_connected" {
  type        = bool
  default     = false
  description = <<-EOT
    Set to true after this repository has been connected to
    Cloud Build in this project's console. Gates the billing-{env} trigger.
  EOT
}

variable "billing_service_url" {
  type        = string
  default     = ""
  description = "Internal URL of the billing Cloud Run service, passed to developer-proxy as BILLING_SERVICE_URL."
}

variable "governance_adversarial_eval_enabled" {
  type        = bool
  default     = false
  description = "Set to true to create the governance-adversarial-eval Cloud Run Job. Disabled by default (zero cost when off)."
}

variable "governance_engine_url" {
  type        = string
  default     = ""
  description = "Internal URL of the governance-engine Cloud Run service, passed to the adversarial eval job as GOVERNANCE_BASE_URL."
}

# -----------------------------------------------------------------------------
# Agent Performance-Understanding Harness — passive eval Cloud Run Job.
# Disabled by default (count = 0); flip agent_diagnostics_enabled to true in the
# environment tfvars to enable. Near-$0 (Always-Free job, scales to zero).
# -----------------------------------------------------------------------------
variable "agent_diagnostics_enabled" {
  type        = bool
  default     = false
  description = "Set to true to create the agent-diagnostics passive-eval Cloud Run Job + its SA/IAM. Disabled by default (zero cost when off)."
}

variable "agent_diagnostics_harvest_schedule" {
  type        = string
  default     = "0 6 * * *"
  description = "Cron schedule for the scheduled agent-diagnostics passive harvest (daily 06:00 UTC by default)."
}

variable "agent_diagnostics_scheduled" {
  type        = bool
  default     = true
  description = "Run the daily passive harvest. False keeps the job, its SA, the evaluator and the scorecard tables (none cost anything idle) and removes only the schedule; the job still runs on demand."
}

variable "agent_diagnostics_eval_tenant_id" {
  type        = string
  default     = ""
  description = "Tenant the passive diagnostics job evaluates (an operator-owned tenant). Empty leaves the job present but a no-op until set."
}

variable "agent_diagnostics_collab_grade_job" {
  type        = string
  default     = ""
  description = "Full resource path (projects/<p>/locations/<r>/jobs/<n>) of the tenant `tenant-runtime-collab-grade` Cloud Run Job that `--collab-grade` fans out to. Passed as a static string from the root (deterministic tenant-<id>-<env> project) to avoid a platform_ci → tenant module edge. Empty = --collab-grade disabled."
}

variable "agent_diagnostics_workforce_db_url_secret" {
  type        = string
  default     = "diagnostics-workforce-db-url"
  description = "Secret Manager secret id holding the read-only workforce-service DB connection string."
}

variable "agent_diagnostics_insights_db_url_secret" {
  type        = string
  default     = "diagnostics-insights-db-url"
  description = "Secret Manager secret id holding the read-only platform-backend (insights) DB connection string."
}

variable "agent_diagnostics_tr_harness_url" {
  type        = string
  default     = ""
  description = "Eval-tenant agent-service test-harness base URL (…/api/internal/test-harness/run-agent). user-created runs are reconstructed + evaluated IN tenant-runtime (DB + tool-gateway are tenant-local); the job POSTs the sibling /harvest path and sinks the returned EvaluatedRuns. Empty → user-created harvest is skipped."
}

variable "agent_diagnostics_service_token_secret" {
  type        = string
  default     = "tenant-runtime-service-token"
  description = "Secret Manager secret id (platform-control project) holding the shared TENANT_RUNTIME_SERVICE_TOKEN. Sent as X-Service-Auth to the eval-tenant test-harness router, which constant-time-compares it against the tenant agent-service's TENANT_RUNTIME_SERVICE_TOKEN."
}

# Per-agent target IDs. caio/hrbp/insights query their DBs BY TENANT and use the
# id only as a label — the defaults match the seeded canonical ids (migration
# 194) and the adapter constants. user-created FILTERS agent_trajectories by this
# id, so it MUST be a real agents.id on the eval tenant (set per-env).
variable "agent_diagnostics_user_agent_id" {
  type        = string
  default     = ""
  description = "Real user-created agent id (agent_trajectories.agent_id) on the eval tenant. Empty leaves user-created harvest evaluating nothing."
}
variable "agent_diagnostics_caio_agent_id" {
  type        = string
  default     = "00000000-0000-0000-0000-000000000001"
  description = "CAIO agent id label (seeded canonical, migration 194)."
}
variable "agent_diagnostics_hrbp_agent_id" {
  type        = string
  default     = "00000000-0000-0000-0000-000000000002"
  description = "HRBP agent id label (seeded canonical, migration 194)."
}
variable "agent_diagnostics_insights_agent_id" {
  type        = string
  default     = "00000000-0000-0000-0000-000000000003"
  description = "Insights agent id label (seeded canonical)."
}

variable "agent_diagnostics_vpc_connector" {
  type        = string
  default     = "serverless-connector"
  description = "Serverless VPC Access connector for the diagnostics job to reach the private Cloud SQL replica + the internal evaluator service."
}

variable "agent_diagnostics_image_tag" {
  type        = string
  default     = "latest"
  description = "tenant-runtime image tag (commit SHA) the diagnostics job runs — must be a build containing src/scripts/agent-diagnostics.js."
}

variable "platform_backend_url" {
  type        = string
  default     = ""
  description = "Internal URL of the platform-backend Cloud Run service, passed to the adversarial eval job as PLATFORM_BACKEND_URL."
}

variable "stripe_ou_price_id" {
  description = "Stripe Price ID for the operating_unit_consumed meter item. Forwarded to the platform-backend Cloud Build trigger as _STRIPE_OU_PRICE_ID."
  type        = string
  default     = ""
}

# Post-deploy smoke runner configuration. Forwarded to both the
# platform_backend and tenant_runtime_liftoffos triggers as _SMOKE_IMAGE,
# _CANARY_TENANT_ID, _CANARY_AGENT_ID. The smoke image is built from
# Liftoff-Tenant-Runtime/Dockerfile.smoke and pushed to Artifact Registry;
# the canary IDs are selected per env from the top-5 prod tenants by
# connector-binding count (see runbook below).
variable "smoke_image" {
  description = "Artifact Registry URL of the pre-built post-deploy smoke runner image. Format: us-west1-docker.pkg.dev/<project>/<repo>/runner:<tag>. Defaults to the cloud-sdk image so the cloudbuild parses cleanly before a real smoke image is built; the smoke step itself no-ops when _CANARY_TENANT_ID is empty."
  type        = string
  default     = "gcr.io/google.com/cloudsdktool/cloud-sdk:slim"
}

variable "canary_tenant_id" {
  description = <<-EOT
    UUID of the prod tenant the post-deploy smoke runs against. Empty
    disables the smoke step (post-deploy-smoke + auto-rollback steps
    skip via the `count = canary_tenant_id != "" ? 1 : 0` guard on
    the run.invoker grant).

    To select a canary tenant, run against the prod control-plane DB:
      SELECT i.tenant_id::text AS tenant_id,
             i.id::text         AS agent_id,
             COUNT(DISTINCT c.id) AS bindings
      FROM internal_agents i
      JOIN connectors c ON c.tenant_id = i.tenant_id
      WHERE c.status = 'linked'
      GROUP BY i.tenant_id, i.id
      ORDER BY bindings DESC
      LIMIT 5;
    Pick the highest-binding tenant whose smoke run is acceptable as a
    canary (the smoke fires real connector reads against the tenant's
    bindings — only safe categories are dispatched, but the load itself
    is real). Document the choice in this var's value via terraform.tfvars.
  EOT
  type        = string
  default     = ""
}

variable "canary_agent_id" {
  description = "UUID of the agent within the canary tenant the post-deploy smoke targets. Should be a long-lived agent with broad connector bindings. See canary_tenant_id description for the selection query."
  type        = string
  default     = ""
}

# C4 SWE external-checks smoke (tenant-runtime cloudbuild `swe-external-checks` step —
# NON-GATING, log-only). All default "" → the step stays dormant (it skips unless the
# fixture repo, swe agent, and harness base URL are all set). Set per-env in terraform.tfvars
# to activate; keep prod empty until the dev step is observed stable.
variable "swe_fixture_repo" {
  description = "owner/name of the dedicated throwaway GitHub fixture repo the SWE smoke opens PRs against (e.g. LiftoffOS/swe-smoke-fixture). Empty disables the swe-external-checks step."
  type        = string
  default     = ""
}

variable "swe_tenant_id" {
  description = "UUID of the tenant that owns the code-capable SWE agent. Empty falls back to canary_tenant_id in the cloudbuild step."
  type        = string
  default     = ""
}

variable "swe_agent_id" {
  description = "UUID of a code-capable (GitHub-bound) software-engineer agent used by the SWE smoke. Empty disables the swe-external-checks step."
  type        = string
  default     = ""
}

variable "swe_harness_base" {
  description = "Base URL of the agent-service that hosts /api/internal/test-harness/run-agent (e.g. https://agent-service-<hash>-uw.a.run.app). Empty disables the swe-external-checks step."
  type        = string
  default     = ""
}

variable "swe_fixture_token_secret" {
  description = "Secret Manager secret name (in the tenant secret project tenant-<tenant>-<env>) holding the GitHub fixture token the runner uses to poll/teardown the fixture repo."
  type        = string
  default     = "github-fixture-token"
}

variable "swe_secret_project" {
  description = "GCP project holding the swe fixture-token secret (the tenant secret project tenant-<tenant>-<env>, same one the runner passes as --secret-project). Empty leaves the secret + grant unmanaged."
  type        = string
  default     = ""
}

# github-fixture-token secret + accessor for the swe-external-checks smoke. The secret VALUE
# stays out-of-band (a GitHub token, added manually, like the sibling tenant-runtime-service-token);
# terraform owns only the container + the build-SA accessor grant. Guarded on swe_secret_project so
# it exists only where the smoke is configured (dev). The existing manually-created secret + grant
# are adopted on first apply via the `import` blocks in environments/dev/main.tf (needs Terraform
# >= 1.7). The apply SA needs secretmanager admin/IAM on swe_secret_project.
resource "google_secret_manager_secret" "github_fixture_token" {
  count     = var.swe_secret_project != "" ? 1 : 0
  project   = var.swe_secret_project
  secret_id = var.swe_fixture_token_secret
  labels    = { type = "github-token", environment = var.environment, managed_by = "terraform" }
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "github_fixture_token_accessor" {
  count     = var.swe_secret_project != "" ? 1 : 0
  project   = var.swe_secret_project
  secret_id = google_secret_manager_secret.github_fixture_token[0].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_build.email}"
}

variable "developer_proxy_repo_connected" {
  type        = bool
  default     = false
  description = <<-EOT
    Set to true after this repository has been connected to
    Cloud Build in this project's console. Gates the developer-proxy-{env} trigger.
  EOT
}

variable "deploy_branch_pattern" {
  type        = string
  default     = "^main$"
  description = <<-EOT
    Regex matched against the pushed branch name to fire the Cloud Build
    triggers in this CI project. Lets dev / staging / prod deploy from
    different branches off the same repo so a single push to one branch
    can't promote code through all environments at once.

      dev:     "^main$"     — trunk; default for fast iteration.
      staging: "^staging$"  — promotion candidate.
      prod:    "^release$"  — explicit cut from main → release for prod.
  EOT
}

variable "governance_service_state" {
  type        = string
  default     = "off"
  description = <<-EOT
    Cutover dial baked into the tenant-runtime Cloud Build trigger
    as the _GOVERNANCE_SERVICE_ENABLED substitution, which becomes the
    GOVERNANCE_SERVICE_ENABLED env var on the deployed tenant-runtime
    Cloud Run revision.

      off    — legacy in-process governance only (default, safe).
      shadow — legacy serves; governance-engine RPC observed + mismatches
               logged. Both paths must be live + reachable.
      on     — governance-engine RPC only; fail-closed on unreachable.

    Flip a non-production environment to shadow once governance-engine is deployed + the Pub/Sub
    subscription is created; flip to on after observing zero mismatches.
    Promote production once the non-production environment is stable.
  EOT
  validation {
    condition     = contains(["off", "shadow", "on"], var.governance_service_state)
    error_message = "governance_service_state must be one of: off, shadow, on."
  }
}

locals {
  project_id = "YOUR_CI_PROJECT_${var.environment}"

  # App-service deploy triggers skip a push whose changed files ALL match these
  # globs (docs / workflow edits produce a byte-identical image). Any code change
  # still triggers a build. Conservative: `*.md` is root-level only, and `docs/`
  # / `.github/` are never baked into an image, so no runtime file is matched.
  deploy_ignored_files = ["*.md", "docs/**", ".github/**"]
}

# -----------------------------------------------------------------------------
# Project
# -----------------------------------------------------------------------------

resource "google_project" "platform_ci" {
  name            = "Platform CI ${var.environment}"
  project_id      = local.project_id
  org_id          = var.org_id
  billing_account = var.billing_account
}

# Enable required APIs
resource "google_project_service" "apis" {
  for_each = toset([
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "bigquery.googleapis.com",
    "containeranalysis.googleapis.com",
  ])

  project                    = google_project.platform_ci.project_id
  service                    = each.value
  disable_dependent_services = false
}

# -----------------------------------------------------------------------------
# Service Accounts
# -----------------------------------------------------------------------------

# Cloud Build SA for building and deploying
resource "google_service_account" "cloud_build" {
  project      = google_project.platform_ci.project_id
  account_id   = "cloud-build-${var.environment}"
  display_name = "Cloud Build Service Account"

  depends_on = [google_project_service.apis]
}

# GitHub Actions SA (for Workload Identity Federation)
resource "google_service_account" "github_actions" {
  project      = google_project.platform_ci.project_id
  account_id   = "github-actions-${var.environment}"
  display_name = "GitHub Actions Service Account"

  depends_on = [google_project_service.apis]
}

# -----------------------------------------------------------------------------
# IAM for CI Service Accounts
# -----------------------------------------------------------------------------

# Cloud Build can push to Artifact Registry in platform-control
resource "google_artifact_registry_repository_iam_member" "cloud_build_writer" {
  project    = var.platform_control_project_id
  location   = var.region
  repository = "YOUR_GCP_PROJECT${var.environment}"
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Cloud Build can deploy to Cloud Run in platform-control
resource "google_project_iam_member" "cloud_build_run_admin" {
  project = var.platform_control_project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# The post-deploy-smoke step invokes the test-harness endpoint on
# the freshly-deployed Cloud Run service. The harness CLI uses
# `gcloud auth print-identity-token` to mint an audience-scoped ID token,
# which requires roles/iam.serviceAccountTokenCreator on the runner SA
# itself (self-impersonation) AND roles/run.invoker on the target
# service. The run.admin role above already covers platform-backend.run
# (lives in platform-control); this block adds the explicit
# self-impersonation needed for ID-token minting.
resource "google_service_account_iam_member" "cloud_build_self_impersonation" {
  service_account_id = google_service_account.cloud_build.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.cloud_build.email}"
}

# C1-4 fix: Cloud Build SA needs roles/run.invoker on the platform-backend
# Cloud Run service so the PB-mode smoke step can hit
# /api/internal/test-harness/run-chat. roles/run.admin grants this
# transitively, but pinning it as a separate explicit grant means we
# don't accidentally lose it if run.admin is ever narrowed.
resource "google_cloud_run_v2_service_iam_member" "cloud_build_invokes_platform_backend" {
  count    = var.github_repos_connected ? 1 : 0
  project  = var.platform_control_project_id
  location = var.region
  name     = "platform-backend"
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.cloud_build.email}"
}

# C1-4 fix: same grant for the tenant-runtime smoke. Tenant Runtime is
# deployed per-tenant inside tenant-${tenant_id}-${env} projects; the
# specific TR canary service we probe lives at YOUR_TENANT_PROJECT.
# Granting run.invoker here means the smoke step can hit
# /api/internal/test-harness/run-agent. If new tenants are added as
# additional canaries, mirror this grant per-project.
resource "google_cloud_run_v2_service_iam_member" "cloud_build_invokes_tenant_runtime_canary" {
  count    = var.github_repos_connected && var.canary_tenant_id != "" ? 1 : 0
  project  = "YOUR_TENANT_PROJECT${var.environment}"
  location = var.region
  name     = "agent-service"
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Cloud Build can act as service accounts in platform-control
resource "google_project_iam_member" "cloud_build_sa_user" {
  project = var.platform_control_project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# GitHub Actions same permissions
resource "google_artifact_registry_repository_iam_member" "github_actions_writer" {
  project    = var.platform_control_project_id
  location   = var.region
  repository = "YOUR_GCP_PROJECT${var.environment}"
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.github_actions.email}"
}

resource "google_project_iam_member" "github_actions_run_admin" {
  project = var.platform_control_project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

resource "google_project_iam_member" "github_actions_sa_user" {
  project = var.platform_control_project_id
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

# GitHub Actions needs to read Terraform state for plan
resource "google_project_iam_member" "github_actions_storage_reader" {
  project = google_project.platform_ci.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

# GitHub Actions needs viewer on CI project for terraform plan
resource "google_project_iam_member" "github_actions_ci_viewer" {
  project = google_project.platform_ci.project_id
  role    = "roles/viewer"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

# GitHub Actions needs viewer on control project for terraform plan
resource "google_project_iam_member" "github_actions_control_viewer" {
  project = var.platform_control_project_id
  role    = "roles/viewer"
  member  = "serviceAccount:${google_service_account.github_actions.email}"
}

# Local project permissions
resource "google_project_iam_member" "cloud_build_logging" {
  project = google_project.platform_ci.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Cloud Build needs storage access for Terraform state
resource "google_project_iam_member" "cloud_build_storage" {
  project = google_project.platform_ci.project_id
  role    = "roles/storage.admin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Cloud Build needs to act-as itself to create Cloud Build triggers whose
# service_account is this same SA. Without this, Terraform-driven trigger
# creation fails with iam.serviceAccounts.actAs permission_denied.
resource "google_service_account_iam_member" "cloud_build_self_act_as" {
  service_account_id = google_service_account.cloud_build.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Cloud Build needs to manage organization resources for Terraform
resource "google_organization_iam_member" "cloud_build_project_creator" {
  count  = var.environment == "prod" ? 1 : 0 # Only prod can create projects
  org_id = var.org_id
  role   = "roles/resourcemanager.projectCreator"
  member = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Cloud Build needs specific permissions for infrastructure management
# Per Section 20: Least-privilege IAM - replace roles/editor with granular roles

# Cloud SQL Admin for database management
resource "google_project_iam_member" "cloud_build_cloudsql_admin" {
  project = var.platform_control_project_id
  role    = "roles/cloudsql.admin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Pub/Sub Admin for messaging infrastructure
resource "google_project_iam_member" "cloud_build_pubsub_admin" {
  project = var.platform_control_project_id
  role    = "roles/pubsub.admin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Cloud Tasks Admin for task queue management
resource "google_project_iam_member" "cloud_build_cloudtasks_admin" {
  project = var.platform_control_project_id
  role    = "roles/cloudtasks.admin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Secret Manager Admin for secrets management
resource "google_project_iam_member" "cloud_build_secretmanager_admin" {
  project = var.platform_control_project_id
  role    = "roles/secretmanager.admin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Cloud KMS Admin for encryption key management
resource "google_project_iam_member" "cloud_build_kms_admin" {
  project = var.platform_control_project_id
  role    = "roles/cloudkms.admin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Cloud Scheduler Admin for scheduled jobs
resource "google_project_iam_member" "cloud_build_scheduler_admin" {
  project = var.platform_control_project_id
  role    = "roles/cloudscheduler.admin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Compute Network Admin for VPC/networking
resource "google_project_iam_member" "cloud_build_compute_network" {
  project = var.platform_control_project_id
  role    = "roles/compute.networkAdmin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Service Usage Admin for enabling APIs
resource "google_project_iam_member" "cloud_build_serviceusage_admin" {
  project = var.platform_control_project_id
  role    = "roles/serviceusage.serviceUsageAdmin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Logging Admin for log management
resource "google_project_iam_member" "cloud_build_logging_admin" {
  project = var.platform_control_project_id
  role    = "roles/logging.admin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Monitoring Admin for observability setup
resource "google_project_iam_member" "cloud_build_monitoring_admin" {
  project = var.platform_control_project_id
  role    = "roles/monitoring.admin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# Cloud Build needs to manage IAM for service accounts
resource "google_project_iam_member" "cloud_build_iam_admin" {
  project = var.platform_control_project_id
  role    = "roles/iam.securityAdmin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# BigQuery Admin for managing billing export datasets and analytics
resource "google_project_iam_member" "cloud_build_bigquery_admin" {
  project = var.platform_control_project_id
  role    = "roles/bigquery.admin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# -----------------------------------------------------------------------------
# IAM for Tenant Projects
# Cloud Build needs permissions to deploy to each tenant project
# Add a block for each tenant
# -----------------------------------------------------------------------------

# Example tenant - Cloud Run Admin (copy this block per tenant)
resource "google_project_iam_member" "cloud_build_tenant_liftoffos_run_admin" {
  project = "YOUR_TENANT_PROJECT${var.environment}"
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# LiftoffOS Tenant - Service Account User (to act as Cloud Run service account)
resource "google_project_iam_member" "cloud_build_tenant_liftoffos_sa_user" {
  project = "YOUR_TENANT_PROJECT${var.environment}"
  role    = "roles/iam.serviceAccountUser"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# LiftoffOS Tenant - Cloud SQL Client (for migrations)
resource "google_project_iam_member" "cloud_build_tenant_liftoffos_sql_client" {
  project = "YOUR_TENANT_PROJECT${var.environment}"
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# LiftoffOS Tenant - Cloud Run Jobs Developer (for running migrations)
resource "google_project_iam_member" "cloud_build_tenant_liftoffos_run_jobs" {
  project = "YOUR_TENANT_PROJECT${var.environment}"
  role    = "roles/run.developer"
  member  = "serviceAccount:${google_service_account.cloud_build.email}"
}

# -----------------------------------------------------------------------------
# Cloud Build Triggers
# -----------------------------------------------------------------------------

# Platform Backend trigger (requires GitHub repos connected first)
resource "google_cloudbuild_trigger" "platform_backend" {
  count    = var.github_repos_connected ? 1 : 0
  project  = google_project.platform_ci.project_id
  name     = "platform-backend-${var.environment}"
  location = var.region

  github {
    owner = "LiftoffOS"
    name  = "liftoff-platform-backend"

    push {
      branch = var.deploy_branch_pattern # Per-env: see deploy_branch_pattern var
    }
  }

  ignored_files   = local.deploy_ignored_files
  filename        = "cloudbuild.yaml"
  service_account = google_service_account.cloud_build.id

  substitutions = {
    _ENVIRONMENT        = var.environment
    _REGION             = var.region
    _PROJECT_ID         = var.platform_control_project_id
    _ARTIFACT_REGISTRY  = var.artifact_registry
    _STRIPE_OU_PRICE_ID = var.stripe_ou_price_id
    # post-deploy smoke configuration.
    # _SMOKE_IMAGE is the pre-built Dockerfile.smoke image (see
    # Liftoff-Tenant-Runtime/Dockerfile.smoke). _CANARY_TENANT_ID and
    # _CANARY_AGENT_ID identify the tenant the harness runs against.
    _SMOKE_IMAGE      = var.smoke_image
    _CANARY_TENANT_ID = var.canary_tenant_id
    _CANARY_AGENT_ID  = var.canary_agent_id
  }

  depends_on = [google_project_service.apis]
}

# Tenant Runtime trigger for the example tenant
# Each tenant gets their own trigger that sets _TENANT_ID
resource "google_cloudbuild_trigger" "tenant_runtime_liftoffos" {
  count    = var.github_repos_connected ? 1 : 0
  project  = google_project.platform_ci.project_id
  name     = "YOUR_TENANT_PROJECT${var.environment}"
  location = var.region

  description = "Deploy Tenant Runtime to YOUR_TENANT_PROJECT${var.environment}"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-tenant-runtime"

    push {
      branch = var.deploy_branch_pattern # Per-env: see deploy_branch_pattern var
    }
  }

  ignored_files   = local.deploy_ignored_files
  filename        = "cloudbuild.yaml"
  service_account = google_service_account.cloud_build.id

  substitutions = {
    _ENVIRONMENT                = var.environment
    _REGION                     = var.region
    _TENANT_ID                  = "liftoffos"
    _CONTROL_PROJECT            = var.platform_control_project_id
    _ARTIFACT_REGISTRY          = var.artifact_registry
    _GOVERNANCE_SERVICE_ENABLED = var.governance_service_state
    # post-deploy smoke configuration. See platform_backend trigger
    # for variable docs. Tenant Runtime smoke targets agent-service within
    # this tenant's runtime project (tenant-${var.tenant_id}-${env}).
    _SMOKE_IMAGE      = var.smoke_image
    _CANARY_TENANT_ID = var.canary_tenant_id
    _CANARY_AGENT_ID  = var.canary_agent_id
    # C4 SWE external-checks smoke (non-gating). All empty by default → the
    # swe-external-checks step skips. Set per-env to activate.
    _SWE_FIXTURE_REPO         = var.swe_fixture_repo
    _SWE_TENANT_ID            = var.swe_tenant_id
    _SWE_AGENT_ID             = var.swe_agent_id
    _SWE_HARNESS_BASE         = var.swe_harness_base
    _SWE_FIXTURE_TOKEN_SECRET = var.swe_fixture_token_secret
    # Conversation Recall v1 (agent-service RECALL_CONVERSATIONS_ENABLED).
    # Declared here so an infrastructure apply does not strip the substitution
    # a manual `gcloud builds triggers update` set. Live "true" in both envs;
    # change here, never via gcloud (same reap class as the platform-backend
    # RECALL_* / MCP_OAUTH_ENABLED flags).
    _RECALL_CONVERSATIONS_ENABLED = "true"
  }

  depends_on = [google_project_service.apis]
}

# Connector Service trigger - Phase 1 split
resource "google_cloudbuild_trigger" "connector_service" {
  count    = var.connector_service_repo_connected ? 1 : 0
  project  = google_project.platform_ci.project_id
  name     = "connector-service-${var.environment}"
  location = var.region

  description = "Deploy Connector Service to ${var.platform_control_project_id}"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-connector-service"

    push {
      branch = var.deploy_branch_pattern # Per-env: see deploy_branch_pattern var
    }
  }

  ignored_files   = local.deploy_ignored_files
  filename        = "cloudbuild.yaml"
  service_account = google_service_account.cloud_build.id

  substitutions = {
    _ENVIRONMENT       = var.environment
    _REGION            = var.region
    _PROJECT_ID        = var.platform_control_project_id
    _ARTIFACT_REGISTRY = var.artifact_registry
  }

  depends_on = [google_project_service.apis]
}

# Governance Engine trigger — Phase 3 split
resource "google_cloudbuild_trigger" "governance_engine" {
  count    = var.governance_engine_repo_connected ? 1 : 0
  project  = google_project.platform_ci.project_id
  name     = "governance-engine-${var.environment}"
  location = var.region

  description = "Deploy Governance Engine to ${var.platform_control_project_id}"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-governance-engine"

    push {
      branch = var.deploy_branch_pattern # Per-env: see deploy_branch_pattern var
    }
  }

  ignored_files   = local.deploy_ignored_files
  filename        = "cloudbuild.yaml"
  service_account = google_service_account.cloud_build.id

  substitutions = {
    _ENVIRONMENT       = var.environment
    _REGION            = var.region
    _PROJECT_ID        = var.platform_control_project_id
    _ARTIFACT_REGISTRY = var.artifact_registry
  }

  depends_on = [google_project_service.apis]
}

# Harvest Service trigger
resource "google_cloudbuild_trigger" "tunnel_service" {
  count    = var.tunnel_service_repo_connected ? 1 : 0
  project  = google_project.platform_ci.project_id
  name     = "tunnel-service-${var.environment}"
  location = var.region

  description = "Build + deploy liftoff-tunnel-service (terminator) + publish tunnel-client image to GHCR"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-tunnel-service"

    push {
      branch = var.deploy_branch_pattern
    }
  }

  ignored_files   = local.deploy_ignored_files
  filename        = "cloudbuild.yaml"
  service_account = google_service_account.cloud_build.id

  substitutions = {
    _ENVIRONMENT       = var.environment
    _REGION            = var.region
    _PROJECT_ID        = var.platform_control_project_id
    _ARTIFACT_REGISTRY = var.artifact_registry
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloudbuild_trigger" "harvest_service" {
  count    = var.harvest_service_repo_connected ? 1 : 0
  project  = google_project.platform_ci.project_id
  name     = "harvest-service-${var.environment}"
  location = var.region

  description = "Deploy Harvest Service to ${var.platform_control_project_id}"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-harvest-service"

    push {
      branch = var.deploy_branch_pattern
    }
  }

  ignored_files   = local.deploy_ignored_files
  filename        = "cloudbuild.yaml"
  service_account = google_service_account.cloud_build.id

  substitutions = {
    _ENVIRONMENT       = var.environment
    _REGION            = var.region
    _PROJECT_ID        = var.platform_control_project_id
    _ARTIFACT_REGISTRY = var.artifact_registry
  }

  depends_on = [google_project_service.apis]
}

# Workforce Service trigger
# Deploys liftoff-workforce-service to the control project on push to main.
# Trigger lives in platform-ci (consistent with connector-service and governance-engine).
resource "google_cloudbuild_trigger" "workforce_service" {
  count    = var.workforce_service_repo_connected ? 1 : 0
  project  = google_project.platform_ci.project_id
  name     = "workforce-service-${var.environment}"
  location = var.region

  description = "Deploy Workforce Service to ${var.platform_control_project_id}"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-workforce-service"

    push {
      branch = var.deploy_branch_pattern
    }
  }

  ignored_files   = local.deploy_ignored_files
  filename        = "cloudbuild.yaml"
  service_account = google_service_account.cloud_build.id

  substitutions = {
    _ENV    = var.environment
    _REGION = var.region
  }

  depends_on = [google_project_service.apis]
}

# Billing trigger
resource "google_cloudbuild_trigger" "billing" {
  count    = var.billing_repo_connected ? 1 : 0
  project  = google_project.platform_ci.project_id
  name     = "billing-${var.environment}"
  location = var.region

  description = "Deploy Billing Service to ${var.platform_control_project_id}"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-billing"

    push {
      branch = var.deploy_branch_pattern
    }
  }

  ignored_files   = local.deploy_ignored_files
  filename        = "cloudbuild.yaml"
  service_account = google_service_account.cloud_build.id

  substitutions = {
    _ENV    = var.environment
    _REGION = var.region
  }

  depends_on = [google_project_service.apis]
}

# Developer Proxy trigger
resource "google_cloudbuild_trigger" "developer_proxy" {
  count    = var.developer_proxy_repo_connected ? 1 : 0
  project  = google_project.platform_ci.project_id
  name     = "developer-proxy-${var.environment}"
  location = var.region

  description = "Deploy Developer Proxy to ${var.platform_control_project_id}"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-developer-proxy"

    push {
      branch = var.deploy_branch_pattern
    }
  }

  ignored_files   = local.deploy_ignored_files
  filename        = "cloudbuild.yaml"
  service_account = google_service_account.cloud_build.id

  substitutions = {
    _ENV                 = var.environment
    _REGION              = var.region
    _BILLING_SERVICE_URL = var.billing_service_url
    # Canonical public platform-backend URL (api.example.com in prod,
    # api-${env}.example.com elsewhere). Without this, the cloudbuild
    # _PLATFORM_BACKEND_URL default (a dev URL) is used, which points prod's
    # BYOK audit delivery + credential shadow-sync at the dev backend.
    _PLATFORM_BACKEND_URL = var.environment == "prod" ? "https://api.example.com" : "https://api-${var.environment}.example.com"
    # The proxy URL a developer's tool is handed at credential setup. The
    # cloudbuild default is the dev URL, so without this override prod would
    # deploy advertising https://api-dev.example.com/proxy.
    # The service's own config derives this from ENVIRONMENT when it is empty,
    # and this value matches that derivation.
    _PROXY_BASE_URL = var.environment == "prod" ? "https://api.example.com/proxy" : "https://api-${var.environment}.example.com/proxy"
    # Browser origins: the site's hostnames, never a run.app URL (the site's
    # run.app URL no longer answers).
    _CORS_ALLOWED_ORIGINS = var.environment == "prod" ? "https://example.com,https://www.example.com" : "https://${var.environment}.example.com"
  }

  depends_on = [google_project_service.apis]
}

# Infrastructure GCP trigger - Terraform plan on PR
resource "google_cloudbuild_trigger" "infrastructure_plan" {
  count    = var.github_repos_connected ? 1 : 0
  project  = google_project.platform_ci.project_id
  name     = "infrastructure-plan-${var.environment}"
  location = var.region

  description = "Terraform plan on pull requests"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-infrastructure-gcp"

    pull_request {
      branch = var.deploy_branch_pattern # Per-env: see deploy_branch_pattern var
    }
  }

  filename        = "cloudbuild.yaml"
  service_account = google_service_account.cloud_build.id

  substitutions = {
    _ENVIRONMENT     = var.environment
    _TF_STATE_BUCKET = "YOUR_CI_PROJECT_${var.environment}-tfstate"
    _PLAN_ONLY       = "true"
  }

  depends_on = [google_project_service.apis]
}

# Infrastructure GCP trigger - Terraform apply on merge
resource "google_cloudbuild_trigger" "infrastructure_apply" {
  count    = var.github_repos_connected ? 1 : 0
  project  = google_project.platform_ci.project_id
  name     = "infrastructure-apply-${var.environment}"
  location = var.region

  description = "Terraform apply on merge to main/env branch"

  github {
    owner = "LiftoffOS"
    name  = "liftoff-infrastructure-gcp"

    push {
      branch = var.deploy_branch_pattern # Per-env: see deploy_branch_pattern var
    }
  }

  filename        = "cloudbuild.yaml"
  service_account = google_service_account.cloud_build.id

  substitutions = {
    _ENVIRONMENT     = var.environment
    _TF_STATE_BUCKET = "YOUR_CI_PROJECT_${var.environment}-tfstate"
    _PLAN_ONLY       = "false"
  }

  depends_on = [google_project_service.apis]
}

# -----------------------------------------------------------------------------
# Governance Adversarial Eval — Cloud Run Job
# Runs scripts/governance-adversarial-eval.js against the deployed
# governance-engine to check for adversarial prompt injection regressions.
# Disabled by default (count = 0); flip governance_adversarial_eval_enabled
# to true in the environment tfvars to enable.
# -----------------------------------------------------------------------------

# Dedicated SA for the governance adversarial eval job.
# Lives in platform-control so cloud-build-dev's project-level iam.serviceAccountUser
# in platform-control covers it — avoids cross-project actAs issues.
resource "google_service_account" "governance_eval" {
  count        = var.governance_adversarial_eval_enabled ? 1 : 0
  project      = var.platform_control_project_id
  account_id   = "governance-eval-${var.environment}"
  display_name = "Governance Adversarial Eval Job"
}

resource "google_secret_manager_secret_iam_member" "governance_eval_governance_token" {
  count     = var.governance_adversarial_eval_enabled ? 1 : 0
  project   = var.platform_control_project_id
  secret_id = "governance-engine-token"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.governance_eval[0].email}"
}

resource "google_secret_manager_secret_iam_member" "governance_eval_pb_token" {
  count     = var.governance_adversarial_eval_enabled ? 1 : 0
  project   = var.platform_control_project_id
  secret_id = "governance-eval-service-token"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.governance_eval[0].email}"
}

# Platform Backend also reads governance-eval-service-token to validate
# incoming X-Service-Auth from the eval job's LLM relay calls.
resource "google_secret_manager_secret_iam_member" "platform_backend_governance_eval_token" {
  count     = var.governance_adversarial_eval_enabled ? 1 : 0
  project   = var.platform_control_project_id
  secret_id = "governance-eval-service-token"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:platform-backend-${var.environment}@${var.platform_control_project_id}.iam.gserviceaccount.com"
}

resource "google_cloud_run_v2_service_iam_member" "governance_eval_governance_invoker" {
  count    = var.governance_adversarial_eval_enabled ? 1 : 0
  project  = var.platform_control_project_id
  location = var.region
  name     = "governance-engine"
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.governance_eval[0].email}"
}

resource "google_cloud_run_v2_service_iam_member" "governance_eval_pb_invoker" {
  count    = var.governance_adversarial_eval_enabled ? 1 : 0
  project  = var.platform_control_project_id
  location = var.region
  name     = "platform-backend"
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.governance_eval[0].email}"
}

resource "google_cloud_run_v2_job" "governance_adversarial_eval" {
  count    = var.governance_adversarial_eval_enabled ? 1 : 0
  project  = var.platform_control_project_id
  name     = "governance-adversarial-eval"
  location = var.region

  template {
    template {
      timeout         = "600s"
      service_account = google_service_account.governance_eval[0].email

      containers {
        image   = "${var.region}-docker.pkg.dev/${var.platform_control_project_id}/YOUR_GCP_PROJECT${var.environment}/governance-engine:latest"
        command = ["node", "dist/scripts/governance-adversarial-eval.js"]

        env {
          name  = "GOVERNANCE_BASE_URL"
          value = var.governance_engine_url
        }

        env {
          name = "GOVERNANCE_SERVICE_TOKEN"
          value_source {
            secret_key_ref {
              secret  = "governance-engine-token"
              version = "latest"
            }
          }
        }

        env {
          name  = "PLATFORM_BACKEND_URL"
          value = var.platform_backend_url
        }

        env {
          name = "PLATFORM_BACKEND_TOKEN"
          value_source {
            secret_key_ref {
              secret  = "governance-eval-service-token"
              version = "latest"
            }
          }
        }

        env {
          name  = "GCS_ARTIFACT_BUCKET"
          value = "YOUR_GCP_PROJECT${var.environment}-artifacts"
        }
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_service_account.governance_eval,
    google_secret_manager_secret_iam_member.governance_eval_governance_token,
    google_secret_manager_secret_iam_member.governance_eval_pb_token,
  ]
}

# -----------------------------------------------------------------------------
# Agent Performance-Understanding Harness — passive eval Cloud Run Job + SA/IAM.
# Modeled on governance_adversarial_eval above. Reads all three service DBs
# (read-only), judges via the configured DeepEval provider, writes scorecards to
# BigQuery, emits agent_health log-metrics. SA/IAM per the plan's Orchestration
# & Gating "SA/IAM" list.
# -----------------------------------------------------------------------------
resource "google_service_account" "agent_diagnostics" {
  count        = var.agent_diagnostics_enabled ? 1 : 0
  project      = var.platform_control_project_id
  account_id   = "agent-diagnostics-${var.environment}"
  display_name = "Agent Diagnostics Passive Eval Job"
}

locals {
  agent_diagnostics_member = var.agent_diagnostics_enabled ? "serviceAccount:${google_service_account.agent_diagnostics[0].email}" : ""
}

# Secret CONTAINERS for the dedicated diagnostics credentials. Terraform owns the
# resource (id, replication, labels, lifecycle) so they follow the managed_by
# convention and surface in label-based audits; the VERSIONS (values) are
# populated out-of-band (operator-provided keys / DB URLs) and intentionally NOT
# managed here. Replication is `auto {}` to match the existing secrets created
# before they were brought under terraform — replication is immutable, so this
# must match or import would force a destroy/recreate.
resource "google_secret_manager_secret" "diagnostics_workforce_db_url" {
  count     = var.agent_diagnostics_enabled ? 1 : 0
  project   = var.platform_control_project_id
  secret_id = var.agent_diagnostics_workforce_db_url_secret
  labels    = { type = "db-url", environment = var.environment, managed_by = "terraform" }
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "diagnostics_insights_db_url" {
  count     = var.agent_diagnostics_enabled ? 1 : 0
  project   = var.platform_control_project_id
  secret_id = var.agent_diagnostics_insights_db_url_secret
  labels    = { type = "db-url", environment = var.environment, managed_by = "terraform" }
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "diagnostics_openai_api_key" {
  count     = var.agent_diagnostics_enabled ? 1 : 0
  project   = var.platform_control_project_id
  secret_id = var.deepeval_openai_api_key_secret
  labels    = { type = "api-key", environment = var.environment, managed_by = "terraform" }
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret" "diagnostics_anthropic_api_key" {
  count     = var.agent_diagnostics_enabled ? 1 : 0
  project   = var.platform_control_project_id
  secret_id = var.deepeval_anthropic_api_key_secret
  labels    = { type = "api-key", environment = var.environment, managed_by = "terraform" }
  replication {
    auto {}
  }
}

# Read-only DB connection-string secrets (workforce + insights/PB).
resource "google_secret_manager_secret_iam_member" "agent_diagnostics_workforce_db" {
  count     = var.agent_diagnostics_enabled ? 1 : 0
  project   = var.platform_control_project_id
  secret_id = var.agent_diagnostics_workforce_db_url_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = local.agent_diagnostics_member
}

resource "google_secret_manager_secret_iam_member" "agent_diagnostics_insights_db" {
  count     = var.agent_diagnostics_enabled ? 1 : 0
  project   = var.platform_control_project_id
  secret_id = var.agent_diagnostics_insights_db_url_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = local.agent_diagnostics_member
}

resource "google_secret_manager_secret_iam_member" "agent_diagnostics_service_token" {
  count     = var.agent_diagnostics_enabled ? 1 : 0
  project   = var.platform_control_project_id
  secret_id = var.agent_diagnostics_service_token_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = local.agent_diagnostics_member
}

# (Removed: Cloud Build executor IAM for agent-diagnostics. It only existed so
# the deploy-canary could `gcloud run jobs execute` the job; with diagnostics now
# on-demand-only, Cloud Build no longer invokes it. On-demand runs use the
# operator's own credentials.)

# BigQuery dataEditor + jobUser for the results sink.
resource "google_project_iam_member" "agent_diagnostics_bq_data_editor" {
  count   = var.agent_diagnostics_enabled ? 1 : 0
  project = var.platform_control_project_id
  role    = "roles/bigquery.dataEditor"
  member  = local.agent_diagnostics_member
}

resource "google_project_iam_member" "agent_diagnostics_bq_job_user" {
  count   = var.agent_diagnostics_enabled ? 1 : 0
  project = var.platform_control_project_id
  role    = "roles/bigquery.jobUser"
  member  = local.agent_diagnostics_member
}

# In-boundary Vertex Gemini judge.
resource "google_project_iam_member" "agent_diagnostics_vertex_user" {
  count   = var.agent_diagnostics_enabled ? 1 : 0
  project = var.platform_control_project_id
  role    = "roles/aiplatform.user"
  member  = local.agent_diagnostics_member
}

# RCA cross-service evidence: logs + traces.
resource "google_project_iam_member" "agent_diagnostics_logging_viewer" {
  count   = var.agent_diagnostics_enabled ? 1 : 0
  project = var.platform_control_project_id
  role    = "roles/logging.viewer"
  member  = local.agent_diagnostics_member
}

resource "google_project_iam_member" "agent_diagnostics_trace_user" {
  count   = var.agent_diagnostics_enabled ? 1 : 0
  project = var.platform_control_project_id
  role    = "roles/cloudtrace.user"
  member  = local.agent_diagnostics_member
}

# Cloud SQL client so the read-only pools can connect to the service DBs.
resource "google_project_iam_member" "agent_diagnostics_sql_client" {
  count   = var.agent_diagnostics_enabled ? 1 : 0
  project = var.platform_control_project_id
  role    = "roles/cloudsql.client"
  member  = local.agent_diagnostics_member
}

# Write NDJSON scorecards to the results bucket (GCS sink fallback). objectAdmin
# (not objectCreator): the sink writes to a deterministic per-run key and
# OVERWRITES it, which GCS requires storage.objects.delete for — objectCreator
# can only create new objects and fails the overwrite with a delete-denied error.
resource "google_storage_bucket_iam_member" "agent_diagnostics_results_writer" {
  count  = var.agent_diagnostics_enabled ? 1 : 0
  bucket = "trajectories-${var.environment}"
  role   = "roles/storage.objectAdmin"
  member = local.agent_diagnostics_member
}

# agent_health log-metric + alert live HERE (the project the diagnostics job
# logs to), not in tenant-runtime-template — the job runs in platform-control,
# so a tenant-project metric would never see its logs. Emitted by report/sink.ts
# (jsonPayload.event="agent_health"); the alert fires on regressed="true".
resource "google_logging_metric" "agent_health" {
  count       = var.agent_diagnostics_enabled ? 1 : 0
  project     = var.platform_control_project_id
  name        = "agent_health"
  description = "Passive per-agent health across the four eval dimensions."
  filter      = "jsonPayload.event = \"agent_health\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
    labels {
      key        = "agent"
      value_type = "STRING"
    }
    labels {
      key        = "dimension"
      value_type = "STRING"
    }
    labels {
      key        = "regressed"
      value_type = "STRING"
    }
  }
  label_extractors = {
    "agent"     = "EXTRACT(jsonPayload.agent)"
    "dimension" = "EXTRACT(jsonPayload.dimension)"
    "regressed" = "EXTRACT(jsonPayload.regressed)"
  }
}

resource "google_monitoring_alert_policy" "agent_health_regressed" {
  count        = var.agent_diagnostics_enabled ? 1 : 0
  project      = var.platform_control_project_id
  display_name = "Agent health regressed — ${var.environment}"
  combiner     = "OR"
  conditions {
    display_name = "agent_health regressed=true rate > 0 (sustained 10 min)"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/agent_health\" resource.type=\"cloud_run_job\" metric.label.regressed=\"true\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "600s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }
  alert_strategy { auto_close = "1800s" }
  depends_on = [google_logging_metric.agent_health]
}

resource "google_cloud_run_v2_job" "agent_diagnostics" {
  count    = var.agent_diagnostics_enabled ? 1 : 0
  project  = var.platform_control_project_id
  name     = "agent-diagnostics"
  location = var.region

  template {
    template {
      timeout         = "1800s"
      service_account = google_service_account.agent_diagnostics[0].email

      # The job reads the service DBs on private IPs (10.x), which is all the VPC
      # carries for it. Everything else (the evaluator, agent-service, Vertex /
      # OpenAI / Anthropic, BigQuery, Secret Manager) is a public address and
      # leaves directly. It used to send ALL traffic through the VPC so it could
      # reach an internal-only evaluator, which needed a Cloud NAT running around
      # the clock for one daily job; the evaluator is IAM-gated instead (below).
      vpc_access {
        network_interfaces {
          network    = "projects/${var.platform_control_project_id}/global/networks/vpc-${var.environment}"
          subnetwork = "projects/${var.platform_control_project_id}/regions/${var.region}/subnetworks/subnet-${var.region}-${var.environment}"
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

      containers {
        # tenant-runtime images are tagged by commit SHA (no :latest). Pin to the
        # SHA whose build contains the diagnostics CLI.
        image   = "${var.region}-docker.pkg.dev/${var.platform_control_project_id}/YOUR_GCP_PROJECT${var.environment}/tenant-runtime:${var.agent_diagnostics_image_tag}"
        command = ["node", "dist/scripts/agent-diagnostics.js"]
        args    = ["--harvest", "--agents", "user-created,caio,hrbp,insights"]

        env {
          name  = "DIAGNOSTICS_EVAL_TENANT_ID"
          value = var.agent_diagnostics_eval_tenant_id
        }

        # Deliverable grader toggles (default off/empty; grader config also rides
        # the /harvest request body, so these only gate the job-driven passes).
        env {
          name  = "DIAGNOSTICS_GRADER_ENABLED"
          value = var.diagnostics_grader_enabled
        }
        env {
          name  = "DIAGNOSTICS_GRADER_JUDGES"
          value = var.diagnostics_grader_judges
        }
        env {
          name  = "DIAGNOSTICS_RUBRIC_MODEL"
          value = var.diagnostics_rubric_model
        }
        env {
          name  = "DIAGNOSTICS_GRADER_MODE"
          value = var.diagnostics_grader_mode
        }
        env {
          name  = "DIAGNOSTICS_LABELED_SET_PATH"
          value = var.diagnostics_labeled_set_path
        }

        env {
          name = "DIAGNOSTICS_WORKFORCE_DB_URL"
          value_source {
            secret_key_ref {
              secret  = var.agent_diagnostics_workforce_db_url_secret
              version = "latest"
            }
          }
        }

        env {
          name = "DIAGNOSTICS_INSIGHTS_DB_URL"
          value_source {
            secret_key_ref {
              secret  = var.agent_diagnostics_insights_db_url_secret
              version = "latest"
            }
          }
        }

        # Evaluate-in-tenant-runtime inversion: user-created runs need the
        # tenant-local DB + live tool-gateway to reconstruct, which the control
        # job cannot reach across the per-tenant VPC. Instead the job calls the
        # eval-tenant agent-service test-harness, which reconstructs + evaluates
        # in-process and returns EvaluatedRuns. Auth = OIDC (run.invoker) at the
        # ingress + this shared secret as X-Service-Auth at the app layer.
        env {
          name  = "DIAGNOSTICS_TR_HARNESS_URL"
          value = var.agent_diagnostics_tr_harness_url
        }

        env {
          name = "DIAGNOSTICS_SERVICE_TOKEN"
          value_source {
            secret_key_ref {
              secret  = var.agent_diagnostics_service_token_secret
              version = "latest"
            }
          }
        }

        # Fleet auto-discovery: the harvest reads PB's internal
        # /api/internal/diagnostics/fleet-tenants to enumerate every active tenant
        # (verifyServiceAuth → TENANT_RUNTIME_SERVICE_TOKEN, which DIAGNOSTICS_SERVICE_TOKEN
        # above satisfies), so eval harvest is default for all tenants with no per-tenant
        # enrollment. The internal route is token-gated, so the public edge URL is fine.
        env {
          name  = "PLATFORM_BACKEND_URL"
          value = var.platform_backend_url != "" ? var.platform_backend_url : (var.environment == "prod" ? "https://api.example.com" : "https://api-${var.environment}.example.com")
        }

        # Per-agent target IDs (R1b). Without these agentIdFor() returns the zero
        # UUID and user-created harvest finds no runs.
        env {
          name  = "DIAGNOSTICS_USER_AGENT_ID"
          value = var.agent_diagnostics_user_agent_id
        }
        env {
          name  = "DIAGNOSTICS_CAIO_AGENT_ID"
          value = var.agent_diagnostics_caio_agent_id
        }
        env {
          name  = "DIAGNOSTICS_HRBP_AGENT_ID"
          value = var.agent_diagnostics_hrbp_agent_id
        }
        env {
          name  = "DIAGNOSTICS_INSIGHTS_AGENT_ID"
          value = var.agent_diagnostics_insights_agent_id
        }

        env {
          name  = "DIAGNOSTICS_BQ_DATASET"
          value = "agent_diagnostics"
        }

        # GCS NDJSON results fallback (used when the BigQuery client isn't in the
        # image). Without this the sink drops scorecard rows.
        env {
          name  = "DIAGNOSTICS_RESULTS_BUCKET"
          value = "trajectories-${var.environment}"
        }

        env {
          name  = "GCP_PROJECT_ID"
          value = var.platform_control_project_id
        }

        # In-boundary DeepEval scoring service (semantic metrics). When set, the
        # harness routes goal/conformance through DeepEval; otherwise it falls
        # back to the native Vertex judge.
        env {
          name  = "DEEPEVAL_SERVICE_URL"
          value = google_cloud_run_v2_service.deepeval_evaluator[0].uri
        }

        # tenant-runtime needs ENVIRONMENT for its secret/config resolution.
        env {
          name  = "ENVIRONMENT"
          value = var.environment
        }

        # Native fallback judge (llmClient) — provider/tier switchable from here.
        env {
          name  = "DIAGNOSTICS_JUDGE_PROVIDER"
          value = var.diagnostics_judge_provider
        }
        env {
          name  = "DIAGNOSTICS_JUDGE_TIER"
          value = var.diagnostics_judge_tier
        }

        # Dedicated diagnostics provider keys. llmClient is env-first
        # (process.env.OPENAI_API_KEY / ANTHROPIC_API_KEY take precedence over the
        # platform secrets, and loadSecretsToEnv won't overwrite them), so these
        # make the job's judging spend show up under the DEDICATED keys. Vertex
        # providers use ADC (the SA's aiplatform.user) and ignore these.
        env {
          name = "OPENAI_API_KEY"
          value_source {
            secret_key_ref {
              secret  = var.deepeval_openai_api_key_secret
              version = "latest"
            }
          }
        }
        env {
          name = "ANTHROPIC_API_KEY"
          value_source {
            secret_key_ref {
              secret  = var.deepeval_anthropic_api_key_secret
              version = "latest"
            }
          }
        }

        # Durable collab-grade fan-out target. `--collab-grade` (modeCollabGrade)
        # LISTS ungraded collab sessions here in the control plane and fans out
        # ONE execution of the tenant `tenant-runtime-collab-grade` Cloud Run Job
        # per session (base64 worklist override), because execution-heavy agentic
        # grades exceed the 300s /harvest request window. Full resource path of
        # that tenant job. Empty (default) → --collab-grade errors fast; the
        # unrelated --harvest pass ignores it. Passed as a STATIC string from the
        # root (the eval tenant's project is deterministic, tenant-<id>-<env>) to
        # avoid a platform_ci → tenant_liftoffos module edge / count-on-computed,
        # mirroring diagnostics_sa in environments/<env>/main.tf. Appended last so
        # its addition is a clean single env insert (no positional list churn).
        env {
          name  = "COLLAB_GRADE_JOB"
          value = var.agent_diagnostics_collab_grade_job
        }
      }
    }
  }

  # The tenant-runtime Cloud Build now updates this job's image to the SHA it just
  # deployed (update-diagnostics-image step), so the evaluator tracks current code.
  # The var above is only the seed on first apply; ignore later image drift here so
  # Terraform and the build don't fight over ownership.
  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      # client/client_version are stamped by cloudbuild's gcloud run deploy.
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.apis,
    google_service_account.agent_diagnostics,
    google_secret_manager_secret_iam_member.agent_diagnostics_workforce_db,
    google_secret_manager_secret_iam_member.agent_diagnostics_insights_db,
    google_secret_manager_secret_iam_member.agent_diagnostics_service_token,
    google_secret_manager_secret_iam_member.diagnostics_openai_key_readers,
    google_secret_manager_secret_iam_member.diagnostics_anthropic_key_readers,
    google_cloud_run_v2_service.deepeval_evaluator,
  ]
}

# Scheduled passive harvest: a Cloud Scheduler job that runs the agent-diagnostics job on a
# cadence (default daily 06:00 UTC). The job's default args are already `--harvest`.
resource "google_service_account" "agent_diagnostics_scheduler" {
  count      = var.agent_diagnostics_enabled ? 1 : 0
  project    = var.platform_control_project_id
  account_id = "agent-diag-scheduler"
}

resource "google_cloud_run_v2_job_iam_member" "diag_scheduler_invoker" {
  count    = var.agent_diagnostics_enabled ? 1 : 0
  project  = var.platform_control_project_id
  location = var.region
  name     = google_cloud_run_v2_job.agent_diagnostics[0].name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.agent_diagnostics_scheduler[0].email}"
}

# The tenant-runtime build updates this job's image on every deploy
# (update-diagnostics-image step). The project-level run.admin the build SA
# already holds covers that today, but pin run.developer on the job explicitly
# so the update survives run.admin ever being narrowed — same belt-and-suspenders
# pattern as the run.invoker grants above.
resource "google_cloud_run_v2_job_iam_member" "cloud_build_updates_diagnostics" {
  count    = var.agent_diagnostics_enabled ? 1 : 0
  project  = var.platform_control_project_id
  location = var.region
  name     = google_cloud_run_v2_job.agent_diagnostics[0].name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.cloud_build.email}"
}

resource "google_cloud_scheduler_job" "agent_diagnostics_harvest" {
  count    = var.agent_diagnostics_enabled && var.agent_diagnostics_scheduled ? 1 : 0
  project  = var.platform_control_project_id
  region   = var.region
  name     = "agent-diagnostics-harvest"
  schedule = var.agent_diagnostics_harvest_schedule

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.platform_control_project_id}/locations/${var.region}/jobs/agent-diagnostics:run"

    oauth_token {
      service_account_email = google_service_account.agent_diagnostics_scheduler[0].email
    }
  }
}

# -----------------------------------------------------------------------------
# deepeval-evaluator — DeepEval scoring service (Python). Judges via the
# CONFIGURED provider/model (LLMClient-style: anthropic | openai |
# anthropic-vertex | google | self-hosted). Internal ingress; only the
# diagnostics job invokes it. Built from
# Liftoff-Tenant-Runtime/services/deepeval-evaluator.
# -----------------------------------------------------------------------------
variable "deepeval_evaluator_image" {
  type        = string
  default     = "gcr.io/google.com/cloudsdktool/cloud-sdk:slim"
  description = "Artifact Registry URL of the built deepeval-evaluator image. Defaults to a placeholder so plans parse before the first image build."
}

variable "deepeval_provider" {
  type        = string
  default     = "openai"
  description = "Judge provider, same set as LLMClient: anthropic | openai | anthropic-vertex | google | self-hosted. Defaults to openai."
}

# Dedicated diagnostics provider keys — SEPARATE from the platform's main LLM
# keys so DeepEval/diagnostics spend is tracked independently at the provider.
# Managed OUT-OF-BAND per env (created in Secret Manager already); Terraform only
# references them. Used by BOTH the evaluator service and the diagnostics job,
# so either can switch providers freely.
variable "deepeval_openai_api_key_secret" {
  type        = string
  default     = "diagnostics-openai-api-key"
  description = "Secret id for the DEDICATED diagnostics OpenAI key (injected as OPENAI_API_KEY into the evaluator service + diagnostics job)."
}

variable "deepeval_anthropic_api_key_secret" {
  type        = string
  default     = "diagnostics-anthropic-api-key"
  description = "Secret id for the DEDICATED diagnostics Anthropic key (injected as ANTHROPIC_API_KEY into the evaluator service + diagnostics job)."
}

variable "diagnostics_judge_provider" {
  type        = string
  default     = "anthropic"
  description = "Native fallback judge provider in the diagnostics job (DIAGNOSTICS_JUDGE_PROVIDER): anthropic | openai | anthropic-vertex | google. Default anthropic."
}

variable "diagnostics_judge_tier" {
  type        = string
  default     = "flagship"
  description = "Native fallback judge tier (DIAGNOSTICS_JUDGE_TIER): flagship | medium | small. Default flagship."
}

variable "deepeval_tier" {
  type        = string
  default     = "flagship"
  description = "Judge model tier (flagship | medium | small). Defaults to flagship for judge reliability. Ignored when deepeval_model is set or provider=self-hosted."
}

variable "deepeval_model" {
  type        = string
  default     = ""
  description = "Exact judge model id; overrides the tier. Required when deepeval_provider=self-hosted."
}

variable "deepeval_base_url" {
  type        = string
  default     = ""
  description = "OpenAI-compatible endpoint URL for the self-hosted judge provider."
}

resource "google_service_account" "deepeval_evaluator" {
  count        = var.agent_diagnostics_enabled ? 1 : 0
  project      = var.platform_control_project_id
  account_id   = "deepeval-evaluator-${var.environment}"
  display_name = "DeepEval Evaluator (configurable-provider judge) service"
}

# aiplatform.user covers the Vertex providers (google / anthropic-vertex).
resource "google_project_iam_member" "deepeval_evaluator_vertex_user" {
  count   = var.agent_diagnostics_enabled ? 1 : 0
  project = var.platform_control_project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.deepeval_evaluator[0].email}"
}

# Optional provider-credential secrets (only when the provider is selected).
# The dedicated diagnostics key secrets are managed OUT-OF-BAND (created in
# Secret Manager per env, like the platform's other LLM keys) — Terraform only
# REFERENCES them, it does not own them. This matches the platform convention
# and avoids 409 "already exists" on apply. Rotate keys with
# `gcloud secrets versions add <secret> --project=YOUR_GCP_PROJECT<env> --data-file=-`.
#
# Both SAs (evaluator service + diagnostics job) may read both keys, so either
# can switch providers without re-plumbing IAM.
locals {
  # Static KEYS (known at plan) → SA email (computed at apply). for_each requires
  # known keys; mapping by a stable label avoids "Invalid for_each argument".
  diagnostics_key_reader_sas = var.agent_diagnostics_enabled ? {
    evaluator = google_service_account.deepeval_evaluator[0].email
    job       = google_service_account.agent_diagnostics[0].email
  } : {}
}

resource "google_secret_manager_secret_iam_member" "diagnostics_openai_key_readers" {
  for_each  = local.diagnostics_key_reader_sas
  project   = var.platform_control_project_id
  secret_id = var.deepeval_openai_api_key_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value}"
}

resource "google_secret_manager_secret_iam_member" "diagnostics_anthropic_key_readers" {
  for_each  = local.diagnostics_key_reader_sas
  project   = var.platform_control_project_id
  secret_id = var.deepeval_anthropic_api_key_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value}"
}

resource "google_cloud_run_v2_service" "deepeval_evaluator" {
  count    = var.agent_diagnostics_enabled ? 1 : 0
  project  = var.platform_control_project_id
  name     = "deepeval-evaluator"
  location = var.region
  # Reachable at its run.app address, and admitted only with an ID token for a
  # principal holding run.invoker on it, which is the diagnostics job's SA
  # alone (no allUsers binding). The job mints that token per call
  # (tenant-runtime src/diagnostics/analyze/judge/deepeval-client.ts). Internal
  # ingress would force the job's internet calls through a Cloud NAT.
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.deepeval_evaluator[0].email
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
    containers {
      image = var.deepeval_evaluator_image
      # Scale-to-zero economics: cpu_idle throttles CPU when no request is in
      # flight (CPU billed only during requests), so an idle service costs ~$0.
      # startup_cpu_boost gives extra CPU during the heavy DeepEval cold start.
      # 2Gi guards against OOM on DeepEval's import (it pulls a large dep tree).
      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.platform_control_project_id
      }
      env {
        name  = "GCP_LOCATION"
        value = "global"
      }
      env {
        name  = "DEEPEVAL_PROVIDER"
        value = var.deepeval_provider
      }
      env {
        name  = "DEEPEVAL_TIER"
        value = var.deepeval_tier
      }
      env {
        name  = "DEEPEVAL_MODEL"
        value = var.deepeval_model
      }
      env {
        name  = "DEEPEVAL_BASE_URL"
        value = var.deepeval_base_url
      }
      # Provider credentials — dedicated diagnostics keys, always wired so the
      # provider can be switched freely. The Vertex providers (google /
      # anthropic-vertex) use ADC and ignore these.
      env {
        name = "OPENAI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = var.deepeval_openai_api_key_secret
            version = "latest"
          }
        }
      }
      env {
        name = "ANTHROPIC_API_KEY"
        value_source {
          secret_key_ref {
            secret  = var.deepeval_anthropic_api_key_secret
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [
    google_project_service.apis,
    google_service_account.deepeval_evaluator,
    google_secret_manager_secret_iam_member.diagnostics_openai_key_readers,
    google_secret_manager_secret_iam_member.diagnostics_anthropic_key_readers,
  ]
}

# Only the diagnostics job may invoke the evaluator.
resource "google_cloud_run_v2_service_iam_member" "deepeval_evaluator_invoker" {
  count    = var.agent_diagnostics_enabled ? 1 : 0
  project  = var.platform_control_project_id
  location = var.region
  name     = google_cloud_run_v2_service.deepeval_evaluator[0].name
  role     = "roles/run.invoker"
  member   = local.agent_diagnostics_member
}

# BigQuery results dataset + tables (Always-Free). The sink writes here; Looker
# Studio reads from these tables (the dashboards themselves are built in the
# Looker UI — no Terraform resource exists for Looker Studio reports).
resource "google_bigquery_dataset" "agent_diagnostics" {
  count                      = var.agent_diagnostics_enabled ? 1 : 0
  project                    = var.platform_control_project_id
  dataset_id                 = "agent_diagnostics"
  location                   = "US"
  description                = "Agent Performance-Understanding Harness results: scorecards, failure clusters, per-run results."
  delete_contents_on_destroy = false
}

resource "google_bigquery_table" "scorecards" {
  count               = var.agent_diagnostics_enabled ? 1 : 0
  project             = var.platform_control_project_id
  dataset_id          = google_bigquery_dataset.agent_diagnostics[0].dataset_id
  table_id            = "scorecards"
  deletion_protection = false
  schema = jsonencode([
    { name = "agentKind", type = "STRING" },
    { name = "tenantId", type = "STRING" },
    { name = "agentId", type = "STRING" },
    { name = "computedAt", type = "TIMESTAMP" },
    { name = "runCount", type = "INT64" },
    { name = "gatingFailureRate", type = "FLOAT64" },
    { name = "invariantFindingCount", type = "INT64" },
    { name = "avgToolCorrectness", type = "FLOAT64" },
    { name = "avgStepEfficiency", type = "FLOAT64" },
    { name = "loopRate", type = "FLOAT64" },
    { name = "avgCostUsd", type = "FLOAT64" },
    { name = "avgLatencyMs", type = "FLOAT64" },
    { name = "goalSuccessRate", type = "FLOAT64" },
    { name = "specConformanceRate", type = "FLOAT64" },
    { name = "avgArgValidity", type = "FLOAT64" },
    { name = "argAppropriatenessRate", type = "FLOAT64" },
    { name = "avgDeliverableScore", type = "FLOAT64" },
    { name = "gradedRunCount", type = "INT64" },
    { name = "findingsByStage", type = "STRING" },
  ])
  # External (BigLake-style) table over the diagnostics NDJSON the job writes to
  # GCS. Keeps the producer decoupled from BigQuery (job → GCS), while the rows
  # are queryable directly in BQ with zero ETL; every new run auto-appears.
  external_data_configuration {
    autodetect            = false
    source_format         = "NEWLINE_DELIMITED_JSON"
    source_uris           = ["gs://trajectories-${var.environment}/diagnostics/scorecards/*"]
    ignore_unknown_values = true # the NDJSON carries a _batch field not in schema
  }
}

resource "google_bigquery_table" "failure_clusters" {
  count               = var.agent_diagnostics_enabled ? 1 : 0
  project             = var.platform_control_project_id
  dataset_id          = google_bigquery_dataset.agent_diagnostics[0].dataset_id
  table_id            = "failure_clusters"
  deletion_protection = false
  schema = jsonencode([
    { name = "agentKind", type = "STRING" },
    { name = "agentId", type = "STRING" },
    { name = "computedAt", type = "TIMESTAMP" },
    { name = "key", type = "STRING" },
    { name = "failureMode", type = "STRING" },
    { name = "taxonomy", type = "STRING" },
    { name = "stage", type = "STRING" },
    { name = "frequency", type = "INT64" },
    { name = "severityWeight", type = "INT64" },
    { name = "score", type = "INT64" },
    { name = "invariants", type = "STRING" },
    { name = "exampleMessages", type = "STRING" },
    { name = "fixSuggestions", type = "STRING" },
  ])
  external_data_configuration {
    autodetect            = false
    source_format         = "NEWLINE_DELIMITED_JSON"
    source_uris           = ["gs://trajectories-${var.environment}/diagnostics/failure_clusters/*"]
    ignore_unknown_values = true
  }
}

resource "google_bigquery_table" "run_results" {
  count               = var.agent_diagnostics_enabled ? 1 : 0
  project             = var.platform_control_project_id
  dataset_id          = google_bigquery_dataset.agent_diagnostics[0].dataset_id
  table_id            = "run_results"
  deletion_protection = false
  schema = jsonencode([
    { name = "agent", type = "STRING" },
    { name = "agentId", type = "STRING" },
    { name = "key", type = "STRING" },
    { name = "computedAt", type = "TIMESTAMP" },
    { name = "gating", type = "BOOL" },
    { name = "findingCount", type = "INT64" },
    { name = "toolCorrectness", type = "FLOAT64" },
    { name = "stepEfficiency", type = "FLOAT64" },
    { name = "goalPass", type = "BOOL" },
    { name = "conformancePass", type = "BOOL" },
    { name = "argValidity", type = "FLOAT64" },
    { name = "argAppropriatenessPass", type = "BOOL" },
    { name = "deliverableScore", type = "FLOAT64" },
    { name = "deliverableScoreSpread", type = "FLOAT64" },
    { name = "rubricId", type = "STRING" },
    { name = "rcaStage", type = "STRING" },
    { name = "scenarioId", type = "STRING" },
    { name = "trial", type = "INT64" },
    { name = "canary", type = "BOOL" },
  ])
  external_data_configuration {
    autodetect            = false
    source_format         = "NEWLINE_DELIMITED_JSON"
    source_uris           = ["gs://trajectories-${var.environment}/diagnostics/run_results/*"]
    ignore_unknown_values = true
  }
}

# The agent-diagnostics Cloud Run Job runs on the daily Cloud Scheduler above
# (agent_diagnostics_harvest, var.agent_diagnostics_harvest_schedule, 06:00 UTC by
# default) AND can be run on demand. The scheduled harvest auto-discovers the whole
# active fleet from PB (PLATFORM_BACKEND_URL → /api/internal/diagnostics/fleet-tenants),
# so every active tenant is evaluated with no per-tenant enrollment. Manual run, e.g.:
#   gcloud run jobs execute agent-diagnostics \
#     --project=YOUR_GCP_PROJECT<env> --region=us-west1 \
#     --args="^@^--harvest@--agents@user-created,caio,hrbp,insights"   # passive
#     # or "^@^--run@--agents@user-created"                            # active canary

# -----------------------------------------------------------------------------
# Workload Identity Federation for GitHub Actions
# -----------------------------------------------------------------------------

resource "google_iam_workload_identity_pool" "github" {
  provider                  = google-beta
  project                   = google_project.platform_ci.project_id
  workload_identity_pool_id = "github-actions-pool"
  display_name              = "GitHub Actions Pool"
  description               = "Workload Identity Pool for GitHub Actions CI/CD"

  depends_on = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  provider                           = google-beta
  project                            = google_project.platform_ci.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub OIDC Provider"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
    # Required by the github_workload_identity SA binding below, which grants
    # workloadIdentityUser to principalSet .../attribute.repository_owner/LiftoffOS.
    # Without mapping this attribute the principalSet matched nothing, so no GitHub
    # Actions job could impersonate the SA (getAccessToken denied) — which is why
    # `npm ci` in Actions never worked. Additive; existing federations unaffected.
    "attribute.repository_owner" = "assertion.repository_owner"
  }

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  # Only allow tokens from LiftoffOS organization
  attribute_condition = "assertion.repository_owner == 'LiftoffOS'"
}

# Allow GitHub Actions from any LiftoffOS repo to impersonate the service account
resource "google_service_account_iam_member" "github_workload_identity" {
  service_account_id = google_service_account.github_actions.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_owner/LiftoffOS"
}

# -----------------------------------------------------------------------------
# Outputs
# -----------------------------------------------------------------------------

output "project_id" {
  value = google_project.platform_ci.project_id
}

output "project_number" {
  value = google_project.platform_ci.number
}

output "cloud_build_sa" {
  value = google_service_account.cloud_build.email
}

output "github_actions_sa" {
  value = google_service_account.github_actions.email
}

# Agent-diagnostics job SA — wired into the eval-tenant (tenant_liftoffos) module
# as `diagnostics_sa` so the template grants it run.invoker on agent-service,
# letting the passive job call the in-tenant /harvest endpoint. Empty when the
# diagnostics job is disabled.
output "agent_diagnostics_sa_email" {
  value = var.agent_diagnostics_enabled ? google_service_account.agent_diagnostics[0].email : ""
}

output "workload_identity_provider" {
  value       = google_iam_workload_identity_pool_provider.github.name
  description = "Full name of the Workload Identity Provider for GitHub Actions"
}
