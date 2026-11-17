# Stuck-plan sweep for workforce-service.
#
# A workforce plan lands in `provisioning` and its specs fan out over Cloud
# Tasks. If a task never fires, or fires and dies mid-run, the plan needs
# something to come back and finish it. The service has a resumer for that, but
# it runs at process startup — so without this job, recovery is a side effect of
# deploying rather than a mechanism.
#
# An in-process interval cannot replace it: the service runs at min-instances 0,
# so a timer dies with the instance. It has to be woken from outside.
#
# POST /api/tasks/resume-stuck-plans is OIDC-guarded by the same check the Cloud
# Tasks delivery route uses: it verifies the ID token's audience and that its
# email is the workforce service account. So this needs an `oidc_token`, NOT the
# `oauth_token` used by the audit-anchor job next door — that one invokes the
# Cloud Run Jobs API, which is a different kind of call.
#
# The audience must match WORKFORCE_SERVICE_URL exactly, because that is the
# value the handler verifies against. Note that is the project-number hostname
# built in main.tf, not `google_cloud_run_v2_service.workforce[0].uri` — a Cloud
# Run service answers on both, and they are not the same string.
variable "resume_stuck_plans_schedule" {
  description = "Cron for the stuck-plan resumer. Hourly while the platform is idle (platform-control's idle_cadence)."
  type        = string
  default     = "*/15 * * * *"
}

resource "google_cloud_scheduler_job" "workforce_resume_stuck_plans" {
  count       = var.enabled ? 1 : 0
  project     = var.project_id
  region      = var.region
  name        = "workforce-resume-stuck-plans-${var.environment}"
  description = "Re-enqueue specs for workforce plans stuck in provisioning. The in-service resumer otherwise only runs at startup."
  schedule    = var.resume_stuck_plans_schedule
  time_zone   = "Etc/UTC"

  # The sweep re-enqueues one Cloud Task per outstanding spec and returns; it
  # does not wait for provisioning. Generous anyway so a cold start plus a slow
  # scan cannot make Scheduler record a failure for work that did happen.
  attempt_deadline = "600s"

  retry_config {
    retry_count = 1
  }

  http_target {
    http_method = "POST"
    uri         = "https://${local.service_name}-${data.google_project.self.number}.${var.region}.run.app/api/tasks/resume-stuck-plans"

    oidc_token {
      service_account_email = google_service_account.workforce.email
      audience              = "https://${local.service_name}-${data.google_project.self.number}.${var.region}.run.app"
    }
  }
}
