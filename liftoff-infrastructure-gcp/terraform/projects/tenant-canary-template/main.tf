// WS-10.1 — tenant-canary lightweight runtime.
//
// A fully self-contained, throwaway GCP project that the tenant-runtime
// `canary-gate` CI job stands an ephemeral Cloud Run service up inside on
// every PR (see Liftoff-Tenant-Runtime/.github/canary-stack/up.sh). It holds:
//
//   - a tiny dedicated Postgres (db-f1-micro, public IP) with the
//     `tenant_runtime` database and a `tenant_app` login whose password lives
//     in the `tenant-db-password` Secret Manager secret,
//   - an Artifact Registry DOCKER repo (`canary`) the PR image is pushed to,
//   - a `canary-runner` runtime SA (the identity the ephemeral Cloud Run
//     service runs as),
//   - project-level IAM that lets the GitHub Actions WIF identity
//     (github-actions-dev@YOUR_CI_PROJECT_STAGING) build + deploy + migrate.
//
// The canary runs the runtime with USE_CLOUD_TASKS_EXECUTION=false
// (in-process execution) so NO Pub/Sub / Cloud Tasks / Cloud Scheduler
// topology is provisioned here — deliberately unlike tenant-runtime-template.

variable "environment" {
  description = "dev or prod"
  type        = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod"
  }
}

variable "region" {
  type    = string
  default = "us-west1"
}

variable "billing_account" {
  type        = string
  description = "Same billing account as the tenant-runtime projects"
}

variable "org_id" {
  type        = string
  description = "GCP organization ID. The org is flat — canary projects are parented directly under the org (no folder), matching the real tenant-runtime projects."
}

variable "github_actions_deployer" {
  type        = string
  description = "Email of the pre-existing GitHub Actions WIF identity that the canary-gate workflow impersonates. It is granted the build/deploy/migrate roles directly on this project (the simpler of the two paths in the plan — no separate canary-deployer SA + tokenCreator impersonation hop)."
  default     = "YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com"
}

variable "terraform_pipeline_sa" {
  type        = string
  description = "Email of the infrastructure Cloud Build SA that runs terraform plan/apply for this environment (infrastructure-apply-dev). It must be able to READ and MANAGE this project, or the dev plan/apply fails at the google_project.canary refresh with 'user does not have permission to access Project' — blocking ALL dev infra applies, not just the canary."
  default     = "YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com"
}

locals {
  project_id = "tenant-canary-${var.environment}"
  // Stable per-env IDs so canary-assertions.ts can target them directly.
  canary_tenant_id  = var.environment == "prod" ? "00000000-0000-0000-0000-0000000ca91c" : "00000000-0000-0000-0000-0000000ca90d"
  canary_agent_id   = var.environment == "prod" ? "00000000-0000-0000-0000-0000000ca92c" : "00000000-0000-0000-0000-0000000ca91d"
  canary_account_id = var.environment == "prod" ? "00000000-0000-0000-0000-0000000ca93c" : "00000000-0000-0000-0000-0000000ca92d"
}

resource "google_project" "canary" {
  name            = "tenant-canary-${var.environment}"
  project_id      = local.project_id
  org_id          = var.org_id
  billing_account = var.billing_account
}

resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "iam.googleapis.com",
    "serviceusage.googleapis.com",
    "logging.googleapis.com",
    "monitoring.googleapis.com",
  ])
  project            = google_project.canary.project_id
  service            = each.value
  disable_on_destroy = false
}

// -----------------------------------------------------------------------------
// Artifact Registry — the PR image is pushed to
//   us-west1-docker.pkg.dev/tenant-canary-${env}/canary/tenant-runtime:<sha>
// -----------------------------------------------------------------------------
resource "google_artifact_registry_repository" "canary" {
  project       = google_project.canary.project_id
  location      = var.region
  repository_id = "canary"
  format        = "DOCKER"
  description   = "Ephemeral PR canary tenant-runtime images"
  depends_on    = [google_project_service.apis]
}

