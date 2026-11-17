# Layer B — independent central auditor for agent schedulers.
#
# Terraform owns: SA, IAM grants, Cloud Scheduler trigger.
# Cloudbuild owns: the agent-scheduler-audit Cloud Run Job itself
# (image, command, env, secrets — same pattern as cost-attribution-backfill).
# This split keeps the script in lock-step with the platform-backend image
# tag without an extra terraform apply on every deploy.

resource "google_service_account" "agent_scheduler_audit" {
  project      = google_project.platform_control.project_id
  account_id   = "agent-scheduler-audit"
  display_name = "Independent hourly auditor for agent schedulers (Layer B)"
}

resource "google_project_iam_member" "audit_metric_writer" {
  project = google_project.platform_control.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.agent_scheduler_audit.email}"
}

# Audit SA reads tenant data via withAdminScope (BYPASSRLS liftoff_admin role)
# from the control plane DB. It needs cloudsql.client to open the connection.
resource "google_project_iam_member" "audit_cloudsql_client" {
  project = google_project.platform_control.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.agent_scheduler_audit.email}"
}

# Audit SA reads the liftoff_admin password from Secret Manager.
#
# liftoff_admin's password is provisioned equal to control-plane-db-password in
# every environment (see DB_ADMIN_USER in main.tf), so that is the secret both
# this binding and the job's --set-secrets use. A separate
# admin-db-password secret was gated behind an operator step that was
# never carried out in any environment, which left the Cloud Run Job uncreated
# and its hourly scheduler resolving NOT_FOUND.
resource "google_secret_manager_secret_iam_member" "audit_admin_db_password" {
  project   = google_project.platform_control.project_id
  secret_id = "control-plane-db-password"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agent_scheduler_audit.email}"
}

# Cross-project Cloud Scheduler read (roles/cloudscheduler.viewer) is granted
# per-tenant in tenant-runtime-template/main.tf — search for
# `audit_sa_scheduler_viewer`.

# Cloud Scheduler trigger — fires the cloudbuild-managed Cloud Run Job hourly.
# The target Job is created/updated by cloudbuild.yaml's
# `create-agent-scheduler-audit-job` step, NOT by Terraform.
#
# Initial-deploy ordering:
#   1. terraform apply creates this scheduler + the audit SA.
#   2. First cloudbuild run on the platform-backend triggers creates the Job.
#   3. Until step 2 completes, this scheduler will 404 every hour on :run
#      (the target Job doesn't exist yet). That's noisy but harmless.
#
# To avoid the 404 noise on a green-field environment, the runbook is:
#   - Apply this Terraform AFTER the platform-backend has had at least one
#     successful Cloud Build deploy in this environment, OR
#   - Comment out this resource on first apply, push platform-backend to
#     create the Job, then uncomment and re-apply.
resource "google_cloud_scheduler_job" "agent_scheduler_audit_hourly" {
  project = google_project.platform_control.project_id
  name    = "agent-scheduler-audit-hourly"
  # Daily with platform-backend's housekeeping pass (housekeeping.tf). A Cloud Run
  # job keeps its own schedule: the project's VPC-SC perimeter refuses a Cloud
  # Run Admin API call made from Cloud Tasks, and admits it from Cloud Scheduler.
  schedule  = "0 15 * * *"
  time_zone = "UTC"
  region    = var.region

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.platform_control.project_id}/jobs/agent-scheduler-audit:run"
    oauth_token {
      service_account_email = google_service_account.agent_scheduler_audit.email
    }
  }
}

# The scheduler SA needs run.invoker on the Cloud Run Jobs API to execute
# its own Job on schedule. Cloud Run Jobs use roles/run.invoker for :run.
resource "google_project_iam_member" "audit_scheduler_run_invoker" {
  project = google_project.platform_control.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.agent_scheduler_audit.email}"
}

# Cloud Scheduler's own service identity needs serviceAccountTokenCreator on
# the target SA to mint the OAuth token used in http_target.oauth_token. The
# service-${PROJECT_NUMBER}@gcp-sa-cloudscheduler.iam.gserviceaccount.com
# identity is created when the Cloud Scheduler API is enabled. Without this
# binding, the trigger fires but the :run POST is unauthenticated and 401s.
resource "google_service_account_iam_member" "audit_scheduler_token_creator" {
  service_account_id = google_service_account.agent_scheduler_audit.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
}
