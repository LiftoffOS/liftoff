# Daily Cloud Scheduler — invokes liftoff-billing's
# /api/internal/jobs/test-subscription-refresh endpoint at 08:00 UTC,
# DEV ONLY.
#
# Stripe automatically cancels every test-mode subscription 90 days after
# creation (retention policy), and the resulting customer.subscription.deleted
# webhook suspends the workspace that sub belongs to. The Dashboard's
# "Exclude from auto-cancellation" has no API equivalent, so this job
# re-provisions any test-mode sub older than 85 days through the normal
# replaceSubscriptionForTenant path. The endpoint additionally hard-gates on
# the Stripe key being sk_test_* — scheduling it in prod would only no-op,
# but we do not schedule it there at all.

resource "google_cloud_scheduler_job" "billing_test_subscription_refresh_daily" {
  count = var.enabled && var.environment == "dev" ? 1 : 0

  project     = var.project_id
  name        = "billing-test-subscription-refresh-daily-${var.environment}"
  description = "Daily 08:00 UTC (dev only): re-provision test-mode subs before Stripe's 90-day retention auto-cancel"
  region      = var.region
  schedule    = "0 8 * * *"
  time_zone   = "Etc/UTC"

  http_target {
    uri         = "${google_cloud_run_v2_service.billing[0].uri}/api/internal/jobs/test-subscription-refresh"
    http_method = "POST"

    headers = {
      "X-Service-Auth" = var.billing_service_token
      "Content-Type"   = "application/json"
    }

    body = base64encode("{}")

    oidc_token {
      service_account_email = var.scheduler_service_account_email
      audience              = google_cloud_run_v2_service.billing[0].uri
    }
  }

  retry_config {
    retry_count          = 3
    min_backoff_duration = "60s"
    max_backoff_duration = "600s"
  }
}