// -----------------------------------------------------------------------------
// Per-environment canary SQL instance — tiny f1-micro, no HA, public IP so the
// CI runner can run `npm run migrate` and the Cloud Run service can connect
// without a VPC connector.
// -----------------------------------------------------------------------------
resource "google_sql_database_instance" "canary_pg" {
  project          = google_project.canary.project_id
  region           = var.region
  database_version = "POSTGRES_15"
  name             = "canary-pg-${var.environment}"
  settings {
    tier              = "db-f1-micro"
    availability_type = "ZONAL"
    ip_configuration {
      ipv4_enabled    = true
      private_network = null
      // Open to any IP: this is a disposable canary DB with a generated
      // password and no real data. GitHub-hosted runners have no stable
      // egress range to allowlist.
      authorized_networks {
        name  = "all"
        value = "0.0.0.0/0"
      }
    }
  }
  deletion_protection = false
  depends_on          = [google_project_service.apis]

  # scripts/dev-power.sh stops and starts the dev instances; an apply must not
  # restart a sleeping one.
  lifecycle {
    ignore_changes = [settings[0].activation_policy]
  }
}

resource "google_sql_database" "canary" {
  name     = "tenant_runtime"
  instance = google_sql_database_instance.canary_pg.name
  project  = google_project.canary.project_id
}

// Generated DB password → Secret Manager. up.sh deploys the Cloud Run service
// with `--set-secrets DB_PASSWORD=tenant-db-password:latest` and exports the
// same value to the migrate step's PGPASSWORD.
resource "random_password" "canary_db" {
  length  = 32
  special = false
}

resource "google_secret_manager_secret" "tenant_db_password" {
  project   = google_project.canary.project_id
  secret_id = "tenant-db-password"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "tenant_db_password" {
  secret      = google_secret_manager_secret.tenant_db_password.id
  secret_data = random_password.canary_db.result
}

// The runtime connects as `tenant_app` (src/infrastructure/database.ts default
// DB_USER). Set its password to the generated secret value.
resource "google_sql_user" "tenant_app" {
  project  = google_project.canary.project_id
  instance = google_sql_database_instance.canary_pg.name
  name     = "tenant_app"
  password = random_password.canary_db.result
}

// -----------------------------------------------------------------------------
// Anthropic API key for the canary agent's real LLM turn.
//
// The value is NOT hardcoded — it is copied at apply time from the same dev
// Anthropic secret the live tenant-runtime uses (YOUR_TENANT_PROJECT →
// anthropic-api-key-${env}, wired as plain ANTHROPIC_API_KEY on agent-service).
// up.sh deploys the canary Cloud Run service with
// `--set-secrets ANTHROPIC_API_KEY=anthropic-api-key:latest`. Rotations are
// re-synced out of band (ignore_changes on the version), matching how the
// live services pin `:latest`.
// -----------------------------------------------------------------------------
data "google_secret_manager_secret_version" "source_anthropic" {
  secret  = "anthropic-api-key-${var.environment}"
  project = "YOUR_TENANT_PROJECT${var.environment}"
}

resource "google_secret_manager_secret" "anthropic_api_key" {
  project   = google_project.canary.project_id
  secret_id = "anthropic-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "anthropic_api_key" {
  secret      = google_secret_manager_secret.anthropic_api_key.id
  secret_data = data.google_secret_manager_secret_version.source_anthropic.secret_data
  lifecycle {
    ignore_changes = [secret_data]
  }
}

// -----------------------------------------------------------------------------
// Runtime identity — the ephemeral Cloud Run service runs as this SA.
// -----------------------------------------------------------------------------
resource "google_service_account" "canary_runner" {
  project    = google_project.canary.project_id
  account_id = "canary-runner"
}

resource "google_project_iam_member" "canary_runner_basic_roles" {
  for_each = toset([
    "roles/run.invoker",
    "roles/logging.logWriter",
    "roles/cloudsql.client",
    "roles/secretmanager.secretAccessor",
  ])
  project = google_project.canary.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.canary_runner.email}"
}

