// Quarterly fixture-age alert dispatcher.
//
// 09:00 UTC on the 1st of each quarter (Jan/Apr/Jul/Oct), fires an HTTP
// request to the connector-service repo's GitHub API to trigger the
// fixture-age-quarterly workflow. The workflow itself runs the
// response-shape fixture-age-test and posts a Slack alert when any
// fixture is approaching the 120-day refresh deadline (giving 30 days
// of warning before the CI gate trips).
//
// Why HTTP+GitHub-dispatch instead of running the test from inside
// Cloud Build: the test needs `npm ci` against the connector-service
// repo. GitHub's runners already have node + the repo checkout; we just
// fire the dispatch.

resource "google_cloud_scheduler_job" "fixture_age_quarterly_dispatch" {
  count = var.fixture_age_alert_enabled ? 1 : 0

  project     = google_project.platform_ci.project_id
  name        = "fixture-age-quarterly-${var.environment}"
  description = "Triggers the connector-service fixture-age-quarterly workflow at 09:00 UTC on the 1st of each quarter; alerts Slack if any fixture is >90 days old (30-day warning before the 120-day gate)."
  region      = var.region

  # 09:00 UTC on the 1st of January, April, July, October.
  schedule  = "0 9 1 1,4,7,10 *"
  time_zone = "Etc/UTC"

  http_target {
    # GitHub repository_dispatch endpoint. The workflow at
    # liftoff-connector-service/.github/workflows/fixture-age-quarterly.yml
    # listens for either schedule (its own cron) or workflow_dispatch
    # (this trigger). Cron-vs-dispatch is belt-and-suspenders — if either
    # mechanism breaks (GHA outage, GCP outage), the other still fires.
    uri         = "https://api.github.com/repos/LiftoffOS/liftoff-connector-service/actions/workflows/fixture-age-quarterly.yml/dispatches"
    http_method = "POST"

    headers = {
      "Accept"       = "application/vnd.github+json"
      "User-Agent"   = "google-cloud-scheduler/fixture-age-alert"
      "Content-Type" = "application/json"
    }

    body = base64encode("{\"ref\": \"main\"}")

    oauth_token {
      service_account_email = google_service_account.cloud_build.email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  retry_config {
    retry_count          = 3
    min_backoff_duration = "60s"
  }
}

variable "fixture_age_alert_enabled" {
  type        = bool
  default     = false
  description = "Set to true to enable the quarterly fixture-age dispatch (prod only). Requires GitHub PAT in Secret Manager for the dispatch call."
}
