# Layer D — disagreement-emitter for reconciler vs auditor cross-check.
#
# Terraform owns: SA, IAM grants, Cloud Scheduler trigger.
# Cloudbuild owns: the agent-scheduler-disagreement Cloud Run Job itself
# (image, command, env — same pattern as Layer B). The disagreement job is
# stateless and only talks to Cloud Monitoring (no VPC, no DB).

resource "google_service_account" "agent_scheduler_disagreement" {
  project      = google_project.platform_control.project_id
  account_id   = "agent-scheduler-disagreement"
  display_name = "Layer D disagreement-emitter — reads recent reconciler+auditor metrics, writes diff"
}

# Read access — required to call listTimeSeries on Layer A + Layer B metrics.
resource "google_project_iam_member" "disagreement_metric_viewer" {
  project = google_project.platform_control.project_id
  role    = "roles/monitoring.viewer"
  member  = "serviceAccount:${google_service_account.agent_scheduler_disagreement.email}"
}

# Write access — required to write the disagreement_count metric.
resource "google_project_iam_member" "disagreement_metric_writer" {
  project = google_project.platform_control.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.agent_scheduler_disagreement.email}"
}

# Scheduler trigger — fires the cloudbuild-managed Cloud Run Job every 10 min.
# Same initial-deploy ordering caveat as agent_scheduler_audit_hourly: the
# trigger 404s on its :run target until cloudbuild creates the Job in the
# `create-agent-scheduler-disagreement-job` step. See that comment for the
# runbook to avoid the 404 noise on a green-field environment.
resource "google_cloud_scheduler_job" "agent_scheduler_disagreement_10min" {
  project = google_project.platform_control.project_id
  name    = "agent-scheduler-disagreement-10min"
  # Daily with platform-backend's housekeeping pass (housekeeping.tf). A Cloud Run
  # job keeps its own schedule: the project's VPC-SC perimeter refuses a Cloud
  # Run Admin API call made from Cloud Tasks, and admits it from Cloud Scheduler.
  # Ten minutes after the auditor; its read window is 25 h.
  schedule  = "10 15 * * *"
  time_zone = "UTC"
  region    = var.region

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${google_project.platform_control.project_id}/jobs/agent-scheduler-disagreement:run"
    oauth_token {
      service_account_email = google_service_account.agent_scheduler_disagreement.email
    }
  }
}

# The disagreement SA needs run.invoker to execute its own Job on schedule.
resource "google_project_iam_member" "disagreement_scheduler_run_invoker" {
  project = google_project.platform_control.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.agent_scheduler_disagreement.email}"
}

# Cloud Scheduler's service identity needs serviceAccountTokenCreator on the
# target SA to mint the OAuth token for http_target.oauth_token. See the
# matching comment in agent_scheduler_audit.tf for the full rationale.
resource "google_service_account_iam_member" "disagreement_scheduler_token_creator" {
  service_account_id = google_service_account.agent_scheduler_disagreement.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${google_project.platform_control.number}@gcp-sa-cloudscheduler.iam.gserviceaccount.com"
}