// -----------------------------------------------------------------------------
// Deployer IAM.
//
// Cleaner path (per plan): rather than a dedicated canary-deployer SA that the
// WIF identity impersonates via tokenCreator, grant the pre-existing WIF
// identity (github-actions-dev@YOUR_CI_PROJECT_STAGING — the SA every LiftoffOS
// repo already federates into) the build/deploy/migrate roles DIRECTLY on this
// project. One fewer SA, one fewer impersonation hop.
// -----------------------------------------------------------------------------
resource "google_project_iam_member" "deployer_roles" {
  for_each = toset([
    "roles/cloudbuild.builds.editor",          // gcloud builds submit
    "roles/run.admin",                         // deploy the ephemeral Cloud Run service
    "roles/artifactregistry.writer",           // push the PR image
    "roles/cloudsql.client",                   // reach the canary DB for migrate
    "roles/serviceusage.serviceUsageConsumer", // use enabled APIs in this project
    "roles/secretmanager.secretAccessor",      // read tenant-db-password for migrate
    "roles/storage.admin",                     // gcloud builds submit source-staging bucket
    "roles/run.invoker",                       // invoke the private canary service (trigger + assertions ID token)
  ])
  project = google_project.canary.project_id
  role    = each.value
  member  = "serviceAccount:${var.github_actions_deployer}"
}

// The infra Cloud Build SA (cloud-build-dev) runs `terraform apply` for the whole
// dev environment, which now includes this module. It therefore has to READ and
// MANAGE this project — refresh google_project.canary, create/update the SQL
// instance, secrets, SAs, AR, and IAM. Without these roles the dev plan dies at
// the google_project.canary refresh ("user does not have permission to access
// Project tenant-canary-dev"), which blocks EVERY dev infra apply, not just the
// canary. (This is what silently broke the pipeline: the SA is the project's own
// terraform manager but was never granted access to the project it manages.)
//
// BOOTSTRAP NOTE (chicken-and-egg): on a BRAND-NEW canary project, the very first
// apply creates google_project.canary as this same SA, which does NOT get access
// automatically — so this self-grant can't be the thing that unblocks the first
// apply. Grant these roles out-of-band once via gcloud on a fresh project, then
// this resource adopts them into state and keeps them durable on every apply.
resource "google_project_iam_member" "terraform_pipeline_roles" {
  for_each = toset([
    "roles/editor",                          // create SQL / AR / SAs / enable APIs
    "roles/resourcemanager.projectIamAdmin", // manage google_project_iam_member grants
    "roles/iam.securityAdmin",               // set IAM policy on the canary SAs
    "roles/iam.serviceAccountUser",          // act as / reference the canary SAs
    "roles/secretmanager.admin",             // create secrets + versions
    "roles/cloudsql.admin",                  // manage the canary SQL instance
    "roles/cloudsql.client",                 // connectivity checks
    "roles/run.admin",                       // (parity with the tenant project set)
    "roles/run.developer",
    "roles/artifactregistry.admin", // manage the canary image repo
    "roles/serviceusage.serviceUsageAdmin",
    "roles/logging.admin",
    "roles/monitoring.admin",
  ])
  project = google_project.canary.project_id
  role    = each.value
  member  = "serviceAccount:${var.terraform_pipeline_sa}"
}

// Deploy Cloud Run acting as canary_runner ⇒ actAs on that SA specifically.
resource "google_service_account_iam_member" "deployer_actas_runner" {
  service_account_id = google_service_account.canary_runner.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.github_actions_deployer}"
}

// The canary service is private (--no-allow-unauthenticated); the workflow calls
// its scheduled-invoke endpoint with a Cloud Run identity token. Under WIF the
// deployer's credential is external/impersonated and cannot mint an audience-
// scoped ID token directly, so up.sh impersonates canary_runner via IAM
// Credentials generateIdToken. That requires tokenCreator (not just actAs) on
// canary_runner. canary_runner holds project-level run.invoker, so the minted
// token passes the Cloud Run IAM check on the private service.
resource "google_service_account_iam_member" "deployer_tokencreator_runner" {
  service_account_id = google_service_account.canary_runner.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${var.github_actions_deployer}"
}

