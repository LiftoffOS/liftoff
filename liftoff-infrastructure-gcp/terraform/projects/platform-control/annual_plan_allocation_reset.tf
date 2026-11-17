# Monthly Cloud Scheduler — invokes platform-backend's
# /api/internal/annual-plan-allocation-reset endpoint.
#
# Grants an annual subscriber every Operating Unit allowance after their first.
#
# A monthly subscriber's allowance is reset by invoice.paid, which arrives every
# month. An annual subscriber invoices once a year, so that path fires once a
# year and this job is the only thing standing between them and a single
# allowance for a twelve month term. Without it the consumption counter climbs
# until it crosses the plan allotment, after which every unit drains the reload
# wallet, and a zero wallet suspends the workspace.
#
# Midnight UTC on the 1st, matching the schedule the module documents. The work
# is one bounded UPDATE per annual subscriber and does not contend with the
# nightly maintenance jobs, which run in the 03:00-04:30 band.
#
# Idempotent: the selection only takes accounts whose billing_period_start
# predates the current calendar month, so a retry inside the same month finds
# nothing and a missed month catches up on the next run. retry_count 3 matches
# its neighbours.
#
# PAIRED WITH A FLAG. The endpoint refuses with 503 unless
# ANNUAL_ALLOCATION_RESET_ENABLED is "true", declared on the platform_backend
# module in main.tf. The pair is the switch: scheduling this job without the
# flag produces a job that reddens every month, which is the intended signal.
# Setting the flag without this job produces nothing at all, which is the state
# that went unnoticed.

resource "google_cloud_scheduler_job" "annual_plan_allocation_reset" {
  project     = google_project.platform_control.project_id
  name        = "annual-plan-allocation-reset-${var.environment}"
  description = "Monthly: grant annual subscribers their Operating Unit allowance for the new month"
  region      = var.region
  schedule    = "0 0 1 * *"
  time_zone   = "Etc/UTC"

  http_target {
    uri         = "${local.platform_backend_public_url}/api/internal/annual-plan-allocation-reset"
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
