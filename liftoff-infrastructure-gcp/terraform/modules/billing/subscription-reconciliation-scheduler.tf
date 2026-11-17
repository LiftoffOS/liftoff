# Daily Cloud Scheduler — invokes liftoff-billing's
# /api/internal/jobs/subscription-reconciliation endpoint at 07:30 UTC in
# BOTH environments.
#
# Diffs Stripe's view of every known customer's subscriptions against the
# local subscriptions table and the billing_controls pointer, and logs each
# divergence at ERROR under a stable name. Left unseen, this drift (a live
# untracked Stripe sub, or a pointer at a hard-deleted sub) can end in a
# workspace being suspended.

resource "google_cloud_scheduler_job" "billing_subscription_reconciliation_daily" {
  count = var.enabled ? 1 : 0

  project     = var.project_id
  name        = "billing-subscription-reconciliation-daily-${var.environment}"
  description = "Daily 07:30 UTC: Stripe vs local subscription + billing_controls pointer drift detection"
  region      = var.region
  schedule    = "30 7 * * *"
  time_zone   = "Etc/UTC"

  http_target {
    uri         = "${google_cloud_run_v2_service.billing[0].uri}/api/internal/jobs/subscription-reconciliation"
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

# Alert when the reconciliation finds ANY drift. The job logs each finding at
# ERROR with a message name under billing.reconciliation.* — this log-based
# alert is the "alert on (a)/(b)/(c)" contract for subscription drift.
resource "google_monitoring_alert_policy" "billing_subscription_drift" {
  count = var.enabled ? 1 : 0

  project      = var.project_id
  display_name = "Billing — subscription drift detected (${var.environment})"
  combiner     = "OR"

  conditions {
    display_name = "billing.reconciliation.* drift logged"
    condition_matched_log {
      # No severity clause: the billing service's pino formatter emits a
      # jsonPayload.level label, which Cloud Logging does not map to
      # severity — a severity>=ERROR filter would never match. The stable
      # msg prefix is the contract.
      filter = <<-EOT
        resource.type="cloud_run_revision"
        resource.labels.service_name="billing"
        jsonPayload.msg=~"^billing\\.reconciliation\\."
      EOT
    }
  }

  alert_strategy {
    notification_rate_limit {
      period = "3600s"
    }
    auto_close = "86400s"
  }

  notification_channels = var.notification_channels
}