// -----------------------------------------------------------------------------
// Cloud Build service agents need to push to AR and write logs. In a fresh
// project either the Cloud Build SA or the Compute default SA runs the build
// (depends on org policy constraints/cloudbuild.useComputeServiceAccount), so
// grant both. IAM bindings to not-yet-materialized service agents are accepted
// by GCP and take effect once the API provisions them.
// -----------------------------------------------------------------------------
// Static keys ("cloudbuild"/"compute") so for_each is known at plan time; the
// member email (which embeds the computed project number) is resolved per key.
locals {
  cloudbuild_agent_emails = {
    cloudbuild = "serviceAccount:${google_project.canary.number}@cloudbuild.gserviceaccount.com"
    compute    = "serviceAccount:${google_project.canary.number}-compute@developer.gserviceaccount.com"
  }
}

// cloudbuild.builds.builder covers what a `gcloud builds submit` run needs as
// the build execution identity: read the source-staging GCS object, write
// build logs, and push to Artifact Registry. In a fresh project the Compute
// default SA does NOT get these automatically (automaticIamGrants may be off),
// so the first build 403s on storage.objects.get without this.
resource "google_project_iam_member" "cloudbuild_agents_builder" {
  for_each = local.cloudbuild_agent_emails
  project  = google_project.canary.project_id
  role     = "roles/cloudbuild.builds.builder"
  member   = each.value

  depends_on = [google_project_service.apis]
}

// Kept explicit (redundant with the builder role, but harmless) so an audit of
// "who can push canary images / write canary logs" reads clearly.
resource "google_project_iam_member" "cloudbuild_agents" {
  for_each = local.cloudbuild_agent_emails
  project  = google_project.canary.project_id
  role     = "roles/artifactregistry.writer"
  member   = each.value

  depends_on = [google_project_service.apis]
}

resource "google_project_iam_member" "cloudbuild_agents_logs" {
  for_each = local.cloudbuild_agent_emails
  project  = google_project.canary.project_id
  role     = "roles/logging.logWriter"
  member   = each.value

  depends_on = [google_project_service.apis]
}

// The Docker build pulls @liftoffos/* from the private npm Artifact Registry in
// YOUR_GCP_PROJECT. The build runs as the Compute default SA,
// so grant it (and the Cloud Build agent) read on that cross-project repo.
resource "google_artifact_registry_repository_iam_member" "cloudbuild_agents_npm_read" {
  for_each   = local.cloudbuild_agent_emails
  project    = "YOUR_GCP_PROJECT${var.environment}"
  location   = var.region
  repository = "npm-packages-${var.environment}"
  role       = "roles/artifactregistry.reader"
  member     = each.value

  depends_on = [google_project_service.apis]
}

// github-actions-dev SUBMITS the build, but the build EXECUTES as the Compute
// default SA (modern `gcloud builds submit` default; the legacy
// <num>@cloudbuild SA is not provisioned unless a legacy build creates it).
// `gcloud builds submit` therefore needs actAs on the compute SA, or it fails
// PERMISSION_DENIED "caller does not have permission to act as service account".
// Scoped to compute only: a google_service_account_iam_member binding requires
// the target SA to exist, and the cloudbuild agent SA does not in this project.
resource "google_service_account_iam_member" "deployer_actas_compute" {
  service_account_id = "projects/${google_project.canary.project_id}/serviceAccounts/${google_project.canary.number}-compute@developer.gserviceaccount.com"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${var.github_actions_deployer}"

  depends_on = [google_project_service.apis]
}

// -----------------------------------------------------------------------------
// Outputs — consumed by the CI workflow / operators.
// -----------------------------------------------------------------------------
output "project_id" { value = google_project.canary.project_id }
output "sql_connection_name" { value = google_sql_database_instance.canary_pg.connection_name }
output "sql_public_ip" { value = google_sql_database_instance.canary_pg.public_ip_address }
output "db_password_secret" { value = google_secret_manager_secret.tenant_db_password.secret_id }
output "canary_runner_email" { value = google_service_account.canary_runner.email }
output "artifact_registry_repo" {
  value = "${var.region}-docker.pkg.dev/${google_project.canary.project_id}/${google_artifact_registry_repository.canary.repository_id}"
}
output "canary_tenant_id" { value = local.canary_tenant_id }
output "canary_agent_id" { value = local.canary_agent_id }
output "canary_account_id" { value = local.canary_account_id }
