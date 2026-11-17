# Daily Cloud Scheduler — invokes liftoff-billing's
# /api/internal/jobs/card-expiring-reminders endpoint at 09:00 UTC. The job
# queries the local payment_methods table for default cards expiring in
# ~30 days, dedupes via card_expiring_reminders_sent, and fans out to
# platform-backend's /controls/:accountId/card-expiring endpoint for each
# matched card.
#
# Pivoted from the originally-planned customer.source.expiring webhook
# approach: Liftoff uses Stripe's PaymentMethod API exclusively and
# customer.source.expiring does not emit for PaymentMethods.

resource "google_cloud_scheduler_job" "billing_card_expiring_reminders_daily" {
  count = var.enabled ? 1 : 0

  project     = var.project_id
  name        = "billing-card-expiring-reminders-daily-${var.environment}"
  description = "Daily 09:00 UTC: send 30-day card-expiring reminder emails"
  region      = var.region
  schedule    = "0 9 * * *"
  time_zone   = "Etc/UTC"

  http_target {
    uri         = "${google_cloud_run_v2_service.billing[0].uri}/api/internal/jobs/card-expiring-reminders"
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
