# platform-backend's daily housekeeping pass: its one Cloud Scheduler job
# (with the monthly allowance reset in annual_plan_allocation_reset.tf).
#
# Each of platform-backend's internal jobs had a scheduler entry here and fired
# every hour whether or not there was work, and several called into every
# tenant runtime, which woke an always-allocated agent-service for ~15 billed
# idle minutes each time. platform-backend now arms a Cloud Task on
# maintenance-tasks-<env> when the work appears (spend arms the cost pass, a
# queued webhook arms delivery, a tunnel heartbeat arms its sweep; see
# src/jobs/maintenance-targets.ts), and this job enqueues every route in
# dailyHousekeeping() (src/jobs/housekeeping.ts) once a day as the backstop and
# as the cadence for retention, reconcilers and probes. The tasks carry this
# scheduler SA's identity, which platform_backend_act_as_scheduler lets
# platform-backend mint. Failed tasks page through maintenance_task_failed
# (scheduled_work_alerts.tf).
#
# Routes only: platform-backend's Cloud Run jobs keep daily schedules of their
# own (pubsub_bulletproof.tf, agent_scheduler_*.tf, apify_cost_reconcile.tf,
# model_pricing_sync.tf), because the project's VPC-SC perimeter refuses a
# Cloud Run Admin API jobs:run call made from Cloud Tasks ("Request is
# prohibited by organization's policy") and admits it from Cloud Scheduler.
#
# 15:00 UTC: the hour the person-facing reminders and invite sweeps already
# ran, and the hour the tenant runtime's own pass runs, so the two share one
# wake.
resource "google_cloud_scheduler_job" "housekeeping_daily" {
  project     = google_project.platform_control.project_id
  name        = "housekeeping-daily-${var.environment}"
  description = "Daily: enqueue every platform-backend maintenance route and job as a Cloud Task"
  region      = var.region
  schedule    = "0 15 * * *"
  time_zone   = "Etc/UTC"

  http_target {
    uri         = "${local.platform_backend_public_url}/api/internal/jobs/housekeeping/daily"
    http_method = "POST"

    headers = {
      "X-Service-Auth" = var.platform_callback_token
      "Content-Type"   = "application/json"
    }

    body = base64encode("{}")

    oidc_token {
      service_account_email = google_service_account.scheduler.email
      audience              = local.platform_backend_public_url
    }
  }

  retry_config {
    retry_count          = 3
    min_backoff_duration = "60s"
    max_backoff_duration = "600s"
  }

  depends_on = [google_project_service.apis]
}
